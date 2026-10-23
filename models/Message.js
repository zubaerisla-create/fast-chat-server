const { query } = require("../config/db");

// Sender + reactions populated the same way the Mongo version did with .populate()
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
    ), '[]'::json) AS reactions
  FROM messages m
  JOIN users u ON u.id = m.sender_id`;

const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Maps a messages row to the API shape. `senderId` is the populated sender
 * object when the row came from SELECT_FULL, otherwise the plain id.
 */
const fromRow = (row) =>
  row && {
    _id: row.id,
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender || row.sender_id,
    text: row.text,
    replyToMessageId: row.reply_to_message_id,
    replyToText: row.reply_to_text,
    replyToSenderId: row.reply_to_sender_id,
    fileUrl: row.file_url,
    fileType: row.file_type,
    fileName: row.file_name,
    fileSize: toNumber(row.file_size),
    audioDuration: toNumber(row.audio_duration),
    isRead: row.is_read,
    reactions: row.reactions || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timestamp: row.created_at,
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
 * Inserts a message, bumps the conversation for list ordering,
 * and returns the populated message.
 */
const create = async (fields) => {
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, sender_id, text, file_url, file_type, file_name,
                           file_size, audio_duration, reply_to_message_id, reply_to_text, reply_to_sender_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
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
    ]
  );
  await query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [fields.conversationId]);
  return getFull(rows[0].id);
};

const listForConversation = async (conversationId) => {
  const { rows } = await query(`${SELECT_FULL} WHERE m.conversation_id = $1 ORDER BY m.created_at ASC`, [
    conversationId,
  ]);
  return rows.map(fromRow);
};

const listMedia = async (conversationId) => {
  const { rows } = await query(
    "SELECT * FROM messages WHERE conversation_id = $1 AND file_url IS NOT NULL ORDER BY created_at DESC",
    [conversationId]
  );
  return rows.map(fromRow);
};

/**
 * Marks the reader's incoming unread messages as read.
 * Optionally limited to one sender. Returns [{ id, senderId }] of updated rows.
 */
const markRead = async (conversationId, readerId, senderId = null) => {
  const { rows } = await query(
    `UPDATE messages SET is_read = TRUE, updated_at = NOW()
     WHERE conversation_id = $1 AND sender_id <> $2 AND is_read = FALSE
       AND ($3::uuid IS NULL OR sender_id = $3::uuid)
     RETURNING id, sender_id`,
    [conversationId, readerId, senderId]
  );
  return rows.map((r) => ({ id: r.id, senderId: r.sender_id }));
};

const remove = (id) => query("DELETE FROM messages WHERE id = $1", [id]);

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

module.exports = {
  fromRow,
  findById,
  getFull,
  create,
  listForConversation,
  listMedia,
  markRead,
  remove,
  toggleReaction,
};
