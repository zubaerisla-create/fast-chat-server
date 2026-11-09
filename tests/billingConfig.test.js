const test = require("node:test");
const assert = require("node:assert/strict");
const { testEnv } = require("./helpers");
const { loadBillingConfig } = require("../config/billing");
const { planForPrice } = require("../services/paddleBilling");

test("billing is off when PADDLE_ENVIRONMENT is not set", () => {
  const config = loadBillingConfig({});
  assert.equal(config.paddle.enabled, false);
  assert.equal(config.pastDueGraceDays, 7);
  assert.equal("googlePlay" in config, false, "no Google Play billing in this release");
});

test("a sandbox config loads with every offer mapped and checkout explicit", () => {
  const config = loadBillingConfig(testEnv({ PADDLE_CHECKOUT_ENABLED: undefined }));
  assert.equal(config.paddle.environment, "sandbox");
  assert.equal(config.paddle.checkoutEnabled, false, "checkout must be explicitly enabled");
  assert.deepEqual(planForPrice("pri_pro_year", config.paddle), { key: "pro_year", plan: "pro", interval: "year" });
  assert.deepEqual(planForPrice("pri_advanced_lifetime", config.paddle), { key: "advanced_lifetime", plan: "advanced", interval: "lifetime" });
  assert.equal(planForPrice("pri_unknown", config.paddle), null);
  assert.deepEqual(config.paddle.missingPriceEnv, []);
});

test("'live' and 'production' both mean the live environment", () => {
  const live = { PADDLE_API_KEY: "pdl_live_apikey_x", PADDLE_CLIENT_TOKEN: "live_x" };
  assert.equal(loadBillingConfig(testEnv({ PADDLE_ENVIRONMENT: "live", ...live })).paddle.environment, "production");
  assert.equal(loadBillingConfig(testEnv({ PADDLE_ENVIRONMENT: "production", ...live })).paddle.environment, "production");
  assert.throws(() => loadBillingConfig(testEnv({ PADDLE_ENVIRONMENT: "staging" })), /must be "sandbox" or "live"/);
});

test("fails loudly when a credential is missing", () => {
  assert.throws(() => loadBillingConfig(testEnv({ PADDLE_WEBHOOK_SECRET: "" })), /missing: PADDLE_WEBHOOK_SECRET/);
  assert.throws(() => loadBillingConfig(testEnv({ PADDLE_API_KEY: "" })), /missing: PADDLE_API_KEY/);
});

test("a missing price ID only disables that offer and is reported by name", () => {
  const config = loadBillingConfig(testEnv({ PADDLE_STARTER_YEARLY_PRICE_ID: "", PADDLE_PRO_MONTHLY_PRICE_ID: undefined }));
  assert.deepEqual(config.paddle.missingPriceEnv, ["PADDLE_STARTER_YEARLY_PRICE_ID", "PADDLE_PRO_MONTHLY_PRICE_ID"]);
  assert.equal(config.paddle.prices.starter_year, undefined);
  assert.equal(config.paddle.prices.pro_year, "pri_pro_year");
});

test("never mixes sandbox and live credentials", () => {
  assert.throws(() => loadBillingConfig(testEnv({ PADDLE_API_KEY: "pdl_live_apikey_x" })), /not a sandbox API key/);
  assert.throws(() => loadBillingConfig(testEnv({ PADDLE_CLIENT_TOKEN: "live_x" })), /not a sandbox client-side token/);
  assert.throws(() => loadBillingConfig(testEnv({ PADDLE_ENVIRONMENT: "live", PADDLE_API_KEY: "pdl_live_apikey_x" })), /not a live client-side token/);
});

test("rejects duplicated or malformed price IDs", () => {
  assert.throws(() => loadBillingConfig(testEnv({ PADDLE_PRO_MONTHLY_PRICE_ID: "pri_starter_month" })), /must all be different/);
  assert.throws(() => loadBillingConfig(testEnv({ PADDLE_PRO_MONTHLY_PRICE_ID: "price_123" })), /PADDLE_PRO_MONTHLY_PRICE_ID must be a Paddle price ID/);
});

test("error messages never contain secret values", () => {
  try {
    loadBillingConfig(testEnv({ PADDLE_API_KEY: "pdl_live_apikey_SUPERSECRET" }));
    assert.fail("should throw");
  } catch (e) {
    assert.ok(!e.message.includes("SUPERSECRET"));
  }
});
