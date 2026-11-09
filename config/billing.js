/**
 * Billing configuration, read once from the environment.
 *
 * Paddle is OFF unless PADDLE_ENVIRONMENT is set. When it is "sandbox" or "live"
 * ("production" is accepted as an alias for live), the API key, client token and
 * webhook secret must be present and match that environment, otherwise
 * loadBillingConfig() throws and the server refuses to start. It never silently
 * falls back to the other environment.
 *
 * Price IDs are optional one by one: an offer whose price ID is missing is simply not
 * purchasable, and its variable name is reported in `missingPriceEnv` (names only).
 * Secret values are never logged.
 */
const { OFFERS } = require("./plans");

const PADDLE_PREFIXES = {
  sandbox: { apiKey: "pdl_sdbx_apikey_", clientToken: "test_" },
  production: { apiKey: "pdl_live_apikey_", clientToken: "live_" },
};
const ENVIRONMENT_ALIASES = { sandbox: "sandbox", live: "production", production: "production" };

const intFromEnv = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

function loadPaddleConfig(env) {
  const raw = (env.PADDLE_ENVIRONMENT || "").trim().toLowerCase();
  if (!raw) return { enabled: false };
  const environment = ENVIRONMENT_ALIASES[raw];
  if (!environment) throw new Error(`PADDLE_ENVIRONMENT must be "sandbox" or "live" (got "${raw}")`);

  const missing = [];
  const need = (name) => {
    const v = (env[name] || "").trim();
    if (!v) missing.push(name);
    return v;
  };
  const apiKey = need("PADDLE_API_KEY");
  const clientToken = need("PADDLE_CLIENT_TOKEN");
  const webhookSecret = need("PADDLE_WEBHOOK_SECRET");
  if (missing.length) throw new Error(`Paddle (${raw}) is missing: ${missing.join(", ")}`);

  const prefix = PADDLE_PREFIXES[environment];
  if (!apiKey.startsWith(prefix.apiKey)) throw new Error(`PADDLE_API_KEY is not a ${raw} API key`);
  if (!clientToken.startsWith(prefix.clientToken)) throw new Error(`PADDLE_CLIENT_TOKEN is not a ${raw} client-side token`);

  // offer key → price ID (only configured offers)
  const prices = {};
  const missingPriceEnv = [];
  for (const offer of OFFERS) {
    const id = (env[offer.env] || "").trim();
    if (!id) {
      missingPriceEnv.push(offer.env);
      continue;
    }
    if (!id.startsWith("pri_")) throw new Error(`${offer.env} must be a Paddle price ID (pri_…)`);
    prices[offer.key] = id;
  }
  const ids = Object.values(prices);
  if (new Set(ids).size !== ids.length) throw new Error("Paddle price IDs must all be different");

  // Checkout stays off until it is explicitly enabled (live: account verified + domain approved)
  const checkoutEnabled = env.PADDLE_CHECKOUT_ENABLED === "true";

  return { enabled: true, environment, apiKey, clientToken, webhookSecret, prices, missingPriceEnv, checkoutEnabled };
}

function loadBillingConfig(env = process.env) {
  return {
    paddle: loadPaddleConfig(env),
    // Days a past_due subscription keeps paid access while Paddle retries payment (default 7)
    pastDueGraceDays: intFromEnv(env, "BILLING_PAST_DUE_GRACE_DAYS", 7),
    // Paused subscriptions lose paid access unless this is "true"
    pausedKeepsAccess: env.BILLING_PAUSED_KEEPS_ACCESS === "true",
    siteUrl: (env.SITE_URL || "https://fastchatwebsite.hosensoft.com").replace(/\/$/, ""),
    // Configuration warnings (variable names only) are shown to visitors only outside production
    showConfigWarnings: env.NODE_ENV !== "production",
  };
}

let cached;
const getBillingConfig = () => (cached ??= loadBillingConfig());
// Tests swap in their own config
const setBillingConfigForTests = (config) => {
  cached = config;
};

module.exports = { loadBillingConfig, getBillingConfig, setBillingConfigForTests };
