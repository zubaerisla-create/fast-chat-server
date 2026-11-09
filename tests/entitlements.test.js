const test = require("node:test");
const assert = require("node:assert/strict");
require("./helpers");
const { loadBillingConfig } = require("../config/billing");
const { subscriptionGrantsAccess, computeEntitlement } = require("../services/entitlements");

const config = loadBillingConfig({});
const now = new Date("2026-11-01T12:00:00Z");
const DAY = 86400000;
const sub = (o) => ({ provider: "paddle", plan: "pro", status: "active", current_period_end: new Date(now.getTime() + 20 * DAY), ...o });

test("active and trialing grant access", () => {
  assert.equal(subscriptionGrantsAccess(sub({}), now, config), true);
  assert.equal(subscriptionGrantsAccess(sub({ status: "trialing" }), now, config), true);
});

test("a scheduled cancellation keeps access until it takes effect", () => {
  const s = sub({ scheduled_change_action: "cancel", scheduled_change_at: new Date(now.getTime() + 5 * DAY) });
  assert.equal(subscriptionGrantsAccess(s, now, config), true);
  assert.equal(subscriptionGrantsAccess({ ...s, status: "canceled" }, now, config), false);
});

test("past_due keeps access only during the grace period", () => {
  assert.equal(subscriptionGrantsAccess(sub({ status: "past_due", past_due_since: new Date(now.getTime() - 6 * DAY) }), now, config), true);
  assert.equal(subscriptionGrantsAccess(sub({ status: "past_due", past_due_since: new Date(now.getTime() - 8 * DAY) }), now, config), false);
  const noGrace = { ...config, pastDueGraceDays: 0 };
  assert.equal(subscriptionGrantsAccess(sub({ status: "past_due", past_due_since: now }), now, noGrace), false);
});

test("paused denies access unless configured", () => {
  assert.equal(subscriptionGrantsAccess(sub({ status: "paused" }), now, config), false);
  assert.equal(subscriptionGrantsAccess(sub({ status: "paused" }), now, { ...config, pausedKeepsAccess: true }), true);
});

test("unknown statuses and plans grant nothing", () => {
  for (const status of ["canceled", "expired", "pending", "on_hold", "weird"]) {
    assert.equal(subscriptionGrantsAccess(sub({ status }), now, config), false, status);
  }
  assert.equal(subscriptionGrantsAccess(sub({ plan: null }), now, config), false);
});

test("no subscriptions means the baseline with today's limits", () => {
  const e = computeEntitlement([], [], now, config);
  assert.equal(e.plan, "free");
  assert.equal(e.limits.maxFileBytes, 25 * 1024 * 1024);
  assert.equal(e.subscription, null);
  assert.equal(e.lifetime, null);
});

test("the highest granting subscription wins and duplicates are flagged", () => {
  const e = computeEntitlement([sub({ id: "a", plan: "starter" }), sub({ id: "b", plan: "pro" }), sub({ id: "c", plan: "pro", status: "canceled" })], [], now, config);
  assert.equal(e.plan, "pro");
  assert.equal(e.subscription.id, "b");
  assert.equal(e.hasDuplicateSubscriptions, true);
});

test("Lifetime grants Advanced with no expiry, and outranks subscriptions", () => {
  const life = { id: "l1", plan: "advanced", status: "active", purchased_at: new Date("2020-01-01") };
  const e = computeEntitlement([], [life], new Date("2090-01-01"), config);
  assert.equal(e.plan, "advanced");
  assert.equal(e.planName, "Advanced Lifetime");
  assert.equal(e.lifetime.id, "l1");
  assert.equal(e.subscription, null);
  const both = computeEntitlement([sub({ plan: "pro" })], [life], now, config);
  assert.equal(both.plan, "advanced");
  assert.equal(both.hasDuplicateSubscriptions, true);
  assert.equal(computeEntitlement([], [{ ...life, status: "revoked" }], now, config).plan, "free");
});
