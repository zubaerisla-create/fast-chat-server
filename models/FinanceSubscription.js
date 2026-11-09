const { pool } = require("../config/db");

const FINANCE_PRICING = {
  monthly: { id: "finance_monthly_10", price: 10, interval: "month", trialDays: 7, title: "Monthly Pro" },
  yearly: { id: "finance_yearly_50", price: 50, interval: "year", title: "Yearly Pro" },
  lifetime: { id: "finance_lifetime_100", price: 100, interval: "lifetime", title: "Lifetime Access" },
};

class FinanceSubscription {
  /**
   * Get or initialize subscription status for user (with 7-day free trial)
   */
  static async getForUser(userId, userCreatedAt = null) {
    const res = await pool.query(
      `SELECT * FROM finance_subscriptions WHERE user_id = $1`,
      [userId]
    );

    let sub = res.rows[0];
    const now = new Date();

    if (!sub) {
      // Initialize with 7-day free trial from user registration (or now)
      const trialStart = userCreatedAt ? new Date(userCreatedAt) : now;
      const trialEnd = new Date(trialStart.getTime() + 7 * 24 * 60 * 60 * 1000);

      const ins = await pool.query(
        `INSERT INTO finance_subscriptions (
          user_id, trial_starts_at, trial_ends_at, status
        ) VALUES ($1, $2, $3, 'trialing')
        RETURNING *`,
        [userId, trialStart.toISOString(), trialEnd.toISOString()]
      );
      sub = ins.rows[0];
    }

    return this.evaluateAccess(sub);
  }

  /**
   * Calculate access details, days left, and paywall requirements
   */
  static evaluateAccess(sub) {
    const now = new Date();
    const trialEnds = new Date(sub.trial_ends_at);
    const periodEnds = sub.current_period_end ? new Date(sub.current_period_end) : null;

    let hasAccess = false;
    let isTrial = false;
    let daysLeft = 0;
    let effectiveStatus = sub.status;

    if (sub.status === "lifetime") {
      hasAccess = true;
      effectiveStatus = "lifetime";
    } else if (sub.status === "active") {
      if (!periodEnds || periodEnds > now) {
        hasAccess = true;
        effectiveStatus = "active";
      } else {
        hasAccess = false;
        effectiveStatus = "expired";
      }
    } else {
      // Check if 7-day free trial is currently active
      if (now < trialEnds) {
        hasAccess = true;
        isTrial = true;
        effectiveStatus = "trialing";
        const diffMs = trialEnds.getTime() - now.getTime();
        daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      } else {
        hasAccess = false;
        effectiveStatus = "expired";
      }
    }

    return {
      hasAccess,
      status: effectiveStatus,
      isTrial,
      daysLeft,
      trialEndsAt: sub.trial_ends_at,
      plan: sub.plan,
      currentPeriodEnd: sub.current_period_end,
      pricing: FINANCE_PRICING,
    };
  }

  /**
   * Sync purchase from RevenueCat SDK or in-app purchase
   */
  static async syncPurchase(userId, data) {
    const {
      plan = "monthly",
      revenuecatCustomerId = null,
      originalTransactionId = null,
      currentPeriodEnd = null,
      status = "active",
    } = data;

    const res = await pool.query(
      `INSERT INTO finance_subscriptions (
        user_id, status, plan, revenuecat_customer_id, revenuecat_original_transaction_id, current_period_end, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        status = EXCLUDED.status,
        plan = EXCLUDED.plan,
        revenuecat_customer_id = COALESCE(EXCLUDED.revenuecat_customer_id, finance_subscriptions.revenuecat_customer_id),
        revenuecat_original_transaction_id = COALESCE(EXCLUDED.revenuecat_original_transaction_id, finance_subscriptions.revenuecat_original_transaction_id),
        current_period_end = EXCLUDED.current_period_end,
        updated_at = NOW()
      RETURNING *`,
      [userId, status, plan, revenuecatCustomerId, originalTransactionId, currentPeriodEnd]
    );

    return this.evaluateAccess(res.rows[0]);
  }

  /**
   * Handle webhook from RevenueCat
   */
  static async handleWebhook(event) {
    if (!event) return null;
    const {
      type,
      app_user_id,
      product_id,
      expiration_at_ms,
      original_transaction_id,
    } = event;

    if (!app_user_id) return null;

    let plan = "monthly";
    const pId = (product_id || "").toLowerCase();
    if (pId.includes("lifetime")) plan = "lifetime";
    else if (pId.includes("year") || pId.includes("annual")) plan = "yearly";

    let status = "active";
    let periodEnd = expiration_at_ms ? new Date(expiration_at_ms).toISOString() : null;

    if (type === "EXPIRATION" || type === "SUBSCRIPTION_PAUSED") {
      status = "expired";
    } else if (type === "CANCELLATION") {
      // User cancelled auto-renew, but might still have access until period ends
      if (periodEnd && new Date(periodEnd) <= new Date()) {
        status = "expired";
      } else {
        status = "active";
      }
    } else if (plan === "lifetime") {
      status = "lifetime";
      periodEnd = null;
    }

    return this.syncPurchase(app_user_id, {
      plan,
      status,
      revenuecatCustomerId: app_user_id,
      originalTransactionId: original_transaction_id,
      currentPeriodEnd: periodEnd,
    });
  }
}

module.exports = {
  FinanceSubscription,
  FINANCE_PRICING,
};
