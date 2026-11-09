/**
 * Entitlements: which plan a user effectively has right now, computed only on the
 * server from verified records written by signed Paddle webhooks. The website and
 * the Android app both read the result from GET /api/billing/me.
 *
 * Subscription access rules (Starter, Pro):
 *   active          → access (including when a cancellation is scheduled; Paddle only
 *                      moves the status to canceled once it takes effect)
 *   trialing        → access
 *   past_due        → access for BILLING_PAST_DUE_GRACE_DAYS (default 7) after it went past due
 *   paused          → no access unless BILLING_PAUSED_KEEPS_ACCESS=true
 *   canceled, expired, anything else → no access
 *
 * Advanced Lifetime: an active lifetime_purchases row grants access permanently.
 * Nothing expires it automatically; only an admin can revoke it.
 */
const { query } = require("../config/db");
const { PLANS, planById } = require("../config/plans");
const { getBillingConfig } = require("../config/billing");

const DAY_MS = 24 * 60 * 60 * 1000;

function subscriptionGrantsAccess(sub, now = new Date(), config = getBillingConfig()) {
  if (!sub || !planById(sub.plan)) return false;
  switch (sub.status) {
    case "active":
    case "trialing":
      return true;
    case "past_due": {
      const since = sub.past_due_since ? new Date(sub.past_due_since) : now;
      return now.getTime() - since.getTime() < config.pastDueGraceDays * DAY_MS;
    }
    case "paused":
      return config.pausedKeepsAccess;
    default:
      return false;
  }
}

const SUB_COLUMNS = `id, user_id, provider, provider_subscription_id, plan, billing_interval, status,
  current_period_start, current_period_end, trial_start, trial_end, scheduled_change_action,
  scheduled_change_at, canceled_at, past_due_since`;

async function listUserSubscriptions(userId, db = { query }) {
  const { rows } = await db.query(
    `SELECT ${SUB_COLUMNS} FROM subscriptions WHERE user_id = $1 ORDER BY provider_updated_at DESC`,
    [userId]
  );
  return rows;
}

async function listUserLifetimePurchases(userId, db = { query }) {
  const { rows } = await db.query(
    `SELECT id, provider, provider_transaction_id, plan, status, purchased_at
     FROM lifetime_purchases WHERE user_id = $1 ORDER BY purchased_at`,
    [userId]
  );
  return rows;
}

/** Pure part: picks the best plan from a user's subscriptions and lifetime purchases. */
function computeEntitlement(subscriptions, lifetimePurchases = [], now = new Date(), config = getBillingConfig()) {
  const lifetime = lifetimePurchases.find((p) => p.status === "active" && planById(p.plan));
  const granting = subscriptions.filter((s) => subscriptionGrantsAccess(s, now, config));
  granting.sort((a, b) => planById(b.plan).rank - planById(a.plan).rank);
  const best = granting[0];

  let plan = PLANS.free;
  if (lifetime) plan = planById(lifetime.plan);
  else if (best) plan = planById(best.plan);

  return {
    plan: plan.id,
    planName: plan.name,
    limits: plan.limits,
    features: plan.features,
    source: lifetime || best ? "paddle" : null,
    // Lifetime access: no renewal and no expiry
    lifetime: lifetime ? { id: lifetime.id, purchasedAt: lifetime.purchased_at } : null,
    subscription:
      !lifetime && best
        ? {
            id: best.id,
            provider: best.provider,
            status: best.status,
            interval: best.billing_interval,
            currentPeriodEnd: best.current_period_end,
            trialEnd: best.trial_end,
            scheduledChange: best.scheduled_change_action ? { action: best.scheduled_change_action, at: best.scheduled_change_at } : null,
          }
        : null,
    // More than one thing granting access (two subscriptions, or a subscription next to
    // Lifetime): surfaced so the user can cancel the one they no longer need
    hasDuplicateSubscriptions: granting.length + (lifetime ? 1 : 0) > 1,
  };
}

async function getEntitlement(userId, now = new Date()) {
  const [subs, lifetime] = await Promise.all([listUserSubscriptions(userId), listUserLifetimePurchases(userId)]);
  return computeEntitlement(subs, lifetime, now);
}

module.exports = { subscriptionGrantsAccess, computeEntitlement, getEntitlement, listUserSubscriptions, listUserLifetimePurchases };
