/**
 * Admin control center roles and the permission matrix enforced by middleware/adminAuth.js,
 * plus owner provisioning.
 *
 * Roles live in admin_users (never derived from an email a client sends). Accounts with the
 * older users.role = 'admin' are treated as role 'admin'. There is no public admin sign-up:
 * the first super admin is created by scripts/provision-owner.js (or OWNER_USER_ID at startup).
 */
const { query, pool } = require("../config/db");
const { ENTITLEMENT } = require("../config/games");

const ROLES = ["super_admin", "admin", "support", "game_manager", "analyst"];
const ALL = [
  "dashboard.read",
  "analytics.read",
  "users.read",
  "users.manage",
  "entitlements.manage",
  "purchases.read",
  "purchases.reconcile",
  "games.read",
  "games.manage",
  "matches.read",
  "matches.manage",
  "reports.manage",
  "settings.read",
  "settings.manage",
  "audit.read",
  "notifications.read",
  "admins.manage",
];

const PERMISSIONS = {
  super_admin: ALL,
  admin: ALL.filter((p) => p !== "admins.manage"),
  support: ["dashboard.read", "users.read", "users.manage", "purchases.read", "games.read", "matches.read", "reports.manage", "notifications.read"],
  game_manager: ["dashboard.read", "analytics.read", "games.read", "games.manage", "matches.read", "matches.manage", "reports.manage", "settings.read", "settings.manage"],
  analyst: ["dashboard.read", "analytics.read", "games.read", "matches.read", "purchases.read", "settings.read"],
};

async function roleOf(userId) {
  const { rows } = await query(`SELECT a.role AS admin_role, u.role AS legacy FROM users u LEFT JOIN admin_users a ON a.user_id = u.id WHERE u.id = $1`, [userId]);
  if (!rows.length) return null;
  return rows[0].admin_role || (rows[0].legacy === "admin" ? "admin" : null);
}

const permissionsFor = (role) => (role && PERMISSIONS[role]) || [];

/**
 * Makes `userId` the owner: permanent Games Lifetime (source 'owner', protected by a DB
 * trigger) and super admin. Idempotent. Binds to the immutable user id.
 */
async function provisionOwner(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT id, email FROM users WHERE id = $1`, [userId]);
    if (!rows.length) throw new Error(`No user with id ${userId}`);
    await client.query(
      `INSERT INTO user_entitlements (user_id, entitlement, source, status, note)
       VALUES ($1, $2, 'owner', 'active', 'App owner — permanent access')
       ON CONFLICT (user_id, entitlement, source) DO NOTHING`,
      [userId, ENTITLEMENT]
    );
    await client.query(
      `INSERT INTO admin_users (user_id, role) VALUES ($1, 'super_admin')
       ON CONFLICT (user_id) DO UPDATE SET role = 'super_admin', updated_at = NOW()`,
      [userId]
    );
    await client.query("COMMIT");
    return { id: rows[0].id, email: rows[0].email };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { ROLES, PERMISSIONS, ALL_PERMISSIONS: ALL, roleOf, permissionsFor, provisionOwner };
