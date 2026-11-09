const { query } = require("../config/db");

const SELECT = `
  SELECT t.*,
    CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('id', a.id, '_id', a.id, 'username', a.username, 'avatar', a.avatar) END AS assignee,
    CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, '_id', c.id, 'username', c.username, 'avatar', c.avatar) END AS creator,
    w.name AS workspace_name, conv.title AS conversation_title,
    (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id)::int AS comment_count
  FROM tasks t
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users c ON c.id = t.created_by
  LEFT JOIN workspaces w ON w.id = t.workspace_id
  LEFT JOIN conversations conv ON conv.id = t.conversation_id`;

const fromRow = (r) =>
  r && {
    id: r.id,
    _id: r.id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    conversationId: r.conversation_id,
    conversationTitle: r.conversation_title,
    sourceMessageId: r.source_message_id,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    dueAt: r.due_at,
    assignee: r.assignee,
    creator: r.creator,
    attachments: r.attachments || [],
    commentCount: r.comment_count,
    completedAt: r.completed_at,
    overdue: Boolean(r.due_at && r.status !== "completed" && new Date(r.due_at) < new Date()),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const get = async (id) => fromRow((await query(`${SELECT} WHERE t.id = $1`, [id])).rows[0]);
const getRaw = async (id) => (await query("SELECT * FROM tasks WHERE id = $1", [id])).rows[0] || null;

const create = async (f) => {
  const { rows } = await query(
    `INSERT INTO tasks (workspace_id, conversation_id, source_message_id, title, description, status, priority, due_at, assignee_id, created_by, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [f.workspaceId || null, f.conversationId || null, f.sourceMessageId || null, f.title, f.description || null, f.status || "todo", f.priority || "medium", f.dueAt || null, f.assigneeId || null, f.createdBy, JSON.stringify(f.attachments || [])]
  );
  return get(rows[0].id);
};

const COLUMNS = { title: "title", description: "description", status: "status", priority: "priority", dueAt: "due_at", assigneeId: "assignee_id", attachments: "attachments" };
const update = async (id, fields) => {
  const sets = [];
  const values = [id];
  for (const [key, col] of Object.entries(COLUMNS)) {
    if (fields[key] === undefined) continue;
    values.push(key === "attachments" ? JSON.stringify(fields[key]) : fields[key]);
    sets.push(`${col} = $${values.length}`);
  }
  if (fields.status !== undefined) {
    values.push(fields.status);
    sets.push(`completed_at = CASE WHEN $${values.length}::text = 'completed' THEN COALESCE(completed_at, NOW()) ELSE NULL END`);
  }
  if (!sets.length) return get(id);
  await query(`UPDATE tasks SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`, values);
  return get(id);
};

const remove = (id) => query("DELETE FROM tasks WHERE id = $1", [id]);

/**
 * Lists tasks visible to the user.
 *  scope "mine": assigned to or created by the user (all workspaces + personal)
 *  scope "workspace": every task in the workspace (caller checks membership; guests get only their own)
 */
const list = async (userId, { scope = "mine", workspaceId = null, status = null, assigneeId = null, onlyOwnInWorkspace = false, limit = 200 } = {}) => {
  const where = [];
  const p = [];
  const param = (v) => {
    p.push(v);
    return `$${p.length}`;
  };
  if (scope === "workspace") {
    where.push(`t.workspace_id = ${param(workspaceId)}`);
    if (onlyOwnInWorkspace) {
      const u = param(userId);
      where.push(`(t.assignee_id = ${u} OR t.created_by = ${u})`);
    }
  } else {
    const u = param(userId);
    where.push(`(t.assignee_id = ${u} OR t.created_by = ${u})`);
    // Workspace tasks only while the user is still a member of that workspace
    where.push(`(t.workspace_id IS NULL OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = t.workspace_id AND wm.user_id = ${u}))`);
  }
  if (status) where.push(`t.status = ${param(status)}`);
  if (assigneeId) where.push(`t.assignee_id = ${param(assigneeId)}`);
  const lim = param(Math.min(Number(limit) || 200, 500));
  const { rows } = await query(
    `${SELECT} WHERE ${where.join(" AND ")}
     ORDER BY (t.status = 'completed'), t.due_at ASC NULLS LAST,
       CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at DESC
     LIMIT ${lim}`,
    p
  );
  return rows.map(fromRow);
};

/** Counts per status for dashboards. */
const summary = async (userId, workspaceId = null) => {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS n,
       COUNT(*) FILTER (WHERE due_at < NOW() AND status <> 'completed')::int AS overdue
     FROM tasks t WHERE ${workspaceId ? "t.workspace_id = $1" : "(t.assignee_id = $1 OR t.created_by = $1)"} GROUP BY status`,
    [workspaceId || userId]
  );
  const out = { todo: 0, in_progress: 0, review: 0, completed: 0, overdue: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.overdue += r.overdue;
  }
  return out;
};

const listComments = async (taskId) => {
  const { rows } = await query(
    `SELECT tc.*, json_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) AS author
     FROM task_comments tc LEFT JOIN users u ON u.id = tc.user_id WHERE tc.task_id = $1 ORDER BY tc.created_at`,
    [taskId]
  );
  return rows.map((r) => ({ id: r.id, body: r.body, author: r.author, createdAt: r.created_at }));
};

const addComment = async (taskId, userId, body) => {
  const { rows } = await query("INSERT INTO task_comments (task_id, user_id, body) VALUES ($1, $2, $3) RETURNING id", [taskId, userId, body]);
  await query("UPDATE tasks SET updated_at = NOW() WHERE id = $1", [taskId]);
  return (await listComments(taskId)).find((c) => c.id === rows[0].id);
};

module.exports = { get, getRaw, create, update, remove, list, summary, listComments, addComment };
