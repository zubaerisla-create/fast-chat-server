/**
 * Game catalog + app settings, backed by PostgreSQL (game_registry, app_settings) with a short
 * in-process cache. Built-in games from config/games.js are inserted when missing and their
 * newly added features are merged in, but admin edits (status, texts, tiers) are never overwritten.
 */
const { query } = require("../config/db");
const { BUILTIN_GAMES, DEFAULT_SETTINGS } = require("../config/games");

const TTL_MS = 15000;
let gamesCache = null;
let settingsCache = null;
let synced = null; // promise of the first syncBuiltins() in this process

async function syncBuiltins() {
  for (const g of BUILTIN_GAMES) {
    await query(
      `INSERT INTO game_registry (id, name, description, icon, status, sort_order, modes, multiplayer, ai, features, config, builtin)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, TRUE)
       ON CONFLICT (id) DO UPDATE
         SET features = EXCLUDED.features || game_registry.features, -- new built-in features appear; admin tiers win
             builtin = TRUE`,
      [g.id, g.name, g.description, g.icon, g.sort_order, JSON.stringify(g.modes), g.multiplayer, g.ai, JSON.stringify(g.features), JSON.stringify(g.config)]
    );
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, JSON.stringify(value)]);
  }
  invalidate();
}

function invalidate() {
  gamesCache = null;
  settingsCache = null;
}

const rowToGame = (r) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  icon: r.icon,
  status: r.status,
  sortOrder: r.sort_order,
  modes: r.modes,
  multiplayer: r.multiplayer,
  ai: r.ai,
  features: r.features,
  config: r.config,
  builtin: r.builtin,
  updatedAt: r.updated_at,
});

/** Seeds the built-ins once per process before the first read. */
function ensureSynced() {
  if (!synced) synced = syncBuiltins().catch((e) => {
    synced = null;
    throw e;
  });
  return synced;
}

async function listGames() {
  await ensureSynced();
  if (gamesCache && Date.now() - gamesCache.at < TTL_MS) return gamesCache.games;
  const { rows } = await query(`SELECT * FROM game_registry ORDER BY sort_order, name`);
  const games = rows.map(rowToGame);
  gamesCache = { at: Date.now(), games };
  return games;
}

async function getGame(id) {
  return (await listGames()).find((g) => g.id === id) || null;
}

async function getSettings() {
  await ensureSynced();
  if (settingsCache && Date.now() - settingsCache.at < TTL_MS) return settingsCache.values;
  const { rows } = await query(`SELECT key, value FROM app_settings`);
  const values = { ...DEFAULT_SETTINGS };
  for (const r of rows) values[r.key] = r.value;
  settingsCache = { at: Date.now(), values };
  return values;
}

/** 'free' | 'premium' | null (unknown or disabled feature). */
function featureTier(game, featureId) {
  const feat = game && game.features && game.features[featureId];
  if (!feat || feat.enabled === false) return null;
  return feat.tier === "premium" ? "premium" : "free";
}

module.exports = { ensureSynced, syncBuiltins, invalidate, listGames, getGame, getSettings, featureTier };
