const { query } = require("../config/db");
const { getBillingConfig } = require("../config/billing");

// Statuses that currently grant paid access (past_due within grace is approximated as granting)
const ACCESS_STATUSES = ["active", "trialing", "past_due"];

/**
 * GET /api/admin/billing/summary (admin only).
 * Every figure comes from our own tables, populated by verified Paddle webhooks.
 * Amounts are integers in the currency's minor unit, grouped by currency; nothing is
 * converted. No card or payment-method details are stored or returned.
 */
const getBillingSummary = async (req, res) => {
  try {
    const [users, byPlan, lifetimeUsers, byStatus, mrr, lifetimeRevenue, customers, transactions, events] = await Promise.all([
      query("SELECT COUNT(*)::int AS total FROM users"),
      query(
        `SELECT plan, COUNT(DISTINCT user_id)::int AS users FROM subscriptions
         WHERE status = ANY($1) AND user_id IS NOT NULL GROUP BY plan`,
        [ACCESS_STATUSES]
      ),
      query("SELECT COUNT(DISTINCT user_id)::int AS users FROM lifetime_purchases WHERE status = 'active' AND user_id IS NOT NULL"),
      query("SELECT status, COUNT(*)::int AS count FROM subscriptions WHERE provider = 'paddle' GROUP BY status ORDER BY status"),
      // Monthly recurring revenue from paying (not trialing) subscriptions, before tax
      query(
        `SELECT currency_code, SUM(CASE WHEN billing_interval = 'year' THEN recurring_amount_minor / 12.0 ELSE recurring_amount_minor END)::bigint AS mrr_minor,
                COUNT(*)::int AS subscriptions
         FROM subscriptions
         WHERE provider = 'paddle' AND status IN ('active', 'past_due') AND recurring_amount_minor IS NOT NULL
         GROUP BY currency_code`
      ),
      query(
        `SELECT currency_code, SUM(total_minor)::bigint AS total_minor, COUNT(*)::int AS purchases
         FROM lifetime_purchases WHERE status = 'active' GROUP BY currency_code`
      ),
      // One row per customer with any billing record: latest subscription and any lifetime purchase
      query(
        `SELECT u.id AS user_id, u.username, u.email,
                s.plan AS subscription_plan, s.billing_interval, s.status AS subscription_status,
                s.current_period_end, s.trial_end, s.scheduled_change_action, s.scheduled_change_at, s.canceled_at,
                l.status AS lifetime_status, l.purchased_at AS lifetime_purchased_at,
                GREATEST(s.updated_at, l.created_at) AS last_change
         FROM users u
         LEFT JOIN LATERAL (
           SELECT * FROM subscriptions WHERE user_id = u.id ORDER BY provider_updated_at DESC LIMIT 1
         ) s ON TRUE
         LEFT JOIN LATERAL (
           SELECT * FROM lifetime_purchases WHERE user_id = u.id ORDER BY purchased_at LIMIT 1
         ) l ON TRUE
         WHERE s.id IS NOT NULL OR l.id IS NOT NULL
         ORDER BY last_change DESC NULLS LAST
         LIMIT 100`
      ),
      query(
        `SELECT t.provider_transaction_id AS id, t.status, t.currency_code, t.total_minor, t.billed_at, t.price_id, u.username
         FROM billing_transactions t LEFT JOIN users u ON u.id = t.user_id
         ORDER BY t.billed_at DESC NULLS LAST LIMIT 20`
      ),
      query(
        `SELECT provider, event_id, event_type, status, received_at, processed_at, error
         FROM webhook_events ORDER BY received_at DESC LIMIT 20`
      ),
    ]);

    const subscribers = Object.fromEntries(byPlan.rows.map((r) => [r.plan, r.users]));
    const config = getBillingConfig();
    const lifetimePriceId = config.paddle.enabled ? config.paddle.prices.advanced_lifetime : null;

    res.json({
      success: true,
      billing: {
        paddle: config.paddle.enabled
          ? { environment: config.paddle.environment, checkoutEnabled: config.paddle.checkoutEnabled, missingPriceEnv: config.paddle.missingPriceEnv }
          : null,
      },
      users: {
        total: users.rows[0].total,
        starter: subscribers.starter || 0,
        pro: subscribers.pro || 0,
        advancedLifetime: lifetimeUsers.rows[0].users,
      },
      subscriptionsByStatus: byStatus.rows,
      monthlyRecurringRevenue: mrr.rows,
      lifetimeRevenue: lifetimeRevenue.rows,
      customers: customers.rows.map((c) => ({
        userId: c.user_id,
        username: c.username,
        email: c.email,
        // Lifetime wins over a subscription, the same way entitlements are computed
        plan: c.lifetime_status === "active" ? "advanced" : c.subscription_plan,
        billing: c.lifetime_status === "active" ? "lifetime" : c.billing_interval,
        status: c.lifetime_status === "active" ? "lifetime" : c.subscription_status,
        currentPeriodEnd: c.lifetime_status === "active" ? null : c.current_period_end,
        trialEnd: c.lifetime_status === "active" ? null : c.trial_end,
        scheduledChange: c.lifetime_status !== "active" && c.scheduled_change_action ? { action: c.scheduled_change_action, at: c.scheduled_change_at } : null,
        lifetimePurchasedAt: c.lifetime_purchased_at,
        // A subscription that still renews next to Lifetime access should be canceled
        subscriptionAlongsideLifetime: c.lifetime_status === "active" && ACCESS_STATUSES.includes(c.subscription_status),
      })),
      recentTransactions: transactions.rows.map((t) => ({ ...t, lifetime: Boolean(lifetimePriceId) && t.price_id === lifetimePriceId })),
      recentWebhookEvents: events.rows,
    });
  } catch (error) {
    console.error("Admin billing summary failed:", error.message);
    res.status(500).json({ success: false, message: "Could not load the billing summary." });
  }
};

module.exports = { getBillingSummary };
