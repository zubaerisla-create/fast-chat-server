const { query } = require("../config/db");

/** Record of a game invitation (the live invitation itself is held by services/games/rooms.js). */
const create = ({ inviteId, game, from, to, options, expiresAt }) =>
  query(
    `INSERT INTO game_invitations (id, game, from_user, to_user, options, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [inviteId, game, from.id, to.id, JSON.stringify(options || {}), new Date(expiresAt)]
  );

// Only a pending invitation changes status, so a late timer can't overwrite an answer
const setStatus = (id, status, roomId = null) =>
  query(
    `UPDATE game_invitations SET status = $2, room_id = COALESCE($3, room_id), responded_at = NOW()
      WHERE id = $1 AND status = 'invited'`,
    [id, status === "canceled" ? "cancelled" : status, roomId]
  );

/** Invitations still marked pending after a restart can no longer be answered. */
const expireStale = (before = new Date()) =>
  query(`UPDATE game_invitations SET status = 'expired', responded_at = NOW() WHERE status = 'invited' AND created_at < $1`, [before]);

module.exports = { create, setStatus, expireStale };
