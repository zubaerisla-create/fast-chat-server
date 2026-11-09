const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

let srv;
let owner, admin, manager, member, guest, outsider;
let wsId;

test.before(async () => {
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});

const api = (user, method, url, body) => srv.call(method, url, { token: user?.token, body });

/** Invites `user` with `role` and accepts via the emailed token link. */
async function join(inviter, user, role) {
  const res = await api(inviter, "POST", `/api/workspaces/${wsId}/invitations`, { emails: [user.email], role });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const token = res.body.invitations[0].link.split("/invite/")[1];
  const acc = await api(user, "POST", `/api/invitations/${token}/accept`);
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  return token;
}

test.beforeEach(async () => {
  await h.resetDb();
  owner = await h.createUser("owner");
  admin = await h.createUser("admin1");
  manager = await h.createUser("manager1");
  member = await h.createUser("member1");
  guest = await h.createUser("guest1");
  outsider = await h.createUser("outsider");
  // Advanced Lifetime owner, so plan limits don't interfere unless a test wants them
  await h.query("INSERT INTO lifetime_purchases (user_id, provider, provider_transaction_id, plan) VALUES ($1, 'paddle', 'txn_owner', 'advanced')", [owner.id]);
  const res = await api(owner, "POST", "/api/workspaces", { name: "Hosen Soft" });
  assert.equal(res.status, 201);
  wsId = res.body.workspace.id;
  await join(owner, admin, "admin");
  await join(owner, manager, "manager");
  await join(owner, member, "member");
  await join(owner, guest, "guest");
});

test("creating a workspace makes an organization, the owner, #general and #announcements", async () => {
  const ws = (await api(owner, "GET", `/api/workspaces/${wsId}`)).body;
  assert.equal(ws.workspace.myRole, "owner");
  assert.equal(ws.workspace.slug, "hosen-soft");
  assert.equal(ws.workspace.memberCount, 5);
  assert.equal(ws.permissions["workspace.delete"], true);
  const channels = (await api(member, "GET", `/api/workspaces/${wsId}/channels`)).body.channels;
  assert.deepEqual(channels.map((c) => c.name), ["general", "announcements"]);
  assert.ok(channels.every((c) => c.joined), "new members join the default channels");
  const orgs = (await api(owner, "GET", "/api/organizations")).body.organizations;
  assert.equal(orgs[0].name, "Hosen Soft");
  assert.equal(orgs[0].isOwner, true);
});

test("outsiders can't see the workspace, its members, channels or messages", async () => {
  for (const url of [`/api/workspaces/${wsId}`, `/api/workspaces/${wsId}/members`, `/api/workspaces/${wsId}/channels`]) {
    assert.equal((await api(outsider, "GET", url)).status, 404, url);
  }
  const general = (await api(member, "GET", `/api/workspaces/${wsId}/channels`)).body.channels[0];
  assert.equal((await api(outsider, "GET", `/api/messages/${general.id}`)).status, 403);
  assert.equal((await api(outsider, "POST", "/api/messages", { conversationId: general.id, text: "hi" })).status, 403);
  assert.equal((await api(outsider, "GET", "/api/workspaces")).body.workspaces.length, 0);
});

test("RBAC: invites need manager+, roles only below your own, guests can't invite or browse", async () => {
  assert.equal((await api(member, "POST", `/api/workspaces/${wsId}/invitations`, { emails: ["x@example.test"] })).status, 403);
  assert.equal((await api(guest, "POST", `/api/workspaces/${wsId}/invitations`, { emails: ["x@example.test"] })).status, 403);
  assert.equal((await api(manager, "POST", `/api/workspaces/${wsId}/invitations`, { emails: ["x@example.test"], role: "admin" })).status, 403, "manager can't invite admins");
  assert.equal((await api(manager, "POST", `/api/workspaces/${wsId}/invitations`, { emails: ["x@example.test"], role: "member" })).status, 201);

  assert.equal((await api(admin, "PATCH", `/api/workspaces/${wsId}/members/${member.id}`, { role: "manager" })).status, 200);
  assert.equal((await api(admin, "PATCH", `/api/workspaces/${wsId}/members/${member.id}`, { role: "admin" })).status, 403, "admin can't create admins");
  assert.equal((await api(owner, "PATCH", `/api/workspaces/${wsId}/members/${member.id}`, { role: "admin" })).status, 200);
  assert.equal((await api(member, "PATCH", `/api/workspaces/${wsId}/members/${admin.id}`, { role: "member" })).status, 403, "admins can't demote admins");
  assert.equal((await api(owner, "PATCH", `/api/workspaces/${wsId}/members/${admin.id}`, { role: "owner" })).status, 400, "ownership only via transfer");

  // Guests: no browsing of public channels, no member emails
  const guestChannels = (await api(guest, "GET", `/api/workspaces/${wsId}/channels`)).body.channels;
  assert.equal(guestChannels.length, 0, "guests aren't auto-joined and can't browse");
  const guestMembers = (await api(guest, "GET", `/api/workspaces/${wsId}/members`)).body.members;
  assert.ok(guestMembers.every((m) => m.email === undefined));
  assert.ok((await api(member, "GET", `/api/workspaces/${wsId}/members`)).body.members.every((m) => m.email));
});

test("removing members: admins remove lower roles; removal drops channel access; the owner can't leave", async () => {
  assert.equal((await api(manager, "DELETE", `/api/workspaces/${wsId}/members/${member.id}`)).status, 403);
  assert.equal((await api(admin, "DELETE", `/api/workspaces/${wsId}/members/${owner.id}`)).status, 403);
  const general = (await api(member, "GET", `/api/workspaces/${wsId}/channels`)).body.channels[0];
  assert.equal((await api(admin, "DELETE", `/api/workspaces/${wsId}/members/${member.id}`)).status, 200);
  assert.equal((await api(member, "GET", `/api/workspaces/${wsId}`)).status, 404);
  assert.equal((await api(member, "POST", "/api/messages", { conversationId: general.id, text: "still here?" })).status, 403);
  assert.equal((await api(owner, "DELETE", `/api/workspaces/${wsId}/members/${owner.id}`)).status, 400);
  assert.equal((await api(manager, "DELETE", `/api/workspaces/${wsId}/members/${manager.id}`)).status, 200, "leave");
});

test("ownership transfer moves the owner role; there's always exactly one owner", async () => {
  assert.equal((await api(admin, "POST", `/api/workspaces/${wsId}/transfer`, { userId: admin.id })).status, 403);
  assert.equal((await api(owner, "POST", `/api/workspaces/${wsId}/transfer`, { userId: guest.id })).status, 400);
  assert.equal((await api(owner, "POST", `/api/workspaces/${wsId}/transfer`, { userId: admin.id })).status, 200);
  const roles = Object.fromEntries((await api(admin, "GET", `/api/workspaces/${wsId}/members`)).body.members.map((m) => [m.username, m.role]));
  assert.equal(roles.admin1, "owner");
  assert.equal(roles.owner, "admin");
  const owners = await h.query("SELECT COUNT(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'", [wsId]);
  assert.equal(owners.rows[0].n, 1);
});

test("invitations: only the invited email can accept, once; revoked and expired links fail", async () => {
  const res = await api(owner, "POST", `/api/workspaces/${wsId}/invitations`, { emails: [outsider.email] });
  assert.equal(res.body.invitations[0].emailed, true);
  const token = res.body.invitations[0].link.split("/invite/")[1];

  const preview = await srv.call("GET", `/api/invitations/${token}`);
  assert.equal(preview.status, 200, "preview works signed out");
  assert.equal(preview.body.invitation.workspace.name, "Hosen Soft");
  assert.equal(preview.body.invitation.state, "pending");
  assert.ok(!preview.body.invitation.email.includes("outsider@"), "email is masked");

  const intruder = await h.createUser("intruder");
  const wrong = await api(intruder, "POST", `/api/invitations/${token}/accept`);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "wrong_account");

  // In-app: shows up for the invited user, with a notification
  assert.equal((await api(outsider, "GET", "/api/invitations")).body.invitations.length, 1);
  assert.ok((await api(outsider, "GET", "/api/notifications")).body.notifications.some((n) => n.type === "workspace_invite"));

  assert.equal((await api(outsider, "POST", `/api/invitations/${token}/accept`)).status, 200);
  assert.equal((await srv.call("GET", `/api/invitations/${token}`)).body.invitation.state, "accepted");

  const second = await api(owner, "POST", `/api/workspaces/${wsId}/invitations`, { emails: [intruder.email] });
  const t2 = second.body.invitations[0].link.split("/invite/")[1];
  await api(owner, "DELETE", `/api/workspaces/${wsId}/invitations/${second.body.invitations[0].id}`);
  assert.equal((await api(intruder, "POST", `/api/invitations/${t2}/accept`)).status, 410);

  const third = await api(owner, "POST", `/api/workspaces/${wsId}/invitations`, { emails: [intruder.email] });
  await h.query("UPDATE workspace_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [third.body.invitations[0].id]);
  assert.equal((await api(intruder, "POST", `/api/invitations/${third.body.invitations[0].link.split("/invite/")[1]}/accept`)).status, 410);
  assert.equal((await srv.call("GET", `/api/invitations/not-a-real-token`)).status, 404);
});

test("invitation tokens are stored hashed, never in plain text", async () => {
  const res = await api(owner, "POST", `/api/workspaces/${wsId}/invitations`, { emails: ["new@example.test"] });
  const token = res.body.invitations[0].link.split("/invite/")[1];
  const row = (await h.query("SELECT token_hash FROM workspace_invitations WHERE id = $1", [res.body.invitations[0].id])).rows[0];
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash.length, 64);
});

test("channels: public join, private stays invisible, announcement posting, #general protected", async () => {
  const pub = await api(member, "POST", `/api/workspaces/${wsId}/channels`, { name: "Development Team", kind: "project" });
  assert.equal(pub.status, 201);
  assert.equal(pub.body.channel.name, "development-team");
  assert.equal((await api(member, "POST", `/api/workspaces/${wsId}/channels`, { name: "development-team" })).status, 409);

  const priv = await api(manager, "POST", `/api/workspaces/${wsId}/channels`, { name: "leadership", visibility: "private", memberIds: [admin.id, outsider.id] });
  assert.equal(priv.status, 201);
  const memberSees = (await api(member, "GET", `/api/workspaces/${wsId}/channels`)).body.channels.map((c) => c.name);
  assert.ok(memberSees.includes("development-team"));
  assert.ok(!memberSees.includes("leadership"), "private channel hidden from non-members");
  assert.ok((await api(admin, "GET", `/api/workspaces/${wsId}/channels`)).body.channels.some((c) => c.name === "leadership" && c.joined));
  assert.equal((await api(member, "POST", `/api/workspaces/${wsId}/channels/${priv.body.channel.id}/join`)).status, 404);
  const privMembers = (await api(admin, "GET", `/api/conversations/${priv.body.channel.id}`)).body.conversation.members.map((m) => m.username);
  assert.ok(!privMembers.includes("outsider"), "non-workspace users can't be added to channels");

  assert.equal((await api(admin, "POST", `/api/workspaces/${wsId}/channels/${pub.body.channel.id}/join`)).status, 200);
  assert.equal((await api(admin, "POST", "/api/messages", { conversationId: pub.body.channel.id, text: "hello team" })).status, 201);

  const ann = (await api(member, "GET", `/api/workspaces/${wsId}/channels`)).body.channels.find((c) => c.name === "announcements");
  assert.equal((await api(member, "POST", "/api/messages", { conversationId: ann.id, text: "can I post?" })).status, 403);
  assert.equal((await api(owner, "POST", "/api/messages", { conversationId: ann.id, text: "Welcome!" })).status, 201);

  const general = (await api(member, "GET", `/api/workspaces/${wsId}/channels`)).body.channels.find((c) => c.name === "general");
  assert.equal((await api(member, "POST", `/api/workspaces/${wsId}/channels/${general.id}/leave`)).status, 400);
  assert.equal((await api(owner, "DELETE", `/api/workspaces/${wsId}/channels/${general.id}`)).status, 400);
  assert.equal((await api(member, "DELETE", `/api/workspaces/${wsId}/channels/${pub.body.channel.id}`)).status, 403);
  assert.equal((await api(admin, "DELETE", `/api/workspaces/${wsId}/channels/${pub.body.channel.id}`)).status, 200);
});

test("guests only see and use channels they're added to", async () => {
  const proj = (await api(manager, "POST", `/api/workspaces/${wsId}/channels`, { name: "client-project", memberIds: [guest.id] })).body.channel;
  const visible = (await api(guest, "GET", `/api/workspaces/${wsId}/channels`)).body.channels.map((c) => c.name);
  assert.deepEqual(visible, ["client-project"]);
  assert.equal((await api(guest, "POST", "/api/messages", { conversationId: proj.id, text: "hi from client" })).status, 201);
  assert.equal((await api(guest, "POST", `/api/workspaces/${wsId}/channels`, { name: "mine" })).status, 403);
});

test("workspace settings can restrict who creates channels; activity log records admin actions", async () => {
  assert.equal((await api(member, "PATCH", `/api/workspaces/${wsId}`, { name: "Nope" })).status, 403);
  assert.equal((await api(admin, "PATCH", `/api/workspaces/${wsId}`, { settings: { minChannelCreateRole: "manager" } })).status, 200);
  assert.equal((await api(member, "POST", `/api/workspaces/${wsId}/channels`, { name: "x" })).status, 403);
  assert.equal((await api(manager, "POST", `/api/workspaces/${wsId}/channels`, { name: "x" })).status, 201);
  assert.equal((await api(admin, "PATCH", `/api/workspaces/${wsId}`, { settings: { minChannelCreateRole: "guest" } })).status, 400);

  assert.equal((await api(member, "GET", `/api/workspaces/${wsId}/activity`)).status, 403);
  const actions = (await api(admin, "GET", `/api/workspaces/${wsId}/activity`)).body.events.map((e) => e.action);
  for (const a of ["workspace.create", "member.invite", "member.join", "workspace.update", "channel.create"]) assert.ok(actions.includes(a), a);
});

test("deleting a workspace needs the owner and its exact name", async () => {
  assert.equal((await api(admin, "DELETE", `/api/workspaces/${wsId}`, { confirm: "Hosen Soft" })).status, 403);
  assert.equal((await api(owner, "DELETE", `/api/workspaces/${wsId}`, { confirm: "hosen" })).status, 400);
  assert.equal((await api(owner, "DELETE", `/api/workspaces/${wsId}`, { confirm: "Hosen Soft" })).status, 200);
  assert.equal((await api(member, "GET", "/api/workspaces")).body.workspaces.length, 0);
  assert.equal((await h.query("SELECT COUNT(*)::int AS n FROM conversations WHERE workspace_id = $1", [wsId])).rows[0].n, 0);
});

test("plan limits: workspaces, members (incl. pending invites) and channels follow the owner's plan", async () => {
  const free = await h.createUser("freeuser");
  const first = await api(free, "POST", "/api/workspaces", { name: "Free Co" });
  assert.equal(first.status, 201);
  const second = await api(free, "POST", "/api/workspaces", { name: "Second" });
  assert.equal(second.status, 402);
  assert.equal(second.body.code, "limit_reached");
  assert.equal(second.body.limit, 1);

  const freeWs = first.body.workspace.id;
  // Free: 10 members including pending invitations; owner is 1
  const emails = Array.from({ length: 9 }, (_, i) => `p${i}@example.test`);
  assert.equal((await api(free, "POST", `/api/workspaces/${freeWs}/invitations`, { emails })).status, 201);
  const over = await api(free, "POST", `/api/workspaces/${freeWs}/invitations`, { emails: ["one-more@example.test"] });
  assert.equal(over.status, 402);
  assert.equal(over.body.key, "membersPerWorkspace");

  // Free: 5 channels (2 default)
  for (const n of ["a", "b", "c"]) assert.equal((await api(free, "POST", `/api/workspaces/${freeWs}/channels`, { name: n })).status, 201);
  const ch = await api(free, "POST", `/api/workspaces/${freeWs}/channels`, { name: "d" });
  assert.equal(ch.status, 402);
  assert.equal(ch.body.key, "channelsPerWorkspace");

  // Upgrading the owner lifts the limits immediately
  await h.query("INSERT INTO lifetime_purchases (user_id, provider, provider_transaction_id, plan) VALUES ($1, 'paddle', 'txn_free_up', 'advanced')", [free.id]);
  assert.equal((await api(free, "POST", `/api/workspaces/${freeWs}/channels`, { name: "d" })).status, 201);
});
