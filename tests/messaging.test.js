const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

let srv;
let alice, bob, carol, dave;
test.before(async () => {
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});
test.beforeEach(async () => {
  await h.resetDb();
  alice = await h.createUser("alice");
  bob = await h.createUser("bob");
  carol = await h.createUser("carol");
  dave = await h.createUser("dave");
});

const send = (user, conversationId, body = {}) => srv.call("POST", "/api/messages", { token: user.token, body: { conversationId, text: "hi", ...body } });
const waitFor = (sock, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    sock.once(event, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });
const notFor = (sock, event, ms = 300) =>
  new Promise((resolve, reject) => {
    const handler = () => reject(new Error(`unexpected ${event}`));
    sock.once(event, handler);
    setTimeout(() => {
      sock.off(event, handler);
      resolve();
    }, ms);
  });
const group = async (owner, members, title = "Team") =>
  (await srv.call("POST", "/api/conversations/groups", { token: owner.token, body: { title, memberIds: members.map((m) => m.id) } })).body.conversation;

// ─── Direct chats (backward compatible) ──────────────────────────────────────

test("direct chats keep the original API shape and add membership data", async () => {
  const res = await srv.call("POST", "/api/conversations", { token: alice.token, body: { receiverId: bob.id } });
  assert.equal(res.status, 201);
  const c = res.body.conversation;
  assert.equal(c.type, "direct");
  assert.deepEqual(c.participants.map((p) => p.username).sort(), ["alice", "bob"]);
  assert.equal(c.myRole, "member");
  const again = await srv.call("POST", "/api/conversations", { token: bob.token, body: { receiverId: alice.id } });
  assert.equal(again.status, 200);
  assert.equal(again.body.conversation.id, c.id);
});

test("existing direct conversations without membership rows are backfilled by the schema", async () => {
  const [a, b] = [alice.id, bob.id].sort();
  const id = (await h.query("INSERT INTO conversations (user_a, user_b) VALUES ($1, $2) RETURNING id", [a, b])).rows[0].id;
  await h.query(require("fs").readFileSync(require("path").join(__dirname, "../config/schema.sql"), "utf8"));
  const list = await srv.call("GET", "/api/conversations", { token: alice.token });
  assert.ok(list.body.conversations.some((c) => c.id === id));
});

test("outsiders can't read, send to, or see a conversation", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  assert.equal((await send(carol, id)).status, 403);
  assert.equal((await srv.call("GET", `/api/messages/${id}`, { token: carol.token })).status, 403);
  assert.equal((await srv.call("GET", `/api/conversations/${id}`, { token: carol.token })).status, 404);
  assert.equal((await srv.call("GET", "/api/conversations", { token: carol.token })).body.conversations.length, 0);
});

// ─── Messages ────────────────────────────────────────────────────────────────

test("unread counts follow reads; system messages don't count", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  await send(alice, id);
  await send(alice, id);
  let conv = (await srv.call("GET", "/api/conversations", { token: bob.token })).body.conversations[0];
  assert.equal(conv.unreadCount, 2);
  await srv.call("PATCH", `/api/messages/${id}/mark-read`, { token: bob.token });
  conv = (await srv.call("GET", "/api/conversations", { token: bob.token })).body.conversations[0];
  assert.equal(conv.unreadCount, 0);
  assert.equal((await srv.call("GET", "/api/conversations", { token: alice.token })).body.conversations[0].unreadCount, 0);
});

test("cursor pagination returns pages oldest-first without gaps or repeats", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  for (let i = 0; i < 25; i += 1) await send(alice, id, { text: `m${i}` });
  const p1 = await srv.call("GET", `/api/messages/${id}?limit=10`, { token: bob.token });
  assert.deepEqual(p1.body.messages.map((m) => m.text), Array.from({ length: 10 }, (_, i) => `m${i + 15}`));
  assert.equal(p1.body.hasMore, true);
  const p2 = await srv.call("GET", `/api/messages/${id}?limit=10&before=${p1.body.nextCursor}`, { token: bob.token });
  assert.deepEqual(p2.body.messages.map((m) => m.text), Array.from({ length: 10 }, (_, i) => `m${i + 5}`));
  const p3 = await srv.call("GET", `/api/messages/${id}?limit=10&before=${p2.body.nextCursor}`, { token: bob.token });
  assert.equal(p3.body.messages.length, 5);
  assert.equal(p3.body.hasMore, false);
  // Legacy call still returns everything
  assert.equal((await srv.call("GET", `/api/messages/${id}`, { token: bob.token })).body.messages.length, 25);
});

test("a retried send with the same clientId never creates a duplicate", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  const first = await send(alice, id, { clientId: "c-123" });
  const retry = await send(alice, id, { clientId: "c-123" });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.message.id, first.body.message.id);
  assert.equal((await srv.call("GET", `/api/messages/${id}`, { token: bob.token })).body.messages.length, 1);
});

test("edit: own messages only, marked edited, broadcast", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  const bobSock = await srv.socket(bob.token);
  const m = (await send(alice, id, { text: "helo" })).body.message;
  assert.equal((await srv.call("PATCH", `/api/messages/${m.id}`, { token: bob.token, body: { text: "x" } })).status, 403);
  const updated = waitFor(bobSock, "messageUpdated");
  const res = await srv.call("PATCH", `/api/messages/${m.id}`, { token: alice.token, body: { text: "hello" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.message.text, "hello");
  assert.ok(res.body.message.editedAt);
  assert.equal((await updated).message.text, "hello");
  await h.query("UPDATE messages SET created_at = NOW() - INTERVAL '3 days' WHERE id = $1", [m.id]);
  assert.equal((await srv.call("PATCH", `/api/messages/${m.id}`, { token: alice.token, body: { text: "late" } })).status, 400);
});

test("delete for everyone leaves a placeholder; legacy history hides it", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  const m = (await send(alice, id, { text: "secret" })).body.message;
  assert.equal((await srv.call("DELETE", `/api/messages/${m.id}`, { token: bob.token })).status, 403);
  assert.equal((await srv.call("DELETE", `/api/messages/${m.id}`, { token: alice.token })).status, 200);
  const page = (await srv.call("GET", `/api/messages/${id}?limit=10`, { token: bob.token })).body.messages;
  assert.equal(page.length, 1);
  assert.ok(page[0].deletedAt);
  assert.equal(page[0].text, "");
  assert.equal((await srv.call("GET", `/api/messages/${id}`, { token: bob.token })).body.messages.length, 0);
});

test("replies snapshot the stored original, not client-supplied text", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  const original = (await send(alice, id, { text: "the real text" })).body.message;
  const reply = (await send(bob, id, { text: "answer", replyToMessageId: original.id, replyToText: "FORGED" })).body.message;
  assert.equal(reply.replyToText, "the real text");
  assert.equal(reply.replyToSenderId, alice.id);
});

test("forward copies content into conversations the user belongs to only", async () => {
  const ab = await h.directConversation(alice.id, bob.id);
  const ac = await h.directConversation(alice.id, carol.id);
  const bc = await h.directConversation(bob.id, carol.id);
  const m = (await send(bob, ab, { text: "fwd me" })).body.message;
  const res = await srv.call("POST", `/api/messages/${m.id}/forward`, { token: alice.token, body: { conversationIds: [ac, bc] } });
  assert.equal(res.status, 201);
  assert.equal(res.body.messages.length, 1, "bc is not alice's");
  assert.equal(res.body.messages[0].forwarded, true);
  assert.equal(res.body.messages[0].conversationId, ac);
});

test("pins, bookmarks and reports", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  const m = (await send(alice, id, { text: "pin me" })).body.message;
  assert.equal((await srv.call("POST", `/api/messages/${m.id}/pin`, { token: bob.token })).status, 200);
  const pins = (await srv.call("GET", `/api/messages/${id}/pins`, { token: alice.token })).body.messages;
  assert.equal(pins.length, 1);
  assert.equal(pins[0].isPinned, true);
  assert.equal((await srv.call("GET", `/api/messages/${id}/pins`, { token: carol.token })).status, 403);

  assert.equal((await srv.call("POST", `/api/messages/${m.id}/bookmark`, { token: bob.token })).body.bookmarked, true);
  assert.equal((await srv.call("GET", "/api/messages/bookmarks", { token: bob.token })).body.messages.length, 1);
  assert.equal((await srv.call("GET", "/api/messages/bookmarks", { token: alice.token })).body.messages.length, 0);
  assert.equal((await srv.call("POST", `/api/messages/${m.id}/bookmark`, { token: bob.token })).body.bookmarked, false);

  assert.equal((await srv.call("POST", `/api/messages/${m.id}/report`, { token: bob.token, body: { reason: "spam" } })).status, 201);
  assert.equal((await srv.call("POST", `/api/messages/${m.id}/report`, { token: alice.token, body: { reason: "spam" } })).status, 400);
  assert.equal((await srv.call("POST", `/api/messages/${m.id}/report`, { token: carol.token, body: { reason: "spam" } })).status, 404);
});

test("search finds words only in the user's own conversations", async () => {
  const ab = await h.directConversation(alice.id, bob.id);
  const cd = await h.directConversation(carol.id, dave.id);
  await send(alice, ab, { text: "the quarterly report is ready" });
  await send(carol, cd, { text: "quarterly report from carol" });
  const res = await srv.call("GET", "/api/messages/search?q=quarterly", { token: bob.token });
  assert.equal(res.body.messages.length, 1);
  assert.equal(res.body.messages[0].conversationId, ab);
  const convs = await srv.call("GET", "/api/conversations/search?q=bo", { token: alice.token });
  assert.equal(convs.body.conversations[0].id, ab);
});

// ─── Blocking and muting ─────────────────────────────────────────────────────

test("blocking stops messages and new chats in both directions", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  assert.equal((await srv.call("POST", `/api/users/${bob.id}/block`, { token: alice.token })).status, 200);
  assert.equal((await send(bob, id)).status, 403);
  assert.equal((await send(alice, id)).status, 403);
  assert.equal((await srv.call("POST", "/api/conversations", { token: bob.token, body: { receiverId: alice.id } })).status, 403);
  assert.equal((await srv.call("GET", "/api/users/blocked", { token: alice.token })).body.users[0].username, "bob");
  await srv.call("DELETE", `/api/users/${bob.id}/block`, { token: alice.token });
  assert.equal((await send(bob, id)).status, 201);
});

// ─── Groups ──────────────────────────────────────────────────────────────────

test("groups: create, deliver to every member in real time, owner role", async () => {
  const bobSock = await srv.socket(bob.token);
  const carolSock = await srv.socket(carol.token);
  // first receiveMessage is the "created the group" system line
  const created = Promise.all([waitFor(bobSock, "receiveMessage"), waitFor(carolSock, "receiveMessage")]);
  const g = await group(alice, [bob, carol]);
  assert.equal(g.type, "group");
  assert.equal(g.myRole, "owner");
  assert.equal(g.memberCount, 3);
  const [sys] = await created;
  assert.equal(sys.message.kind, "system");
  const next = Promise.all([waitFor(bobSock, "receiveMessage"), waitFor(carolSock, "receiveMessage")]);
  await send(alice, g.id, { text: "welcome" });
  const [b, c] = await next;
  assert.equal(b.message.text, "welcome");
  assert.equal(c.message.text, "welcome");
  assert.equal((await send(dave, g.id)).status, 403);
});

test("groups: admins manage members, members can't; owner leaving hands over ownership", async () => {
  const g = await group(alice, [bob, carol]);
  assert.equal((await srv.call("POST", `/api/conversations/${g.id}/members`, { token: bob.token, body: { userIds: [dave.id] } })).status, 403);
  assert.equal((await srv.call("PATCH", `/api/conversations/${g.id}/members/${bob.id}`, { token: alice.token, body: { role: "admin" } })).status, 200);
  const added = await srv.call("POST", `/api/conversations/${g.id}/members`, { token: bob.token, body: { userIds: [dave.id] } });
  assert.deepEqual(added.body.added, [dave.id]);
  assert.equal((await srv.call("DELETE", `/api/conversations/${g.id}/members/${alice.id}`, { token: bob.token })).status, 403, "admin can't remove owner");
  assert.equal((await srv.call("DELETE", `/api/conversations/${g.id}/members/${carol.id}`, { token: dave.token })).status, 403);
  assert.equal((await srv.call("DELETE", `/api/conversations/${g.id}/members/${alice.id}`, { token: alice.token })).status, 200, "owner leaves");
  const roles = Object.fromEntries((await srv.call("GET", `/api/conversations/${g.id}`, { token: bob.token })).body.conversation.members.map((m) => [m.username, m.role]));
  assert.equal(roles.bob, "owner");
  assert.equal(roles.alice, undefined);
  assert.equal((await send(alice, g.id)).status, 403);
});

test("groups: announcement mode lets only admins post; admins moderate messages", async () => {
  const g = await group(alice, [bob]);
  await srv.call("PATCH", `/api/conversations/${g.id}`, { token: alice.token, body: { adminsOnlyPost: true } });
  assert.equal((await send(bob, g.id)).status, 403);
  await srv.call("PATCH", `/api/conversations/${g.id}`, { token: alice.token, body: { adminsOnlyPost: false } });
  const m = (await send(bob, g.id, { text: "spam" })).body.message;
  assert.equal((await srv.call("DELETE", `/api/messages/${m.id}`, { token: alice.token })).status, 200);
  assert.equal((await srv.call("PATCH", `/api/conversations/${g.id}`, { token: bob.token, body: { title: "x" } })).status, 403);
});

test("groups: invite links join, preview, and stop working once reset", async () => {
  const g = await group(alice, [bob]);
  assert.equal((await srv.call("POST", `/api/conversations/${g.id}/invite-link`, { token: bob.token })).status, 403);
  const code = (await srv.call("POST", `/api/conversations/${g.id}/invite-link`, { token: alice.token })).body.code;
  const preview = await srv.call("GET", `/api/conversations/join/${code}`, { token: carol.token });
  assert.equal(preview.body.group.title, "Team");
  assert.equal(preview.body.group.isMember, false);
  assert.equal((await srv.call("POST", `/api/conversations/join/${code}`, { token: carol.token })).status, 200);
  assert.equal((await send(carol, g.id)).status, 201);
  const fresh = (await srv.call("POST", `/api/conversations/${g.id}/invite-link`, { token: alice.token, body: { regenerate: true } })).body.code;
  assert.notEqual(fresh, code);
  assert.equal((await srv.call("POST", `/api/conversations/join/${code}`, { token: dave.token })).status, 404);
});

test("groups: read receipts list who has read", async () => {
  const g = await group(alice, [bob, carol]);
  await send(alice, g.id);
  await srv.call("PATCH", `/api/messages/${g.id}/mark-read`, { token: bob.token });
  const readers = (await srv.call("GET", `/api/messages/${g.id}/read-receipts`, { token: alice.token })).body.readers;
  assert.deepEqual(readers.map((r) => r.username), ["bob"]);
});

// ─── Realtime: typing, delivered, seen ───────────────────────────────────────

test("typing only reaches members of the conversation", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  const a = await srv.socket(alice.token);
  const b = await srv.socket(bob.token);
  const c = await srv.socket(carol.token);
  const got = waitFor(b, "userTyping");
  const carolNot = notFor(c, "userTyping");
  a.emit("typing", { conversationId: id, receiverId: carol.id });
  assert.equal((await got).senderId, alice.id);
  await carolNot;
  // A non-member can't send typing into the conversation
  const bobNot = notFor(b, "userTyping");
  c.emit("typing", { conversationId: id });
  await bobNot;
});

test("delivered and seen receipts reach the sender", async () => {
  const id = await h.directConversation(alice.id, bob.id);
  const a = await srv.socket(alice.token);
  const b = await srv.socket(bob.token);
  const m = (await send(alice, id)).body.message;
  const delivered = waitFor(a, "messagesDelivered");
  b.emit("messagesDelivered", { messageIds: [m.id] });
  assert.deepEqual((await delivered).messageIds, [m.id]);
  const seen = waitFor(a, "messagesSeen");
  b.emit("markMessagesSeen", { conversationId: id });
  assert.deepEqual((await seen).messageIds, [m.id]);
  const page = (await srv.call("GET", `/api/messages/${id}?limit=5`, { token: alice.token })).body.messages;
  assert.ok(page[0].deliveredAt);
  assert.equal(page[0].isRead, true);
});

// ─── Notifications ───────────────────────────────────────────────────────────

test("@mentions create one in-app notification; muted members and blockers get nothing", async () => {
  const g = await group(alice, [bob, carol, dave]);
  await srv.call("PATCH", `/api/conversations/${g.id}/membership`, { token: carol.token, body: { muted: true } });
  await srv.call("POST", `/api/users/${alice.id}/block`, { token: dave.token });
  const bobSock = await srv.socket(bob.token);
  const live = waitFor(bobSock, "notification");
  await send(alice, g.id, { text: "hey @bob @carol @dave look" });
  assert.equal((await live).notification.type, "mention");
  await new Promise((r) => setTimeout(r, 100));
  const forBob = await srv.call("GET", "/api/notifications", { token: bob.token });
  assert.equal(forBob.body.unread, 2, "added-to-group + mention");
  const mentions = forBob.body.notifications.filter((n) => n.type === "mention");
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].title, "alice mentioned you");
  assert.equal((await srv.call("GET", "/api/notifications", { token: carol.token })).body.notifications.filter((n) => n.type === "mention").length, 0, "muted");
  assert.equal((await srv.call("GET", "/api/notifications", { token: dave.token })).body.notifications.filter((n) => n.type === "mention").length, 0, "blocked sender");

  await srv.call("POST", "/api/notifications/read", { token: bob.token });
  assert.equal((await srv.call("GET", "/api/notifications", { token: bob.token })).body.unread, 0);
});

test("the same event never notifies twice, and preferences switch categories off", async () => {
  const notifications = require("../services/notifications");
  const n1 = await notifications.notify([bob.id], { type: "task_assigned", title: "t", dedupeKey: "task:1" });
  const n2 = await notifications.notify([bob.id], { type: "task_assigned", title: "t", dedupeKey: "task:1" });
  assert.equal(n1, 1);
  assert.equal(n2, 0);
  await srv.call("PUT", "/api/notifications/preferences/tasks", { token: bob.token, body: { inApp: false } });
  assert.equal(await notifications.notify([bob.id], { type: "task_assigned", title: "t2", dedupeKey: "task:2" }), 0);
  const prefs = (await srv.call("GET", "/api/notifications/preferences", { token: bob.token })).body.preferences;
  assert.deepEqual(prefs.find((p) => p.category === "tasks"), { category: "tasks", push: true, inApp: false });
  assert.equal((await srv.call("PUT", "/api/notifications/preferences/nope", { token: bob.token, body: {} })).status, 400);
});

test("link previews refuse private network addresses", async () => {
  const { assertPublicUrl, isPrivateAddress, firstUrl } = require("../utils/linkPreview");
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  await assert.rejects(assertPublicUrl("http://127.0.0.1/admin"));
  await assert.rejects(assertPublicUrl("http://localhost:5000/"));
  await assert.rejects(assertPublicUrl("file:///etc/passwd"));
  assert.equal(firstUrl("see https://example.com/a), ok"), "https://example.com/a");
});
