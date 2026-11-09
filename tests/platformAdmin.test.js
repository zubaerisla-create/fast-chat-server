const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

let srv;
test.before(async () => {
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});

test("platform admin endpoints are admin-only and built from real tables", async () => {
  await h.resetDb();
  const admin = await h.createUser("boss", { role: "admin" });
  const user = await h.createUser("regular");
  await srv.call("POST", "/api/workspaces", { token: user.token, body: { name: "Team One" } });
  for (const url of ["/api/admin/overview", "/api/admin/users", "/api/admin/organizations", "/api/admin/audit", "/api/admin/reports"]) {
    assert.equal((await srv.call("GET", url, { token: user.token })).status, 403, url);
    assert.equal((await srv.call("GET", url)).status, 401, url);
  }
  const o = (await srv.call("GET", "/api/admin/overview?days=7", { token: admin.token })).body;
  assert.equal(o.users.total, 2);
  assert.equal(o.organizations.workspaces, 1);
  assert.equal(o.signupsByDay.length, 7);
  assert.equal(o.signupsByDay.at(-1).signups, 2);
  const users = (await srv.call("GET", "/api/admin/users?q=reg", { token: admin.token })).body;
  assert.equal(users.total, 1);
  assert.equal(users.users[0].workspaces, 1);
  assert.equal((await srv.call("GET", "/api/admin/organizations", { token: admin.token })).body.organizations[0].name, "Team One");
  assert.ok((await srv.call("GET", "/api/admin/audit", { token: admin.token })).body.events.some((e) => e.action === "workspace.create"));
});

test("usage endpoint reports storage, workspaces and per-workspace limits", async () => {
  await h.resetDb();
  const u = await h.createUser("usage");
  const ws = (await srv.call("POST", "/api/workspaces", { token: u.token, body: { name: "Mine" } })).body.workspace;
  await srv.call("POST", `/api/workspaces/${ws.id}/invitations`, { token: u.token, body: { emails: ["a@example.test"] } });
  const res = (await srv.call("GET", "/api/billing/usage", { token: u.token })).body;
  assert.equal(res.plan.id, "free");
  assert.deepEqual(res.usage.workspaces, { used: 1, limit: 1 });
  assert.deepEqual(res.workspaces[0].members, { used: 2, limit: 10 });
  assert.deepEqual(res.workspaces[0].channels, { used: 2, limit: 5 });
  assert.equal(res.usage.storage.used, 0);
});
