const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { FinanceSubscription, FINANCE_PRICING } = require("../models/FinanceSubscription");

let srv;
let user;

test.before(async () => {
  srv = await h.startServer();
});

test.after(async () => {
  await srv.close();
  await h.pool.end();
});

test.beforeEach(async () => {
  await h.resetDb();
  user = await h.createUser("finance_test_user");
});

test("finance subscription pricing is configured with 7-day trial, monthly $10, yearly $50, lifetime $100", () => {
  assert.equal(FINANCE_PRICING.monthly.price, 10);
  assert.equal(FINANCE_PRICING.monthly.trialDays, 7);
  assert.equal(FINANCE_PRICING.yearly.price, 50);
  assert.equal(FINANCE_PRICING.lifetime.price, 100);
});

test("new user receives active 7-day free trial", async () => {
  const access = await FinanceSubscription.getForUser(user.id, user.created_at);
  assert.equal(access.hasAccess, true);
  assert.equal(access.isTrial, true);
  assert.ok(access.daysLeft >= 6 && access.daysLeft <= 7);
  assert.equal(access.status, "trialing");
});

test("syncing monthly ($10) subscription grants active access", async () => {
  const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const access = await FinanceSubscription.syncPurchase(user.id, {
    plan: "monthly",
    status: "active",
    revenuecatCustomerId: "rc_cust_123",
    currentPeriodEnd: nextMonth,
  });

  assert.equal(access.hasAccess, true);
  assert.equal(access.isTrial, false);
  assert.equal(access.status, "active");
  assert.equal(access.plan, "monthly");
});

test("syncing lifetime ($100) subscription grants permanent access", async () => {
  const access = await FinanceSubscription.syncPurchase(user.id, {
    plan: "lifetime",
    status: "lifetime",
  });

  assert.equal(access.hasAccess, true);
  assert.equal(access.isTrial, false);
  assert.equal(access.status, "lifetime");
  assert.equal(access.plan, "lifetime");
});

test("GET /api/finance/subscription endpoint returns subscription details", async () => {
  const res = await srv.call("GET", "/api/finance/subscription", { token: user.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.subscription.hasAccess, true);
  assert.equal(res.body.subscription.isTrial, true);
  assert.equal(res.body.subscription.pricing.monthly.price, 10);
  assert.equal(res.body.subscription.pricing.yearly.price, 50);
  assert.equal(res.body.subscription.pricing.lifetime.price, 100);
});
