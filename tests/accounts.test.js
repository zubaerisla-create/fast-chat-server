/**
 * Email + password accounts without OTP: registration, sessions per device, revocation,
 * password change, link-based password reset, suspension and account deletion.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
process.env.SIGNUP_OTP_REQUIRED = "false"; // these tests cover accounts without the email-code step

let srv;
test.before(async () => {
  await h.resetDb();
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});

const register = (username, email, password = "secret123") => srv.call("POST", "/api/auth/register", { body: { username, email, password } });
const login = (email, password = "secret123", headers = {}) => srv.call("POST", "/api/auth/login", { body: { email, password }, headers });

/** Runs fn while capturing what the log mail transport prints. */
async function captureMail(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => (lines.push(a.join(" ")), undefined);
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

test("register with email + password only (no code), then log in; bad input is rejected", async () => {
  const r = await register("maya", "maya@example.test");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.token);
  assert.equal(r.body.user.email, "maya@example.test");
  assert.equal((await register("maya2", "maya@example.test")).status, 400); // duplicate email
  assert.equal((await register("maya", "other@example.test")).status, 400); // duplicate username
  assert.equal((await register("ok_name", "not-an-email")).status, 400);
  assert.equal((await register("ok_name", "short@example.test", "123")).status, 400);
  const l = await login("maya@example.test");
  assert.equal(l.status, 200);
  assert.equal((await login("maya@example.test", "wrong-pass")).status, 401);
  // The token works on a protected route
  assert.equal((await srv.call("GET", "/api/games/access", { token: l.body.token })).status, 200);
});

test("each login is its own session: list, revoke one device, sign out others, logout", async () => {
  await register("nils", "nils@example.test");
  const phone = (await login("nils@example.test", "secret123", { "x-device-name": "Pixel", "x-client-platform": "android" })).body.token;
  const laptop = (await login("nils@example.test", "secret123", { "user-agent": "Mozilla/5.0" })).body.token;
  const list = await srv.call("GET", "/api/auth/sessions", { token: phone });
  assert.equal(list.status, 200);
  const mine = list.body.sessions.filter((s) => s.current);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].deviceName, "Pixel");
  assert.ok(list.body.sessions.length >= 2);
  const laptopSession = list.body.sessions.find((s) => !s.current && s.platform === "web");
  assert.equal((await srv.call("DELETE", `/api/auth/sessions/${laptopSession.id}`, { token: phone })).status, 200);
  const dead = await srv.call("GET", "/api/games/access", { token: laptop });
  assert.equal(dead.status, 401);
  assert.equal(dead.body.code, "session_revoked");
  assert.equal((await srv.call("GET", "/api/games/access", { token: phone })).status, 200);

  // Token rotation keeps the session
  const rotated = (await srv.call("POST", "/api/auth/refresh", { token: phone })).body.token;
  assert.ok(rotated);
  assert.equal((await srv.call("GET", "/api/games/access", { token: rotated })).status, 200);

  const tablet = (await login("nils@example.test")).body.token;
  assert.equal((await srv.call("POST", "/api/auth/sessions/revoke-others", { token: rotated })).status, 200);
  assert.equal((await srv.call("GET", "/api/games/access", { token: tablet })).status, 401);
  assert.equal((await srv.call("GET", "/api/games/access", { token: rotated })).status, 200);

  assert.equal((await srv.call("POST", "/api/auth/logout", { token: rotated })).status, 200);
  assert.equal((await srv.call("GET", "/api/games/access", { token: rotated })).status, 401);
});

test("legacy tokens without a session still work until a revoke-all", async () => {
  const u = await h.createUser("legacy"); // token without sid, like tokens issued before sessions existed
  assert.equal((await srv.call("GET", "/api/games/access", { token: u.token })).status, 200);
  await h.query("UPDATE users SET sessions_revoked_at = NOW() + interval '2 seconds' WHERE id = $1", [u.id]);
  assert.equal((await srv.call("GET", "/api/games/access", { token: u.token })).status, 401);
});

test("change password: needs the current one, signs out other devices, returns a fresh token", async () => {
  await register("olga", "olga@example.test");
  const a = (await login("olga@example.test")).body.token;
  const b = (await login("olga@example.test")).body.token;
  assert.equal((await srv.call("POST", "/api/auth/change-password", { token: a, body: { currentPassword: "nope", newPassword: "newpass99" } })).status, 401);
  const ch = await srv.call("POST", "/api/auth/change-password", { token: a, body: { currentPassword: "secret123", newPassword: "newpass99" } });
  assert.equal(ch.status, 200);
  assert.equal((await srv.call("GET", "/api/games/access", { token: b })).status, 401);
  assert.equal((await srv.call("GET", "/api/games/access", { token: ch.body.token })).status, 200);
  assert.equal((await login("olga@example.test")).status, 401);
  assert.equal((await login("olga@example.test", "newpass99")).status, 200);
});

test("password reset by email link: single use, expires, signs everyone out; unknown emails look the same", async () => {
  await register("pia", "pia@example.test");
  const before = (await login("pia@example.test")).body.token;
  let res;
  const mail = await captureMail(async () => {
    res = await srv.call("POST", "/api/auth/password-reset/request", { body: { email: "pia@example.test" } });
  });
  assert.equal(res.status, 200);
  const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail)?.[1];
  assert.ok(token, "the email contains a reset link");
  // The token itself is not stored, only its hash
  const stored = await h.query("SELECT token_hash FROM password_reset_tokens WHERE token_hash = $1", [token]);
  assert.equal(stored.rows.length, 0);

  const unknown = await captureMail(async () => {
    res = await srv.call("POST", "/api/auth/password-reset/request", { body: { email: "nobody@example.test" } });
  });
  assert.equal(res.status, 200);
  assert.doesNotMatch(unknown, /reset-password\?token=/);

  assert.equal((await srv.call("POST", "/api/auth/password-reset/confirm", { body: { token: "x".repeat(40), newPassword: "brandnew1" } })).status, 400);
  assert.equal((await srv.call("POST", "/api/auth/password-reset/confirm", { body: { token, newPassword: "brandnew1" } })).status, 200);
  assert.equal((await srv.call("POST", "/api/auth/password-reset/confirm", { body: { token, newPassword: "again1234" } })).status, 400, "single use");
  assert.equal((await srv.call("GET", "/api/games/access", { token: before })).status, 401, "old sessions end");
  assert.equal((await login("pia@example.test", "brandnew1")).status, 200);

  // Expired links don't work
  let token2;
  await captureMail(async () => {
    await srv.call("POST", "/api/auth/password-reset/request", { body: { email: "pia@example.test" } });
  }).then((m) => (token2 = /token=([A-Za-z0-9_-]+)/.exec(m)[1]));
  await h.query("UPDATE password_reset_tokens SET expires_at = NOW() - interval '1 minute' WHERE used_at IS NULL");
  assert.equal((await srv.call("POST", "/api/auth/password-reset/confirm", { body: { token: token2, newPassword: "later1234" } })).status, 400);
});

test("suspended accounts can't log in or use existing tokens; deletion needs password + confirmation", async () => {
  await register("quinn", "quinn@example.test");
  const t = (await login("quinn@example.test")).body.token;
  await h.query("UPDATE users SET status = 'suspended' WHERE email = 'quinn@example.test'");
  const r = await srv.call("GET", "/api/games/access", { token: t });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "account_suspended");
  assert.equal((await login("quinn@example.test")).status, 403);
  await h.query("UPDATE users SET status = 'active' WHERE email = 'quinn@example.test'");
  const t2 = (await login("quinn@example.test")).body.token;
  assert.equal((await srv.call("DELETE", "/api/auth/account", { token: t2, body: { password: "secret123" } })).status, 400);
  assert.equal((await srv.call("DELETE", "/api/auth/account", { token: t2, body: { password: "bad", confirm: "DELETE" } })).status, 401);
  assert.equal((await srv.call("DELETE", "/api/auth/account", { token: t2, body: { password: "secret123", confirm: "DELETE" } })).status, 200);
  assert.equal((await h.query("SELECT 1 FROM users WHERE email = 'quinn@example.test'")).rows.length, 0);
  assert.equal((await srv.call("GET", "/api/games/access", { token: t2 })).status, 401);
});

test("sockets refuse revoked sessions and suspended accounts", async () => {
  await register("rita", "rita@example.test");
  const t = (await login("rita@example.test")).body.token;
  const s = await srv.socket(t);
  s.close();
  await srv.call("POST", "/api/auth/logout", { token: t });
  await assert.rejects(srv.socket(t), /Invalid token/);
});
