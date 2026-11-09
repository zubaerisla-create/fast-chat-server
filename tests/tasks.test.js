const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

let srv;
let owner, manager, member, guest, outsider, wsId, generalId;
const api = (u, method, url, body) => srv.call(method, url, { token: u?.token, body });

test.before(async () => {
  srv = await h.startServer();
});
test.after(async () => {
  await srv.close();
  await h.pool.end();
});

async function join(user, role) {
  const res = await api(owner, "POST", `/api/workspaces/${wsId}/invitations`, { emails: [user.email], role });
  await api(user, "POST", `/api/invitations/${res.body.invitations[0].link.split("/invite/")[1]}/accept`);
}

test.beforeEach(async () => {
  await h.resetDb();
  owner = await h.createUser("owner");
  manager = await h.createUser("manager");
  member = await h.createUser("member");
  guest = await h.createUser("guest");
  outsider = await h.createUser("outsider");
  wsId = (await api(owner, "POST", "/api/workspaces", { name: "Acme" })).body.workspace.id;
  await join(manager, "manager");
  await join(member, "member");
  await join(guest, "guest");
  generalId = (await api(owner, "GET", `/api/workspaces/${wsId}/channels`)).body.channels[0].id;
});

test("create, assign (with notification), move through statuses, complete", async () => {
  const res = await api(owner, "POST", "/api/tasks", { title: "Ship v2", workspaceId: wsId, assigneeId: member.id, priority: "high", dueAt: "2030-01-01T00:00:00Z" });
  assert.equal(res.status, 201);
  const task = res.body.task;
  assert.equal(task.status, "todo");
  assert.equal(task.assignee.username, "member");
  assert.ok((await api(member, "GET", "/api/notifications")).body.notifications.some((n) => n.type === "task_assigned"));

  for (const status of ["in_progress", "review", "completed"]) {
    const up = await api(member, "PATCH", `/api/tasks/${task.id}`, { status });
    assert.equal(up.body.task.status, status);
  }
  const done = (await api(owner, "GET", `/api/tasks/${task.id}`)).body.task;
  assert.ok(done.completedAt);
  const reopened = (await api(owner, "PATCH", `/api/tasks/${task.id}`, { status: "todo" })).body.task;
  assert.equal(reopened.completedAt, null);
  assert.equal((await api(owner, "PATCH", `/api/tasks/${task.id}`, { status: "done" })).status, 400);
});

test("a title that equals a status value doesn't confuse completion tracking", async () => {
  const t = (await api(owner, "POST", "/api/tasks", { title: "x" })).body.task;
  const up = (await api(owner, "PATCH", `/api/tasks/${t.id}`, { title: "completed", status: "in_progress" })).body.task;
  assert.equal(up.title, "completed");
  assert.equal(up.completedAt, null);
});

test("visibility: workspace members see workspace tasks, guests and outsiders only their own", async () => {
  const t = (await api(owner, "POST", "/api/tasks", { title: "Internal", workspaceId: wsId })).body.task;
  const g = (await api(manager, "POST", "/api/tasks", { title: "For guest", workspaceId: wsId, assigneeId: guest.id })).body.task;
  assert.equal((await api(member, "GET", `/api/tasks/${t.id}`)).status, 200);
  assert.equal((await api(guest, "GET", `/api/tasks/${t.id}`)).status, 404);
  assert.equal((await api(guest, "GET", `/api/tasks/${g.id}`)).status, 200);
  assert.equal((await api(outsider, "GET", `/api/tasks/${t.id}`)).status, 404);
  assert.equal((await api(outsider, "GET", `/api/tasks?scope=workspace&workspaceId=${wsId}`)).status, 404);
  const guestBoard = (await api(guest, "GET", `/api/tasks?scope=workspace&workspaceId=${wsId}`)).body.tasks.map((x) => x.title);
  assert.deepEqual(guestBoard, ["For guest"]);
  assert.equal((await api(member, "GET", `/api/tasks?scope=workspace&workspaceId=${wsId}`)).body.tasks.length, 2);
});

test("editing: assignee, creator and managers may edit; other members may not", async () => {
  const t = (await api(owner, "POST", "/api/tasks", { title: "Edit me", workspaceId: wsId })).body.task;
  assert.equal((await api(member, "PATCH", `/api/tasks/${t.id}`, { title: "hijack" })).status, 403);
  assert.equal((await api(manager, "PATCH", `/api/tasks/${t.id}`, { title: "Edited" })).status, 200);
  assert.equal((await api(member, "DELETE", `/api/tasks/${t.id}`)).status, 403);
  assert.equal((await api(manager, "DELETE", `/api/tasks/${t.id}`)).status, 200);
});

test("assignees must belong to the workspace; personal tasks only to people you chat with", async () => {
  assert.equal((await api(owner, "POST", "/api/tasks", { title: "x", workspaceId: wsId, assigneeId: outsider.id })).status, 400);
  assert.equal((await api(member, "POST", "/api/tasks", { title: "personal", assigneeId: outsider.id })).status, 400);
  await h.directConversation(member.id, outsider.id);
  assert.equal((await api(member, "POST", "/api/tasks", { title: "personal", assigneeId: outsider.id })).status, 201);
  assert.equal((await api(outsider, "POST", "/api/tasks", { title: "x", workspaceId: wsId })).status, 403);
  assert.equal((await api(guest, "POST", "/api/tasks", { title: "x", workspaceId: wsId })).status, 403);
});

test("convert a message into a task, linked to its channel and workspace", async () => {
  const msg = (await api(member, "POST", "/api/messages", { conversationId: generalId, text: "Can someone update the pricing page by Friday?" })).body.message;
  const res = await api(manager, "POST", `/api/messages/${msg.id}/task`, { assigneeId: member.id, priority: "urgent" });
  assert.equal(res.status, 201);
  assert.equal(res.body.task.title, "Can someone update the pricing page by Friday?");
  assert.equal(res.body.task.workspaceId, wsId);
  assert.equal(res.body.task.conversationId, generalId);
  assert.equal(res.body.task.sourceMessageId, msg.id);
  assert.equal((await api(outsider, "POST", `/api/messages/${msg.id}/task`)).status, 404);
});

test("comments notify the creator and assignee; personal dashboard summarises", async () => {
  const t = (await api(owner, "POST", "/api/tasks", { title: "Discuss", workspaceId: wsId, assigneeId: member.id, dueAt: "2001-01-01T00:00:00Z" })).body.task;
  assert.equal(t.overdue, true);
  const c = await api(member, "POST", `/api/tasks/${t.id}/comments`, { body: "On it" });
  assert.equal(c.status, 201);
  assert.ok((await api(owner, "GET", "/api/notifications")).body.notifications.some((n) => n.type === "task_comment"));
  assert.equal((await api(guest, "POST", `/api/tasks/${t.id}/comments`, { body: "hi" })).status, 404);
  const mine = (await api(member, "GET", "/api/tasks?scope=mine")).body;
  assert.equal(mine.tasks.length, 1);
  assert.equal(mine.summary.todo, 1);
  assert.equal(mine.summary.overdue, 1);
  assert.equal((await api(member, "GET", `/api/tasks/${t.id}/comments`)).body.comments[0].body, "On it");
});

test("leaving a workspace hides its tasks from the personal dashboard", async () => {
  await api(owner, "POST", "/api/tasks", { title: "Team task", workspaceId: wsId, assigneeId: member.id });
  assert.equal((await api(member, "GET", "/api/tasks")).body.tasks.length, 1);
  await api(owner, "DELETE", `/api/workspaces/${wsId}/members/${member.id}`);
  assert.equal((await api(member, "GET", "/api/tasks")).body.tasks.length, 0);
});
