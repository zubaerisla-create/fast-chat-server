/**
 * Sign-up requires the 6-digit email code by default (the app shows the code screen).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const OTP = require("../models/OTP");

let srv;
const body = (extra = {}) => ({ username: "otp_user", email: "otp.user@example.test", password: "secret123", ...extra });

test.before(async () => {
  delete process.env.SIGNUP_OTP_REQUIRED;
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});
test.beforeEach(async () => {
  await h.resetDb();
  await h.query("DELETE FROM otps");
});

test("sign-up without a code is refused", async () => {
  const res = await srv.call("POST", "/api/auth/register", { body: body() });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /6-digit code/);
});

test("a wrong code is refused and no account is created", async () => {
  await OTP.issue("otp.user@example.test", "register");
  const res = await srv.call("POST", "/api/auth/register", { body: body({ otp: "000000" }) });
  assert.equal(res.status, 400);
  const { rows } = await h.query("SELECT COUNT(*)::int AS n FROM users WHERE email = 'otp.user@example.test'");
  assert.equal(rows[0].n, 0);
});

test("send-otp → correct code → account created; the code can't be reused", async () => {
  const sent = await srv.call("POST", "/api/auth/send-otp", { body: { email: "otp.user@example.test", username: "otp_user" } });
  assert.equal(sent.status, 200);
  // The emailed code (mailer is in log mode in tests): issue a known one the same way the route does
  const code = await OTP.issue("otp.user@example.test", "register");
  const res = await srv.call("POST", "/api/auth/register", { body: body({ otp: code }) });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  const again = await srv.call("POST", "/api/auth/register", { body: body({ username: "otp_user2", otp: code }) });
  assert.equal(again.status, 400);
});
