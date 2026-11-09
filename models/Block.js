const { query } = require("../config/db");

const block = (blockerId, blockedId) =>
  query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [blockerId, blockedId]);

const unblock = (blockerId, blockedId) => query("DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2", [blockerId, blockedId]);

/** True if either user blocked the other. */
const between = async (a, b) => {
  const { rowCount } = await query(
    "SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
    [a, b]
  );
  return rowCount > 0;
};

const listBlocked = async (blockerId) => {
  const { rows } = await query(
    `SELECT u.id, u.username, u.avatar, b.created_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [blockerId]
  );
  return rows.map((r) => ({ _id: r.id, id: r.id, username: r.username, avatar: r.avatar, blockedAt: r.created_at }));
};

/** Users who blocked `userId` (their messages to them are hidden / not pushed). */
const blockersOf = async (userId) => {
  const { rows } = await query("SELECT blocker_id FROM user_blocks WHERE blocked_id = $1", [userId]);
  return new Set(rows.map((r) => r.blocker_id));
};

module.exports = { block, unblock, between, listBlocked, blockersOf };
