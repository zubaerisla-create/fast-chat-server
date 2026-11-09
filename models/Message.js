const { query } = require("../config/db");

// Sender + reactions + pin state populated the same way the Mongo version did with .populate()
const SELECT_FULL = `
  SELECT m.*,
    json_build_object('_id', u.id, 'id', u.id, 'username', u.username, 'avatar', u.avatar) AS sender,
    COALESCE((
      SELECT json_agg(json_build_object(
               '_id', r.id,
               'userId', json_build_object('_id', ru.id, 'id', ru.id, 'username', ru.username, 'avatar', ru.avatar),
               'emoji', r.emoji,
               'createdAt', r.created_at
             ) ORDER BY r.created_at)
      FROM message_reactions r JOIN users ru ON ru.id = r.user_id
      WHERE r.message_id = m.id
    ), '[]'::json) AS reactions,
    EXISTS (SELECT 1 FROM message_pins p WHERE p.message_id = m.id) AS is_pinned
  FROM messages m
  JOIN users u ON u.id = m.sender_id`;

const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Maps a messages row to the API shape. `senderId` is the populated sender
 * object when the row came from SELECT_FULL, otherwise the plain id.
 * A message deleted for everyone keeps its place but loses its content.
 */
const fromRow = (row) => {
  if (!row) return null;
  const deleted = Boolean(row.deleted_at);
  return {
    _id: row.id,
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender || row.sender_id,
    kind: row.kind || "user",
    text: deleted ? "" : row.text,
    replyToMessageId: row.reply_to_message_id,
    replyToText: deleted ? null : row.reply_to_text,
    replyToSenderId: row.reply_to_sender_id,
    fileUrl: deleted ? null : row.file_url,
    fileType: deleted ? null : row.file_type,
    fileName: deleted ? null : row.file_name,
    fileSize: deleted ? null : toNumber(row.file_size),
    audioDuration: deleted ? null : toNumber(row.audio_duration),
    attachments: deleted ? [] : row.attachments || [],
    linkPreview: deleted ? null : row.link_preview || null,
    forwarded: Boolean(row.forwarded),
    isRead: row.is_read,
    deliveredAt: row.delivered_at || null,
    editedAt: row.edited_at || null,
    deletedAt: row.deleted_at || null,
    isPinned: Boolean(row.is_pinned),
    clientId: row.client_id || null,
    reactions: deleted ? [] : row.reactions || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timestamp: row.created_at,
  };
};

const findById = async (id) => {
  const { rows } = await query("SELECT * FROM messages WHERE id = $1", [id]);
  return rows[0] || null;
};

const getFull = async (id) => {
  const { rows } = await query(`${SELECT_FULL} WHERE m.id = $1`, [id]);
  return fromRow(rows[0]);
};

/**
 * Inserts a message, bumps the conversation for list ordering, and returns the
 * populated message. A retried send with the same clientId returns the original
 * message instead of creating a duplicate (offline queues retry).
 */
const create = async (fields) => {
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, sender_id, text, file_url, file_type, file_name, file_size, audio_duration,
                           reply_to_message_id, reply_to_text, reply_to_sender_id, attachments, forwarded, client_id, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      fields.conversationId,
      fields.senderId,
      fields.text || "",
      fields.fileUrl || null,
      fields.fileType || null,
      fields.fileName || null,
      fields.fileSize || null,
      fields.audioDuration || null,
      fields.replyToMessageId || null,
      fields.replyToText || null,
      fields.replyToSenderId || null,
      fields.attachments?.length ? JSON.stringify(fields.attachments) : null,
      Boolean(fields.forwarded),
      fields.clientId || null,
      fields.kind || "user",
    ]
  );
  if (!rows[0]) {
    const existing = await query("SELECT id FROM messages WHERE sender_id = $1 AND client_id = $2", [fields.senderId, fields.clientId]);
    const message = await getFull(existing.rows[0].id);
    return Object.assign(message, { duplicate: true });
  }
  await query("UPDATE conversations SET updated_at = NOW(), last_message_at = NOW() WHERE id = $1", [fields.conversationId]);
  return getFull(rows[0].id);
};

/** Legacy: the whole history, oldest first (old clients without pagination). */
const listForConversation = async (conversationId) => {
  const { rows } = await query(`${SELECT_FULL} WHERE m.conversation_id = $1 ORDER BY m.created_at ASC`, [conversationId]);
  return rows.map(fromRow);
};

/**
 * Cursor pagination: up to `limit` messages older than the `before` message,
 * returned oldest first, plus whether more exist.
 */
const listPage = async (conversationId, { before = null, limit = 50 } = {}) => {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const { rows } = await query(
    `${SELECT_FULL}
     WHERE m.conversation_id = $1
       AND ($2::uuid IS NULL OR (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $2::uuid))
     ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
    [conversationId, before, lim + 1]
  );
  const hasMore = rows.length > lim;
  return { messages: rows.slice(0, lim).reverse().map(fromRow), hasMore };
};

const listMedia = async (conversationId) => {
  const { rows } = await query(
    "SELECT * FROM messages WHERE conversation_id = $1 AND file_url IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC",
    [conversationId]
  );
  return rows.map(fromRow);
};

/**
 * Marks the reader's incoming messages as read: moves their read position and, for
 * direct chats, sets the per-message flag older clients use.
 * Returns [{ id, senderId }] of messages newly marked.
 */
const markRead = async (conversationId, readerId, senderId = null) => {
  await query(
    "UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2",
    [conversationId, readerId]
  );
  const { rows } = await query(
    `UPDATE messages SET is_read = TRUE, delivered_at = COALESCE(delivered_at, NOW()), updated_at = NOW()
     WHERE conversation_id = $1 AND sender_id <> $2 AND is_read = FALSE
       AND ($3::uuid IS NULL OR sender_id = $3::uuid)
     RETURNING id, sender_id`,
    [conversationId, readerId, senderId]
  );
  return rows.map((r) => ({ id: r.id, senderId: r.sender_id }));
};

/** Marks messages delivered to a recipient's device; returns [{ id, senderId, conversationId }]. */
const markDelivered = async (messageIds, recipientId) => {
  if (!messageIds.length) return [];
  const { rows } = await query(
    `UPDATE messages m SET delivered_at = NOW()
     FROM conversation_members cm
     WHERE m.id = ANY($1::uuid[]) AND m.delivered_at IS NULL AND m.sender_id <> $2
       AND cm.conversation_id = m.conversation_id AND cm.user_id = $2
     RETURNING m.id, m.sender_id, m.conversation_id`,
    [messageIds, recipientId]
  );
  return rows.map((r) => ({ id: r.id, senderId: r.sender_id, conversationId: r.conversation_id }));
};

/** Per-member read positions of a group, for "seen by" lists. */
const readPositions = async (conversationId) => {
  const { rows } = await query(
    `SELECT cm.user_id, cm.last_read_at, u.username, u.avatar FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $1 AND cm.last_read_at IS NOT NULL`,
    [conversationId]
  );
  return rows.map((r) => ({ userId: r.user_id, username: r.username, avatar: r.avatar, lastReadAt: r.last_read_at }));
};

/** Hard delete (legacy "delete for me" from older clients used this). */
const remove = (id) => query("DELETE FROM messages WHERE id = $1", [id]);

/** Delete for everyone: clears content but keeps the row; returns the deleted file URLs. */
const softDelete = async (id) => {
  const { rows } = await query(
    `UPDATE messages SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL
     RETURNING file_url, attachments`,
    [id]
  );
  await query("DELETE FROM message_pins WHERE message_id = $1", [id]);
  if (!rows[0]) return [];
  return [rows[0].file_url, ...(rows[0].attachments || []).map((a) => a.url)].filter(Boolean);
};

const edit = async (id, text) => {
  await query("UPDATE messages SET text = $2, edited_at = NOW(), updated_at = NOW(), link_preview = NULL WHERE id = $1", [id, text]);
  return getFull(id);
};

const setLinkPreview = (id, preview) => query("UPDATE messages SET link_preview = $2 WHERE id = $1", [id, JSON.stringify(preview)]);

/**
 * Toggles a user's reaction: same emoji removes it, a different emoji replaces it.
 * Returns the message's populated reactions.
 */
const toggleReaction = async (messageId, userId, emoji) => {
  const { rowCount } = await query(
    "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
    [messageId, userId, emoji]
  );
  if (rowCount === 0) {
    await query(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = NOW()`,
      [messageId, userId, emoji]
    );
  }
  const message = await getFull(messageId);
  return message ? message.reactions : [];
};

const pin = (messageId, conversationId, userId) =>
  query(
    "INSERT INTO message_pins (message_id, conversation_id, pinned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [messageId, conversationId, userId]
  );
const unpin = (messageId) => query("DELETE FROM message_pins WHERE message_id = $1", [messageId]);
const listPins = async (conversationId) => {
  const { rows } = await query(
    `${SELECT_FULL} JOIN message_pins p ON p.message_id = m.id WHERE p.conversation_id = $1 ORDER BY p.pinned_at DESC`,
    [conversationId]
  );
  return rows.map(fromRow);
};

/** Toggles a bookmark; returns true when the message is now bookmarked. */
const toggleBookmark = async (userId, messageId) => {
  const del = await query("DELETE FROM message_bookmarks WHERE user_id = $1 AND message_id = $2", [userId, messageId]);
  if (del.rowCount) return false;
  await query("INSERT INTO message_bookmarks (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, messageId]);
  return true;
};

/** Bookmarks the user can still see (still a member of the conversation). */
const listBookmarks = async (userId) => {
  const { rows } = await query(
    `${SELECT_FULL} JOIN message_bookmarks b ON b.message_id = m.id AND b.user_id = $1
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
     WHERE m.deleted_at IS NULL ORDER BY b.created_at DESC LIMIT 200`,
    [userId]
  );
  return rows.map(fromRow);
};

/**
 * Full-text search over messages in conversations the user belongs to
 * (optionally one conversation). Uses the GIN index on to_tsvector('simple', text).
 */
const search = async (userId, term, { conversationId = null, limit = 30 } = {}) => {
  const { rows } = await query(
    `${SELECT_FULL}
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
     WHERE m.deleted_at IS NULL AND m.kind = 'user'
       AND to_tsvector('simple', m.text) @@ plainto_tsquery('simple', $2)
       AND ($3::uuid IS NULL OR m.conversation_id = $3::uuid)
     ORDER BY m.created_at DESC LIMIT $4`,
    [userId, term, conversationId, Math.min(Number(limit) || 30, 100)]
  );
  return rows.map(fromRow);
};

const report = (messageId, reporterId, reason, details) =>
  query(
    `INSERT INTO message_reports (message_id, reporter_id, reason, details) VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id, reporter_id) DO UPDATE SET reason = EXCLUDED.reason, details = EXCLUDED.details`,
    [messageId, reporterId, reason, details]
  );

const hasHistory = async (conversationId) => {
  const { rowCount } = await query("SELECT 1 FROM messages WHERE conversation_id = $1 LIMIT 1", [conversationId]);
  return rowCount > 0;
};

module.exports = {
  fromRow,
  findById,
  getFull,
  create,
  hasHistory,
  listForConversation,
  listPage,
  listMedia,
  markRead,
  markDelivered,
  readPositions,
  remove,
  softDelete,
  edit,
  setLinkPreview,
  toggleReaction,
  pin,
  unpin,
  listPins,
  toggleBookmark,
  listBookmarks,
  search,
  report,
};
