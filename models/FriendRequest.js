const { query } = require("../config/db");
const User = require("./User");
const Conversation = require("./Conversation");
const Block = require("./Block");

const fromRow = (row) =>
  row && {
    id: row.id,
    _id: row.id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sender: row.sender_username
      ? {
          _id: row.sender_id,
          id: row.sender_id,
          username: row.sender_username,
          avatar: row.sender_avatar,
          email: row.sender_email,
          isOnline: row.sender_is_online,
          lastSeen: row.sender_last_seen,
        }
      : undefined,
    receiver: row.receiver_username
      ? {
          _id: row.receiver_id,
          id: row.receiver_id,
          username: row.receiver_username,
          avatar: row.receiver_avatar,
          email: row.receiver_email,
          isOnline: row.receiver_is_online,
          lastSeen: row.receiver_last_seen,
        }
      : undefined,
  };

const findById = async (id) => {
  const { rows } = await query(
    `SELECT fr.*,
      s.username as sender_username, s.avatar as sender_avatar, s.email as sender_email, s.is_online as sender_is_online, s.last_seen as sender_last_seen,
      r.username as receiver_username, r.avatar as receiver_avatar, r.email as receiver_email, r.is_online as receiver_is_online, r.last_seen as receiver_last_seen
     FROM friend_requests fr
     JOIN users s ON s.id = fr.sender_id
     JOIN users r ON r.id = fr.receiver_id
     WHERE fr.id = $1`,
    [id]
  );
  return fromRow(rows[0]);
};

const sendRequest = async (senderId, receiverId) => {
  if (String(senderId) === String(receiverId)) {
    const err = new Error("Cannot send friend request to yourself.");
    err.status = 400;
    throw err;
  }

  // Check if blocked
  if (await Block.between(senderId, receiverId)) {
    const err = new Error("Cannot send request to this user.");
    err.status = 403;
    throw err;
  }

  // Check existing pending or accepted requests
  const { rows: existing } = await query(
    `SELECT * FROM friend_requests
     WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
       AND status IN ('pending', 'accepted')`,
    [senderId, receiverId]
  );

  for (const req of existing) {
    if (req.status === "accepted") {
      const err = new Error("You are already connected with this user.");
      err.status = 400;
      throw err;
    }
    if (req.status === "pending") {
      if (req.sender_id === senderId) {
        const err = new Error("Friend request already sent.");
        err.status = 400;
        throw err;
      } else {
        const err = new Error("This user has already sent you a friend request.");
        err.status = 400;
        throw err;
      }
    }
  }

  const { rows } = await query(
    `INSERT INTO friend_requests (sender_id, receiver_id, status)
     VALUES ($1, $2, 'pending')
     RETURNING *`,
    [senderId, receiverId]
  );

  return findById(rows[0].id);
};

const acceptRequest = async (requestId, receiverId) => {
  const req = await findById(requestId);
  if (!req) {
    const err = new Error("Request not found.");
    err.status = 404;
    throw err;
  }
  if (req.receiverId !== receiverId) {
    const err = new Error("You are not authorized to accept this request.");
    err.status = 403;
    throw err;
  }
  if (req.status !== "pending") {
    const err = new Error(`Request is already ${req.status}.`);
    err.status = 400;
    throw err;
  }

  if (await Block.between(req.senderId, req.receiverId)) {
    const err = new Error("Cannot connect with this user.");
    err.status = 403;
    throw err;
  }

  await query(
    "UPDATE friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1",
    [requestId]
  );

  // Automatically create / fetch direct conversation
  const { conversation } = await Conversation.getOrCreate(req.senderId, req.receiverId);

  return {
    request: await findById(requestId),
    conversation,
  };
};

const rejectRequest = async (requestId, receiverId) => {
  const req = await findById(requestId);
  if (!req) {
    const err = new Error("Request not found.");
    err.status = 404;
    throw err;
  }
  if (req.receiverId !== receiverId) {
    const err = new Error("You are not authorized to reject this request.");
    err.status = 403;
    throw err;
  }
  if (req.status !== "pending") {
    const err = new Error(`Request is already ${req.status}.`);
    err.status = 400;
    throw err;
  }

  await query(
    "UPDATE friend_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1",
    [requestId]
  );

  return findById(requestId);
};

const cancelRequest = async (requestId, senderId) => {
  const req = await findById(requestId);
  if (!req) {
    const err = new Error("Request not found.");
    err.status = 404;
    throw err;
  }
  if (req.senderId !== senderId) {
    const err = new Error("You can only cancel requests you sent.");
    err.status = 403;
    throw err;
  }
  if (req.status !== "pending") {
    const err = new Error(`Request is already ${req.status}.`);
    err.status = 400;
    throw err;
  }

  await query(
    "UPDATE friend_requests SET status = 'canceled', updated_at = NOW() WHERE id = $1",
    [requestId]
  );

  return findById(requestId);
};

const listIncoming = async (userId) => {
  const { rows } = await query(
    `SELECT fr.*,
      s.username as sender_username, s.avatar as sender_avatar, s.email as sender_email, s.is_online as sender_is_online, s.last_seen as sender_last_seen
     FROM friend_requests fr
     JOIN users s ON s.id = fr.sender_id
     WHERE fr.receiver_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [userId]
  );
  return rows.map(fromRow);
};

const listOutgoing = async (userId) => {
  const { rows } = await query(
    `SELECT fr.*,
      r.username as receiver_username, r.avatar as receiver_avatar, r.email as receiver_email, r.is_online as receiver_is_online, r.last_seen as receiver_last_seen
     FROM friend_requests fr
     JOIN users r ON r.id = fr.receiver_id
     WHERE fr.sender_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [userId]
  );
  return rows.map(fromRow);
};

const listAcceptedFriends = async (userId) => {
  const { rows } = await query(
    `SELECT u.* FROM users u
     JOIN (
       SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS friend_id
       FROM friend_requests
       WHERE (sender_id = $1 OR receiver_id = $1) AND status = 'accepted'
     ) f ON f.friend_id = u.id
     ORDER BY u.username`,
    [userId]
  );
  return rows.map(User.fromRow).map(User.toPublic);
};

const areFriends = async (userA, userB) => {
  const { rowCount } = await query(
    `SELECT 1 FROM friend_requests
     WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
       AND status = 'accepted'`,
    [userA, userB]
  );
  return rowCount > 0;
};

const getRelationshipStatus = async (userId, otherUserId) => {
  if (String(userId) === String(otherUserId)) return { status: "self" };
  if (await Block.between(userId, otherUserId)) return { status: "blocked" };

  const { rows } = await query(
    `SELECT * FROM friend_requests
     WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
       AND status IN ('pending', 'accepted')
     ORDER BY updated_at DESC LIMIT 1`,
    [userId, otherUserId]
  );

  if (rows.length === 0) {
    // Check if there is an existing conversation with messages (backward compatibility)
    const [a, b] = [String(userId), String(otherUserId)].sort();
    const { rowCount: convExists } = await query(
      `SELECT 1 FROM conversations c
       WHERE c.user_a = $1 AND c.user_b = $2
         AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`,
      [a, b]
    );
    if (convExists > 0) return { status: "accepted" };
    return { status: "none" };
  }

  const req = rows[0];
  if (req.status === "accepted") return { status: "accepted" };
  if (req.status === "pending") {
    if (req.sender_id === userId) {
      return { status: "pending_outgoing", requestId: req.id };
    } else {
      return { status: "pending_incoming", requestId: req.id };
    }
  }
  return { status: "none" };
};

const cancelPendingBetween = async (userA, userB) => {
  await query(
    `UPDATE friend_requests SET status = 'canceled', updated_at = NOW()
     WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
       AND status = 'pending'`,
    [userA, userB]
  );
};

module.exports = {
  findById,
  sendRequest,
  acceptRequest,
  rejectRequest,
  cancelRequest,
  listIncoming,
  listOutgoing,
  listAcceptedFriends,
  areFriends,
  getRelationshipStatus,
  cancelPendingBetween,
};
