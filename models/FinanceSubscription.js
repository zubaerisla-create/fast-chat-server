const { pool } = require("../config/db");

const FINANCE_PRICING = {
  monthly: { id: "finance_monthly_10", price: 10, interval: "month", trialDays: 7, title: "Monthly Pro" },
  yearly: { id: "finance_yearly_50", price: 50, interval: "year", title: "Yearly Pro" },
  lifetime: { id: "finance_lifetime_100", price: 100, interval: "lifetime", title: "Lifetime Access" },
};

class FinanceSubscription {
  /**
   * Accounts created before this moment keep the old automatic 7-day sign-up trial; newer ones
   * start without a trial (Google Play's Monthly plan has the trial). Set once at deploy time
   * (config/schema.sql). Missing → nobody gets the automatic trial.
   */
  static async signupTrialCutoff() {
    const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'finance_signup_trial_cutoff'`);
    const v = rows[0] && rows[0].value;
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  }

  /**
   * Get the user's Finance subscription row, creating it the first time.
   * Existing rows are returned as they are (a running trial keeps its end date).
   */
  static async getForUser(userId, userCreatedAt = null) {
    const res = await pool.query(
      `SELECT * FROM finance_subscriptions WHERE user_id = $1`,
      [userId]
    );

    let sub = res.rows[0];
    const now = new Date();

    if (!sub) {
      const cutoff = await this.signupTrialCutoff();
      const created = userCreatedAt ? new Date(userCreatedAt) : null;
      const legacyTrial = cutoff && created && !Number.isNaN(created.getTime()) && created < cutoff;
      let ins;
      if (legacyTrial) {
        // Account from before the cutoff: the old rule, 7 days from registration
        const trialEnd = new Date(created.getTime() + 7 * 24 * 60 * 60 * 1000);
        ins = await pool.query(
          `INSERT INTO finance_subscriptions (user_id, trial_starts_at, trial_ends_at, status)
           VALUES ($1, $2, $3, 'trialing')
           ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
           RETURNING *`,
          [userId, created.toISOString(), trialEnd.toISOString()]
        );
      } else {
        // New account: no automatic trial (start = end), Pro only via Google Play
        ins = await pool.query(
          `INSERT INTO finance_subscriptions (user_id, trial_starts_at, trial_ends_at, status)
           VALUES ($1, $2, $2, 'free')
           ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
           RETURNING *`,
          [userId, now.toISOString()]
        );
      }
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

    const hadTrial = new Date(sub.trial_ends_at) > new Date(sub.trial_starts_at);
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
        // Never had a trial → "free" (not "expired")
        effectiveStatus = hadTrial ? "expired" : "free";
      }
    }

    return {
      hasAccess,
      hadTrial,
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
   * Writes a store-verified state. Only call with data from RevenueCat's API
   * (services/revenuecat.reconcileFinance) — never with values sent by the app.
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

}

module.exports = {
  FinanceSubscription,
  FINANCE_PRICING,
};
