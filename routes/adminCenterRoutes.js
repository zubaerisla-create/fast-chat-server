/**
 * Admin control center API — /api/admin-center. Used by the separate Next.js admin app
 * (fast-chat-admin). Every route needs a signed-in admin whose role has the listed permission.
 */
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { protect } = require("../middleware/authMiddleware");
const { loadAdmin, can } = require("../middleware/adminAuth");
const c = require("../controllers/adminCenterController");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `admin-login:${String(req.body?.email || "").trim().toLowerCase()}`,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Try again later." },
});
router.post("/auth/login", loginLimiter, c.login);

router.use(protect, loadAdmin);
// Mutations are rate limited per admin as a safety net
router.use((req, res, next) => (req.method === "GET" ? next() : mutations(req, res, next)));
const mutations = rateLimit({ windowMs: 60 * 1000, limit: 60, keyGenerator: (req) => `admin-mut:${req.user._id}`, standardHeaders: "draft-7", legacyHeaders: false, message: { success: false, message: "Slow down." } });

router.get("/auth/me", c.me);
router.get("/dashboard", can("dashboard.read"), c.dashboard);

router.get("/users", can("users.read"), c.listUsers);
router.get("/users/:id", can("users.read"), c.getUser);
router.post("/users/:id/suspend", can("users.manage"), c.suspendUser);
router.post("/users/:id/reactivate", can("users.manage"), c.reactivateUser);
router.post("/users/:id/sessions/revoke", can("users.manage"), c.revokeUserSessions);
router.post("/users/:id/sessions/:sid/revoke", can("users.manage"), c.revokeUserSessions);
router.post("/users/:id/entitlements/promo", can("entitlements.manage"), c.grantPromo);
router.post("/users/:id/entitlements/promo/revoke", can("entitlements.manage"), c.revokePromo);
router.post("/users/:id/reconcile", can("purchases.reconcile"), c.reconcile);

router.get("/purchases", can("purchases.read"), c.listPurchases);
router.get("/webhooks", can("purchases.read"), c.listWebhooks);

router.get("/games", can("games.read"), c.listGames);
router.post("/games", can("games.manage"), c.createGame);
router.patch("/games/:id", can("games.manage"), c.updateGame);

router.get("/matches", can("matches.read"), c.listMatches);
router.get("/matches/:id", can("matches.read"), c.getMatch);
router.post("/matches/:roomId/cancel", can("matches.manage"), c.cancelMatch);
router.get("/reports", can("reports.manage"), c.listReports);
router.patch("/reports/:id", can("reports.manage"), c.updateReport);

router.get("/analytics", can("analytics.read"), c.analytics);
router.get("/settings", can("settings.read"), c.getSettings);
router.put("/settings/:key", can("settings.manage"), c.updateSetting);

router.get("/audit", can("audit.read"), c.auditLog);
router.get("/notifications", can("notifications.read"), c.notifications);
router.post("/notifications/read", can("notifications.read"), c.readNotifications);

router.get("/admins", can("admins.manage"), c.listAdmins);
router.put("/admins/:userId", can("admins.manage"), c.setAdminRole);

module.exports = router;
