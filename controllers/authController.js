const https = require("https");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const OTP = require("../models/OTP");
const { sendOTPEmail, sendPasswordResetEmail, sendPasswordResetLinkEmail } = require("../utils/mailer");
const sessions = require("../services/sessions");
const { query } = require("../config/db");

const GOOGLE_CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID_ANDROID || "496809230686-nnd3i14rdhb1plkddn7dl0emnihauas4.apps.googleusercontent.com",
  process.env.GOOGLE_CLIENT_ID_WEB || "496809230686-djde9n55nvgaads7e0o6qak5vjur8b61.apps.googleusercontent.com",
].filter(Boolean);

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const USERNAME_REGEX = /^[a-zA-Z0-9._]{3,30}$/;
const MIN_PASSWORD_LENGTH = 6;

const verifyGoogleToken = (idToken) => {
  return new Promise((resolve, reject) => {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error("Google token verification failed."));
          }
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", (err) => {
        reject(err);
      });
  });
};

/**
 * Standard success payload for every auth flow that logs the user in. Every login gets its own
 * session (services/sessions.js), so devices can be listed and signed out one by one.
 */
const authResponse = async (res, status, message, user, req) => {
  if (user.status === "suspended") return res.status(403).json({ success: false, code: "account_suspended", message: "This account is suspended. Contact support." });
  const token = await sessions.issueToken(user._id, req, req?.body?.client === "web" ? "web" : "app");
  return res.status(status).json({ success: true, message, token, user: User.toPublic(user) });
};

const badRequest = (res, message, status = 400) => res.status(status).json({ success: false, message });

const cooldownMessage = (seconds) => `Please wait ${seconds}s before requesting another code.`;

/**
 * POST /api/auth/send-otp
 * Sends a signup verification code to the email.
 * Body: { email, username? } — username is checked early so the user isn't surprised after the OTP step.
 */
const sendOTP = async (req, res, next) => {
  try {
    const email = User.normalizeEmail(req.body.email);
    const { username } = req.body;

    if (!EMAIL_REGEX.test(email)) {
      return badRequest(res, "Please enter a valid email.");
    }

    if (await User.findByEmail(email)) {
      return badRequest(res, "An account with this email already exists. Please sign in.");
    }

    if (username && (await User.usernameExists(username))) {
      return badRequest(res, "This username is already taken.");
    }

    const wait = await OTP.cooldownRemaining(email, "register");
    if (wait > 0) {
      return badRequest(res, cooldownMessage(wait), 429);
    }

    const otp = await OTP.issue(email, "register");
    await sendOTPEmail(email, otp, OTP.OTP_TTL_MINUTES);

    res.status(200).json({
      success: true,
      message: "Verification code sent. Please check your email.",
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/register
 * Register with username, email and password. No email code is needed; an `otp` sent by
 * older app versions is still checked when present.
 */
const register = async (req, res, next) => {
  try {
    const { username, password, otp } = req.body;
    const email = User.normalizeEmail(req.body.email);

    if (!username || !email || !password) {
      return badRequest(res, "Username, email and password are required.");
    }
    if (!EMAIL_REGEX.test(email) || email.length > 255) {
      return badRequest(res, "Enter a valid email address.");
    }
    if (!USERNAME_REGEX.test(username)) {
      return badRequest(res, "Username must be 3–30 characters: letters, numbers, dots or underscores.");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return badRequest(res, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    if (password.length > 128) {
      return badRequest(res, "Password is too long (128 characters at most).");
    }
    if (otp) {
      const check = await OTP.verify(email, "register", otp);
      if (!check.ok) return badRequest(res, check.message);
    }

    if (await User.findByEmail(email)) {
      return badRequest(res, "An account with this email already exists. Please sign in.");
    }
    if (await User.usernameExists(username)) {
      return badRequest(res, "This username is already taken.");
    }

    const user = await User.create({ username, email, password });
    if (otp) await OTP.consume(email, "register");

    await authResponse(res, 201, "Account created successfully.", user, req);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/login
 * Authenticate a user and return a JWT token.
 * Accepts either email or username in the identifier/email field.
 */
const login = async (req, res, next) => {
  try {
    const identifier = req.body.email || req.body.username;
    const { password } = req.body;

    if (!identifier || !password) {
      return badRequest(res, "Email/username and password are required.");
    }

    const user = await User.verifyPassword(identifier, password);
    if (!user) {
      return badRequest(res, "Invalid email/username or password.", 401);
    }

    await authResponse(res, 200, "Login successful.", user, req);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/google
 * Log in (or sign up) with a Google ID token.
 */
const googleLogin = async (req, res, next) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return badRequest(res, "Google ID token is required.");
    }

    const tokenInfo = await verifyGoogleToken(idToken);
    const email = tokenInfo.email && tokenInfo.email.toLowerCase();
    const emailVerified = tokenInfo.email_verified === "true" || tokenInfo.email_verified === true;
    const aud = tokenInfo.aud;

    if (!email || !emailVerified) {
      return badRequest(res, "Google account email is not verified.", 401);
    }

    if (GOOGLE_CLIENT_IDS.length > 0 && !GOOGLE_CLIENT_IDS.includes(aud)) {
      return badRequest(res, "Google token audience mismatch.", 401);
    }

    let user = await User.findByEmail(email);
    if (!user) {
      const rawUsername = (tokenInfo.name || email.split("@")[0]).replace(/[^a-zA-Z0-9._]/g, "").toLowerCase();
      let username = (rawUsername || email.split("@")[0]).slice(0, 24);
      if (username.length < 3) {
        username = `${username}user`;
      }

      let uniqueUsername = username;
      let suffix = 0;
      while (await User.usernameExists(uniqueUsername)) {
        suffix += 1;
        uniqueUsername = `${username}${suffix}`;
      }

      user = await User.create({
        username: uniqueUsername,
        email,
        password: crypto.randomBytes(24).toString("hex"),
        avatar: tokenInfo.picture || "",
      });
    }

    await authResponse(res, 200, "Login successful.", user, req);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/forgot-password
 * Emails a password reset code. Responds the same way whether or not the
 * account exists, so the endpoint can't be used to discover registered emails.
 * Body: { email }
 */
const forgotPassword = async (req, res, next) => {
  try {
    const email = User.normalizeEmail(req.body.email);

    if (!EMAIL_REGEX.test(email)) {
      return badRequest(res, "Please enter a valid email.");
    }

    const wait = await OTP.cooldownRemaining(email, "reset");
    if (wait > 0) {
      return badRequest(res, cooldownMessage(wait), 429);
    }

    if (await User.findByEmail(email)) {
      const otp = await OTP.issue(email, "reset");
      await sendPasswordResetEmail(email, otp, OTP.OTP_TTL_MINUTES);
    }

    res.status(200).json({
      success: true,
      message: "If an account exists for this email, a reset code has been sent.",
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/verify-reset-otp
 * Checks a reset code before the user picks a new password (does not consume it).
 * Body: { email, otp }
 */
const verifyResetOTP = async (req, res, next) => {
  try {
    const email = User.normalizeEmail(req.body.email);
    const { otp } = req.body;

    if (!email || !otp) {
      return badRequest(res, "Email and code are required.");
    }

    const check = await OTP.verify(email, "reset", otp);
    if (!check.ok) {
      return badRequest(res, check.message);
    }

    res.status(200).json({ success: true, message: "Code verified." });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/reset-password
 * Sets a new password using a valid reset code, then logs the user in.
 * Body: { email, otp, newPassword }
 */
const resetPassword = async (req, res, next) => {
  try {
    const email = User.normalizeEmail(req.body.email);
    const { otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return badRequest(res, "Email, code and new password are required.");
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return badRequest(res, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const check = await OTP.verify(email, "reset", otp);
    if (!check.ok) {
      return badRequest(res, check.message);
    }

    const user = await User.findByEmail(email);
    if (!user) {
      return badRequest(res, "Code expired or not found. Please request a new one.");
    }

    await User.updatePassword(user._id, newPassword);
    await OTP.consume(email, "reset");

    authResponse(res, 200, "Password updated successfully.", user);
  } catch (error) {
    next(error);
  }
};

// ─── Link-based password reset, password change, sessions, account deletion ──────────

const RESET_TTL_MINUTES = 30;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const siteUrl = () => (process.env.PASSWORD_RESET_URL_BASE || process.env.CLIENT_URL || process.env.SITE_URL || "http://localhost:3000").split(",")[0].replace(/\/$/, "");

/**
 * POST /api/auth/password-reset/request  Body: { email }
 * Emails a single-use link. Same answer whether or not the account exists.
 */
const requestPasswordReset = async (req, res, next) => {
  try {
    const email = User.normalizeEmail(req.body.email);
    if (!email || !EMAIL_REGEX.test(email)) return badRequest(res, "Enter a valid email address.");
    const user = await User.findByEmail(email);
    if (user && user.status !== "suspended") {
      const token = crypto.randomBytes(32).toString("base64url");
      // Older unused links stop working when a new one is requested
      await query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [user._id]);
      await query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip) VALUES ($1, $2, NOW() + interval '${RESET_TTL_MINUTES} minutes', $3)`, [user._id, sha256(token), sessions.clientIp(req)]);
      await sendPasswordResetLinkEmail(email, { link: `${siteUrl()}/reset-password?token=${token}`, minutes: RESET_TTL_MINUTES });
    }
    res.json({ success: true, message: "If an account exists for this email, we sent a link to reset the password." });
  } catch (error) {
    next(error);
  }
};

/** POST /api/auth/password-reset/confirm  Body: { token, newPassword } — signs out every device. */
const confirmPasswordReset = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (typeof token !== "string" || token.length < 20 || token.length > 200) return badRequest(res, "This reset link is invalid.");
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 128) return badRequest(res, `Password must be ${MIN_PASSWORD_LENGTH}–128 characters.`);
    // Claim the token atomically so it can only be used once
    const { rows } = await query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id`,
      [sha256(token)]
    );
    if (!rows.length) return badRequest(res, "This reset link has expired or was already used. Request a new one.");
    await User.updatePassword(rows[0].user_id, newPassword);
    await query(`UPDATE users SET password_changed_at = NOW() WHERE id = $1`, [rows[0].user_id]);
    await sessions.revokeAll(rows[0].user_id);
    res.json({ success: true, message: "Password updated. Sign in with your new password." });
  } catch (error) {
    next(error);
  }
};

/** POST /api/auth/change-password (signed in)  Body: { currentPassword, newPassword } */
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 128) return badRequest(res, `Password must be ${MIN_PASSWORD_LENGTH}–128 characters.`);
    const ok = await User.verifyPassword(req.user.email, String(currentPassword || ""));
    if (!ok || ok._id !== req.user._id) return badRequest(res, "Your current password is not correct.", 401);
    await User.updatePassword(req.user._id, newPassword);
    await query(`UPDATE users SET password_changed_at = NOW() WHERE id = $1`, [req.user._id]);
    // Every other device is signed out; this one gets a fresh session
    await sessions.revokeAll(req.user._id);
    const token = await sessions.issueToken(req.user._id, req);
    res.json({ success: true, message: "Password changed. Other devices were signed out.", token });
  } catch (error) {
    next(error);
  }
};

/** POST /api/auth/refresh (signed in) — same session, new expiry (token rotation). */
const refresh = async (req, res, next) => {
  try {
    const token = req.auth.sid ? await sessions.rotateToken(req.auth) : await sessions.issueToken(req.user._id, req);
    res.json({ success: true, token });
  } catch (error) {
    next(error);
  }
};

/** POST /api/auth/logout (signed in) — ends this device's session. */
const logout = async (req, res, next) => {
  try {
    if (req.auth.sid) await sessions.revokeSession(req.user._id, req.auth.sid);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

const listMySessions = async (req, res, next) => {
  try {
    const list = await sessions.listSessions(req.user._id);
    res.json({ success: true, sessions: list.map((s) => ({ ...s, current: s.id === req.auth.sid })) });
  } catch (error) {
    next(error);
  }
};

const revokeMySession = async (req, res, next) => {
  try {
    const ok = await sessions.revokeSession(req.user._id, req.params.id);
    if (!ok) return badRequest(res, "Session not found.", 404);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/** POST /api/auth/sessions/revoke-others — signs out every other device. */
const revokeOtherSessions = async (req, res, next) => {
  try {
    await sessions.revokeAll(req.user._id, { exceptSid: req.auth.sid || null });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/auth/account  Body: { password, confirm: "DELETE" }
 * Permanently deletes the account (messages, memberships … cascade). Purchase records keep
 * their transaction data with the user detached, as store records must be retained.
 */
const deleteAccount = async (req, res, next) => {
  try {
    const { password, confirm } = req.body;
    if (confirm !== "DELETE") return badRequest(res, 'Type DELETE to confirm.');
    const ok = await User.verifyPassword(req.user.email, String(password || ""));
    if (!ok || ok._id !== req.user._id) return badRequest(res, "Your password is not correct.", 401);
    const owner = await query(`SELECT 1 FROM user_entitlements WHERE user_id = $1 AND source = 'owner'`, [req.user._id]);
    if (owner.rows.length) return badRequest(res, "The owner account can't be deleted from the app.", 403);
    await query(`DELETE FROM users WHERE id = $1`, [req.user._id]);
    res.json({ success: true, message: "Your account was deleted." });
  } catch (error) {
    next(error);
  }
};

module.exports = {
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
};
