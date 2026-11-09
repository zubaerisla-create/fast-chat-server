const Task = require("../models/Task");
const Workspace = require("../models/Workspace");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const rbac = require("../services/rbac");
const notifications = require("../services/notifications");
const { emitToUsers } = require("../services/realtime");

const STATUSES = ["todo", "in_progress", "review", "completed"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const STATUS_LABEL = { todo: "To do", in_progress: "In progress", review: "Review", completed: "Completed" };
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const handle = (fn) => (req, res, next) => fn(req, res).catch(next);

/**
 * Who can see / edit a task:
 *  personal (no workspace): creator and assignee
 *  workspace: members see all tasks (guests only their own); edit = creator, assignee or manager+
 */
async function taskAccess(task, userId) {
  if (!task) return { view: false, edit: false };
  const own = task.created_by === userId || task.assignee_id === userId;
  if (!task.workspace_id) return { view: own, edit: own, del: task.created_by === userId };
  const m = await Workspace.getMember(task.workspace_id, userId);
  if (!m) return { view: false, edit: false };
  const manage = rbac.can(m.role, "tasks.manage");
  return { view: own || m.role !== "guest", edit: own || manage, del: task.created_by === userId || manage, role: m.role };
}

/** Validates an assignee: workspace members for workspace tasks, self or a direct-chat contact for personal ones. */
async function validAssignee(assigneeId, workspaceId, userId) {
  if (!assigneeId || assigneeId === userId) return true;
  if (workspaceId) return Boolean(await Workspace.getMember(workspaceId, assigneeId));
  const { rowCount } = await require("../config/db").query(
    `SELECT 1 FROM conversation_members a JOIN conversation_members b ON a.conversation_id = b.conversation_id
     WHERE a.user_id = $1 AND b.user_id = $2`,
    [userId, assigneeId]
  );
  return rowCount > 0;
}

function readFields(b, { partial }) {
  const f = {};
  if (b.title !== undefined || !partial) {
    f.title = String(b.title || "").trim().slice(0, 200);
    if (!f.title) return { error: "Title is required." };
  }
  if (b.description !== undefined) f.description = b.description ? String(b.description).slice(0, 5000) : null;
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return { error: "Invalid status." };
    f.status = b.status;
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) return { error: "Invalid priority." };
    f.priority = b.priority;
  }
  if (b.dueAt !== undefined) {
    if (b.dueAt && Number.isNaN(Date.parse(b.dueAt))) return { error: "Invalid due date." };
    f.dueAt = b.dueAt ? new Date(b.dueAt).toISOString() : null;
  }
  if (b.assigneeId !== undefined) f.assigneeId = b.assigneeId || null;
  if (b.attachments !== undefined) {
    f.attachments = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 10).flatMap((a) =>
      a && typeof a.url === "string" && /^https?:\/\//.test(a.url) ? [{ url: a.url.slice(0, 1000), name: String(a.name || "file").slice(0, 255), type: String(a.type || "file").slice(0, 10), size: Number(a.size) || null }] : []
    );
  }
  return { fields: f };
}

async function notifyAssignment(task, actor) {
  if (!task.assignee || task.assignee.id === actor._id) return;
  await notifications.notify([task.assignee.id], {
    type: "task_assigned",
    title: `${actor.username} assigned you a task`,
    body: task.title,
    data: { taskId: task.id, workspaceId: task.workspaceId },
    actorId: actor._id,
    dedupeKey: `task_assigned:${task.id}:${task.assignee.id}`,
  });
}

const broadcast = (task) => emitToUsers([task.creator?.id, task.assignee?.id].filter(Boolean), "taskUpdated", { task });

/** GET /api/tasks?scope=mine|workspace&workspaceId=&status=&assigneeId= */
const listTasks = handle(async (req, res) => {
  const { scope = "mine", workspaceId, status, assigneeId } = req.query;
  if (status && !STATUSES.includes(status)) return fail(res, 400, "Invalid status.");
  let onlyOwnInWorkspace = false;
  if (scope === "workspace") {
    const m = workspaceId && (await Workspace.getMember(workspaceId, req.user._id));
    if (!m) return fail(res, 404, "Workspace not found.");
    onlyOwnInWorkspace = m.role === "guest";
  }
  const tasks = await Task.list(req.user._id, { scope, workspaceId, status, assigneeId, onlyOwnInWorkspace });
  const summary = await Task.summary(req.user._id, scope === "workspace" ? workspaceId : null);
  res.json({ success: true, tasks, summary });
});

/** POST /api/tasks { title, description?, priority?, dueAt?, assigneeId?, workspaceId?, conversationId? } */
const createTask = handle(async (req, res) => {
  const b = req.body || {};
  const { fields, error } = readFields(b, { partial: false });
  if (error) return fail(res, 400, error);
  const workspaceId = b.workspaceId || null;
  if (workspaceId) {
    const m = await Workspace.getMember(workspaceId, req.user._id);
    if (!m || !rbac.can(m.role, "tasks.create")) return fail(res, 403, "You can't create tasks in this workspace.");
  }
  let conversationId = null;
  if (b.conversationId) {
    const conv = await Conversation.findForUser(b.conversationId, req.user._id);
    if (!conv) return fail(res, 403, "You are not in that conversation.");
    if (workspaceId && conv.workspace_id && conv.workspace_id !== workspaceId) return fail(res, 400, "That conversation belongs to another workspace.");
    conversationId = conv.id;
  }
  if (!(await validAssignee(fields.assigneeId, workspaceId, req.user._id))) return fail(res, 400, "The assignee must be a member of this workspace.");
  const task = await Task.create({ ...fields, workspaceId, conversationId, createdBy: req.user._id });
  await notifyAssignment(task, req.user);
  broadcast(task);
  res.status(201).json({ success: true, task });
});

/** POST /api/messages/:messageId/task { assigneeId?, dueAt?, priority?, title? } — turns a message into a task. */
const taskFromMessage = handle(async (req, res) => {
  const msg = await Message.findById(req.params.messageId);
  const conv = msg && (await Conversation.findForUser(msg.conversation_id, req.user._id));
  if (!msg || !conv || msg.deleted_at) return fail(res, 404, "Message not found.");
  const workspaceId = conv.workspace_id || null;
  if (workspaceId) {
    const m = await Workspace.getMember(workspaceId, req.user._id);
    if (!m || !rbac.can(m.role, "tasks.create")) return fail(res, 403, "You can't create tasks in this workspace.");
  }
  const b = req.body || {};
  const defaultTitle = (msg.text || msg.file_name || "Task from message").replace(/\s+/g, " ").trim();
  const { fields, error } = readFields({ ...b, title: b.title || defaultTitle.slice(0, 200), description: b.description ?? msg.text ?? null }, { partial: false });
  if (error) return fail(res, 400, error);
  if (msg.file_url) fields.attachments = [{ url: msg.file_url, name: msg.file_name || "attachment", type: msg.file_type || "file", size: Number(msg.file_size) || null }];
  if (!(await validAssignee(fields.assigneeId, workspaceId, req.user._id))) return fail(res, 400, "The assignee must be a member of this workspace.");
  const task = await Task.create({ ...fields, workspaceId, conversationId: conv.id, sourceMessageId: msg.id, createdBy: req.user._id });
  await notifyAssignment(task, req.user);
  broadcast(task);
  res.status(201).json({ success: true, task });
});

const getTask = handle(async (req, res) => {
  const raw = await Task.getRaw(req.params.id);
  if (!(await taskAccess(raw, req.user._id)).view) return fail(res, 404, "Task not found.");
  res.json({ success: true, task: await Task.get(raw.id), comments: await Task.listComments(raw.id) });
});

/** PATCH /api/tasks/:id — creator, assignee or workspace manager+. */
const updateTask = handle(async (req, res) => {
  const raw = await Task.getRaw(req.params.id);
  const acc = await taskAccess(raw, req.user._id);
  if (!acc.view) return fail(res, 404, "Task not found.");
  if (!acc.edit) return fail(res, 403, "You can't edit this task.");
  const { fields, error } = readFields(req.body || {}, { partial: true });
  if (error) return fail(res, 400, error);
  if (fields.assigneeId !== undefined && !(await validAssignee(fields.assigneeId, raw.workspace_id, req.user._id))) {
    return fail(res, 400, "The assignee must be a member of this workspace.");
  }
  const task = await Task.update(raw.id, fields);
  if (fields.assigneeId && fields.assigneeId !== raw.assignee_id) await notifyAssignment(task, req.user);
  if (fields.status && fields.status !== raw.status) {
    const others = [raw.created_by, raw.assignee_id].filter((id) => id && id !== req.user._id);
    await notifications.notify(others, {
      type: "task_status",
      title: `${req.user.username} moved a task to ${STATUS_LABEL[fields.status]}`,
      body: task.title,
      data: { taskId: task.id, workspaceId: task.workspaceId },
      actorId: req.user._id,
      dedupeKey: `task_status:${task.id}:${fields.status}:${Date.now()}`,
    });
  }
  broadcast(task);
  res.json({ success: true, task });
});

const deleteTask = handle(async (req, res) => {
  const raw = await Task.getRaw(req.params.id);
  const acc = await taskAccess(raw, req.user._id);
  if (!acc.view) return fail(res, 404, "Task not found.");
  if (!acc.del) return fail(res, 403, "Only the creator or a workspace manager can delete this task.");
  await Task.remove(raw.id);
  emitToUsers([raw.created_by, raw.assignee_id].filter(Boolean), "taskDeleted", { taskId: raw.id });
  res.json({ success: true });
});

const listComments = handle(async (req, res) => {
  const raw = await Task.getRaw(req.params.id);
  if (!(await taskAccess(raw, req.user._id)).view) return fail(res, 404, "Task not found.");
  res.json({ success: true, comments: await Task.listComments(raw.id) });
});

/** POST /api/tasks/:id/comments { body } — anyone who can see the task. */
const addComment = handle(async (req, res) => {
  const raw = await Task.getRaw(req.params.id);
  if (!(await taskAccess(raw, req.user._id)).view) return fail(res, 404, "Task not found.");
  const body = String(req.body?.body || "").trim().slice(0, 2000);
  if (!body) return fail(res, 400, "Comment can't be empty.");
  const comment = await Task.addComment(raw.id, req.user._id, body);
  await notifications.notify([raw.created_by, raw.assignee_id].filter(Boolean), {
    type: "task_comment",
    title: `${req.user.username} commented on "${raw.title}"`,
    body,
    data: { taskId: raw.id, workspaceId: raw.workspace_id },
    actorId: req.user._id,
    dedupeKey: `task_comment:${comment.id}`,
  });
  emitToUsers([raw.created_by, raw.assignee_id].filter(Boolean), "taskComment", { taskId: raw.id, comment });
  res.status(201).json({ success: true, comment });
});

module.exports = { listTasks, createTask, taskFromMessage, getTask, updateTask, deleteTask, listComments, addComment };
