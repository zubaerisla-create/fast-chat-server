const { getBillingConfig } = require("../config/billing");
const { PLANS, PAID_PLAN_IDS, MB } = require("../config/plans");
const { getEntitlement, listUserSubscriptions, listUserLifetimePurchases } = require("../services/entitlements");
const { getOffers } = require("../services/paddleCatalog");
const paddleBilling = require("../services/paddleBilling");

const sendError = (res, error, fallback) => {
  const status = error.status || 500;
  if (status >= 500 && !error.status) console.error(`${fallback}:`, error.message);
  res.status(status).json({ success: false, code: error.code, message: error.status ? error.message : fallback });
};

/**
 * GET /api/billing/catalog (public).
 * Only Starter, Pro and Advanced Lifetime. Amounts, cycles and trials come from the
 * configured Paddle prices. Price IDs and the client-side token are public by design
 * (Paddle.js needs them); the API key and webhook secret never leave the server.
 */
const getCatalog = async (req, res) => {
  const config = getBillingConfig();
  const { paddle } = config;
  try {
    const offers = await getOffers();
    const warnings = [];
    if (config.showConfigWarnings) {
      if (!paddle.enabled) warnings.push("PADDLE_ENVIRONMENT is not set, so billing is off.");
      for (const o of Object.values(offers)) if (o.issue && paddle.enabled) warnings.push(o.issue);
      if (paddle.enabled && !paddle.checkoutEnabled) warnings.push("PADDLE_CHECKOUT_ENABLED is not true, so checkout buttons are disabled.");
    }

    res.set("Cache-Control", "public, max-age=60");
    res.json({
      success: true,
      paddle: paddle.enabled
        ? { enabled: true, environment: paddle.environment, clientToken: paddle.clientToken, checkoutEnabled: paddle.checkoutEnabled }
        : { enabled: false },
      plans: PAID_PLAN_IDS.map((id) => {
        const plan = PLANS[id];
        const planOffers = Object.values(offers)
          .filter((o) => o.plan === id)
          .map(({ issue, ...o }) => o); // reasons are only shown via `warnings`
        return {
          id: plan.id,
          name: plan.name,
          rank: plan.rank,
          recommended: Boolean(plan.recommended),
          lifetime: Boolean(plan.lifetime),
          maxFileSizeMb: Math.round(plan.limits.maxFileBytes / MB),
          features: plan.features,
          offers: Object.fromEntries(planOffers.map((o) => [o.interval, o])),
        };
      }),
      baseline: { maxFileSizeMb: Math.round(PLANS.free.limits.maxFileBytes / MB) },
      warnings,
    });
  } catch (error) {
    sendError(res, error, "Could not load plans");
  }
};

/** GET /api/billing/me: the signed-in user's plan, limits, subscriptions and lifetime purchases. */
const getMyBilling = async (req, res) => {
  try {
    const [entitlement, subscriptions, lifetime] = await Promise.all([
      getEntitlement(req.user._id),
      listUserSubscriptions(req.user._id),
      listUserLifetimePurchases(req.user._id),
    ]);
    res.json({
      success: true,
      entitlement,
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        provider: s.provider,
        plan: s.plan,
        interval: s.billing_interval,
        status: s.status,
        currentPeriodEnd: s.current_period_end,
        trialEnd: s.trial_end,
        scheduledChange: s.scheduled_change_action ? { action: s.scheduled_change_action, at: s.scheduled_change_at } : null,
      })),
      lifetimePurchases: lifetime.map((p) => ({ id: p.id, plan: p.plan, status: p.status, purchasedAt: p.purchased_at })),
    });
  } catch (error) {
    sendError(res, error, "Could not load billing details");
  }
};

/** POST /api/billing/checkout { priceId }: validated against configured, active Paddle prices. */
const createCheckout = async (req, res) => {
  const { priceId } = req.body || {};
  if (typeof priceId !== "string" || !priceId) return res.status(400).json({ success: false, message: "priceId is required." });
  try {
    res.json({ success: true, ...(await paddleBilling.createCheckout(req.user, priceId)) });
  } catch (error) {
    sendError(res, error, "Could not start checkout");
  }
};

/** POST /api/billing/portal: customer resolved from the authenticated user only. */
const createPortalSession = async (req, res) => {
  try {
    res.json({ success: true, ...(await paddleBilling.createPortalSession(req.user)) });
  } catch (error) {
    sendError(res, error, "Could not open billing management");
  }
};

/** POST /api/billing/webhooks/paddle: raw body; see routes/billingRoutes.js. */
const paddleWebhook = async (req, res) => {
  const { status, body } = await paddleBilling.handlePaddleWebhook(req.body, req.get("paddle-signature"));
  res.status(status).json(body);
};

module.exports = { getCatalog, getMyBilling, createCheckout, createPortalSession, paddleWebhook };

/**
 * GET /api/billing/usage — the signed-in user's usage against their plan, plus each
 * workspace they own (members and channels count against the owner's plan).
 */
const getUsage = async (req, res) => {
  try {
    const { query } = require("../config/db");
    const limits = require("../services/limits");
    const entitlement = await getEntitlement(req.user._id);
    const [storageUsed, owned] = await Promise.all([
      limits.storageUsedBy(req.user._id),
      query(
        `SELECT w.id, w.name,
           (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id)::int AS members,
           (SELECT COUNT(*) FROM workspace_invitations i WHERE i.workspace_id = w.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW())::int AS pending_invites,
           (SELECT COUNT(*) FROM conversations c WHERE c.workspace_id = w.id AND c.type = 'channel')::int AS channels
         FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE o.owner_id = $1 ORDER BY w.created_at`,
        [req.user._id]
      ),
    ]);
    const l = entitlement.limits;
    res.json({
      success: true,
      plan: { id: entitlement.plan, name: entitlement.planName },
      usage: {
        storage: { used: storageUsed, limit: l.storageBytes },
        workspaces: { used: owned.rows.length, limit: l.workspaces },
        maxFileBytes: l.maxFileBytes,
        aiRequests: { used: null, limit: l.aiRequestsPerMonth, available: false },
        groupCalls: l.groupCalls,
      },
      workspaces: owned.rows.map((w) => ({
        id: w.id,
        name: w.name,
        members: { used: w.members + w.pending_invites, limit: l.membersPerWorkspace },
        channels: { used: w.channels, limit: l.channelsPerWorkspace },
      })),
    });
  } catch (error) {
    sendError(res, error, "Could not load usage");
  }
};
module.exports.getUsage = getUsage;
