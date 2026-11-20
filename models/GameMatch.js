const { query } = require("../config/db");

/** Stores one finished multiplayer match. */
const record = async ({ game, roomId, playerA, playerB, winnerId, reason, scoreA, scoreB, moves, options, startedAt }) => {
  const { rows } = await query(
    `INSERT INTO game_matches (game, room_id, player_a, player_b, winner_id, reason, score_a, score_b, moves, options, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [game, roomId, playerA, playerB, winnerId, reason, scoreA, scoreB, moves, JSON.stringify(options || {}), startedAt]
  );
  return rows[0].id;
};

/** A match row when the match is created (waiting for players / in progress). Returns its id. */
const start = async ({ game, roomId, matchNo, playerA, playerB, options, status, startedAt }) => {
  const { rows } = await query(
    `INSERT INTO game_matches (game, room_id, match_no, player_a, player_b, options, status, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
     ON CONFLICT (room_id, match_no) DO UPDATE SET status = EXCLUDED.status
     RETURNING id`,
    [game, roomId, matchNo, playerA, playerB, JSON.stringify(options || {}), status, startedAt]
  );
  return rows[0].id;
};

const setStatus = (id, status, startedAt) =>
  query(`UPDATE game_matches SET status = $2, started_at = COALESCE($3, started_at) WHERE id = $1 AND status IN ('waiting_for_players', 'in_progress')`, [id, status, startedAt || null]);

/** Final result of a match (completed with a winner / draw, or cancelled before it started). */
const end = (id, { status, winnerId, reason, scoreA, scoreB, moves, detail, durationMs }) =>
  query(
    `UPDATE game_matches
        SET status = $2, winner_id = $3, reason = $4, score_a = $5, score_b = $6, moves = $7,
            result_detail = $8, duration_ms = $9, ended_at = NOW()
      WHERE id = $1 AND status IN ('waiting_for_players', 'in_progress')`,
    [id, status, winnerId, reason, scoreA || 0, scoreB || 0, moves || 0, JSON.stringify(detail || {}), durationMs ?? null]
  );

const addAction = (matchId, seq, playerId, action) =>
  query(`INSERT INTO game_match_actions (match_id, seq, player_id, action) VALUES ($1, $2, $3, $4) ON CONFLICT (match_id, seq) DO NOTHING`, [
    matchId,
    seq,
    playerId,
    JSON.stringify(action),
  ]);

const actionsFor = async (matchId) => (await query(`SELECT seq, player_id, action FROM game_match_actions WHERE match_id = $1 ORDER BY seq`, [matchId])).rows;

/** Live rooms are in memory, so matches still open when the server starts were abandoned. */
const abandonStale = (before = new Date()) =>
  query(`UPDATE game_matches SET status = 'abandoned', ended_at = NOW() WHERE status IN ('waiting_for_players', 'in_progress') AND started_at < $1`, [before]);

/** Wins / losses / draws per game for one user, against friends. */
const statsFor = async (userId) => {
  const { rows } = await query(
    `SELECT game,
            COUNT(*) FILTER (WHERE winner_id = $1)::int AS wins,
            COUNT(*) FILTER (WHERE winner_id IS NOT NULL AND winner_id <> $1)::int AS losses,
            COUNT(*) FILTER (WHERE winner_id IS NULL)::int AS draws
       FROM game_matches
      WHERE (player_a = $1 OR player_b = $1) AND status = 'completed'
      GROUP BY game`,
    [userId]
  );
  const stats = {};
  for (const g of ["connect4", "dots", "hangman", "chess", "carrom"]) stats[g] = { wins: 0, losses: 0, draws: 0 };
  for (const r of rows) stats[r.game] = { wins: r.wins, losses: r.losses, draws: r.draws };
  return stats;
};

/** The user's latest finished matches, with the opponent's public profile. */
const recentFor = async (userId, limit = 20, game = null) => {
  const { rows } = await query(
    `SELECT m.id, m.game, m.winner_id, m.reason, m.ended_at, m.duration_ms,
            CASE WHEN m.player_a = $1 THEN m.score_a ELSE m.score_b END AS my_score,
            CASE WHEN m.player_a = $1 THEN m.score_b ELSE m.score_a END AS their_score,
            u.id AS opponent_id, u.username AS opponent_username, u.avatar AS opponent_avatar
       FROM game_matches m
       JOIN users u ON u.id = CASE WHEN m.player_a = $1 THEN m.player_b ELSE m.player_a END
      WHERE (m.player_a = $1 OR m.player_b = $1) AND m.status = 'completed' AND ($3::text IS NULL OR m.game = $3)
      ORDER BY m.ended_at DESC
      LIMIT $2`,
    [userId, limit, game]
  );
  return rows.map((r) => ({
    id: r.id,
    game: r.game,
    result: r.winner_id === null ? "draw" : r.winner_id === userId ? "win" : "loss",
    reason: r.reason,
    myScore: r.my_score,
    theirScore: r.their_score,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    opponent: { id: r.opponent_id, username: r.opponent_username, avatar: r.opponent_avatar },
  }));
};

module.exports = { record, start, setStatus, end, addAction, actionsFor, abandonStale, statsFor, recentFor };
