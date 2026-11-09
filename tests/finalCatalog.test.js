/**
 * The owner's final catalog (2026-10-31): exactly five live Paddle prices.
 * Stubbed Paddle responses mirror what the live API returned for these IDs.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { setPaddleClientForTests } = require("../services/paddleBilling");
const { getEntitlement } = require("../services/entitlements");

const FINAL = {
  starter_month: "pri_01m68exn8p6zh05v9hw75afr37",
  starter_year: "pri_01m68jcgwjfx4q4z138fger5kd",
  pro_month: "pri_01m68jjnsk600ahqgb37sevbh8",
  pro_year: "pri_01m68f37k2swxkfk9d3k5eyxcd",
  advanced_lifetime: "pri_01m68f83q9qdjske7wn112krww",
};
const STARTER = "pro_01m68eg5hqhnjxpfsm0mv6kjrr";
const PRO = "pro_01m68ehp44t2fryrfymnkpk5qh";
const ADVANCED = "pro_01m68ek4m23dhj3xcgqcq4zg3g";
const livePrices = () => [
  h.paddlePrice(FINAL.starter_month, { amount: 500, interval: "month", trialDays: 7, productId: STARTER }),
  h.paddlePrice(FINAL.starter_year, { amount: 4000, interval: "year", trialDays: 7, productId: STARTER }),
  h.paddlePrice(FINAL.pro_month, { amount: 800, interval: "month", trialDays: 7, productId: PRO }),
  h.paddlePrice(FINAL.pro_year, { amount: 4000, interval: "year", productId: PRO }),
  h.paddlePrice(FINAL.advanced_lifetime, { amount: 100000, productId: ADVANCED }),
];
const finalEnv = {
  PADDLE_STARTER_MONTHLY_PRICE_ID: FINAL.starter_month,
  PADDLE_STARTER_YEARLY_PRICE_ID: FINAL.starter_year,
  PADDLE_PRO_MONTHLY_PRICE_ID: FINAL.pro_month,
  PADDLE_PRO_YEARLY_PRICE_ID: FINAL.pro_year,
  PADDLE_ADVANCED_LIFETIME_PRICE_ID: FINAL.advanced_lifetime,
};

let srv;
let paddle;
test.before(async () => {
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});
test.beforeEach(async () => {
  h.useBillingEnv(finalEnv);
  paddle = h.paddleStub({ prices: livePrices() });
  setPaddleClientForTests(paddle.stub);
  await h.resetDb();
});

const offersOf = (body) => Object.fromEntries(body.plans.flatMap((p) => Object.values(p.offers)).map((o) => [o.key, o]));

test("the catalog serves exactly the five final prices with their Paddle amounts, intervals and trials", async () => {
  const res = await srv.call("GET", "/api/billing/catalog");
  assert.deepEqual(res.body.plans.map((p) => p.name), ["Starter", "Pro", "Advanced Lifetime"]);
  const o = offersOf(res.body);
  assert.deepEqual(Object.keys(o).sort(), Object.keys(FINAL).sort());
  const expected = {
    starter_month: ["$5", "month", 7],
    starter_year: ["$40", "year", 7],
    pro_month: ["$8", "month", 7],
    pro_year: ["$40", "year", null],
    advanced_lifetime: ["$1,000", "lifetime", null],
  };
  for (const [key, [price, interval, trialDays]] of Object.entries(expected)) {
    assert.equal(o[key].priceId, FINAL[key], key);
    assert.equal(o[key].available, true, key);
    assert.equal(o[key].price.formatted, price, key);
    assert.equal(o[key].price.currency, "USD", key);
    assert.equal(o[key].interval, interval, key);
    assert.equal(o[key].trial?.frequency ?? null, trialDays, key);
  }
  assert.deepEqual(res.body.warnings, []);
});

test("each CTA's price ID starts checkout for the matching plan and interval", async () => {
  const expected = {
    starter_month: ["starter", "month"],
    starter_year: ["starter", "year"],
    pro_month: ["pro", "month"],
    pro_year: ["pro", "year"],
    advanced_lifetime: ["advanced", "lifetime"],
  };
  for (const [key, [plan, interval]] of Object.entries(expected)) {
    const u = await h.createUser(`buyer_${key}`);
    const res = await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId: FINAL[key] } });
    assert.equal(res.status, 200, key);
    assert.equal(res.body.plan, plan, key);
    assert.equal(res.body.interval, interval, key);
    const txn = paddle.calls.transactions.at(-1);
    assert.deepEqual(txn.items, [{ priceId: FINAL[key], quantity: 1 }], key);
    assert.deepEqual(txn.customData, { userId: u.id, offer: key }, key);
  }
});

test("verified subscription webhooks store the right plan and interval for all four subscription prices", async () => {
  const cases = { starter_month: ["starter", "month"], starter_year: ["starter", "year"], pro_month: ["pro", "month"], pro_year: ["pro", "year"] };
  for (const [key, [plan, interval]] of Object.entries(cases)) {
    const u = await h.createUser(`sub_${key}`);
    const customerId = `ctm_${key}`;
    await h.query("INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'paddle', $2)", [u.id, customerId]);
    const payload = h.subscriptionPayload({ id: `sub_${key}`, customerId, status: "active", priceId: FINAL[key] });
    payload.billing_cycle = { interval, frequency: 1 };
    const raw = JSON.stringify(h.event("subscription.created", payload));
    const res = await srv.call("POST", "/api/billing/webhooks/paddle", { raw, headers: { "content-type": "application/json", "paddle-signature": h.sign(raw) } });
    assert.equal(res.status, 200, key);
    const row = (await h.query("SELECT * FROM subscriptions WHERE provider_subscription_id = $1", [`sub_${key}`])).rows[0];
    assert.equal(row.plan, plan, key);
    assert.equal(row.billing_interval, interval, key);
    assert.equal(row.price_id, FINAL[key], key);
    assert.equal(row.provider_customer_id, customerId, key);
    assert.equal((await getEntitlement(u.id)).plan, plan, key);
  }
});

test("Starter yearly and Pro yearly share an amount but never get confused", async () => {
  const res = await srv.call("GET", "/api/billing/catalog");
  const o = offersOf(res.body);
  assert.equal(o.starter_year.price.amountMinor, o.pro_year.price.amountMinor);
  assert.notEqual(o.starter_year.priceId, o.pro_year.priceId);
  assert.equal(o.starter_year.plan, "starter");
  assert.equal(o.pro_year.plan, "pro");
});

test("a price ID pasted into the wrong plan's variable is not sold and is reported", async () => {
  // Pro yearly's ID configured as Starter yearly (and Starter yearly's real ID left out)
  h.useBillingEnv({ ...finalEnv, PADDLE_STARTER_YEARLY_PRICE_ID: FINAL.pro_year, PADDLE_PRO_YEARLY_PRICE_ID: FINAL.starter_year });
  setPaddleClientForTests(paddle.stub);
  const res = await srv.call("GET", "/api/billing/catalog");
  const o = offersOf(res.body);
  assert.equal(o.starter_year.available, false);
  assert.equal(o.pro_year.available, false);
  assert.ok(res.body.warnings.some((w) => /different Paddle products/.test(w)));
  const u = await h.createUser("mixup");
  const co = await srv.call("POST", "/api/billing/checkout", { token: u.token, body: { priceId: FINAL.pro_year } });
  assert.equal(co.status, 503);
  assert.equal(paddle.calls.transactions.length, 0);
});

test("a wrong amount in Paddle is shown as Paddle has it, never replaced", async () => {
  paddle = h.paddleStub({ prices: livePrices().map((p) => (p.id === FINAL.pro_month ? { ...p, unitPrice: { amount: "900", currencyCode: "USD" } } : p)) });
  setPaddleClientForTests(paddle.stub);
  const o = offersOf((await srv.call("GET", "/api/billing/catalog")).body);
  assert.equal(o.pro_month.price.formatted, "$9", "Paddle is the source of truth; the site never hard-codes $8");
});
