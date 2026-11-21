/**
 * Fast Finance sign-up trial cutoff: accounts created after the cutoff get no automatic trial
 * (Pro only via Google Play), older accounts keep the old 7-day rule, and existing rows —
 * including a running trial — are never changed.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { FinanceSubscription } = require("../models/FinanceSubscription");

let srv;
const day = 24 * 60 * 60 * 1000;
const setCutoff = (iso) => h.query(`INSERT INTO app_settings (key, value) VALUES ('finance_signup_trial_cutoff', to_jsonb($1::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [iso]);
const rowHash = async (id) => (await h.query(`SELECT md5(finance_subscriptions::text) AS m FROM finance_subscriptions WHERE user_id = $1`, [id])).rows[0]?.m;
const backdate = (id, ms) => h.query(`UPDATE users SET created_at = $2 WHERE id = $1`, [id, new Date(Date.now() - ms).toISOString()]);
const createdAt = async (id) => (await h.query(`SELECT created_at FROM users WHERE id = $1`, [id])).rows[0].created_at;

test.before(async () => {
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});
test.beforeEach(async () => {
  await h.resetDb();
  await h.query("TRUNCATE finance_subscriptions CASCADE");
});

test("schema sets the cutoff once and keeps it on later starts", async () => {
  await h.query(`DELETE FROM app_settings WHERE key = 'finance_signup_trial_cutoff'`);
  await h.query(`INSERT INTO app_settings (key, value) VALUES ('finance_signup_trial_cutoff', to_jsonb(NOW())) ON CONFLICT (key) DO NOTHING`);
  const first = await FinanceSubscription.signupTrialCutoff();
  await new Promise((r) => setTimeout(r, 20));
  await h.query(`INSERT INTO app_settings (key, value) VALUES ('finance_signup_trial_cutoff', to_jsonb(NOW())) ON CONFLICT (key) DO NOTHING`);
  assert.equal((await FinanceSubscription.signupTrialCutoff()).getTime(), first.getTime());
});

test("a new account (after the cutoff) gets no automatic trial", async () => {
  await setCutoff(new Date(Date.now() - day).toISOString());
  const u = await h.createUser("fresh_user");
  const res = await srv.call("GET", "/api/finance/subscription", { token: u.token });
  assert.equal(res.status, 200);
  const sub = res.body.subscription;
  assert.equal(sub.hasAccess, false);
  assert.equal(sub.isTrial, false);
  assert.equal(sub.hadTrial, false);
  assert.equal(sub.status, "free");
  // Paid action: 402 with the Google Play trial wording
  const goal = await srv.call("POST", "/api/finance/goals", { token: u.token, body: { title: "Car", targetAmount: 1000 } });
  assert.equal(goal.status, 402);
  assert.match(goal.body.message, /7-day free trial in Google Play/);
});

test("an account created before the cutoff keeps the old 7-day rule", async () => {
  await setCutoff(new Date(Date.now() + day).toISOString());
  const u = await h.createUser("older_user");
  await backdate(u.id, 2 * day);
  const sub = await FinanceSubscription.getForUser(u.id, await createdAt(u.id));
  assert.equal(sub.hasAccess, true);
  assert.equal(sub.isTrial, true);
  assert.equal(sub.status, "trialing");
  assert.ok(sub.daysLeft >= 4 && sub.daysLeft <= 5, String(sub.daysLeft));
  // …and one whose 7 days are long over shows "trial ended", not "free"
  const old = await h.createUser("very_old_user");
  await backdate(old.id, 30 * day);
  const oldSub = await FinanceSubscription.getForUser(old.id, await createdAt(old.id));
  assert.equal(oldSub.hasAccess, false);
  assert.equal(oldSub.hadTrial, true);
  assert.equal(oldSub.status, "expired");
  const goal = await srv.call("POST", "/api/finance/goals", { token: old.token, body: { title: "Car", targetAmount: 1000 } });
  assert.match(goal.body.message, /free trial has ended/);
});

test("an existing row — e.g. a running trial — is never changed by the new rule", async () => {
  await setCutoff(new Date(Date.now() + day).toISOString());
  const u = await h.createUser("trial_user");
  await FinanceSubscription.getForUser(u.id, await createdAt(u.id)); // trial row under the old rule
  const before = await rowHash(u.id);
  // Cutoff moves to "now" (deploy) — reading, status checks, paid actions and a RevenueCat-less sync
  await setCutoff(new Date(Date.now() - 1000).toISOString());
  for (let i = 0; i < 3; i++) await srv.call("GET", "/api/finance/subscription", { token: u.token });
  const goal = await srv.call("POST", "/api/finance/goals", { token: u.token, body: { title: "Trip", targetAmount: 50 } });
  assert.equal(goal.status, 201, "the running trial still works");
  delete process.env.REVENUECAT_SECRET_KEY;
  await srv.call("POST", "/api/finance/subscription/sync", { token: u.token });
  assert.equal(await rowHash(u.id), before, "row unchanged");
});

test("without a cutoff setting nobody gets an automatic trial (fail closed)", async () => {
  await h.query(`DELETE FROM app_settings WHERE key = 'finance_signup_trial_cutoff'`);
  const u = await h.createUser("no_cutoff_user");
  const sub = await FinanceSubscription.getForUser(u.id, await createdAt(u.id));
  assert.equal(sub.hasAccess, false);
  assert.equal(sub.status, "free");
});
