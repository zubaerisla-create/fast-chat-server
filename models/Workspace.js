const crypto = require("crypto");
const { query, withTransaction } = require("../config/db");

const slugify = (name) =>
  String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";

const wsFromRow = (r) =>
  r && {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    logo: r.logo,
    settings: r.settings || {},
    createdAt: r.created_at,
    ...(r.my_role !== undefined ? { myRole: r.my_role } : {}),
    ...(r.member_count !== undefined ? { memberCount: r.member_count } : {}),
    ...(r.org_name !== undefined ? { organization: { id: r.organization_id, name: r.org_name, logo: r.org_logo, ownerId: r.org_owner_id } } : {}),
    ...(r.unread_count !== undefined ? { unreadCount: r.unread_count } : {}),
  };

// ─── Organizations ───────────────────────────────────────────────────────────

const createOrganization = async (db, { name, ownerId }) =>
  (await db.query("INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING *", [name, ownerId])).rows[0];

const getOrganization = async (id) => (await query("SELECT * FROM organizations WHERE id = $1", [id])).rows[0] || null;

/** Organizations the user owns or has a workspace in. */
const listOrganizations = async (userId) => {
  const { rows } = await query(
    `SELECT o.*, (o.owner_id = $1) AS is_owner,
       (SELECT COUNT(*) FROM workspaces w WHERE w.organization_id = o.id)::int AS workspace_count
     FROM organizations o
     WHERE o.owner_id = $1 OR EXISTS (SELECT 1 FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE w.organization_id = o.id AND m.user_id = $1)
     ORDER BY o.created_at`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, logo: r.logo, ownerId: r.owner_id, isOwner: r.is_owner, workspaceCount: r.workspace_count, createdAt: r.created_at }));
};

const updateOrganization = (id, { name, logo }) =>
  query("UPDATE organizations SET name = COALESCE($2, name), logo = CASE WHEN $3::boolean THEN $4 ELSE logo END, updated_at = NOW() WHERE id = $1", [
    id,
    name ?? null,
    logo !== undefined,
    logo ?? null,
  ]);

// ─── Workspaces ──────────────────────────────────────────────────────────────

async function uniqueSlug(db, name) {
  const base = slugify(name);
  for (let i = 0; i < 5; i += 1) {
    const slug = i === 0 ? base : `${base}-${crypto.randomBytes(2).toString("hex")}`;
    const { rowCount } = await db.query("SELECT 1 FROM workspaces WHERE slug = $1", [slug]);
    if (!rowCount) return slug;
  }
  return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Creates a workspace (and its organization if none is given) with the creator as owner,
 * plus #general and #announcements channels.
 */
const create = ({ name, description, organizationId, ownerId }) =>
  withTransaction(async (db) => {
    const orgId = organizationId || (await createOrganization(db, { name, ownerId })).id;
    const slug = await uniqueSlug(db, name);
    const ws = (
      await db.query(
        "INSERT INTO workspaces (organization_id, name, slug, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [orgId, name, slug, description || null, ownerId]
      )
    ).rows[0];
    await db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [ws.id, ownerId]);
    for (const ch of [
      { title: "general", description: "Company-wide conversation", adminsOnly: false, kind: "general" },
      { title: "announcements", description: "Important updates from admins", adminsOnly: true, kind: "announcement" },
    ]) {
      const c = (
        await db.query(
          `INSERT INTO conversations (type, title, description, workspace_id, visibility, admins_only_post, channel_kind, created_by, last_message_at)
           VALUES ('channel', $1, $2, $3, 'public', $4, $5, $6, NOW()) RETURNING id`,
          [ch.title, ch.description, ws.id, ch.adminsOnly, ch.kind, ownerId]
        )
      ).rows[0];
      await db.query("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'owner')", [c.id, ownerId]);
    }
    return ws.id;
  });

/** The user's role in a workspace (null if not a member) plus the workspace row. */
const membership = async (workspaceId, userId) => {
  const { rows } = await query(
    `SELECT w.*, m.role AS my_role, o.owner_id AS org_owner_id FROM workspaces w
     JOIN organizations o ON o.id = w.organization_id
     LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
     WHERE w.id = $1`,
    [workspaceId, userId]
  );
  return rows[0] || null;
};

const get = async (id, userId) => {
  const { rows } = await query(
    `SELECT w.*, m.role AS my_role, o.name AS org_name, o.logo AS org_logo, o.owner_id AS org_owner_id,
       (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id)::int AS member_count
     FROM workspaces w JOIN organizations o ON o.id = w.organization_id
     JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
     WHERE w.id = $1`,
    [id, userId]
  );
  return wsFromRow(rows[0]);
};

const listForUser = async (userId) => {
  const { rows } = await query(
    `SELECT w.*, m.role AS my_role, o.name AS org_name, o.logo AS org_logo, o.owner_id AS org_owner_id,
       (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id)::int AS member_count,
       (SELECT COUNT(*) FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
          JOIN messages msg ON msg.conversation_id = c.id
          WHERE c.workspace_id = w.id AND msg.sender_id <> $1 AND msg.kind = 'user' AND msg.deleted_at IS NULL
            AND msg.created_at > COALESCE(cm.last_read_at, '-infinity'::timestamptz))::int AS unread_count
     FROM workspaces w JOIN organizations o ON o.id = w.organization_id
     JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
     ORDER BY m.joined_at`,
    [userId]
  );
  return rows.map(wsFromRow);
};

const update = (id, { name, description, logo, settings }) =>
  query(
    `UPDATE workspaces SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
       logo = CASE WHEN $5::boolean THEN $6 ELSE logo END, settings = COALESCE($7::jsonb, settings), updated_at = NOW()
     WHERE id = $1`,
    [id, name ?? null, description !== undefined, description ?? null, logo !== undefined, logo ?? null, settings ? JSON.stringify(settings) : null]
  );

const remove = (id) => query("DELETE FROM workspaces WHERE id = $1", [id]);

// ─── Members ─────────────────────────────────────────────────────────────────

const listMembers = async (workspaceId, { q = "", limit = 50, offset = 0 } = {}) => {
  const pattern = `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;
  const { rows } = await query(
    `SELECT u.id, u.username, u.email, u.avatar, u.is_online, u.last_seen, m.role, m.title, m.joined_at, m.last_active_at,
       COUNT(*) OVER()::int AS total
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1 AND (u.username ILIKE $2 OR u.email ILIKE $2)
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'member' THEN 3 ELSE 4 END, u.username
     LIMIT $3 OFFSET $4`,
    [workspaceId, pattern, Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0)]
  );
  return {
    total: rows[0]?.total ?? 0,
    members: rows.map((r) => ({
      id: r.id,
      _id: r.id,
      username: r.username,
      email: r.email,
      avatar: r.avatar,
      isOnline: r.is_online,
      lastSeen: r.last_seen,
      role: r.role,
      title: r.title,
      joinedAt: r.joined_at,
      lastActiveAt: r.last_active_at,
    })),
  };
};

const getMember = async (workspaceId, userId) =>
  (await query("SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId])).rows[0] || null;

/** Adds a member and puts them in the workspace's public general/announcement channels. */
const addMember = (workspaceId, userId, role, db = null) => {
  const run = async (tx) => {
    const { rowCount } = await tx.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [workspaceId, userId, role]
    );
    if (rowCount && role !== "guest") {
      await tx.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         SELECT id, $2 FROM conversations WHERE workspace_id = $1 AND type = 'channel' AND channel_kind IN ('general', 'announcement') AND visibility = 'public'
         ON CONFLICT DO NOTHING`,
        [workspaceId, userId]
      );
    }
    return rowCount > 0;
  };
  return db ? run(db) : withTransaction(run);
};

/** Removes a member from the workspace and every channel in it. */
const removeMember = (workspaceId, userId) =>
  withTransaction(async (db) => {
    await db.query(
      "DELETE FROM conversation_members WHERE user_id = $2 AND conversation_id IN (SELECT id FROM conversations WHERE workspace_id = $1)",
      [workspaceId, userId]
    );
    const { rowCount } = await db.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
    return rowCount > 0;
  });

const setMember = (workspaceId, userId, { role, title }) =>
  query("UPDATE workspace_members SET role = COALESCE($3, role), title = CASE WHEN $4::boolean THEN $5 ELSE title END WHERE workspace_id = $1 AND user_id = $2", [
    workspaceId,
    userId,
    role ?? null,
    title !== undefined,
    title ?? null,
  ]);

/** Moves ownership atomically (the one-owner index forbids two owners at any moment). */
const transferOwnership = (workspaceId, fromUserId, toUserId) =>
  withTransaction(async (db) => {
    await db.query("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2", [workspaceId, fromUserId]);
    await db.query("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [workspaceId, toUserId]);
  });

const touch = (workspaceId, userId) =>
  query("UPDATE workspace_members SET last_active_at = NOW() WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);

// ─── Invitations ─────────────────────────────────────────────────────────────

const INVITE_DAYS = 7;
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

/** Creates an invitation; returns { invitation, token } — the token is never stored. */
const createInvitation = async (db, { workspaceId, email, role, invitedBy }) => {
  const token = crypto.randomBytes(24).toString("base64url");
  // A newer invite for the same email replaces older pending ones
  await db.query(
    "UPDATE workspace_invitations SET revoked_at = NOW() WHERE workspace_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL",
    [workspaceId, email]
  );
  const { rows } = await db.query(
    `INSERT INTO workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(days => $6)) RETURNING *`,
    [workspaceId, email, role, hashToken(token), invitedBy, INVITE_DAYS]
  );
  return { invitation: rows[0], token };
};

const invitationByToken = async (token) => {
  const { rows } = await query(
    `SELECT i.*, w.name AS workspace_name, w.logo AS workspace_logo, u.username AS inviter_name
     FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.token_hash = $1`,
    [hashToken(String(token))]
  );
  return rows[0] || null;
};

const listInvitations = async (workspaceId) => {
  const { rows } = await query(
    `SELECT i.id, i.email, i.role, i.expires_at, i.created_at, u.username AS invited_by
     FROM workspace_invitations i LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.workspace_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
     ORDER BY i.created_at DESC`,
    [workspaceId]
  );
  return rows.map((r) => ({ id: r.id, email: r.email, role: r.role, expiresAt: r.expires_at, createdAt: r.created_at, invitedBy: r.invited_by }));
};

const pendingInvitationsForEmail = async (email) => {
  const { rows } = await query(
    `SELECT i.id, i.role, i.expires_at, w.id AS workspace_id, w.name AS workspace_name, w.logo AS workspace_logo, u.username AS invited_by
     FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by
     WHERE lower(i.email) = lower($1) AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
     ORDER BY i.created_at DESC`,
    [email]
  );
  return rows.map((r) => ({ id: r.id, role: r.role, expiresAt: r.expires_at, invitedBy: r.invited_by, workspace: { id: r.workspace_id, name: r.workspace_name, logo: r.workspace_logo } }));
};

const revokeInvitation = (workspaceId, id) =>
  query("UPDATE workspace_invitations SET revoked_at = NOW() WHERE workspace_id = $1 AND id = $2 AND accepted_at IS NULL", [workspaceId, id]);

/** Accepts atomically: the invitation can be used once. Returns the workspace id or null. */
const acceptInvitation = (invitationId, userId) =>
  withTransaction(async (db) => {
    const { rows } = await db.query(
      `UPDATE workspace_invitations SET accepted_at = NOW(), accepted_by = $2
       WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
       RETURNING workspace_id, role`,
      [invitationId, userId]
    );
    if (!rows[0]) return null;
    await addMember(rows[0].workspace_id, userId, rows[0].role, db);
    return rows[0].workspace_id;
  });

// ─── Channels ────────────────────────────────────────────────────────────────

const channelName = (name) =>
  String(name || "").toLowerCase().trim().replace(/^#/, "").replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 50);

/**
 * Channels visible to a user: the ones they're in, plus (unless guest) public ones they can join.
 */
const listChannels = async (workspaceId, userId, { includeBrowsable }) => {
  const { rows } = await query(
    `SELECT c.id, c.title, c.description, c.visibility, c.channel_kind, c.admins_only_post, c.created_at, c.last_message_at,
       me.user_id IS NOT NULL AS joined, me.role AS my_role, me.muted_until,
       (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id)::int AS member_count,
       CASE WHEN me.user_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $2
         AND m.kind = 'user' AND m.deleted_at IS NULL AND m.created_at > COALESCE(me.last_read_at, '-infinity'::timestamptz)) END::int AS unread_count
     FROM conversations c
     LEFT JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = $2
     WHERE c.workspace_id = $1 AND c.type = 'channel' AND (me.user_id IS NOT NULL OR ($3 AND c.visibility = 'public'))
     ORDER BY (c.channel_kind = 'general') DESC, c.title`,
    [workspaceId, userId, includeBrowsable]
  );
  return rows.map((r) => ({
    id: r.id,
    _id: r.id,
    name: r.title,
    title: r.title,
    description: r.description,
    visibility: r.visibility,
    kind: r.channel_kind,
    adminsOnlyPost: r.admins_only_post,
    joined: r.joined,
    myRole: r.my_role,
    muted: Boolean(r.muted_until && new Date(r.muted_until) > new Date()),
    memberCount: r.member_count,
    unreadCount: r.unread_count,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
  }));
};

const getChannel = async (workspaceId, channelId) =>
  (await query("SELECT * FROM conversations WHERE id = $1 AND workspace_id = $2 AND type = 'channel'", [channelId, workspaceId])).rows[0] || null;

const channelExists = async (workspaceId, name, exceptId = null) =>
  (await query("SELECT 1 FROM conversations WHERE workspace_id = $1 AND type = 'channel' AND lower(title) = lower($2) AND ($3::uuid IS NULL OR id <> $3)", [workspaceId, name, exceptId])).rowCount > 0;

// ─── Activity ────────────────────────────────────────────────────────────────

const activity = async (workspaceId, { limit = 50, before = null } = {}) => {
  const { rows } = await query(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.metadata, a.created_at, u.username AS actor
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.workspace_id = $1 AND ($2::bigint IS NULL OR a.id < $2)
     ORDER BY a.id DESC LIMIT $3`,
    [workspaceId, before, Math.min(Number(limit) || 50, 200)]
  );
  return rows.map((r) => ({ id: Number(r.id), action: r.action, targetType: r.target_type, targetId: r.target_id, metadata: r.metadata, actor: r.actor, createdAt: r.created_at }));
};

module.exports = {
  slugify,
  INVITE_DAYS,
  createOrganization,
  getOrganization,
  listOrganizations,
  updateOrganization,
  create,
  membership,
  get,
  listForUser,
  update,
  remove,
  listMembers,
  getMember,
  addMember,
  removeMember,
  setMember,
  transferOwnership,
  touch,
  createInvitation,
  invitationByToken,
  listInvitations,
  pendingInvitationsForEmail,
  revokeInvitation,
  acceptInvitation,
  channelName,
  listChannels,
  getChannel,
  channelExists,
  activity,
};
