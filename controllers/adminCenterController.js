/**
 * Admin control center API (mounted at /api/admin-center). Every route is behind `protect` +
 * an admin role, and each handler is mapped to one permission in routes/adminCenterRoutes.js.
 * Every change is validated, written in a transaction where it touches several rows, and
 * audited (services/adminAudit.js).
 */
const { query, pool } = require("../config/db");
const User = require("../models/User");
const sessions = require("../services/sessions");
const catalog = require("../services/gameCatalog");
const access = require("../services/gameEntitlements");
const revenuecat = require("../services/revenuecat");
const { audit } = require("../services/adminAudit");
const { ROLES, roleOf, permissionsFor } = require("../services/adminRoles");
const { ENTITLEMENT, DEFAULT_SETTINGS } = require("../config/games");
const { getGameRooms } = require("../sockets/gameHandler");

const bad = (res, message, status = 400, code) => res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
const UUID_RE = revenuecat.UUID_RE;
const intIn = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};
const reasonOf = (req, required = true) => {
  const r = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (required && r.length < 3) return null;
  return r.slice(0, 500);
};
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (e) {
    next(e);
  }
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** POST /auth/login { email, password } — only accounts with an admin role get a session. */
const login = wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") return bad(res, "Email and password are required.");
  const user = await User.verifyPassword(email, password);
  if (!user) return bad(res, "Invalid email or password.", 401);
  if (user.status === "suspended") return bad(res, "This account is suspended.", 403);
  const role = await roleOf(user._id);
  if (!role) return bad(res, "This account has no admin access.", 403, "not_admin");
  const token = await sessions.issueToken(user._id, req, "admin");
  req.user = user; // not signed in yet on this request: attribute the audit entry to this admin
  await audit(req, { action: "admin.login", targetType: "admin", targetId: user._id });
  res.json({ success: true, token, user: { id: user._id, email: user.email, username: user.username }, role, permissions: permissionsFor(role) });
});

const me = wrap(async (req, res) => {
  res.json({ success: true, user: { id: req.user._id, email: req.user.email, username: req.user.username }, role: req.admin.role, permissions: req.admin.permissions });
});

// ─── Dashboard ───────────────────────────────────────────────────────────────

const one = async (sql, params = []) => (await query(sql, params)).rows[0];

const dashboard = wrap(async (req, res) => {
  const [users, dau, mau, lifetime, owners, purchases, revenue, refunds, matches, today, perGame, regs, rev, recentAudit, recentPurchases, recentUsers, notes] = await Promise.all([
    one(`SELECT COUNT(*)::int AS n FROM users`),
    one(`SELECT COUNT(*)::int AS n FROM user_activity_days WHERE day = (NOW() AT TIME ZONE 'UTC')::date`),
    one(`SELECT COUNT(DISTINCT user_id)::int AS n FROM user_activity_days WHERE day > (NOW() AT TIME ZONE 'UTC')::date - 30`),
    one(`SELECT COUNT(DISTINCT user_id)::int AS n FROM user_entitlements WHERE entitlement = $1 AND status = 'active'`, [ENTITLEMENT]),
    one(`SELECT COUNT(*)::int AS n FROM user_entitlements WHERE entitlement = $1 AND source = 'owner' AND status = 'active'`, [ENTITLEMENT]),
    one(`SELECT COUNT(*)::int AS n FROM purchase_records`),
    one(`SELECT COALESCE(SUM(price_usd), 0)::float AS n FROM purchase_records WHERE status = 'active' AND environment = 'PRODUCTION'`),
    one(`SELECT COUNT(*)::int AS n FROM purchase_records WHERE status IN ('refunded', 'revoked')`),
    one(`SELECT COUNT(*)::int AS n FROM game_matches WHERE status = 'completed'`),
    one(`SELECT COUNT(*)::int AS n FROM game_matches WHERE started_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`),
    query(`SELECT game, COUNT(*)::int AS matches FROM game_matches WHERE started_at > NOW() - interval '30 days' GROUP BY game ORDER BY matches DESC`),
    query(`SELECT to_char(d, 'YYYY-MM-DD') AS day, (SELECT COUNT(*)::int FROM users WHERE created_at >= d AND created_at < d + interval '1 day') AS n FROM generate_series((NOW() AT TIME ZONE 'UTC')::date - 29, (NOW() AT TIME ZONE 'UTC')::date, interval '1 day') d`),
    query(`SELECT to_char(d, 'YYYY-MM-DD') AS day, (SELECT COALESCE(SUM(price_usd), 0)::float FROM purchase_records WHERE status = 'active' AND environment = 'PRODUCTION' AND purchased_at >= d AND purchased_at < d + interval '1 day') AS n FROM generate_series((NOW() AT TIME ZONE 'UTC')::date - 29, (NOW() AT TIME ZONE 'UTC')::date, interval '1 day') d`),
    query(`SELECT l.id, l.action, l.target_type, l.target_id, l.created_at, u.username AS admin FROM admin_audit_logs l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.created_at DESC LIMIT 8`),
    query(`SELECT p.id, p.status, p.price_usd, p.purchased_at, u.username FROM purchase_records p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.purchased_at DESC LIMIT 5`),
    query(`SELECT id, username, created_at FROM users ORDER BY created_at DESC LIMIT 5`),
    query(`SELECT id, kind, title, created_at, read_at FROM admin_notifications ORDER BY created_at DESC LIMIT 5`),
  ]);
  const rooms = getGameRooms();
  const live = rooms ? rooms.listLive() : [];
  res.json({
    success: true,
    totals: {
      users: users.n,
      dau: dau.n,
      mau: mau.n,
      lifetimeUsers: lifetime.n,
      freeUsers: Math.max(0, users.n - lifetime.n),
      ownerAccounts: owners.n,
      purchases: purchases.n,
      revenueUsd: Math.round(revenue.n * 100) / 100,
      refunds: refunds.n,
      activeMatches: live.length,
      totalMatches: matches.n,
      gamesToday: today.n,
    },
    gameUsage: perGame.rows,
    charts: { registrations: regs.rows, revenue: rev.rows },
    recent: { audit: recentAudit.rows, purchases: recentPurchases.rows, users: recentUsers.rows, notifications: notes.rows },
  });
});

// ─── Users ───────────────────────────────────────────────────────────────────

const listUsers = wrap(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const status = ["active", "suspended"].includes(req.query.status) ? req.query.status : null;
  const tier = ["lifetime", "free"].includes(req.query.tier) ? req.query.tier : null;
  const limit = intIn(req.query.limit, 1, 100, 25);
  const offset = intIn(req.query.offset, 0, 1e6, 0);
  const { rows } = await query(
    `SELECT u.id, u.username, u.email, u.status, u.created_at, u.last_seen,
            EXISTS (SELECT 1 FROM user_entitlements e WHERE e.user_id = u.id AND e.entitlement = $5 AND e.status = 'active') AS lifetime,
            (SELECT array_agg(DISTINCT e.source) FROM user_entitlements e WHERE e.user_id = u.id AND e.entitlement = $5 AND e.status = 'active') AS sources,
            COUNT(*) OVER()::int AS total
       FROM users u
      WHERE ($1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%' OR u.id::text = $1)
        AND ($2::text IS NULL OR u.status = $2)
        AND ($6::text IS NULL OR ($6 = 'lifetime') = EXISTS (SELECT 1 FROM user_entitlements e WHERE e.user_id = u.id AND e.entitlement = $5 AND e.status = 'active'))
      ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`,
    [q, status, limit, offset, ENTITLEMENT, tier]
  );
  res.json({ success: true, total: rows[0]?.total ?? 0, users: rows.map(({ total, ...r }) => r) });
});

const getUser = wrap(async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) return bad(res, "Invalid user id.");
  const u = await one(`SELECT id, username, email, avatar, status, suspended_at, suspended_reason, created_at, last_seen, password_changed_at, role FROM users WHERE id = $1`, [id]);
  if (!u) return bad(res, "User not found.", 404);
  const [ents, purchases, sessionList, stats, activity, adminRole, gameAccess] = await Promise.all([
    query(`SELECT e.id, e.source, e.status, e.reference, e.note, e.granted_at, e.revoked_at, e.revoke_reason, g.username AS granted_by FROM user_entitlements e LEFT JOIN users g ON g.id = e.granted_by WHERE e.user_id = $1 ORDER BY e.granted_at DESC`, [id]),
    query(`SELECT id, product_id, store_transaction_id, environment, price, currency, price_usd, status, purchased_at, refunded_at FROM purchase_records WHERE user_id = $1 ORDER BY purchased_at DESC`, [id]),
    sessions.listSessions(id),
    query(
      `SELECT game, COUNT(*)::int AS played,
              COUNT(*) FILTER (WHERE winner_id = $1)::int AS wins,
              COUNT(*) FILTER (WHERE winner_id IS NOT NULL AND winner_id <> $1)::int AS losses,
              COUNT(*) FILTER (WHERE winner_id IS NULL)::int AS draws
         FROM game_matches WHERE (player_a = $1 OR player_b = $1) AND status = 'completed' GROUP BY game`,
      [id]
    ),
    query(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM user_activity_days WHERE user_id = $1 ORDER BY day DESC LIMIT 30`, [id]),
    roleOf(id),
    access.getAccess(id),
  ]);
  res.json({
    success: true,
    user: { ...u, adminRole },
    gameAccess,
    entitlements: ents.rows,
    purchases: purchases.rows,
    sessions: sessionList,
    gameStats: stats.rows,
    activeDays: activity.rows.map((r) => r.day),
  });
});

const suspendUser = wrap(async (req, res) => {
  const id = req.params.id;
  const reason = reasonOf(req);
  if (!UUID_RE.test(id)) return bad(res, "Invalid user id.");
  if (!reason) return bad(res, "A reason is required.");
  if (id === req.user._id) return bad(res, "You can't suspend your own account.");
  if ((await roleOf(id)) === "super_admin" && req.admin.role !== "super_admin") return bad(res, "Only a super admin can suspend a super admin.", 403);
  const prev = await one(`SELECT status FROM users WHERE id = $1`, [id]);
  if (!prev) return bad(res, "User not found.", 404);
  await query(`UPDATE users SET status = 'suspended', suspended_at = NOW(), suspended_reason = $2 WHERE id = $1`, [id, reason]);
  await sessions.revokeAll(id);
  await audit(req, { action: "user.suspend", targetType: "user", targetId: id, previous: { status: prev.status }, next: { status: "suspended" }, reason });
  res.json({ success: true });
});

const reactivateUser = wrap(async (req, res) => {
  const id = req.params.id;
  const reason = reasonOf(req);
  if (!UUID_RE.test(id)) return bad(res, "Invalid user id.");
  if (!reason) return bad(res, "A reason is required.");
  const prev = await one(`SELECT status FROM users WHERE id = $1`, [id]);
  if (!prev) return bad(res, "User not found.", 404);
  await query(`UPDATE users SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = $1`, [id]);
  await audit(req, { action: "user.reactivate", targetType: "user", targetId: id, previous: { status: prev.status }, next: { status: "active" }, reason });
  res.json({ success: true });
});

const revokeUserSessions = wrap(async (req, res) => {
  const id = req.params.id;
  const reason = reasonOf(req);
  if (!UUID_RE.test(id)) return bad(res, "Invalid user id.");
  if (!reason) return bad(res, "A reason is required.");
  if (req.params.sid) {
    if (!UUID_RE.test(req.params.sid)) return bad(res, "Invalid session id.");
    const ok = await sessions.revokeSession(id, req.params.sid);
    if (!ok) return bad(res, "Session not found.", 404);
  } else {
    await sessions.revokeAll(id);
  }
  await audit(req, { action: req.params.sid ? "user.session.revoke" : "user.sessions.revoke_all", targetType: "user", targetId: id, next: req.params.sid ? { session: req.params.sid } : null, reason });
  res.json({ success: true });
});

// ─── Entitlements (promo only; store purchases come from RevenueCat, owner is protected) ──

const grantPromo = wrap(async (req, res) => {
  const id = req.params.id;
  const reason = reasonOf(req);
  if (!UUID_RE.test(id)) return bad(res, "Invalid user id.");
  if (!reason) return bad(res, "A reason is required.");
  if (!(await one(`SELECT 1 AS x FROM users WHERE id = $1`, [id]))) return bad(res, "User not found.", 404);
  const prev = await one(`SELECT status FROM user_entitlements WHERE user_id = $1 AND entitlement = $2 AND source = 'promo'`, [id, ENTITLEMENT]);
  await query(
    `INSERT INTO user_entitlements (user_id, entitlement, source, status, note, granted_by)
     VALUES ($1, $2, 'promo', 'active', $3, $4)
     ON CONFLICT (user_id, entitlement, source) DO UPDATE
       SET status = 'active', note = EXCLUDED.note, granted_by = EXCLUDED.granted_by, granted_at = NOW(),
           revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL, updated_at = NOW()`,
    [id, ENTITLEMENT, reason, req.user._id]
  );
  await audit(req, { action: "entitlement.promo.grant", targetType: "user", targetId: id, previous: prev ? { promo: prev.status } : null, next: { promo: "active" }, reason });
  res.json({ success: true, access: await access.getAccess(id) });
});

const revokePromo = wrap(async (req, res) => {
  const id = req.params.id;
  const reason = reasonOf(req);
  if (!UUID_RE.test(id)) return bad(res, "Invalid user id.");
  if (!reason) return bad(res, "A reason is required.");
  if (req.body?.confirm !== true) return bad(res, "Confirm the revocation.");
  const { rowCount } = await query(
    `UPDATE user_entitlements SET status = 'revoked', revoked_at = NOW(), revoked_by = $3, revoke_reason = $4, updated_at = NOW()
      WHERE user_id = $1 AND entitlement = $2 AND source = 'promo' AND status = 'active'`,
    [id, ENTITLEMENT, req.user._id, reason]
  );
  if (!rowCount) return bad(res, "This user has no active promotional access.", 404);
  await audit(req, { action: "entitlement.promo.revoke", targetType: "user", targetId: id, previous: { promo: "active" }, next: { promo: "revoked" }, reason });
  res.json({ success: true, access: await access.getAccess(id) });
});

// ─── Purchases & webhooks ────────────────────────────────────────────────────

const listPurchases = wrap(async (req, res) => {
  const status = ["active", "refunded", "revoked", "transferred"].includes(req.query.status) ? req.query.status : null;
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
  const limit = intIn(req.query.limit, 1, 200, 50);
  const offset = intIn(req.query.offset, 0, 1e6, 0);
  const { rows } = await query(
    `SELECT p.id, p.user_id, u.username, u.email, p.rc_app_user_id, p.product_id, p.store, p.store_transaction_id, p.environment,
            p.price, p.currency, p.price_usd, p.status, p.purchased_at, p.refunded_at, COUNT(*) OVER()::int AS total
       FROM purchase_records p LEFT JOIN users u ON u.id = p.user_id
      WHERE ($1::text IS NULL OR p.status = $1)
        AND ($2 = '' OR p.store_transaction_id ILIKE '%' || $2 || '%' OR p.rc_app_user_id = $2 OR u.email ILIKE '%' || $2 || '%')
      ORDER BY p.purchased_at DESC LIMIT $3 OFFSET $4`,
    [status, q, limit, offset]
  );
  res.json({ success: true, total: rows[0]?.total ?? 0, purchases: rows.map(({ total, ...r }) => r), revenuecatConfigured: revenuecat.isConfigured() });
});

const listWebhooks = wrap(async (req, res) => {
  const status = ["received", "processed", "ignored", "failed"].includes(req.query.status) ? req.query.status : null;
  const { rows } = await query(
    `SELECT id, type, app_user_id, environment, status, error, received_at, processed_at FROM revenuecat_webhook_events
      WHERE ($1::text IS NULL OR status = $1) ORDER BY received_at DESC LIMIT $2`,
    [status, intIn(req.query.limit, 1, 200, 50)]
  );
  res.json({ success: true, events: rows });
});

const reconcile = wrap(async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) return bad(res, "Invalid user id.");
  if (!revenuecat.isConfigured()) return bad(res, "RevenueCat secret key is not configured on the server.", 503, "billing_unavailable");
  const before = await access.getAccess(id);
  const result = await revenuecat.reconcileUser(id);
  await audit(req, { action: "purchase.reconcile", targetType: "user", targetId: id, previous: { lifetime: before.lifetime }, next: result, reason: reasonOf(req, false) || null });
  res.json({ success: true, result, access: await access.getAccess(id) });
});

// ─── Games ───────────────────────────────────────────────────────────────────

const listGames = wrap(async (req, res) => {
  const games = await catalog.listGames();
  const usage = await query(`SELECT game, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE started_at > NOW() - interval '7 days')::int AS week FROM game_matches GROUP BY game`);
  const byGame = Object.fromEntries(usage.rows.map((r) => [r.game, r]));
  res.json({ success: true, entitlement: ENTITLEMENT, games: games.map((g) => ({ ...g, usage: byGame[g.id] || { total: 0, week: 0 } })) });
});

const STATUSES = ["active", "hidden", "maintenance", "disabled"];
const ICON_RE = /^[a-z0-9-]{2,60}$/;
const FEATURE_ID_RE = /^[a-z0-9_]{2,40}$/;

function cleanFeatures(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};
  for (const [id, f] of Object.entries(input)) {
    if (!FEATURE_ID_RE.test(id) || !f || typeof f !== "object") return null;
    if (typeof f.label !== "string" || !f.label.trim() || f.label.length > 120) return null;
    if (!["free", "premium"].includes(f.tier)) return null;
    out[id] = { label: f.label.trim(), tier: f.tier, enabled: f.enabled !== false };
  }
  return out;
}

const cleanJson = (v, maxLen = 4000) => {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return JSON.stringify(v).length <= maxLen ? v : null;
};

const updateGame = wrap(async (req, res) => {
  const id = req.params.id;
  const prev = await catalog.getGame(id);
  if (!prev) return bad(res, "Game not found.", 404);
  const b = req.body || {};
  const next = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 60) return bad(res, "Name must be 1–60 characters.");
    next.name = b.name.trim();
  }
  if (b.description !== undefined) {
    if (typeof b.description !== "string" || b.description.length > 300) return bad(res, "Description must be at most 300 characters.");
    next.description = b.description.trim();
  }
  if (b.icon !== undefined) {
    if (typeof b.icon !== "string" || !ICON_RE.test(b.icon)) return bad(res, "Icon must be an Ionicons name.");
    next.icon = b.icon;
  }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return bad(res, "Unknown status.");
    next.status = b.status;
  }
  if (b.sortOrder !== undefined) {
    const n = intIn(b.sortOrder, 0, 10000, null);
    if (n === null) return bad(res, "Sort order must be 0–10000.");
    next.sort_order = n;
  }
  if (b.features !== undefined) {
    const f = cleanFeatures(b.features);
    if (!f) return bad(res, "Invalid features.");
    // Built-in features can be switched between tiers or disabled, not removed (the app code uses them)
    if (prev.builtin) for (const fid of Object.keys(prev.features)) if (!f[fid]) return bad(res, `Feature ${fid} is built in and can't be removed (disable it instead).`);
    next.features = f;
  }
  if (b.config !== undefined) {
    const c = cleanJson(b.config);
    if (!c) return bad(res, "Invalid config.");
    next.config = c;
  }
  if (b.modes !== undefined) {
    if (!Array.isArray(b.modes) || b.modes.some((m) => typeof m !== "string" || !/^[a-z_]{2,20}$/.test(m)) || b.modes.length > 10) return bad(res, "Invalid modes.");
    next.modes = b.modes;
  }
  if (!Object.keys(next).length) return bad(res, "Nothing to change.");
  const reason = reasonOf(req, false);
  const sets = [];
  const vals = [id];
  for (const [k, v] of Object.entries(next)) {
    vals.push(typeof v === "object" ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}`);
  }
  await query(`UPDATE game_registry SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`, vals);
  catalog.invalidate();
  const pick = (g) => Object.fromEntries(Object.keys(next).map((k) => [k, g[k === "sort_order" ? "sortOrder" : k]]));
  await audit(req, { action: "game.update", targetType: "game", targetId: id, previous: pick(prev), next, reason });
  res.json({ success: true, game: await catalog.getGame(id) });
});

/** POST /games — registers a new game; it automatically uses the universal games_lifetime entitlement. */
const createGame = wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.id !== "string" || !/^[a-z0-9_]{2,32}$/.test(b.id)) return bad(res, "Id must be 2–32 lowercase letters, digits or _.");
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 60) return bad(res, "Name must be 1–60 characters.");
  if (await catalog.getGame(b.id)) return bad(res, "A game with this id already exists.", 409);
  const features = b.features === undefined ? {} : cleanFeatures(b.features);
  if (!features) return bad(res, "Invalid features.");
  const status = b.status === undefined ? "hidden" : b.status;
  if (!STATUSES.includes(status)) return bad(res, "Unknown status.");
  const icon = b.icon === undefined ? "game-controller-outline" : b.icon;
  if (!ICON_RE.test(icon)) return bad(res, "Icon must be an Ionicons name.");
  await query(
    `INSERT INTO game_registry (id, name, description, icon, status, sort_order, modes, multiplayer, ai, features, config, builtin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE)`,
    [b.id, b.name.trim(), typeof b.description === "string" ? b.description.slice(0, 300) : "", icon, status, intIn(b.sortOrder, 0, 10000, 500), JSON.stringify(Array.isArray(b.modes) ? b.modes.slice(0, 10) : []), b.multiplayer === true, b.ai === true, JSON.stringify(features), JSON.stringify(cleanJson(b.config) || {})]
  );
  catalog.invalidate();
  await audit(req, { action: "game.create", targetType: "game", targetId: b.id, next: { name: b.name, status, features }, reason: reasonOf(req, false) });
  res.status(201).json({ success: true, game: await catalog.getGame(b.id) });
});

// ─── Matches & reports ───────────────────────────────────────────────────────

const listMatches = wrap(async (req, res) => {
  const known = (await catalog.listGames()).map((g) => g.id);
  const game = known.includes(req.query.game) ? req.query.game : null;
  const status = ["waiting_for_players", "in_progress", "completed", "cancelled", "abandoned"].includes(req.query.status) ? req.query.status : null;
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const limit = intIn(req.query.limit, 1, 200, 50);
  const offset = intIn(req.query.offset, 0, 1e6, 0);
  const { rows } = await query(
    `SELECT m.id, m.game, m.room_id, m.match_no, m.status, m.reason, m.score_a, m.score_b, m.moves, m.started_at, m.ended_at, m.duration_ms,
            a.username AS player_a, b.username AS player_b, w.username AS winner, COUNT(*) OVER()::int AS total
       FROM game_matches m
       LEFT JOIN users a ON a.id = m.player_a LEFT JOIN users b ON b.id = m.player_b LEFT JOIN users w ON w.id = m.winner_id
      WHERE ($1::text IS NULL OR m.game = $1) AND ($2::text IS NULL OR m.status = $2)
        AND ($3 = '' OR a.username ILIKE '%' || $3 || '%' OR b.username ILIKE '%' || $3 || '%' OR a.email ILIKE '%' || $3 || '%' OR b.email ILIKE '%' || $3 || '%' OR m.room_id::text = $3)
      ORDER BY m.started_at DESC LIMIT $4 OFFSET $5`,
    [game, status, q, limit, offset]
  );
  const rooms = getGameRooms();
  res.json({ success: true, total: rows[0]?.total ?? 0, matches: rows.map(({ total, ...r }) => r), live: rooms ? rooms.listLive() : [] });
});

const getMatch = wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, "Invalid match id.");
  const m = await one(`SELECT * FROM game_matches WHERE id = $1`, [req.params.id]);
  if (!m) return bad(res, "Match not found.", 404);
  const actions = await query(`SELECT seq, player_id, action, created_at FROM game_match_actions WHERE match_id = $1 ORDER BY seq LIMIT 1000`, [m.id]);
  res.json({ success: true, match: m, actions: actions.rows });
});

const cancelMatch = wrap(async (req, res) => {
  const roomId = req.params.roomId;
  const reason = reasonOf(req);
  if (!UUID_RE.test(roomId)) return bad(res, "Invalid room id.");
  if (!reason) return bad(res, "A reason is required.");
  const rooms = getGameRooms();
  if (!rooms) return bad(res, "Game server not running.", 503);
  try {
    rooms.adminCancel(roomId);
  } catch {
    return bad(res, "No live match with this id.", 404);
  }
  await audit(req, { action: "match.cancel", targetType: "match", targetId: roomId, next: { status: "cancelled" }, reason });
  res.json({ success: true });
});

const listReports = wrap(async (req, res) => {
  const status = ["open", "reviewed", "dismissed"].includes(req.query.status) ? req.query.status : null;
  const { rows } = await query(
    `SELECT r.id, r.game, r.room_id, r.reason, r.details, r.status, r.created_at, a.username AS reporter, b.username AS reported, r.reported_id
       FROM game_reports r LEFT JOIN users a ON a.id = r.reporter_id LEFT JOIN users b ON b.id = r.reported_id
      WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at DESC LIMIT 100`,
    [status]
  );
  res.json({ success: true, reports: rows });
});

const updateReport = wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, "Invalid report id.");
  const status = req.body?.status;
  if (!["open", "reviewed", "dismissed"].includes(status)) return bad(res, "Unknown status.");
  const prev = await one(`SELECT status FROM game_reports WHERE id = $1`, [req.params.id]);
  if (!prev) return bad(res, "Report not found.", 404);
  await query(`UPDATE game_reports SET status = $2, reviewed_by = $3 WHERE id = $1`, [req.params.id, status, req.user._id]);
  await audit(req, { action: "report.update", targetType: "game_report", targetId: req.params.id, previous: prev, next: { status }, reason: reasonOf(req, false) });
  res.json({ success: true });
});

// ─── Analytics ───────────────────────────────────────────────────────────────

const analytics = wrap(async (req, res) => {
  const days = intIn(req.query.days, 7, 365, 30);
  const [perGame, dau, revenue, completion, devices, tiers, buyers, users] = await Promise.all([
    query(`SELECT game, COUNT(*)::int AS matches, COUNT(*) FILTER (WHERE status = 'completed')::int AS completed FROM game_matches WHERE started_at > NOW() - ($1 || ' days')::interval GROUP BY game ORDER BY matches DESC`, [String(days)]),
    query(`SELECT to_char(d, 'YYYY-MM-DD') AS day, (SELECT COUNT(*)::int FROM user_activity_days a WHERE a.day = d::date) AS n FROM generate_series((NOW() AT TIME ZONE 'UTC')::date - ($1::int - 1), (NOW() AT TIME ZONE 'UTC')::date, interval '1 day') d`, [days]),
    query(`SELECT to_char(d, 'YYYY-MM-DD') AS day, (SELECT COALESCE(SUM(price_usd), 0)::float FROM purchase_records WHERE status = 'active' AND environment = 'PRODUCTION' AND purchased_at >= d AND purchased_at < d + interval '1 day') AS n, (SELECT COUNT(*)::int FROM purchase_records WHERE purchased_at >= d AND purchased_at < d + interval '1 day') AS purchases FROM generate_series((NOW() AT TIME ZONE 'UTC')::date - ($1::int - 1), (NOW() AT TIME ZONE 'UTC')::date, interval '1 day') d`, [days]),
    one(`SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed, COUNT(*) FILTER (WHERE status IN ('cancelled', 'abandoned'))::int AS unfinished FROM game_matches WHERE started_at > NOW() - ($1 || ' days')::interval`, [String(days)]),
    query(`SELECT COALESCE(platform, 'unknown') AS platform, COUNT(DISTINCT user_id)::int AS users FROM user_sessions WHERE last_used_at > NOW() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 2 DESC`, [String(days)]),
    query(`SELECT source, COUNT(DISTINCT user_id)::int AS users FROM user_entitlements WHERE entitlement = $1 AND status = 'active' GROUP BY source`, [ENTITLEMENT]),
    one(`SELECT COUNT(DISTINCT user_id)::int AS n FROM purchase_records WHERE status = 'active'`),
    one(`SELECT COUNT(*)::int AS n FROM users`),
  ]);
  const players = await one(`SELECT COUNT(DISTINCT p)::int AS n FROM (SELECT player_a AS p FROM game_matches WHERE started_at > NOW() - interval '30 days' UNION SELECT player_b FROM game_matches WHERE started_at > NOW() - interval '30 days') x`);
  const playersToday = await one(`SELECT COUNT(DISTINCT p)::int AS n FROM (SELECT player_a AS p FROM game_matches WHERE started_at >= date_trunc('day', NOW()) UNION SELECT player_b FROM game_matches WHERE started_at >= date_trunc('day', NOW())) x`);
  // A user can hold several sources (e.g. promo + purchase): count people, not rows
  const lifetimeUsers = (await one(`SELECT COUNT(DISTINCT user_id)::int AS n FROM user_entitlements WHERE entitlement = $1 AND status = 'active'`, [ENTITLEMENT])).n;
  const total = completion.completed + completion.unfinished;
  res.json({
    success: true,
    days,
    perGame: perGame.rows,
    totalMatches: perGame.rows.reduce((n, r) => n + r.matches, 0),
    dau: dau.rows,
    revenue: revenue.rows,
    completionRate: total ? completion.completed / total : null,
    devices: devices.rows,
    lifetimeBySource: tiers.rows,
    freeVsLifetime: { free: Math.max(0, users.n - lifetimeUsers), lifetime: lifetimeUsers },
    conversionRate: users.n ? buyers.n / users.n : 0,
    players: { today: playersToday.n, monthly: players.n },
  });
});

// ─── Settings ────────────────────────────────────────────────────────────────

const getSettings = wrap(async (req, res) => {
  res.json({ success: true, settings: await catalog.getSettings() });
});

function validateSetting(key, value) {
  if (key === "daily_match_limit") return Number.isInteger(value) && value >= 0 && value <= 1000 ? value : undefined;
  if (key === "purchase_display") {
    if (!value || typeof value !== "object") return undefined;
    const { title, subtitle, enabled } = value;
    if (typeof title !== "string" || !title.trim() || title.length > 60) return undefined;
    if (typeof subtitle !== "string" || subtitle.length > 120) return undefined;
    return { title: title.trim(), subtitle: subtitle.trim(), targetPriceUsd: DEFAULT_SETTINGS.purchase_display.targetPriceUsd, enabled: enabled !== false };
  }
  if (key === "announcement") {
    if (!value || typeof value !== "object") return undefined;
    const { text, tone, active } = value;
    if (typeof text !== "string" || text.length > 280) return undefined;
    if (!["info", "warning", "success"].includes(tone)) return undefined;
    return { text: text.trim(), tone, active: active === true && text.trim().length > 0 };
  }
  return undefined;
}

const updateSetting = wrap(async (req, res) => {
  const key = req.params.key;
  const value = validateSetting(key, req.body?.value);
  if (value === undefined) return bad(res, "Invalid value for this setting.");
  const prev = (await catalog.getSettings())[key];
  await query(`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`, [key, JSON.stringify(value), req.user._id]);
  catalog.invalidate();
  await audit(req, { action: "setting.update", targetType: "setting", targetId: key, previous: prev ?? null, next: value, reason: reasonOf(req, false) });
  res.json({ success: true, value });
});

// ─── Audit, notifications, admins ────────────────────────────────────────────

const auditLog = wrap(async (req, res) => {
  const before = req.query.before && /^\d+$/.test(req.query.before) ? Number(req.query.before) : null;
  const { rows } = await query(
    `SELECT l.*, u.username AS admin_username, u.email AS admin_email FROM admin_audit_logs l LEFT JOIN users u ON u.id = l.admin_id
      WHERE ($1::bigint IS NULL OR l.id < $1) AND ($2::text IS NULL OR l.target_type = $2) ORDER BY l.id DESC LIMIT $3`,
    [before, typeof req.query.targetType === "string" ? req.query.targetType.slice(0, 30) : null, intIn(req.query.limit, 1, 200, 50)]
  );
  res.json({ success: true, entries: rows });
});

const notifications = wrap(async (req, res) => {
  const { rows } = await query(`SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 50`);
  res.json({ success: true, notifications: rows, unread: rows.filter((r) => !r.read_at).length });
});

const readNotifications = wrap(async (req, res) => {
  await query(`UPDATE admin_notifications SET read_at = NOW() WHERE read_at IS NULL`);
  res.json({ success: true });
});

const listAdmins = wrap(async (req, res) => {
  const { rows } = await query(`SELECT a.user_id, a.role, a.created_at, u.username, u.email, u.status FROM admin_users a JOIN users u ON u.id = a.user_id ORDER BY a.created_at`);
  res.json({ success: true, admins: rows, roles: ROLES });
});

const setAdminRole = wrap(async (req, res) => {
  const id = req.params.userId;
  const role = req.body?.role;
  const reason = reasonOf(req);
  if (!UUID_RE.test(id)) return bad(res, "Invalid user id.");
  if (!reason) return bad(res, "A reason is required.");
  if (role !== null && !ROLES.includes(role)) return bad(res, "Unknown role.");
  if (id === req.user._id) return bad(res, "You can't change your own role.");
  if (!(await one(`SELECT 1 AS x FROM users WHERE id = $1`, [id]))) return bad(res, "User not found.", 404);
  const prev = await one(`SELECT role FROM admin_users WHERE user_id = $1`, [id]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (role === null) await client.query(`DELETE FROM admin_users WHERE user_id = $1`, [id]);
    else await client.query(`INSERT INTO admin_users (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = NOW()`, [id, role, req.user._id]);
    const supers = await client.query(`SELECT COUNT(*)::int AS n FROM admin_users WHERE role = 'super_admin'`);
    if (supers.rows[0].n < 1) throw Object.assign(new Error("last_super_admin"), { code: "last_super_admin" });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e.code === "last_super_admin") return bad(res, "There must always be at least one super admin.");
    throw e;
  } finally {
    client.release();
  }
  // A removed admin's admin sessions end immediately
  if (role === null) await query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND kind = 'admin' AND revoked_at IS NULL`, [id]);
  await audit(req, { action: "admin.role", targetType: "admin", targetId: id, previous: prev ? { role: prev.role } : null, next: { role }, reason });
  res.json({ success: true });
});

module.exports = {
  login,
  me,
  dashboard,
  listUsers,
  getUser,
  suspendUser,
  reactivateUser,
  revokeUserSessions,
  grantPromo,
  revokePromo,
  listPurchases,
  listWebhooks,
  reconcile,
  listGames,
  updateGame,
  createGame,
  listMatches,
  getMatch,
  cancelMatch,
  listReports,
  updateReport,
  analytics,
  getSettings,
  updateSetting,
  auditLog,
  notifications,
  readNotifications,
  listAdmins,
  setAdminRole,
};
