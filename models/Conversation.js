const crypto = require("crypto");
const { query, withTransaction } = require("../config/db");
const User = require("./User");
const Message = require("./Message");

/**
 * Conversations of every type (direct, group, channel) share one membership model:
 * conversation_members. Direct chats also keep user_a/user_b (unique pair) so the
 * original API keeps working. Every read goes through membership, so a user only
 * ever sees conversations they belong to.
 */

const MEMBER_LIST_LIMIT = 200; // members embedded in a conversation payload

// Conversation + viewer's membership + latest message + unread count + members
const SELECT_FOR_VIEWER = `
  SELECT c.*, to_jsonb(lm.*) AS lm,
    me.role AS my_role, me.last_read_at AS my_last_read_at, me.muted_until AS my_muted_until,
    me.pinned_at AS my_pinned_at, me.archived_at AS my_archived_at,
    (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id)::int AS member_count,
    (SELECT COUNT(*) FROM messages um
      WHERE um.conversation_id = c.id AND um.sender_id <> me.user_id AND um.deleted_at IS NULL AND um.kind = 'user'
        AND um.created_at > COALESCE(me.last_read_at, '-infinity'::timestamptz)
        AND (c.type <> 'direct' OR um.is_read = FALSE))::int AS unread_count,
    (SELECT json_agg(json_build_object('user', to_jsonb(u.*), 'role', m.role) ORDER BY m.joined_at)
       FROM (SELECT * FROM conversation_members WHERE conversation_id = c.id ORDER BY joined_at LIMIT ${MEMBER_LIST_LIMIT}) m
       JOIN users u ON u.id = m.user_id) AS members
  FROM conversations c
  JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = $1
  LEFT JOIN LATERAL (
    SELECT * FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
  ) lm ON TRUE`;

const publicUser = (raw) => User.toPublic(User.fromRow(raw));

const fromRow = (row) => {
  if (!row) return null;
  const lastMessage = Message.fromRow(row.lm);
  const members = (row.members || []).map((m) => ({ ...publicUser(m.user), role: m.role }));
  return {
    _id: row.id,
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    avatar: row.avatar,
    workspaceId: row.workspace_id || null,
    visibility: row.visibility || null,
    adminsOnlyPost: row.admins_only_post,
    createdBy: row.created_by,
    // Kept for older clients: for direct chats these are the two users
    participants: members.map(({ role, ...u }) => u),
    members,
    memberCount: row.member_count,
    lastMessage: lastMessage || null,
    lastMessageTime: lastMessage ? lastMessage.createdAt : row.updated_at,
    unreadCount: row.unread_count ?? 0,
    myRole: row.my_role,
    mutedUntil: row.my_muted_until,
    pinnedAt: row.my_pinned_at,
    archivedAt: row.my_archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/** Raw conversation row plus the user's membership, only if the user is a member. */
const findForUser = async (id, userId) => {
  const { rows } = await query(
    `SELECT c.*, m.role AS my_role, m.muted_until AS my_muted_until
     FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $2
     WHERE c.id = $1`,
    [id, userId]
  );
  return rows[0] || null;
};

const memberIds = async (conversationId) => {
  const { rows } = await query("SELECT user_id FROM conversation_members WHERE conversation_id = $1", [conversationId]);
  return rows.map((r) => r.user_id);
};

const getFull = async (id, viewerId) => {
  const { rows } = await query(`${SELECT_FOR_VIEWER} WHERE c.id = $2`, [viewerId, id]);
  return fromRow(rows[0]);
};

/** Finds the direct conversation between two users, creating it if needed. */
const getOrCreate = async (userId, otherUserId) => {
  const [a, b] = [String(userId), String(otherUserId)].sort();
  return withTransaction(async (db) => {
    const inserted = await db.query(
      `INSERT INTO conversations (user_a, user_b, type, created_by) VALUES ($1, $2, 'direct', $3)
       ON CONFLICT (user_a, user_b) DO NOTHING RETURNING id`,
      [a, b, userId]
    );
    const { rows } = await db.query("SELECT id FROM conversations WHERE user_a = $1 AND user_b = $2", [a, b]);
    const id = rows[0].id;
    await db.query(
      "INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING",
      [id, a, b]
    );
    return { id, created: inserted.rowCount > 0 };
  }).then(async ({ id, created }) => ({ conversation: await getFull(id, userId), created }));
};

/**
 * Conversations the user belongs to, newest activity first.
 * Optional filters: type, workspaceId (null = not in a workspace), archived.
 */
const listForUser = async (userId, { type, workspaceId, includeArchived = false } = {}) => {
  const where = ["TRUE"];
  const params = [userId];
  if (type) {
    params.push(type);
    where.push(`c.type = $${params.length}`);
  }
  if (workspaceId !== undefined) {
    if (workspaceId === null) where.push("c.workspace_id IS NULL");
    else {
      params.push(workspaceId);
      where.push(`c.workspace_id = $${params.length}`);
    }
  }
  if (!includeArchived) where.push("me.archived_at IS NULL");
  const { rows } = await query(
    `${SELECT_FOR_VIEWER} WHERE ${where.join(" AND ")}
     ORDER BY me.pinned_at DESC NULLS LAST, COALESCE(lm.created_at, c.updated_at) DESC`,
    params
  );
  return rows.map(fromRow);
};

const newInviteCode = () => crypto.randomBytes(12).toString("base64url");

/** Creates a group with the creator as owner and the given members. */
const createGroup = async ({ creatorId, title, description = null, avatar = null, memberIds: ids = [], workspaceId = null, type = "group", visibility = null, adminsOnlyPost = false }) => {
  const unique = [...new Set(ids.map(String))].filter((id) => id !== String(creatorId));
  const id = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO conversations (type, title, description, avatar, created_by, workspace_id, visibility, admins_only_post, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING id`,
      [type, title, description, avatar, creatorId, workspaceId, visibility, adminsOnlyPost]
    );
    const convId = rows[0].id;
    await db.query("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'owner')", [convId, creatorId]);
    if (unique.length) {
      await db.query(
        `INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, u.id FROM users u WHERE u.id = ANY($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [convId, unique]
      );
    }
    return convId;
  });
  return getFull(id, creatorId);
};

const update = async (id, fields) => {
  const map = { title: "title", description: "description", avatar: "avatar", adminsOnlyPost: "admins_only_post", visibility: "visibility" };
  const sets = [];
  const values = [id];
  for (const [key, column] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return;
  await query(`UPDATE conversations SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`, values);
};

/** Adds users that exist; returns the ids actually added. */
const addMembers = async (id, userIds) => {
  const { rows } = await query(
    `INSERT INTO conversation_members (conversation_id, user_id)
     SELECT $1, u.id FROM users u WHERE u.id = ANY($2::uuid[])
     ON CONFLICT DO NOTHING RETURNING user_id`,
    [id, userIds]
  );
  return rows.map((r) => r.user_id);
};

const removeMember = async (id, userId) => {
  const { rowCount } = await query("DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [id, userId]);
  return rowCount > 0;
};

const getMember = async (id, userId) => {
  const { rows } = await query("SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [id, userId]);
  return rows[0] || null;
};

const setRole = (id, userId, role) =>
  query("UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2", [id, userId, role]);

/** The member who should own the group after the owner leaves: oldest admin, else oldest member. */
const successor = async (id, excludeUserId) => {
  const { rows } = await query(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2
     ORDER BY (role = 'admin') DESC, joined_at LIMIT 1`,
    [id, excludeUserId]
  );
  return rows[0]?.user_id || null;
};

/** Per-member settings: mute, pin, archive, read position. */
const updateMembership = async (id, userId, { mutedUntil, pinned, archived } = {}) => {
  const sets = [];
  const values = [id, userId];
  if (mutedUntil !== undefined) {
    values.push(mutedUntil);
    sets.push(`muted_until = $${values.length}`);
  }
  if (pinned !== undefined) sets.push(`pinned_at = ${pinned ? "NOW()" : "NULL"}`);
  if (archived !== undefined) sets.push(`archived_at = ${archived ? "NOW()" : "NULL"}`);
  if (!sets.length) return;
  await query(`UPDATE conversation_members SET ${sets.join(", ")} WHERE conversation_id = $1 AND user_id = $2`, values);
};

const ensureInviteCode = async (id, regenerate = false) => {
  const { rows } = await query(
    `UPDATE conversations SET invite_code = CASE WHEN $2 OR invite_code IS NULL THEN $3 ELSE invite_code END
     WHERE id = $1 RETURNING invite_code`,
    [id, regenerate, newInviteCode()]
  );
  return rows[0]?.invite_code;
};

const findByInviteCode = async (code) => {
  const { rows } = await query("SELECT * FROM conversations WHERE invite_code = $1 AND type = 'group'", [code]);
  return rows[0] || null;
};

/** Search the user's conversations by title or the other person's username. */
const searchForUser = async (userId, term) => {
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const { rows } = await query(
    `${SELECT_FOR_VIEWER}
     WHERE c.title ILIKE $2 OR EXISTS (
       SELECT 1 FROM conversation_members om JOIN users ou ON ou.id = om.user_id
       WHERE om.conversation_id = c.id AND om.user_id <> $1 AND c.type = 'direct' AND ou.username ILIKE $2)
     ORDER BY COALESCE(lm.created_at, c.updated_at) DESC LIMIT 30`,
    [userId, pattern]
  );
  return rows.map(fromRow);
};

module.exports = {
  fromRow,
  findForUser,
  memberIds,
  getFull,
  getOrCreate,
  listForUser,
  createGroup,
  update,
  addMembers,
  removeMember,
  getMember,
  setRole,
  successor,
  updateMembership,
  ensureInviteCode,
  findByInviteCode,
  searchForUser,
};
