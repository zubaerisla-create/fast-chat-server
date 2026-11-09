const { query } = require("../config/db");

/** Records an audit event; never throws (auditing must not block the action). */
async function audit(req, action, { targetType = null, targetId = null, workspaceId = null, metadata = {} } = {}) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, workspace_id, metadata, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req?.user?._id || null, action, targetType, targetId ? String(targetId) : null, workspaceId, JSON.stringify(metadata), req?.ip?.slice(0, 64) || null]
    );
  } catch (error) {
    console.error(`[Audit] ${action} not recorded:`, error.message);
  }
}

module.exports = { audit };
