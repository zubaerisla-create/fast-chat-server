const { getEntitlement } = require("../services/entitlements");
const { planById } = require("../config/plans");

/**
 * Loads the authenticated user's entitlement once per request (after `protect`).
 * Free users are never blocked here — only the guards below restrict paid features.
 */
const loadEntitlement = async (req, res, next) => {
  try {
    if (!req.entitlement) req.entitlement = await getEntitlement(req.user._id);
    next();
  } catch (error) {
    console.error("Entitlement lookup failed:", error.message);
    res.status(500).json({ success: false, message: "Could not check your plan. Please try again." });
  }
};

const deny = (res, message) => res.status(402).json({ success: false, code: "upgrade_required", message });

/** Any paid plan (active, trialing or within grace). */
const requireSubscription = () => [
  loadEntitlement,
  (req, res, next) => (req.entitlement.plan !== "free" ? next() : deny(res, "This feature needs a paid plan.")),
];

/** The given plan or a higher one. */
const requirePlan = (minimumPlanId) => {
  const minimum = planById(minimumPlanId);
  if (!minimum) throw new Error(`Unknown plan "${minimumPlanId}"`);
  return [
    loadEntitlement,
    (req, res, next) =>
      planById(req.entitlement.plan).rank >= minimum.rank ? next() : deny(res, `This feature needs the ${minimum.name} plan or higher.`),
  ];
};

/** A named feature from config/plans.js. */
const requireFeature = (feature) => [
  loadEntitlement,
  (req, res, next) => (req.entitlement.features.includes(feature) ? next() : deny(res, "Your plan doesn't include this feature.")),
];

const requireRole = (role) => (req, res, next) =>
  req.user?.role === role ? next() : res.status(403).json({ success: false, message: "Access denied." });

module.exports = { loadEntitlement, requireSubscription, requirePlan, requireFeature, requireRole };
