const express = require("express");
const {
  sendOTP,
  register,
  login,
  googleLogin,
  forgotPassword,
  verifyResetOTP,
  resetPassword,
} = require("../controllers/authController");

const router = express.Router();

// POST /api/auth/send-otp
router.post("/send-otp", sendOTP);

// POST /api/auth/register
router.post("/register", register);

// POST /api/auth/login
router.post("/login", login);

// POST /api/auth/google
router.post("/google", googleLogin);

// POST /api/auth/forgot-password    → email a reset code
// POST /api/auth/verify-reset-otp   → check the code before choosing a new password
// POST /api/auth/reset-password     → set the new password (logs the user in)
router.post("/forgot-password", forgotPassword);
router.post("/verify-reset-otp", verifyResetOTP);
router.post("/reset-password", resetPassword);

module.exports = router;
