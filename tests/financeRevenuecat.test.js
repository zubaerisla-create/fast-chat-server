/**
 * Fast Finance Pro purchases are decided by RevenueCat only (stubbed REST API here — simulated,
 * no real Google Play). The app's request body and unauthenticated webhooks can't grant access.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const h = require("./helpers");

const WEBHOOK_AUTH = "Bearer rc-finance-webhook-secret";
process.env.REVENUECAT_WEBHOOK_AUTH = WEBHOOK_AUTH;

const subscribers = new Map();
let stub, srv, user;
const day = 24 * 60 * 60 * 1000;
const financeEnt = (product, expires) => ({ entitlements: { finance_pro: { product_identifier: product, expires_date: expires, purchase_date: new Date().toISOString() } }, non_subscriptions: {} });
const expireTrial = (id) => h.query(`UPDATE finance_subscriptions SET trial_ends_at = NOW() - INTERVAL '1 day', trial_starts_at = NOW() - INTERVAL '8 days' WHERE user_id = $1`, [id]);
const getSub = async (u = user) => (await srv.call("GET", "/api/finance/subscription", { token: u.token })).body.subscription;
let evN = 0;
const webhook = (body, auth = WEBHOOK_AUTH) => srv.call("POST", "/api/finance/revenuecat-webhook", { body, headers: auth ? { authorization: auth } : {} });
const event = (type, appUserId, extra = {}) => ({ event: { id: `fin_evt_${Date.now()}_${evN++}`, type, app_user_id: appUserId, product_id: "finance_pro:monthly", environment: "SANDBOX", ...extra } });

test.before(async () => {
  stub = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer sk_test_secret") return res.writeHead(401).end();
    const id = decodeURIComponent(req.url.split("/").pop());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ subscriber: subscribers.get(id) || { entitlements: {}, non_subscriptions: {} } }));
  });
  await new Promise((r) => stub.listen(0, r));
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await new Promise((r) => stub.close(r));
  await h.pool.end();
});
test.beforeEach(async () => {
  await h.resetDb();
  await h.query("TRUNCATE revenuecat_webhook_events, finance_subscriptions CASCADE");
  subscribers.clear();
  process.env.REVENUECAT_SECRET_KEY = "sk_test_secret";
  process.env.REVENUECAT_API_BASE = `http://127.0.0.1:${stub.address().port}`;
  user = await h.createUser("fin_buyer");
});

test("sync ignores a client body claiming lifetime when RevenueCat has no purchase", async () => {
  await getSub();
  await expireTrial(user.id);
  const res = await srv.call("POST", "/api/finance/subscription/sync", { token: user.token, body: { plan: "lifetime", status: "lifetime", originalTransactionId: "fake" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.subscription.hasAccess, false);
  assert.equal(res.body.subscription.status, "expired");
});

test("sync refuses (503) and changes nothing when RevenueCat isn't configured", async () => {
  delete process.env.REVENUECAT_SECRET_KEY;
  const res = await srv.call("POST", "/api/finance/subscription/sync", { token: user.token, body: { plan: "lifetime", status: "lifetime" } });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "billing_unavailable");
  assert.equal((await getSub()).status, "trialing");
});

test("verified monthly subscription grants access until the store expiry, then revokes", async () => {
  subscribers.set(user.id, financeEnt("finance_pro:monthly", new Date(Date.now() + 30 * day).toISOString()));
  let sub = (await srv.call("POST", "/api/finance/subscription/sync", { token: user.token })).body.subscription;
  assert.equal(sub.status, "active");
  assert.equal(sub.plan, "monthly");
  assert.ok(sub.currentPeriodEnd);
  await expireTrial(user.id);
  // Google Play: subscription expired → RevenueCat no longer lists the entitlement
  subscribers.set(user.id, { entitlements: {}, non_subscriptions: {} });
  sub = (await srv.call("POST", "/api/finance/subscription/sync", { token: user.token })).body.subscription;
  assert.equal(sub.hasAccess, false);
  assert.equal(sub.status, "expired");
});

test("an expiry date in the past never grants access", async () => {
  await getSub();
  await expireTrial(user.id);
  subscribers.set(user.id, financeEnt("finance_pro:yearly", new Date(Date.now() - day).toISOString()));
  const sub = (await srv.call("POST", "/api/finance/subscription/sync", { token: user.token })).body.subscription;
  assert.equal(sub.hasAccess, false);
});

test("verified yearly and lifetime purchases map to the right plan", async () => {
  subscribers.set(user.id, financeEnt("finance_pro:yearly", new Date(Date.now() + 365 * day).toISOString()));
  assert.equal((await srv.call("POST", "/api/finance/subscription/sync", { token: user.token })).body.subscription.plan, "yearly");
  subscribers.set(user.id, financeEnt("finance_lifetime_100", null));
  const sub = (await srv.call("POST", "/api/finance/subscription/sync", { token: user.token })).body.subscription;
  assert.equal(sub.status, "lifetime");
  assert.equal(sub.hasAccess, true);
  assert.equal(sub.currentPeriodEnd, null);
});

test("webhook without the right Authorization is rejected and grants nothing", async () => {
  await getSub();
  await expireTrial(user.id);
  for (const auth of [null, "Bearer wrong"]) {
    const res = await webhook(event("NON_RENEWING_PURCHASE", user.id, { product_id: "finance_lifetime_100" }), auth);
    assert.equal(res.status, 401);
  }
  assert.equal((await getSub()).hasAccess, false);
});

test("authenticated webhook only triggers a reconcile — the event body itself can't grant", async () => {
  await getSub();
  await expireTrial(user.id);
  // Forged-looking event but RevenueCat (stub) has no purchase
  let res = await webhook(event("NON_RENEWING_PURCHASE", user.id, { product_id: "finance_lifetime_100" }));
  assert.equal(res.status, 200);
  assert.equal((await getSub()).hasAccess, false);
  // Real purchase recorded at RevenueCat
  subscribers.set(user.id, financeEnt("finance_lifetime_100", null));
  const ev = event("NON_RENEWING_PURCHASE", user.id, { product_id: "finance_lifetime_100" });
  res = await webhook(ev);
  assert.equal(res.status, 200);
  assert.equal((await getSub()).status, "lifetime");
  // Same event delivered twice is processed once
  res = await webhook(ev);
  assert.equal(res.body.duplicate, true);
  const { rows } = await h.query("SELECT COUNT(*)::int AS n FROM revenuecat_webhook_events WHERE id = $1", [ev.event.id]);
  assert.equal(rows[0].n, 1);
});

test("webhook EXPIRATION removes subscription access (after RevenueCat confirms)", async () => {
  subscribers.set(user.id, financeEnt("finance_pro:monthly", new Date(Date.now() + 10 * day).toISOString()));
  await webhook(event("INITIAL_PURCHASE", user.id));
  assert.equal((await getSub()).status, "active");
  await expireTrial(user.id);
  subscribers.set(user.id, { entitlements: {}, non_subscriptions: {} });
  await webhook(event("EXPIRATION", user.id));
  assert.equal((await getSub()).hasAccess, false);
});

test("webhook for an unknown / non-FastChat user id is ignored", async () => {
  const res = await webhook(event("INITIAL_PURCHASE", "$RCAnonymousID:abc"));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ignored");
});

test("paid Finance actions are enforced on the server after the trial", async () => {
  await getSub();
  await expireTrial(user.id);
  const goal = { title: "Car", targetAmount: 1000 };
  let res = await srv.call("POST", "/api/finance/goals", { token: user.token, body: goal });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, "finance_subscription_required");
  for (const path of ["/api/finance/simulate", "/api/finance/businesses", "/api/finance/transactions"]) {
    assert.equal((await srv.call("POST", path, { token: user.token, body: {} })).status, 402, path);
  }
  subscribers.set(user.id, financeEnt("finance_lifetime_100", null));
  await srv.call("POST", "/api/finance/subscription/sync", { token: user.token });
  res = await srv.call("POST", "/api/finance/goals", { token: user.token, body: goal });
  assert.equal(res.status, 201);
});

test("trial users can still use the paid actions", async () => {
  const res = await srv.call("POST", "/api/finance/goals", { token: user.token, body: { title: "Trip", targetAmount: 50 } });
  assert.equal(res.status, 201);
});

test("lifetime summary subtracts expenses (net and this-month net go negative)", async () => {
  let res = await srv.call("POST", "/api/finance/expenses", { token: user.token, body: { title: "Lunch", amount: 200, category: "Food & Dining" } });
  assert.equal(res.status, 201);
  res = await srv.call("POST", "/api/finance/incomes", { token: user.token, body: { title: "Gift", amount: 50, source: "Other" } });
  assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
  const sum = (await srv.call("GET", "/api/finance/lifetime/summary", { token: user.token })).body.data;
  assert.equal(sum.lifetimeExpense, 200);
  assert.equal(sum.lifetimeIncome, 50);
  assert.equal(sum.netLifetime, -150);
  assert.equal(sum.thisMonthNet, -150);
});

test("the secret key is also read from REVENUECAT_SECRET_API_KEY", async () => {
  delete process.env.REVENUECAT_SECRET_KEY;
  process.env.REVENUECAT_SECRET_API_KEY = "sk_test_secret";
  try {
    subscribers.set(user.id, financeEnt("finance_lifetime_100", null));
    const res = await srv.call("POST", "/api/finance/subscription/sync", { token: user.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.subscription.status, "lifetime");
  } finally {
    delete process.env.REVENUECAT_SECRET_API_KEY;
  }
});
