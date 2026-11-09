const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { protect } = require("../middleware/authMiddleware");
const {
  getCatalog,
  getMyBilling,
  createCheckout,
  createPortalSession,
  paddleWebhook,
} = require("../controllers/billingController");

const router = express.Router();

// Per-user limit on actions that call Paddle
const perUserLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => req.user._id,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please wait a minute and try again." },
});

// GET  /api/billing/catalog                → public plan catalog and Paddle client config
// GET  /api/billing/me                     → current plan, limits and subscriptions
// POST /api/billing/checkout               → create a Paddle transaction for a validated price
// POST /api/billing/portal                 → Paddle customer portal URL
// The Paddle webhook is mounted in server.js because it needs the raw request body.
router.get("/catalog", getCatalog);
router.get("/me", protect, getMyBilling);
router.get("/usage", protect, require("../controllers/billingController").getUsage);
router.post("/checkout", protect, perUserLimit, createCheckout);
router.post("/portal", protect, perUserLimit, createPortalSession);

// Paddle signs the exact bytes it sends, so this router must be mounted before express.json()
const webhookRouter = express.Router();
webhookRouter.post("/paddle", express.raw({ type: "*/*", limit: "1mb" }), paddleWebhook);

module.exports = { billingRouter: router, billingWebhookRouter: webhookRouter };
