/**
 * Login sessions. Every token carries a session id (`sid`) backed by a user_sessions row, so
 * a single device can be signed out (and an admin can revoke sessions). Tokens issued before
 * users.sessions_revoked_at (password change, "sign out everywhere", suspension) stop working.
 *
 * Tokens issued before sessions existed have no `sid`; they stay valid until they expire,
 * unless a revoke-all happens after they were issued.
 */
const jwt = require("jsonwebtoken");
const { query } = require("../config/db");

const ttl = () => process.env.JWT_EXPIRES_IN || "7d";
const ttlMs = () => {
  const m = /^(\d+)([smhd])$/.exec(ttl());
  if (!m) return 7 * 86400000;
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
};

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
const clientIp = (req) => clip((req && (req.headers?.["cf-connecting-ip"] || req.ip)) || null, 64);

function describeDevice(req) {
  const h = (req && req.headers) || {};
  const ua = clip(h["user-agent"], 300);
  const platform = clip(h["x-client-platform"], 20) || (/android/i.test(ua || "") ? "android" : /iphone|ipad/i.test(ua || "") ? "ios" : /okhttp|expo/i.test(ua || "") ? "app" : "web");
  return { userAgent: ua, platform, deviceName: clip(h["x-device-name"], 120) };
}

/** Creates a session and returns a signed token for it. */
async function issueToken(userId, req, kind = "app") {
  const d = describeDevice(req);
  const { rows } = await query(
    `INSERT INTO user_sessions (user_id, kind, device_name, platform, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' milliseconds')::interval) RETURNING id`,
    [userId, kind, d.deviceName, d.platform, d.userAgent, clientIp(req), String(ttlMs())]
  );
  return jwt.sign({ id: userId, sid: rows[0].id }, process.env.JWT_SECRET, { expiresIn: ttl() });
}

/** Rotates a token: same session, fresh expiry. */
async function rotateToken(decoded) {
  await query(`UPDATE user_sessions SET expires_at = NOW() + ($2 || ' milliseconds')::interval, last_used_at = NOW() WHERE id = $1`, [decoded.sid, String(ttlMs())]);
  return jwt.sign({ id: decoded.id, sid: decoded.sid }, process.env.JWT_SECRET, { expiresIn: ttl() });
}

const touched = new Map(); // sid → last time last_used_at was written (throttle DB writes)
const activeToday = new Map(); // userId → UTC day already recorded

/**
 * Validates a verified JWT payload against the session table and the user row.
 * Returns null when OK, or a reason string.
 */
async function checkToken(decoded, user) {
  if (!user) return "user_not_found";
  if (user.status === "suspended") return "suspended";
  if (user.sessionsRevokedAt && decoded.iat && decoded.iat * 1000 < new Date(user.sessionsRevokedAt).getTime() - 999) return "session_revoked";
  if (decoded.sid) {
    const { rows } = await query(`SELECT revoked_at, expires_at FROM user_sessions WHERE id = $1 AND user_id = $2`, [decoded.sid, user._id]);
    const s = rows[0];
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) return "session_revoked";
    const now = Date.now();
    if ((touched.get(decoded.sid) || 0) < now - 5 * 60000) {
      touched.set(decoded.sid, now);
      query(`UPDATE user_sessions SET last_used_at = NOW() WHERE id = $1`, [decoded.sid]).catch(() => {});
    }
  }
  const day = new Date().toISOString().slice(0, 10);
  if (activeToday.get(user._id) !== day) {
    activeToday.set(user._id, day);
    query(`INSERT INTO user_activity_days (user_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user._id, day]).catch(() => {});
  }
  return null;
}

async function listSessions(userId) {
  const { rows } = await query(
    `SELECT id, kind, device_name, platform, user_agent, ip, created_at, last_used_at, expires_at
       FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY last_used_at DESC LIMIT 50`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, deviceName: r.device_name, platform: r.platform, userAgent: r.user_agent, ip: r.ip, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at }));
}

async function revokeSession(userId, sessionId) {
  const { rowCount } = await query(`UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [sessionId, userId]);
  return rowCount > 0;
}

/** Signs out every device (optionally keeping one session, e.g. the one changing the password). */
async function revokeAll(userId, { exceptSid = null } = {}) {
  await query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [userId, exceptSid]);
  // Legacy tokens without a session id are cut off by time; keep the current session usable
  if (!exceptSid) await query(`UPDATE users SET sessions_revoked_at = NOW() WHERE id = $1`, [userId]);
}

module.exports = { issueToken, rotateToken, checkToken, listSessions, revokeSession, revokeAll, describeDevice, clientIp };
