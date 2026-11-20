/**
 * Built-in game catalog: every game in the FastChat app, with its real modes and features.
 *
 * This is the seed for the `game_registry` table (services/gameCatalog.js inserts missing
 * games at startup and never overwrites admin edits). Every premium feature is unlocked by
 * the single `games_lifetime` entitlement — games never define their own purchases.
 *
 * Feature tiers: 'free' (everyone) or 'premium' (Games Lifetime / owner). Only list features
 * that exist in the app and are enforced (server-side for online play, client-side for
 * offline AI play and cosmetics).
 */
const ENTITLEMENT = "games_lifetime";

const f = (label, tier = "free") => ({ label, tier, enabled: true });

/** Features every AI + online game shares. */
const versusFeatures = () => ({
  ai_easy: f("AI opponent — Easy"),
  ai_medium: f("AI opponent — Medium"),
  ai_hard: f("AI opponent — Hard", "premium"),
  online_play: f("Online matches with friends"),
  unlimited_matches: f("Unlimited online match creation", "premium"),
  match_history_full: f("Full match history", "premium"),
});

const BUILTIN_GAMES = [
  {
    id: "arrow",
    name: "Arrow Flow",
    description: "Slide every arrow off the board — 3 hearts per level.",
    icon: "arrow-redo-outline",
    sort_order: 10,
    modes: ["solo"],
    multiplayer: false,
    ai: false,
    features: { endless_levels: f("Endless generated levels"), hints: f("3 hints per level") },
    config: { route: "/games/arrow" },
  },
  {
    id: "jungle",
    name: "Jungle Escape",
    description: "A 3D endless runner: dodge, jump and slide through the jungle.",
    icon: "leaf-outline",
    sort_order: 20,
    modes: ["solo"],
    multiplayer: false,
    ai: false,
    features: { endless_run: f("Endless 3D run") },
    config: { route: "/games/jungle", note: "Only in Android builds that include the Unity export" },
  },
  {
    id: "chess",
    name: "Chess",
    description: "Challenge your friends in a strategic battle of intelligence.",
    icon: "extension-puzzle-outline",
    sort_order: 30,
    modes: ["ai", "online"],
    multiplayer: true,
    ai: true,
    features: {
      ...versusFeatures(),
      time_rapid: f("Rapid 10 and untimed games"),
      time_all: f("Bullet, Blitz and Rapid 15+10 time controls", "premium"),
      themes_premium: f("Tournament and Ebony board themes", "premium"),
    },
    config: { freeTimeControls: ["10+0", "untimed"] },
  },
  {
    id: "carrom",
    name: "Carrom",
    description: "Challenge your friends in a classic multiplayer carrom match.",
    icon: "ellipse-outline",
    sort_order: 40,
    modes: ["ai", "online"],
    multiplayer: true,
    ai: true,
    features: {
      ...versusFeatures(),
      single_board: f("One-board matches"),
      long_matches: f("First to 13 / first to 25 matches", "premium"),
      themes_premium: f("Rosewood board theme", "premium"),
    },
    config: { freeTargets: [0] },
  },
  {
    id: "dots",
    name: "Dots & Boxes",
    description: "Draw lines, close boxes, and steal the board.",
    icon: "grid-outline",
    sort_order: 50,
    modes: ["ai", "online"],
    multiplayer: true,
    ai: true,
    features: { ...versusFeatures(), grid_standard: f("4×4 and 5×5 grids"), grid_large: f("6×6 grid", "premium") },
    config: { freeSizes: [4, 5] },
  },
  {
    id: "hangman",
    name: "Hangman",
    description: "Guess the hidden word one letter at a time.",
    icon: "text-outline",
    sort_order: 60,
    modes: ["ai", "duel", "online"],
    multiplayer: true,
    ai: true,
    features: { ...versusFeatures(), duel_mode: f("Duel mode against the AI") },
    config: {},
  },
  {
    id: "connect4",
    name: "Connect Four",
    description: "Drop discs and line up four before your opponent does.",
    icon: "apps-outline",
    sort_order: 70,
    modes: ["ai", "online"],
    multiplayer: true,
    ai: true,
    features: versusFeatures(),
    config: {},
  },
];

/** Defaults for app_settings. */
const DEFAULT_SETTINGS = {
  daily_match_limit: 3,
  purchase_display: { title: "FastChat Games Lifetime", subtitle: "Pay once. Play forever.", targetPriceUsd: 2, enabled: true },
  announcement: { text: "", tone: "info", active: false },
};

const REVENUECAT = {
  entitlement: ENTITLEMENT,
  productId: "fastchat_games_lifetime_v1",
  offering: "games",
  packageId: "lifetime",
};

module.exports = { ENTITLEMENT, BUILTIN_GAMES, DEFAULT_SETTINGS, REVENUECAT };
