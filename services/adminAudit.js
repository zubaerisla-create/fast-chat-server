/** Audit log for every sensitive admin control center action (admin_audit_logs). */
const { query } = require("../config/db");
const { clientIp } = require("./sessions");

async function audit(req, { action, targetType, targetId = null, previous = null, next = null, reason = null }) {
  await query(
    `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, previous, next, reason, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      req.user ? req.user._id : null,
      action,
      targetType,
      targetId === null ? null : String(targetId).slice(0, 120),
      previous === null ? null : JSON.stringify(previous),
      next === null ? null : JSON.stringify(next),
      reason ? String(reason).slice(0, 500) : null,
      clientIp(req),
      typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 300) : null,
    ]
  );
}

module.exports = { audit };
