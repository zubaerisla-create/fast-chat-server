/**
 * Admin control center authorization: a signed-in user with an admin role whose role grants
 * the permission (services/adminRoles.js). Use after `protect`.
 */
const { roleOf, permissionsFor } = require("../services/adminRoles");

const loadAdmin = async (req, res, next) => {
  try {
    const role = await roleOf(req.user._id);
    if (!role) return res.status(403).json({ success: false, code: "not_admin", message: "This account has no admin access." });
    req.admin = { role, permissions: permissionsFor(role) };
    next();
  } catch (error) {
    next(error);
  }
};

const can = (permission) => (req, res, next) => {
  if (!req.admin || !req.admin.permissions.includes(permission)) {
    return res.status(403).json({ success: false, code: "forbidden", message: "Your admin role can't do this." });
  }
  next();
};

module.exports = { loadAdmin, can };
