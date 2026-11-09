const { query } = require("../config/db");
const { getEntitlement } = require("../services/entitlements");

const handle = (fn) => (req, res, next) => fn(req, res).catch(next);
const range = (req) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  return days;
};

/** GET /api/admin/overview?days=30 — platform metrics from our own tables (admins only). */
const overview = handle(async (req, res) => {
  const days = range(req);
  const [users, orgs, messages, subs, reports, signups] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(days => $1))::int AS new_in_range,
         COUNT(*) FILTER (WHERE is_online)::int AS online_now,
         COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '7 days' OR is_online)::int AS active_7d
       FROM users`,
      [days]
    ),
    query("SELECT (SELECT COUNT(*) FROM organizations)::int AS organizations, (SELECT COUNT(*) FROM workspaces)::int AS workspaces, (SELECT COUNT(*) FROM conversations WHERE type = 'channel')::int AS channels, (SELECT COUNT(*) FROM conversations WHERE type = 'group')::int AS groups"),
    query(
      `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
         COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(days => $1))::int AS in_range,
         COALESCE(SUM(file_size) FILTER (WHERE deleted_at IS NULL), 0)::bigint AS storage_bytes
       FROM messages`,
      [days]
    ),
    query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('active', 'past_due'))::int AS active,
         COUNT(*) FILTER (WHERE status = 'trialing')::int AS trialing,
         COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled,
         (SELECT COUNT(*) FROM lifetime_purchases WHERE status = 'active')::int AS lifetime
       FROM subscriptions`
    ),
    query("SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open FROM message_reports"),
    query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, COUNT(u.id)::int AS signups
       FROM generate_series(date_trunc('day', NOW()) - make_interval(days => $1 - 1), date_trunc('day', NOW()), INTERVAL '1 day') d
       LEFT JOIN users u ON date_trunc('day', u.created_at) = d
       GROUP BY d ORDER BY d`,
      [days]
    ),
  ]);
  res.json({
    success: true,
    days,
    users: users.rows[0],
    organizations: orgs.rows[0],
    messages: { ...messages.rows[0], storage_bytes: Number(messages.rows[0].storage_bytes) },
    subscriptions: subs.rows[0],
    reports: reports.rows[0],
    signupsByDay: signups.rows,
  });
});

/** GET /api/admin/users?q=&limit=&offset= — searchable, paginated user list with plan. */
const listUsers = handle(async (req, res) => {
  const pattern = `%${String(req.query.q || "").replace(/[\\%_]/g, "\\$&")}%`;
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { rows } = await query(
    `SELECT u.id, u.username, u.email, u.role, u.is_online, u.last_seen, u.created_at, COUNT(*) OVER()::int AS total,
       (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id)::int AS workspaces
     FROM users u WHERE u.username ILIKE $1 OR u.email ILIKE $1
     ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
    [pattern, limit, offset]
  );
  const users = await Promise.all(
    rows.map(async (r) => {
      const ent = await getEntitlement(r.id);
      return { id: r.id, username: r.username, email: r.email, role: r.role, isOnline: r.is_online, lastSeen: r.last_seen, createdAt: r.created_at, workspaces: r.workspaces, plan: ent.planName === "Free" ? null : ent.planName };
    })
  );
  res.json({ success: true, total: rows[0]?.total ?? 0, users });
});

/** GET /api/admin/organizations?q= */
const listOrganizations = handle(async (req, res) => {
  const pattern = `%${String(req.query.q || "").replace(/[\\%_]/g, "\\$&")}%`;
  const { rows } = await query(
    `SELECT o.id, o.name, o.created_at, u.username AS owner, u.email AS owner_email,
       (SELECT COUNT(*) FROM workspaces w WHERE w.organization_id = o.id)::int AS workspaces,
       (SELECT COUNT(DISTINCT m.user_id) FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE w.organization_id = o.id)::int AS members
     FROM organizations o LEFT JOIN users u ON u.id = o.owner_id
     WHERE o.name ILIKE $1 ORDER BY o.created_at DESC LIMIT 100`,
    [pattern]
  );
  res.json({ success: true, organizations: rows.map((r) => ({ id: r.id, name: r.name, owner: r.owner, ownerEmail: r.owner_email, workspaces: r.workspaces, members: r.members, createdAt: r.created_at })) });
});

/** GET /api/admin/audit?limit=&before= — platform-wide audit trail. */
const auditLog = handle(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.metadata, a.created_at, u.username AS actor, w.name AS workspace
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN workspaces w ON w.id = a.workspace_id
     WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT $2`,
    [req.query.before || null, Math.min(Number(req.query.limit) || 50, 200)]
  );
  res.json({ success: true, events: rows.map((r) => ({ id: Number(r.id), action: r.action, targetType: r.target_type, targetId: r.target_id, metadata: r.metadata, actor: r.actor, workspace: r.workspace, createdAt: r.created_at })) });
});

/** GET /api/admin/reports — open message reports. */
const listReports = handle(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.reason, r.details, r.status, r.created_at, rep.username AS reporter, s.username AS sender, LEFT(m.text, 200) AS text
     FROM message_reports r LEFT JOIN users rep ON rep.id = r.reporter_id LEFT JOIN messages m ON m.id = r.message_id LEFT JOIN users s ON s.id = m.sender_id
     ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 100`
  );
  res.json({ success: true, reports: rows.map((r) => ({ id: r.id, reason: r.reason, details: r.details, status: r.status, reporter: r.reporter, sender: r.sender, text: r.text, createdAt: r.created_at })) });
});

/** PATCH /api/admin/reports/:id { status: reviewed|dismissed } */
const updateReport = handle(async (req, res) => {
  if (!["reviewed", "dismissed", "open"].includes(req.body?.status)) return res.status(400).json({ success: false, message: "Invalid status." });
  await query("UPDATE message_reports SET status = $2 WHERE id = $1", [req.params.id, req.body.status]);
  await require("../services/audit").audit(req, "report.update", { targetType: "report", targetId: req.params.id, metadata: { status: req.body.status } });
  res.json({ success: true });
});

module.exports = { overview, listUsers, listOrganizations, auditLog, listReports, updateReport };
