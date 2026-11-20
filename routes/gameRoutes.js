const express = require("express");
const { rateLimit } = require("express-rate-limit");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const GameMatch = require("../models/GameMatch");
const catalog = require("../services/gameCatalog");
const access = require("../services/gameEntitlements");
const revenuecat = require("../services/revenuecat");
const { query } = require("../config/db");
const { REVENUECAT } = require("../config/games");

const FREE_HISTORY = 10;

// Win / loss / draw totals for multiplayer games against friends
router.get("/stats", protect, async (req, res, next) => {
  try {
    const userId = String(req.user._id);
    const known = (await catalog.listGames()).map((g) => g.id);
    const game = known.includes(req.query.game) ? req.query.game : null;
    const [stats, recent] = await Promise.all([GameMatch.statsFor(userId), GameMatch.recentFor(userId, 10, game)]);
    res.json({ success: true, stats, recent });
  } catch (error) {
    next(error);
  }
});

const publicGame = (g) => ({
  id: g.id,
  name: g.name,
  description: g.description,
  icon: g.icon,
  status: g.status,
  modes: g.modes,
  multiplayer: g.multiplayer,
  ai: g.ai,
  features: Object.fromEntries(Object.entries(g.features || {}).filter(([, f]) => f.enabled !== false).map(([id, f]) => [id, { label: f.label, tier: f.tier }])),
  config: g.config,
});

/** GET /api/games/catalog — the game library (no hidden / disabled games), for everyone. */
router.get("/catalog", async (req, res, next) => {
  try {
    const games = (await catalog.listGames()).filter((g) => g.status === "active" || g.status === "maintenance").map(publicGame);
    const settings = await catalog.getSettings();
    res.json({ success: true, games, purchase: settings.purchase_display, announcement: settings.announcement?.active ? settings.announcement : null, revenuecat: REVENUECAT });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/games/access — the signed-in user's Games Lifetime status, global daily quota and
 * which features are unlocked in every game (one entitlement for the whole library).
 */
router.get("/access", protect, async (req, res, next) => {
  try {
    const userId = String(req.user._id);
    const a = await access.getAccess(userId);
    const games = {};
    for (const g of await catalog.listGames()) {
      if (g.status === "disabled") continue;
      const ga = await access.getGameAccess(userId, g.id);
      games[g.id] = { status: g.status, features: Object.fromEntries(Object.entries(ga.features).map(([id, f]) => [id, f.unlocked])) };
    }
    res.json({ success: true, ...a, games, billingConfigured: revenuecat.isConfigured() });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/games/purchases/sync — called by the app after a purchase / restore: the server asks
 * RevenueCat (never trusts the app) and updates the entitlement.
 */
const syncLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, keyGenerator: (req) => `rc-sync:${req.user?._id}`, standardHeaders: "draft-7", legacyHeaders: false, message: { success: false, message: "Too many requests." } });
router.post("/purchases/sync", protect, syncLimiter, async (req, res, next) => {
  try {
    const userId = String(req.user._id);
    if (!revenuecat.isConfigured()) return res.status(503).json({ success: false, code: "billing_unavailable", message: "Purchases are not available right now." });
    await revenuecat.reconcileUser(userId);
    res.json({ success: true, ...(await access.getAccess(userId)) });
  } catch (error) {
    if (error.code === "billing_upstream") return res.status(502).json({ success: false, code: error.code, message: "Couldn't reach the store. Try again." });
    next(error);
  }
});

/** GET /api/games/history?game=&before= — free: latest 10 matches; Games Lifetime: full history. */
router.get("/history", protect, async (req, res, next) => {
  try {
    const userId = String(req.user._id);
    const lifetime = await access.hasGamesLifetime(userId);
    const known = (await catalog.listGames()).map((g) => g.id);
    const game = known.includes(req.query.game) ? req.query.game : null;
    const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
    if (!lifetime && before) return res.status(403).json({ success: false, code: "premium_required", message: "Full match history is part of Games Lifetime." });
    const limit = lifetime ? Math.min(50, Number(req.query.limit) || 30) : FREE_HISTORY;
    const { rows } = await query(
      `SELECT m.id, m.game, m.winner_id, m.reason, m.ended_at, m.duration_ms, m.moves,
              CASE WHEN m.player_a = $1 THEN m.score_a ELSE m.score_b END AS my_score,
              CASE WHEN m.player_a = $1 THEN m.score_b ELSE m.score_a END AS their_score,
              u.id AS opponent_id, u.username AS opponent_username, u.avatar AS opponent_avatar
         FROM game_matches m
         LEFT JOIN users u ON u.id = CASE WHEN m.player_a = $1 THEN m.player_b ELSE m.player_a END
        WHERE (m.player_a = $1 OR m.player_b = $1) AND m.status = 'completed'
          AND ($2::text IS NULL OR m.game = $2) AND ($3::timestamptz IS NULL OR m.ended_at < $3)
        ORDER BY m.ended_at DESC LIMIT $4`,
      [userId, game, before, limit + 1]
    );
    const more = rows.length > limit;
    res.json({
      success: true,
      full: lifetime,
      hasMore: lifetime ? more : false,
      lockedOlder: !lifetime && more,
      matches: rows.slice(0, limit).map((r) => ({
        id: r.id,
        game: r.game,
        result: r.winner_id === null ? "draw" : r.winner_id === userId ? "win" : "loss",
        reason: r.reason,
        myScore: r.my_score,
        theirScore: r.their_score,
        moves: r.moves,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        opponent: r.opponent_id ? { id: r.opponent_id, username: r.opponent_username, avatar: r.opponent_avatar } : null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/** POST /api/games/reports — report the opponent of a match you played. */
const REPORT_REASONS = ["cheating", "abuse", "afk", "bug", "other"];
const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, keyGenerator: (req) => `game-report:${req.user?._id}`, standardHeaders: "draft-7", legacyHeaders: false, message: { success: false, message: "Too many reports." } });
router.post("/reports", protect, reportLimiter, async (req, res, next) => {
  try {
    const userId = String(req.user._id);
    const { roomId, reason, details } = req.body || {};
    if (!REPORT_REASONS.includes(reason) || !revenuecat.UUID_RE.test(String(roomId || ""))) return res.status(400).json({ success: false, message: "Choose a reason." });
    // Only players of that match can report it
    const { rows } = await query(`SELECT game, player_a, player_b FROM game_matches WHERE room_id = $1 AND (player_a = $2 OR player_b = $2) ORDER BY match_no DESC LIMIT 1`, [roomId, userId]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Match not found." });
    const m = rows[0];
    await query(`INSERT INTO game_reports (reporter_id, reported_id, game, room_id, reason, details) VALUES ($1, $2, $3, $4, $5, $6)`, [
      userId,
      m.player_a === userId ? m.player_b : m.player_a,
      m.game,
      roomId,
      reason,
      typeof details === "string" ? details.slice(0, 1000) : null,
    ]);
    res.status(201).json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
