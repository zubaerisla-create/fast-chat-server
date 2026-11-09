const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { setPaddleClientForTests } = require("../services/paddleBilling");
const { getEntitlement } = require("../services/entitlements");

let srv;
let paddle;
const DAY = 86400000;

test.before(async () => {
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});
test.beforeEach(async () => {
  h.useBillingEnv();
  paddle = h.paddleStub();
  setPaddleClientForTests(paddle.stub);
  await h.resetDb();
});

const activeSub = (userId, o = {}) =>
  h.query(
    `INSERT INTO subscriptions (user_id, provider, provider_subscription_id, plan, billing_interval, status, current_period_end, provider_updated_at, recurring_amount_minor, currency_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)`,
    [userId, o.provider || "paddle", o.id || "sub_a", o.plan || "pro", o.interval || "month", o.status || "active", new Date(Date.now() + 20 * DAY), o.amount ?? 4000, o.currency || "USD"]
  );

// ─── Catalog and checkout ────────────────────────────────────────────────────

test("catalog is public, has only the three plans, and exposes only public Paddle values", async () => {
  const res = await srv.call("GET", "/api/billing/catalog");
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("pdl_sdbx_apikey"), "API key must not be exposed");
  assert.ok(!text.includes(h.WEBHOOK_SECRET), "webhook secret must not be exposed");
  assert.equal(res.body.paddle.clientToken, "test_clienttoken");
  assert.deepEqual(res.body.plans.map((p) => p.id), ["starter", "pro", "advanced"]);

  const [starter, pro, advanced] = res.body.plans;
  assert.equal(pro.recommended, true);
  assert.deepEqual(Object.keys(starter.offers).sort(), ["month", "year"]);
  assert.deepEqual(starter.offers.month.price, { amountMinor: "500", currency: "USD", formatted: "$5" });
  assert.deepEqual(starter.offers.month.trial, { interval: "day", frequency: 7, requiresPaymentMethod: true });
  assert.equal(pro.offers.year.price.formatted, "$40");
  assert.equal(pro.offers.year.trial, null, "no trial unless Paddle has one");
  assert.deepEqual(Object.keys(advanced.offers), ["lifetime"]);
  assert.equal(advanced.lifetime, true);
  assert.equal(advanced.offers.lifetime.price.formatted, "$1,000");
  assert.equal(advanced.offers.lifetime.trial, null);
  assert.ok(Object.values(res.body.plans).every((p) => Object.values(p.offers).every((o) => o.available)));
  assert.deepEqual(res.body.warnings, []);
});

test("a missing price ID makes that offer unavailable with a named warning, never a guessed price", async () => {
  h.useBillingEnv({ PADDLE_STARTER_YEARLY_PRICE_ID: "", PADDLE_PRO_MONTHLY_PRICE_ID: "" });
  const res = await srv.call("GET", "/api/billing/catalog");
  const [starter, pro] = res.body.plans;
  assert.equal(starter.offers.year.available, false);
  assert.equal(starter.offers.year.price, null);
  assert.equal(starter.offers.year.priceId, null);
  assert.equal(pro.offers.month.available, false);
  assert.ok(res.body.warnings.includes("PADDLE_STARTER_YEARLY_PRICE_ID is not set"));
  assert.ok(res.body.warnings.includes("PADDLE_PRO_MONTHLY_PRICE_ID is not set"));
  assert.ok(!JSON.stringify(res.body.warnings).includes("pdl_"), "warnings hold names only");
});

test("a Paddle price with the wrong cycle or status is not sold", async () => {
  paddle = h.paddleStub({
    prices: [
      h.paddlePrice(h.PRICES.starter_month, { amount: 500, interval: "year" }),
      h.paddlePrice(h.PRICES.pro_year, { amount: 4000, interval: "year", status: "archived" }),
      h.paddlePrice(h.PRICES.advanced_lifetime, { amount: 100000, interval: "month" }),
    ],
  });
  setPaddleClientForTests(paddle.stub);
  const res = await srv.call("GET", "/api/billing/catalog");
  const offers = Object.fromEntries(res.body.plans.flatMap((p) => Object.values(p.offers)).map((o) => [o.key, o]));
  for (const key of ["starter_month", "pro_year", "advanced_lifetime", "starter_year", "pro_month"]) assert.equal(offers[key].available, false, key);
  assert.ok(res.body.warnings.some((w) => /PADDLE_ADVANCED_LIFETIME_PRICE_ID does not have a one-time/.test(w)));
  assert.ok(res.body.warnings.some((w) => /PADDLE_PRO_YEARLY_PRICE_ID is archived/.test(w)));

  const u = await h.createUser("quinn");
  const co = await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId: h.PRICES.pro_year } });
  assert.equal(co.status, 503);
  assert.equal(co.body.code, "offer_unavailable");
  assert.equal(paddle.calls.transactions.length, 0);
});

test("if Paddle can't be reached nothing is purchasable", async () => {
  paddle = h.paddleStub({ pricesFail: true });
  setPaddleClientForTests(paddle.stub);
  const res = await srv.call("GET", "/api/billing/catalog");
  assert.equal(res.status, 200);
  assert.ok(res.body.plans.every((p) => Object.values(p.offers).every((o) => !o.available && o.price === null)));
});

test("Paddle prices are cached between catalog requests", async () => {
  await srv.call("GET", "/api/billing/catalog");
  await srv.call("GET", "/api/billing/catalog");
  assert.equal(paddle.calls.priceLists, 1);
});

test("checkout requires authentication", async () => {
  const res = await srv.call("POST", "/api/billing/checkout", { body: { priceId: h.PRICES.pro_month } });
  assert.equal(res.status, 401);
});

test("checkout rejects prices that are not configured", async () => {
  const u = await h.createUser("bob");
  for (const priceId of ["pri_attacker_cheap", "", 123]) {
    const res = await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId } });
    assert.equal(res.status, 400, String(priceId));
  }
  assert.equal(paddle.calls.transactions.length, 0);
});

test("checkout creates the transaction server-side with the user's own customer and ID", async () => {
  const u = await h.createUser("carol");
  const res = await srv.call("POST", "/api/billing/checkout", {
    token: u.token,
    body: { priceId: h.PRICES.pro_year, customData: { userId: "someone-else" }, customerId: "ctm_victim" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.transactionId, "txn_1");
  assert.equal(res.body.plan, "pro");
  assert.equal(res.body.interval, "year");
  const [txn] = paddle.calls.transactions;
  assert.deepEqual(txn.items, [{ priceId: h.PRICES.pro_year, quantity: 1 }]);
  assert.deepEqual(txn.customData, { userId: u.id, offer: "pro_year" }, "client-supplied customData is ignored");
  assert.notEqual(txn.customerId, "ctm_victim");
  assert.deepEqual(paddle.calls.customersCreated, [u.email]);

  // A second checkout reuses the stored customer
  await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId: h.PRICES.starter_month } });
  assert.equal(paddle.calls.customersCreated.length, 1);
});

test("checkout success in the browser grants nothing until the webhook arrives", async () => {
  const u = await h.createUser("cleo");
  await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId: h.PRICES.advanced_lifetime } });
  const me = await srv.call("GET", "/api/billing/me", { token: u.token });
  assert.equal(me.body.entitlement.plan, "free");
});

test("checkout refuses a second subscription", async () => {
  const u = await h.createUser("dave");
  await activeSub(u.id, { id: "sub_d" });
  const res = await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId: h.PRICES.starter_month } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "already_subscribed");
});

test("a subscriber may buy Lifetime and is told about the running subscription", async () => {
  const u = await h.createUser("dina");
  await activeSub(u.id, { id: "sub_dina", plan: "starter" });
  const res = await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId: h.PRICES.advanced_lifetime } });
  assert.equal(res.status, 200);
  assert.equal(res.body.interval, "lifetime");
  assert.equal(res.body.hasActiveSubscription, true);
});

test("a Lifetime owner can't buy anything else", async () => {
  const u = await h.createUser("dora");
  await h.query("INSERT INTO lifetime_purchases (user_id, provider, provider_transaction_id, plan) VALUES ($1, 'paddle', 'txn_old', 'advanced')", [u.id]);
  for (const priceId of [h.PRICES.advanced_lifetime, h.PRICES.pro_year]) {
    const res = await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "already_lifetime");
  }
  assert.equal(paddle.calls.transactions.length, 0);
});

test("checkout stays closed until explicitly enabled", async () => {
  h.useBillingEnv({ PADDLE_CHECKOUT_ENABLED: "false" });
  const u = await h.createUser("erin");
  const res = await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId: h.PRICES.pro_month } });
  assert.equal(res.status, 503);
  assert.equal(paddle.calls.transactions.length, 0);
});

// ─── Customer portal ─────────────────────────────────────────────────────────

test("portal requires authentication", async () => {
  assert.equal((await srv.call("POST", "/api/billing/portal", {})).status, 401);
});

test("portal returns 404 for users without a billing account", async () => {
  const u = await h.createUser("frank");
  const res = await srv.call("POST", "/api/billing/portal", { token: u.token, body: { customerId: "ctm_other" } });
  assert.equal(res.status, 404);
  assert.equal(paddle.calls.portal.length, 0);
});

test("portal uses the customer linked to the signed-in user, never one from the request", async () => {
  const owner = await h.createUser("grace");
  const other = await h.createUser("heidi");
  await h.query("INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'paddle', 'ctm_grace'), ($2, 'paddle', 'ctm_heidi')", [owner.id, other.id]);
  await activeSub(owner.id, { id: "sub_grace" });
  const res = await srv.call("POST", "/api/billing/portal", { token: owner.token, body: { customerId: "ctm_heidi" } });
  assert.equal(res.status, 200);
  assert.match(res.body.url, /^https:\/\/sandbox-customer-portal\.paddle\.com\//);
  assert.deepEqual(paddle.calls.portal, [{ customerId: "ctm_grace", subscriptionIds: ["sub_grace"] }]);
});

// ─── Entitlement endpoint (used by the website and the Android app) ─────────

test("/me returns the backend entitlement including Lifetime", async () => {
  const u = await h.createUser("trent");
  assert.equal((await srv.call("GET", "/api/billing/me")).status, 401);
  await activeSub(u.id, { id: "sub_web", plan: "starter" });
  let res = await srv.call("GET", "/api/billing/me", { token: u.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.entitlement.plan, "starter");
  assert.equal(res.body.subscriptions.length, 1);
  await h.query("INSERT INTO lifetime_purchases (user_id, provider, provider_transaction_id, plan) VALUES ($1, 'paddle', 'txn_t', 'advanced')", [u.id]);
  res = await srv.call("GET", "/api/billing/me", { token: u.token });
  assert.equal(res.body.entitlement.plan, "advanced");
  assert.ok(res.body.entitlement.lifetime);
  assert.equal(res.body.entitlement.hasDuplicateSubscriptions, true);
  assert.equal(res.body.lifetimePurchases.length, 1);
});

// ─── Admin ───────────────────────────────────────────────────────────────────

test("the admin summary is admin-only and built from stored data", async () => {
  const user = await h.createUser("victor");
  const admin = await h.createUser("walter", { role: "admin" });
  await h.createUser("xena");
  await activeSub(user.id, { id: "sub_m", plan: "pro", amount: 4000 });
  await activeSub(admin.id, { id: "sub_y", plan: "pro", interval: "year", amount: 4000 });
  await h.query("INSERT INTO lifetime_purchases (user_id, provider, provider_transaction_id, plan, total_minor, currency_code) VALUES ($1, 'paddle', 'txn_l', 'advanced', 100000, 'USD')", [user.id]);

  assert.equal((await srv.call("GET", "/api/admin/billing/summary", { token: user.token })).status, 403);
  assert.equal((await srv.call("GET", "/api/admin/billing/summary")).status, 401);

  const res = await srv.call("GET", "/api/admin/billing/summary", { token: admin.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.users, { total: 3, starter: 0, pro: 2, advancedLifetime: 1 });
  assert.deepEqual(res.body.monthlyRecurringRevenue, [{ currency_code: "USD", mrr_minor: "4333", subscriptions: 2 }]);
  assert.deepEqual(res.body.lifetimeRevenue, [{ currency_code: "USD", total_minor: "100000", purchases: 1 }]);
  const victor = res.body.customers.find((c) => c.username === "victor");
  assert.equal(victor.plan, "advanced");
  assert.equal(victor.billing, "lifetime");
  assert.equal(victor.currentPeriodEnd, null);
  assert.equal(victor.subscriptionAlongsideLifetime, true);
  const walter = res.body.customers.find((c) => c.username === "walter");
  assert.equal(walter.billing, "year");
  assert.ok(walter.currentPeriodEnd);
  assert.equal(res.body.customers.length, 2, "users without billing records are not listed");
});

// ─── Plan-based upload limit ─────────────────────────────────────────────────

test("upload size follows the plan: Free keeps 25 MB, paid plans get more", async () => {
  const free = await h.createUser("yvonne");
  const starter = await h.createUser("zara");
  await activeSub(starter.id, { id: "sub_z", plan: "starter" });
  const upload = (token, mb) => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.alloc(mb * 1024 * 1024)], { type: "image/png" }), "big.png");
    return srv.call("POST", "/api/upload", { token, raw: form });
  };
  const tooBig = await upload(free.token, 26);
  assert.equal(tooBig.status, 413);
  assert.match(tooBig.body.message, /25 MB/);
  const ok = (await upload(free.token, 24)).status;
  assert.ok(ok === 200 || ok === 201, `free 24 MB upload returned ${ok}`);
  const paid = (await upload(starter.token, 30)).status;
  assert.ok(paid === 200 || paid === 201, `starter 30 MB upload returned ${paid}`);
});

test("configuration warnings are hidden from visitors in production", async () => {
  h.useBillingEnv({ NODE_ENV: "production", PADDLE_STARTER_YEARLY_PRICE_ID: "" });
  const res = await srv.call("GET", "/api/billing/catalog");
  assert.deepEqual(res.body.warnings, []);
  assert.equal(res.body.plans[0].offers.year.available, false);
});
