const { query } = require("../config/db");
const User = require("./User");
const Message = require("./Message");

// Conversation with both participants and its latest message
const SELECT_FULL = `
  SELECT c.*, to_jsonb(ua.*) AS ua, to_jsonb(ub.*) AS ub, to_jsonb(lm.*) AS lm
  FROM conversations c
  JOIN users ua ON ua.id = c.user_a
  JOIN users ub ON ub.id = c.user_b
  LEFT JOIN LATERAL (
    SELECT * FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
  ) lm ON TRUE`;

const fromRow = (row) => {
  if (!row) return null;
  const lastMessage = Message.fromRow(row.lm);
  return {
    _id: row.id,
    id: row.id,
    participants: [User.toPublic(User.fromRow(row.ua)), User.toPublic(User.fromRow(row.ub))],
    lastMessage: lastMessage || null,
    lastMessageTime: lastMessage ? lastMessage.createdAt : row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const participantIds = (row) => [row.user_a, row.user_b];

/**
 * Returns the raw conversation row only if `userId` is a participant.
 */
const findForUser = async (id, userId) => {
  const { rows } = await query(
    "SELECT * FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)",
    [id, userId]
  );
  return rows[0] || null;
};

const getFull = async (id) => {
  const { rows } = await query(`${SELECT_FULL} WHERE c.id = $1`, [id]);
  return fromRow(rows[0]);
};

/**
 * Finds the conversation between two users, creating it if needed.
 * Returns { conversation, created }.
 */
const getOrCreate = async (userId, otherUserId) => {
  const [a, b] = [String(userId), String(otherUserId)].sort();
  const inserted = await query(
    `INSERT INTO conversations (user_a, user_b) VALUES ($1, $2)
     ON CONFLICT (user_a, user_b) DO NOTHING RETURNING id`,
    [a, b]
  );
  const { rows } = await query(`${SELECT_FULL} WHERE c.user_a = $1 AND c.user_b = $2`, [a, b]);
  return { conversation: fromRow(rows[0]), created: inserted.rowCount > 0 };
};

const listForUser = async (userId) => {
  const { rows } = await query(
    `${SELECT_FULL} WHERE c.user_a = $1 OR c.user_b = $1
     ORDER BY COALESCE(lm.created_at, c.updated_at) DESC`,
    [userId]
  );
  return rows.map(fromRow);
};

module.exports = { participantIds, findForUser, getFull, getOrCreate, listForUser };
