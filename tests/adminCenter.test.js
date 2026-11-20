/** Admin control center API: roles and permissions, audited actions, game & settings controls. */
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const catalog = require("../services/gameCatalog");
const access = require("../services/gameEntitlements");
const { provisionOwner } = require("../services/adminRoles");

let srv, boss, support, gm, analyst, plain, friend;
const PASS = "admin-pass-1";

test.before(async () => {
  await h.resetDb();
  await h.query("TRUNCATE game_registry, app_settings, admin_users, admin_audit_logs, user_entitlements CASCADE");
  catalog.invalidate();
  await catalog.syncBuiltins();
  srv = await h.startServer({ socketOptions: { games: { countdownMs: 30 } } });
  const mk = async (name) => {
    const r = await srv.call("POST", "/api/auth/register", { body: { username: name, email: `${name}@example.test`, password: PASS } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.user.id, email: `${name}@example.test`, token: r.body.token };
  };
  boss = await mk("boss");
  support = await mk("supporter");
  gm = await mk("gamemgr");
  analyst = await mk("analyst");
  plain = await mk("plainuser");
  friend = await mk("friend");
  await provisionOwner(boss.id);
  await h.query("INSERT INTO admin_users (user_id, role) VALUES ($1, 'support'), ($2, 'game_manager'), ($3, 'analyst')", [support.id, gm.id, analyst.id]);
  await h.query("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'accepted')", [plain.id, friend.id]);
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});

const adminLogin = async (u) => {
  const r = await srv.call("POST", "/api/admin-center/auth/login", { body: { email: u.email, password: PASS } });
  return r;
};
const as = (token) => ({
  get: (url) => srv.call("GET", `/api/admin-center${url}`, { token }),
  post: (url, body) => srv.call("POST", `/api/admin-center${url}`, { token, body }),
  patch: (url, body) => srv.call("PATCH", `/api/admin-center${url}`, { token, body }),
  put: (url, body) => srv.call("PUT", `/api/admin-center${url}`, { token, body }),
});

let B, S, G, A;
test("admin login: only admin roles get a session; regular users and wrong passwords are refused", async () => {
  const no = await adminLogin(plain);
  assert.equal(no.status, 403);
  assert.equal(no.body.code, "not_admin");
  assert.equal((await srv.call("POST", "/api/admin-center/auth/login", { body: { email: boss.email, password: "wrong" } })).status, 401);
  const b = await adminLogin(boss);
  assert.equal(b.status, 200);
  assert.equal(b.body.role, "super_admin");
  assert.ok(b.body.permissions.includes("admins.manage"));
  B = as(b.body.token);
  S = as((await adminLogin(support)).body.token);
  G = as((await adminLogin(gm)).body.token);
  A = as((await adminLogin(analyst)).body.token);
  // A normal app token of a non-admin can't use the API either
  assert.equal((await as(plain.token).get("/dashboard")).status, 403);
  assert.equal((await srv.call("GET", "/api/admin-center/dashboard")).status, 401);
});

test("permission matrix: each role sees and changes only what it may", async () => {
  assert.equal((await A.get("/dashboard")).status, 200);
  assert.equal((await A.get("/analytics")).status, 200);
  assert.equal((await A.get("/users")).status, 403, "analyst can't read user PII");
  assert.equal((await A.patch("/games/chess", { status: "hidden" })).status, 403, "analyst is read-only");
  assert.equal((await A.put("/settings/daily_match_limit", { value: 5 })).status, 403);

  assert.equal((await S.get("/users")).status, 200);
  assert.equal((await S.patch("/games/chess", { status: "hidden" })).status, 403, "support can't manage games");
  assert.equal((await S.post(`/users/${plain.id}/entitlements/promo`, { reason: "gift" })).status, 403, "support can't grant access");

  assert.equal((await G.get("/users")).status, 403, "game manager can't read users");
  assert.equal((await G.get("/games")).status, 200);
  assert.equal((await G.get("/admins")).status, 403);
  assert.equal((await B.get("/admins")).status, 200);
});

test("dashboard and analytics return real counts", async () => {
  const d = await B.get("/dashboard");
  assert.equal(d.status, 200);
  assert.equal(d.body.totals.users, 6);
  assert.equal(d.body.totals.ownerAccounts, 1);
  assert.equal(d.body.totals.lifetimeUsers, 1);
  assert.equal(d.body.charts.registrations.length, 30);
  const a = await A.get("/analytics?days=7");
  assert.equal(a.body.dau.length, 7);
  assert.deepEqual(a.body.freeVsLifetime, { free: 5, lifetime: 1 });
});

test("users: search, profile with access/sessions, suspend (revokes sessions) and reactivate — all audited", async () => {
  const list = await S.get("/users?q=plainuser");
  assert.equal(list.body.users.length, 1);
  const detail = await S.get(`/users/${plain.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.gameAccess.lifetime, false);
  assert.ok(detail.body.sessions.length >= 1);
  assert.equal((await S.post(`/users/${plain.id}/suspend`, {})).status, 400, "reason required");
  assert.equal((await S.post(`/users/${plain.id}/suspend`, { reason: "spam reports" })).status, 200);
  assert.equal((await srv.call("GET", "/api/games/access", { token: plain.token })).status, 403);
  assert.equal((await S.post(`/users/${plain.id}/reactivate`, { reason: "appeal accepted" })).status, 200);
  // Suspension ended every session: the user signs in again
  assert.equal((await srv.call("GET", "/api/games/access", { token: plain.token })).status, 401);
  plain.token = (await srv.call("POST", "/api/auth/login", { body: { email: plain.email, password: PASS } })).body.token;
  const log = await B.get("/audit?targetType=user");
  const actions = log.body.entries.map((e) => e.action);
  assert.ok(actions.includes("user.suspend") && actions.includes("user.reactivate"));
  const sus = log.body.entries.find((e) => e.action === "user.suspend");
  assert.deepEqual([sus.reason, sus.previous.status, sus.next.status], ["spam reports", "active", "suspended"]);
  assert.ok(sus.ip !== undefined && sus.admin_username === "supporter");
});

test("promotional Games Lifetime: grant needs a reason, revoke needs confirmation, owner access can't be touched", async () => {
  assert.equal((await B.post(`/users/${plain.id}/entitlements/promo`, {})).status, 400);
  const g = await B.post(`/users/${plain.id}/entitlements/promo`, { reason: "contest winner" });
  assert.equal(g.status, 200);
  assert.equal(g.body.access.lifetime, true);
  assert.equal((await B.post(`/users/${plain.id}/entitlements/promo/revoke`, { reason: "ended" })).status, 400, "needs confirm");
  const r = await B.post(`/users/${plain.id}/entitlements/promo/revoke`, { reason: "ended", confirm: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.access.lifetime, false);
  // The owner's access is not a promo: revoking promo for the owner finds nothing and the owner keeps access
  assert.equal((await B.post(`/users/${boss.id}/entitlements/promo/revoke`, { reason: "test", confirm: true })).status, 404);
  assert.equal(await access.hasGamesLifetime(boss.id), true);
  // Reconcile needs RevenueCat configured — never fabricates purchases
  assert.equal((await B.post(`/users/${plain.id}/reconcile`, {})).status, 503);
});

test("game controls are enforced by the API: maintenance blocks matches, tier changes apply to every user", async () => {
  assert.equal((await G.patch("/games/connect4", { status: "nonsense" })).status, 400);
  assert.equal((await G.patch("/games/connect4", { status: "maintenance", reason: "fixing a bug" })).status, 200);
  const sock = await srv.socket(plain.token);
  const call = (e, p) => new Promise((r) => sock.emit(e, p, r));
  assert.equal((await call("game:invite", { game: "connect4", toUserId: friend.id })).error, "game_unavailable");
  assert.equal((await G.patch("/games/connect4", { status: "active" })).status, 200);
  catalog.invalidate();
  // Make Medium AI premium in chess, then free again
  const games = (await G.get("/games")).body.games;
  const chess = games.find((x) => x.id === "chess");
  const features = { ...chess.features, ai_medium: { ...chess.features.ai_medium, tier: "premium" } };
  assert.equal((await G.patch("/games/chess", { features })).status, 200);
  let acc = (await srv.call("GET", "/api/games/access", { token: plain.token })).body;
  assert.equal(acc.games.chess.features.ai_medium, false);
  // Built-in features can't be removed (the app depends on them)
  const { ai_medium, ...without } = features;
  assert.equal((await G.patch("/games/chess", { features: without })).status, 400);
  features.ai_medium.tier = "free";
  await G.patch("/games/chess", { features });
  acc = (await srv.call("GET", "/api/games/access", { token: plain.token })).body;
  assert.equal(acc.games.chess.features.ai_medium, true);
  // Hidden games disappear from the public catalog
  await G.patch("/games/jungle", { status: "hidden" });
  const cat = await srv.call("GET", "/api/games/catalog");
  assert.ok(!cat.body.games.some((x) => x.id === "jungle"));
  await G.patch("/games/jungle", { status: "active" });
  sock.close();
});

test("new games join the registry on the universal entitlement", async () => {
  const bad = await G.post("/games", { id: "Bad Id", name: "x" });
  assert.equal(bad.status, 400);
  const r = await G.post("/games", { id: "ludo", name: "Ludo", features: { online_play: { label: "Online", tier: "free" }, ai_hard: { label: "Hard AI", tier: "premium" } } });
  assert.equal(r.status, 201);
  assert.equal(r.body.game.status, "hidden", "new games start hidden");
  assert.equal(await access.canAccessGameFeature(plain.id, "ludo", "ai_hard"), false);
  assert.equal(await access.canAccessGameFeature(boss.id, "ludo", "ai_hard"), true, "owner / Games Lifetime covers future games automatically");
  assert.equal((await G.post("/games", { id: "ludo", name: "Again" })).status, 409);
});

test("settings: the global daily limit is validated, persisted and used by the API", async () => {
  assert.equal((await G.put("/settings/daily_match_limit", { value: -1 })).status, 400);
  assert.equal((await G.put("/settings/daily_match_limit", { value: 5 })).status, 200);
  catalog.invalidate();
  const acc = (await srv.call("GET", "/api/games/access", { token: plain.token })).body;
  assert.equal(acc.quota.limit, 5);
  assert.equal((await G.put("/settings/announcement", { value: { text: "Tournament on Friday!", tone: "info", active: true } })).status, 200);
  catalog.invalidate();
  assert.equal((await srv.call("GET", "/api/games/catalog")).body.announcement.text, "Tournament on Friday!");
  assert.equal((await G.put("/settings/unknown_key", { value: 1 })).status, 400);
});

test("admins: only super admins manage roles; you can't change yourself or remove the last super admin", async () => {
  assert.equal((await B.put(`/admins/${boss.id}`, { role: null, reason: "x-test" })).status, 400, "not yourself");
  assert.equal((await B.put(`/admins/${plain.id}`, { role: "support", reason: "new hire" })).status, 200);
  assert.equal((await B.put(`/admins/${plain.id}`, { role: "emperor", reason: "nope" })).status, 400);
  assert.equal((await B.put(`/admins/${plain.id}`, { role: null, reason: "left the team" })).status, 200);
  assert.equal((await as(plain.token).get("/users")).status, 403);
  const log = (await B.get("/audit?targetType=admin")).body.entries;
  assert.ok(log.some((e) => e.action === "admin.role" && e.reason === "new hire"));
});

test("matches: live list and admin cancel of a running match", async () => {
  const a = await srv.socket(plain.token);
  const b = await srv.socket(friend.token);
  const call = (s, e, p) => new Promise((r) => s.emit(e, p, r));
  const invited = new Promise((r) => b.once("game:invited", r));
  assert.equal((await call(a, "game:invite", { game: "connect4", toUserId: friend.id })).ok, true);
  const { inviteId } = await invited;
  const { roomId } = await call(b, "game:invite:respond", { inviteId, accept: true });
  const list = await G.get("/matches");
  assert.ok(list.body.live.some((m) => m.roomId === roomId));
  assert.equal((await G.post(`/matches/${roomId}/cancel`, {})).status, 400, "reason required");
  const cancelled = new Promise((r) => a.on("game:state", (v) => v.status === "cancelled" && r(v)));
  assert.equal((await G.post(`/matches/${roomId}/cancel`, { reason: "abusive names" })).status, 200);
  assert.equal((await cancelled).result.reason, "admin_cancelled");
  assert.equal((await A.post(`/matches/${roomId}/cancel`, { reason: "x" })).status, 403);
  a.close();
  b.close();
});
