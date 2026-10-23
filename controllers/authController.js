const https = require("https");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const OTP = require("../models/OTP");
const { sendOTPEmail, sendPasswordResetEmail } = require("../utils/mailer");

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
 * Generates a signed JWT token for the given user ID.
 */
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

/**
 * Standard success payload for every auth flow that logs the user in.
 */
const authResponse = (res, status, message, user) =>
  res.status(status).json({
    success: true,
    message,
    token: generateToken(user._id),
    user: User.toPublic(user),
  });

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
 * Register a new user with username, email, password, and OTP.
 */
const register = async (req, res, next) => {
  try {
    const { username, password, otp } = req.body;
    const email = User.normalizeEmail(req.body.email);

    if (!username || !email || !password || !otp) {
      return badRequest(res, "All fields including the verification code are required.");
    }
    if (!USERNAME_REGEX.test(username)) {
      return badRequest(res, "Username must be 3–30 characters: letters, numbers, dots or underscores.");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return badRequest(res, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const check = await OTP.verify(email, "register", otp);
    if (!check.ok) {
      return badRequest(res, check.message);
    }

    if (await User.findByEmail(email)) {
      return badRequest(res, "An account with this email already exists. Please sign in.");
    }
    if (await User.usernameExists(username)) {
      return badRequest(res, "This username is already taken.");
    }

    const user = await User.create({ username, email, password });
    await OTP.consume(email, "register");

    authResponse(res, 201, "Account created successfully.", user);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/login
 * Authenticate a user and return a JWT token.
 */
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return badRequest(res, "Email and password are required.");
    }

    const user = await User.verifyPassword(email, password);
    if (!user) {
      return badRequest(res, "Invalid email or password.", 401);
    }

    authResponse(res, 200, "Login successful.", user);
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

    authResponse(res, 200, "Login successful.", user);
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

module.exports = { sendOTP, register, login, googleLogin, forgotPassword, verifyResetOTP, resetPassword };
