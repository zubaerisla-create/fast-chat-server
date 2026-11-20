/**
 * The one entitlement resolver for every game: `games_lifetime`.
 *
 * Access comes from user_entitlements rows (source 'revenuecat' = Google Play via RevenueCat,
 * 'promo' = granted by an admin, 'owner' = the app owner). Any active row grants access. Game
 * code never checks purchases itself; it asks canAccessGameFeature / getGameAccess.
 *
 * The global daily limit (all games combined) is enforced here with one atomic UPSERT.
 */
const { query } = require("../config/db");
const { ENTITLEMENT } = require("../config/games");
const catalog = require("./gameCatalog");

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/** Active entitlement sources for a user, e.g. ['owner'] or ['revenuecat', 'promo']. */
async function entitlementSources(userId, entitlement = ENTITLEMENT) {
  const { rows } = await query(`SELECT source FROM user_entitlements WHERE user_id = $1 AND entitlement = $2 AND status = 'active'`, [userId, entitlement]);
  return rows.map((r) => r.source);
}

async function hasGamesLifetime(userId) {
  return (await entitlementSources(userId)).length > 0;
}

async function quotaFor(userId, { unlimited } = {}) {
  const settings = await catalog.getSettings();
  const limit = Number(settings.daily_match_limit) || 0;
  if (unlimited) return { limit: null, used: null, remaining: null, resetsAt: nextResetIso() };
  const { rows } = await query(`SELECT count FROM global_daily_match_usage WHERE user_id = $1 AND day = $2`, [userId, utcDay()]);
  const used = rows[0] ? rows[0].count : 0;
  return { limit, used, remaining: Math.max(0, limit - used), resetsAt: nextResetIso() };
}

function nextResetIso() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

/** Everything the app needs to render the Games section for one user. */
async function getAccess(userId) {
  const sources = await entitlementSources(userId);
  const lifetime = sources.length > 0;
  return {
    entitlement: ENTITLEMENT,
    lifetime,
    sources,
    owner: sources.includes("owner"),
    quota: await quotaFor(userId, { unlimited: lifetime }),
  };
}

/** Feature check for one game. Unknown / disabled features and unavailable games are denied. */
async function canAccessGameFeature(userId, gameId, featureId, { lifetime } = {}) {
  const game = await catalog.getGame(gameId);
  if (!game || game.status === "disabled" || game.status === "maintenance") return false;
  const tier = catalog.featureTier(game, featureId);
  if (tier === null) return false;
  if (tier === "free") return true;
  return lifetime !== undefined ? lifetime : hasGamesLifetime(userId);
}

/** Per-game summary: which features this user has. */
async function getGameAccess(userId, gameId) {
  const game = await catalog.getGame(gameId);
  if (!game) return null;
  const lifetime = await hasGamesLifetime(userId);
  const features = {};
  for (const [id, feat] of Object.entries(game.features || {})) {
    if (feat.enabled === false) continue;
    features[id] = { label: feat.label, tier: feat.tier, unlocked: feat.tier !== "premium" || lifetime };
  }
  return { gameId, status: game.status, available: game.status === "active" || game.status === "hidden", lifetime, features };
}

/**
 * Consumes one match creation for a free user, atomically: the row is only incremented while
 * it is below the limit, so concurrent creations can never exceed it. Returns
 * { ok, remaining } — ok:false when the limit is reached. Lifetime users are not counted.
 */
async function consumeMatchCreation(userId) {
  if (await hasGamesLifetime(userId)) return { ok: true, remaining: null, unlimited: true };
  const limit = Number((await catalog.getSettings()).daily_match_limit) || 0;
  if (limit <= 0) return { ok: false, remaining: 0 };
  const { rows } = await query(
    `INSERT INTO global_daily_match_usage (user_id, day, count) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = global_daily_match_usage.count + 1
       WHERE global_daily_match_usage.count < $3
     RETURNING count`,
    [userId, utcDay(), limit]
  );
  if (!rows.length) return { ok: false, remaining: 0 };
  return { ok: true, remaining: Math.max(0, limit - rows[0].count) };
}

/** Gives a creation back (e.g. the room could not be created after counting it). */
async function refundMatchCreation(userId) {
  await query(`UPDATE global_daily_match_usage SET count = GREATEST(0, count - 1) WHERE user_id = $1 AND day = $2`, [userId, utcDay()]);
}

/**
 * Rules for creating an online match (sending an invite). Returns null when allowed or an
 * error code: game_unavailable, premium_required, daily_limit. Accepting is never limited.
 */
async function authorizeOnlineInvite(userId, gameId, options = {}) {
  const game = await catalog.getGame(gameId);
  if (!game || !game.multiplayer || game.status === "disabled" || game.status === "maintenance") return "game_unavailable";
  const lifetime = await hasGamesLifetime(userId);
  const can = (featureId) => canAccessGameFeature(userId, gameId, featureId, { lifetime });
  if (!(await can("online_play"))) return lifetime ? "game_unavailable" : "premium_required";
  const cfg = game.config || {};
  // Premium match options, as configured for each game
  if (gameId === "chess" && Array.isArray(cfg.freeTimeControls) && !cfg.freeTimeControls.includes(options.time) && !(await can("time_all"))) return "premium_required";
  if (gameId === "carrom" && Array.isArray(cfg.freeTargets) && !cfg.freeTargets.includes(Number(options.target) || 0) && !(await can("long_matches"))) return "premium_required";
  if (gameId === "dots" && Array.isArray(cfg.freeSizes) && options.size !== undefined && !cfg.freeSizes.includes(Number(options.size)) && !(await can("grid_large"))) return "premium_required";
  if (!lifetime) {
    const q = await quotaFor(userId);
    if (q.remaining <= 0) return "daily_limit";
  }
  return null;
}

module.exports = {
  authorizeOnlineInvite,
  utcDay,
  entitlementSources,
  hasGamesLifetime,
  getAccess,
  canAccessGameFeature,
  getGameAccess,
  quotaFor,
  consumeMatchCreation,
  refundMatchCreation,
};
