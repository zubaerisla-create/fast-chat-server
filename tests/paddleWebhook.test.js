const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { setPaddleClientForTests } = require("../services/paddleBilling");
const { getEntitlement } = require("../services/entitlements");

let srv;
let user;
const DAY = 86400000;

test.before(async () => {
  setPaddleClientForTests(h.paddleStub().stub);
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});
test.beforeEach(async () => {
  await h.resetDb();
  user = await h.createUser("alice");
  await h.query("INSERT INTO billing_customers (user_id, provider, provider_customer_id, email) VALUES ($1, 'paddle', 'ctm_1', $2)", [user.id, user.email]);
});

const deliver = (evt, { signature, body } = {}) => {
  const raw = body ?? JSON.stringify(evt);
  return srv.call("POST", "/api/billing/webhooks/paddle", {
    raw,
    headers: { "content-type": "application/json", "paddle-signature": signature ?? h.sign(raw) },
  });
};
const subRow = async (id = "sub_1") => (await h.query("SELECT * FROM subscriptions WHERE provider_subscription_id = $1", [id])).rows[0];
const eventRow = async (id) => (await h.query("SELECT * FROM webhook_events WHERE event_id = $1", [id])).rows[0];

test("rejects a bad signature with a non-2xx status and stores nothing", async () => {
  const evt = h.event("subscription.created", h.subscriptionPayload({}));
  const raw = JSON.stringify(evt);
  for (const signature of [h.sign(raw, "wrong-secret"), "garbage", h.sign(raw, h.WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 60)]) {
    const res = await deliver(evt, { signature });
    assert.equal(res.status, 401, signature);
  }
  const missing = await srv.call("POST", "/api/billing/webhooks/paddle", { raw, headers: { "content-type": "application/json" } });
  assert.equal(missing.status, 400);
  assert.equal(await subRow(), undefined);
  assert.equal((await h.query("SELECT COUNT(*)::int AS n FROM webhook_events")).rows[0].n, 0);
});

test("a body changed after signing is rejected", async () => {
  const evt = h.event("subscription.created", h.subscriptionPayload({}));
  const signed = h.sign(JSON.stringify(evt));
  const tampered = JSON.stringify({ ...evt, data: h.subscriptionPayload({ priceId: h.PRICES.pro_year }) });
  assert.equal((await deliver(evt, { signature: signed, body: tampered })).status, 401);
});

test("subscription.created stores a trialing subscription and grants trial access", async () => {
  const trialEnd = Date.now() + 7 * DAY;
  const evt = h.event("subscription.created", h.subscriptionPayload({ status: "trialing", trialEnd }));
  const res = await deliver(evt);
  assert.equal(res.status, 200);

  const row = await subRow();
  assert.equal(row.user_id, user.id);
  assert.equal(row.plan, "starter");
  assert.equal(row.billing_interval, "month");
  assert.equal(row.status, "trialing");
  assert.equal(new Date(row.trial_end).getTime(), new Date(new Date(trialEnd).toISOString()).getTime());
  assert.equal((await eventRow(evt.event_id)).status, "processed");

  const ent = await getEntitlement(user.id);
  assert.equal(ent.plan, "starter");
  assert.equal(ent.limits.maxFileBytes, 50 * 1024 * 1024);
});

test("duplicate delivery is acknowledged without being applied twice", async () => {
  const evt = h.event("subscription.created", h.subscriptionPayload({ status: "active" }));
  assert.equal((await deliver(evt)).status, 200);
  // Change the row behind the webhook's back; a re-applied duplicate would overwrite it
  await h.query("UPDATE subscriptions SET status = 'sentinel' WHERE provider_subscription_id = 'sub_1'");
  const again = await deliver(evt);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal((await subRow()).status, "sentinel");
  assert.equal((await h.query("SELECT COUNT(*)::int AS n FROM subscriptions")).rows[0].n, 1);
});

test("an older event delivered late never overwrites newer state", async () => {
  const t0 = Date.now() - 60000;
  const newer = h.event("subscription.updated", h.subscriptionPayload({ status: "active", priceId: h.PRICES.pro_month, updatedAt: t0 + 30000 }));
  const older = h.event("subscription.updated", h.subscriptionPayload({ status: "trialing", priceId: h.PRICES.starter_month, updatedAt: t0 }));
  await deliver(newer);
  const res = await deliver(older);
  assert.equal(res.status, 200);
  assert.equal((await eventRow(older.event_id)).status, "ignored");
  const row = await subRow();
  assert.equal(row.status, "active");
  assert.equal(row.plan, "pro");
});

test("a scheduled cancellation keeps access; the cancellation itself removes it", async () => {
  const t = Date.now() - 10000;
  const effectiveAt = new Date(Date.now() + 10 * DAY).toISOString();
  await deliver(h.event("subscription.updated", h.subscriptionPayload({ status: "active", updatedAt: t, scheduledChange: { action: "cancel", effective_at: effectiveAt, resume_at: null } })));
  let row = await subRow();
  assert.equal(row.scheduled_change_action, "cancel");
  assert.equal((await getEntitlement(user.id)).plan, "starter");

  await deliver(h.event("subscription.canceled", h.subscriptionPayload({ status: "canceled", updatedAt: t + 5000, canceledAt: new Date().toISOString() })));
  row = await subRow();
  assert.equal(row.status, "canceled");
  assert.ok(row.canceled_at);
  assert.equal((await getEntitlement(user.id)).plan, "free");
});

test("past_due records when it started and clears once paid", async () => {
  const t = Date.now() - 10000;
  await deliver(h.event("subscription.past_due", h.subscriptionPayload({ status: "past_due", updatedAt: t })));
  const first = (await subRow()).past_due_since;
  assert.ok(first);
  await deliver(h.event("subscription.updated", h.subscriptionPayload({ status: "past_due", updatedAt: t + 1000 })));
  assert.equal((await subRow()).past_due_since.getTime(), first.getTime(), "start of past_due is kept");
  assert.equal((await getEntitlement(user.id)).plan, "starter", "within the grace period");
  await deliver(h.event("subscription.updated", h.subscriptionPayload({ status: "active", updatedAt: t + 2000 })));
  assert.equal((await subRow()).past_due_since, null);
});

test("transaction.completed is recorded and sets the recurring amount", async () => {
  await deliver(h.event("subscription.created", h.subscriptionPayload({ status: "active" })));
  const txn = {
    id: "txn_1",
    status: "completed",
    customer_id: "ctm_1",
    address_id: "add_1",
    business_id: null,
    custom_data: null,
    origin: "subscription_recurring",
    collection_mode: "automatic",
    subscription_id: "sub_1",
    invoice_id: null,
    invoice_number: null,
    billing_details: null,
    billing_period: null,
    currency_code: "GBP",
    discount_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    billed_at: new Date().toISOString(),
    items: [],
    details: { totals: { subtotal: "800", discount: "0", tax: "160", total: "960", credit: "0", balance: "0", grand_total: "960", fee: null, earnings: null, currency_code: "GBP" }, line_items: [], payout_totals: null, adjusted_payout_totals: null, tax_rates_used: [] },
    payments: [],
    checkout: null,
  };
  const res = await deliver(h.event("transaction.completed", txn));
  assert.equal(res.status, 200);
  const t = (await h.query("SELECT * FROM billing_transactions WHERE provider_transaction_id = 'txn_1'")).rows[0];
  assert.equal(t.user_id, user.id);
  assert.equal(Number(t.total_minor), 960);
  const s = await subRow();
  assert.equal(Number(s.recurring_amount_minor), 800);
  assert.equal(s.currency_code, "GBP");
});

test("subscriptions of unknown customers are stored but grant nobody access", async () => {
  await deliver(h.event("subscription.created", h.subscriptionPayload({ id: "sub_x", customerId: "ctm_unknown", status: "active" })));
  assert.equal((await subRow("sub_x")).user_id, null);
  assert.equal((await getEntitlement(user.id)).plan, "free");
});

test("unsupported events are acknowledged and marked ignored", async () => {
  const evt = h.event("address.created", { id: "add_1", customer_id: "ctm_1", country_code: "GB", status: "active", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const res = await deliver(evt);
  assert.equal(res.status, 200);
  assert.equal((await eventRow(evt.event_id)).status, "ignored");
});

test("past_due beyond the grace period removes access; the cancellation after failed retries keeps it removed", async () => {
  const t = Date.now() - 10000;
  await deliver(h.event("subscription.past_due", h.subscriptionPayload({ status: "past_due", updatedAt: t })));
  await h.query("UPDATE subscriptions SET past_due_since = NOW() - INTERVAL '8 days'");
  assert.equal((await getEntitlement(user.id)).plan, "free", "grace period over");
  await deliver(h.event("subscription.canceled", h.subscriptionPayload({ status: "canceled", updatedAt: t + 1000, canceledAt: new Date().toISOString() })));
  assert.equal((await getEntitlement(user.id)).plan, "free");
});

test("a renewal moves the billing period forward and keeps access", async () => {
  const t = Date.now() - 10000;
  await deliver(h.event("subscription.activated", h.subscriptionPayload({ status: "active", updatedAt: t })));
  const nextEnd = Date.now() + 60 * DAY;
  await deliver(h.event("subscription.updated", h.subscriptionPayload({ status: "active", updatedAt: t + 1000, periodStart: Date.now(), periodEnd: nextEnd })));
  assert.equal((await subRow()).current_period_end.getTime(), new Date(new Date(nextEnd).toISOString()).getTime());
  assert.equal((await getEntitlement(user.id)).plan, "starter");
});

// ─── Advanced Lifetime ───────────────────────────────────────────────────────

const lifetimeRow = async (txn = "txn_life") => (await h.query("SELECT * FROM lifetime_purchases WHERE provider_transaction_id = $1", [txn])).rows[0];

test("a completed Lifetime transaction grants permanent Advanced access", async () => {
  const res = await deliver(h.event("transaction.completed", h.transactionPayload({ id: "txn_life" })));
  assert.equal(res.status, 200);
  const row = await lifetimeRow();
  assert.equal(row.user_id, user.id);
  assert.equal(row.plan, "advanced");
  assert.equal(row.status, "active");
  assert.equal(Number(row.total_minor), 100000);

  const ent = await getEntitlement(user.id);
  assert.equal(ent.plan, "advanced");
  assert.ok(ent.lifetime);
  assert.equal(ent.subscription, null);
  // No expiry: still granted far in the future
  assert.equal((await getEntitlement(user.id, new Date(Date.now() + 50 * 365 * DAY))).plan, "advanced");
  const t = (await h.query("SELECT price_id FROM billing_transactions WHERE provider_transaction_id = 'txn_life'")).rows[0];
  assert.equal(t.price_id, h.PRICES.advanced_lifetime);
});

test("transaction.paid then transaction.completed (and replays) create one Lifetime purchase", async () => {
  const paid = h.event("transaction.paid", h.transactionPayload({ id: "txn_life", status: "paid" }));
  const completed = h.event("transaction.completed", h.transactionPayload({ id: "txn_life", status: "completed" }));
  await deliver(paid);
  await deliver(completed);
  const replay = await deliver(completed);
  assert.equal(replay.body.duplicate, true);
  assert.equal((await h.query("SELECT COUNT(*)::int AS n FROM lifetime_purchases")).rows[0].n, 1);
});

test("an unpaid or unrelated transaction never grants Lifetime", async () => {
  await deliver(h.event("transaction.updated", h.transactionPayload({ id: "txn_a", status: "ready" })));
  await deliver(h.event("transaction.completed", h.transactionPayload({ id: "txn_b", priceId: h.PRICES.pro_year, subscriptionId: "sub_9", total: "4000" })));
  await deliver(h.event("transaction.completed", h.transactionPayload({ id: "txn_c", priceId: "pri_someone_elses" })));
  assert.equal((await h.query("SELECT COUNT(*)::int AS n FROM lifetime_purchases")).rows[0].n, 0);
  assert.equal((await getEntitlement(user.id)).plan, "free");
});

test("Lifetime outranks a subscription and later subscription events don't remove it", async () => {
  const t = Date.now() - 10000;
  await deliver(h.event("subscription.created", h.subscriptionPayload({ status: "active", priceId: h.PRICES.pro_year, updatedAt: t })));
  await deliver(h.event("transaction.completed", h.transactionPayload({ id: "txn_life" })));
  let ent = await getEntitlement(user.id);
  assert.equal(ent.plan, "advanced");
  assert.equal(ent.hasDuplicateSubscriptions, true, "user is told to cancel the subscription");
  await deliver(h.event("subscription.canceled", h.subscriptionPayload({ status: "canceled", priceId: h.PRICES.pro_year, updatedAt: t + 1000 })));
  ent = await getEntitlement(user.id);
  assert.equal(ent.plan, "advanced");
  assert.equal(ent.hasDuplicateSubscriptions, false);
});

test("a Lifetime purchase by an unlinked customer is stored but grants nobody access", async () => {
  await deliver(h.event("transaction.completed", h.transactionPayload({ id: "txn_life", customerId: "ctm_unknown" })));
  assert.equal((await lifetimeRow()).user_id, null);
  assert.equal((await getEntitlement(user.id)).plan, "free");
});

test("an admin-revoked Lifetime purchase stops granting access", async () => {
  await deliver(h.event("transaction.completed", h.transactionPayload({ id: "txn_life" })));
  await h.query("UPDATE lifetime_purchases SET status = 'revoked', revoked_at = NOW()");
  assert.equal((await getEntitlement(user.id)).plan, "free");
});
