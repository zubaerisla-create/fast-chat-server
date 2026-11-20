const express = require("express");
const { rateLimit } = require("express-rate-limit");
const {
  sendOTP,
  register,
  login,
  googleLogin,
  forgotPassword,
  verifyResetOTP,
  resetPassword,
  requestPasswordReset,
  confirmPasswordReset,
  changePassword,
  refresh,
  logout,
  listMySessions,
  revokeMySession,
  revokeOtherSessions,
  deleteAccount,
} = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

// Limits are per email address, not per IP: behind Cloudflare and Caddy many users can share
// an IP, and per-email keys stop guessing and code-spamming against one account.
const perEmail = (name, windowMinutes, limit) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    keyGenerator: (req) => `${name}:${String(req.body?.email || req.body?.username || "").trim().toLowerCase()}`,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { success: false, message: "Too many attempts. Please wait a few minutes and try again." },
  });
const codeRequests = perEmail("code", 60, 5); // verification and reset emails
const loginAttempts = perEmail("login", 15, 10);
const codeChecks = perEmail("check", 15, 15);

// POST /api/auth/send-otp
router.post("/send-otp", codeRequests, sendOTP);

// POST /api/auth/register  (email + password; no verification code needed)
const registrations = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false, message: { success: false, message: "Too many sign-ups from this network. Try again later." } });
router.post("/register", registrations, codeChecks, register);

// POST /api/auth/login
router.post("/login", loginAttempts, login);

// POST /api/auth/google
router.post("/google", googleLogin);

// POST /api/auth/forgot-password    → email a reset code
// POST /api/auth/verify-reset-otp   → check the code before choosing a new password
// POST /api/auth/reset-password     → set the new password (logs the user in)
router.post("/forgot-password", codeRequests, forgotPassword);
router.post("/verify-reset-otp", codeChecks, verifyResetOTP);
router.post("/reset-password", codeChecks, resetPassword);

// Password reset by email link (no codes): request → link to the website → confirm
router.post("/password-reset/request", codeRequests, requestPasswordReset);
const resetConfirms = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false, message: { success: false, message: "Too many attempts. Try again later." } });
router.post("/password-reset/confirm", resetConfirms, confirmPasswordReset);

// Signed-in account management
const sensitive = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: (req) => `acct:${req.user?._id}`, standardHeaders: "draft-7", legacyHeaders: false, message: { success: false, message: "Too many attempts. Try again later." } });
router.post("/change-password", protect, sensitive, changePassword);
router.post("/refresh", protect, refresh);
router.post("/logout", protect, logout);
router.get("/sessions", protect, listMySessions);
router.delete("/sessions/:id", protect, revokeMySession);
router.post("/sessions/revoke-others", protect, revokeOtherSessions);
router.delete("/account", protect, sensitive, deleteAccount);

module.exports = router;
