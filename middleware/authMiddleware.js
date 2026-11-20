const jwt = require("jsonwebtoken");
const User = require("../models/User");
const sessions = require("../services/sessions");

/**
 * Middleware to protect private routes.
 * Reads Bearer token from Authorization header, verifies it,
 * and attaches the authenticated user to req.user.
 */
const protect = async (req, res, next) => {
  try {
    let token;

    // Extract token from Authorization header
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer ")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No token provided.",
      });
    }

    // Verify token signature and expiry
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach the user document (without password) to request
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User belonging to this token no longer exists.",
      });
    }

    // Session still valid, account not suspended (services/sessions.js)
    const reason = await sessions.checkToken(decoded, user);
    if (reason) {
      return res.status(reason === "suspended" ? 403 : 401).json({
        success: false,
        code: reason === "suspended" ? "account_suspended" : "session_revoked",
        message: reason === "suspended" ? "This account is suspended. Contact support." : "You were signed out. Please sign in again.",
      });
    }

    req.user = user;
    req.auth = decoded;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ success: false, message: "Invalid token." });
    }
    if (error.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({ success: false, message: "Token has expired." });
    }
    res.status(500).json({ success: false, message: "Server error." });
  }
};

module.exports = { protect };
