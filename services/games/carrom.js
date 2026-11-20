/**
 * Carrom (two players, singles) — server-authoritative rules on top of carromPhysics.js.
 * The app has the same rules in game/mini/carrom/rules.ts for games against the AI; change both.
 *
 * Rules (simplified ICF singles):
 *  - The player who breaks plays white; colours swap with the break every board.
 *  - Pocketing one of your own coins (without a foul) earns another shot.
 *  - The queen may be pocketed at any time but must be "covered": pocket one of your own coins
 *    in the same shot or the very next one. Covered → the queen is yours; otherwise it goes back.
 *  - Foul: pocketing the striker. Your coins pocketed in that shot come back, a pocketed queen
 *    comes back, and you pay one penalty coin (or owe it, paid with your next pocketed coin).
 *    Pocketing your own last coin, or your opponent's last coin, while the queen is still
 *    uncovered is also a foul (that coin comes back). Covering the queen with your last coin —
 *    in the same shot or the follow-up — is fine and wins the board.
 *  - Opponent coins you pocket count for the opponent.
 *  - A board ends when one side has pocketed all nine coins. That side scores one point per
 *    opponent coin still on the board, plus 3 for the queen if they covered it (only while their
 *    match score is below 22). A match is one board, or first to 13 / 25 points.
 *  - Each shot has a time limit; running out passes the turn, and three missed turns in a row
 *    forfeit the match.
 */
const P = require("./carromPhysics");

const TARGETS = [0, 13, 25]; // 0 = a single board
const SHOT_TIMES = [15, 30, 45];
const COINS_EACH = 9;
const QUEEN_POINTS = 3;
const QUEEN_LIMIT = 22;
const MAX_MISSED = 3;

function cleanOptions(options = {}) {
  const target = Number(options.target);
  const shotTime = Number(options.shotTime);
  return {
    target: TARGETS.includes(target) ? target : 0,
    shotTime: SHOT_TIMES.includes(shotTime) ? shotTime : 30,
  };
}

const colorOf = (state, seat) => (seat === state.white ? "white" : "black");
const kind = (id) => P.kindOf(id);

function newBoard(state, breaker) {
  state.white = breaker;
  state.turn = breaker;
  state.pieces = P.initialPieces();
  state.credit = [0, 0]; // own coins pocketed (count for that seat)
  state.due = [0, 0]; // penalty coins owed
  state.queenBy = null; // seat that covered the queen
  state.queenPending = null; // seat that pocketed the queen and still has to cover it
  state.breaker = breaker;
}

function create(options = {}, first = 0) {
  const opts = cleanOptions(options);
  const state = {
    target: opts.target,
    shotMs: opts.shotTime * 1000,
    score: [0, 0],
    boardNo: 1,
    boards: [], // finished boards: { winner, points, queenBy }
    shots: 0,
    missed: [0, 0],
    turnStartedAt: null,
    lastShot: null,
    lastEvent: null, // short description of what the last shot did (for both players)
    winner: null,
    endReason: null,
    moves: 0,
  };
  newBoard(state, first);
  return state;
}

function start(state, now) {
  state.turnStartedAt = now;
}

function returnCoin(state, id) {
  const spot = P.freeSpot(state.pieces);
  state.pieces.push({ id, x: spot.x, y: spot.y });
}

/** Removes one coin of `color` from `seat`'s pocketed pile back to the board (penalty), or records a debt. */
function payPenalty(state, seat) {
  if (state.credit[seat] > 0) {
    state.credit[seat] -= 1;
    returnCoin(state, pocketedIdOf(state, colorOf(state, seat)));
    return "penalty";
  }
  state.due[seat] += 1;
  return "due";
}

/** Any id of a `color` coin that is currently off the board. */
function pocketedIdOf(state, color) {
  const range = color === "white" ? [1, 9] : [10, 18];
  for (let id = range[0]; id <= range[1]; id++) if (!state.pieces.some((p) => p.id === id)) return id;
  return range[0];
}

/**
 * Resolves a simulated shot for `seat`. Mutates state; returns a summary for the UI:
 * { foul, foulReason, pocketed: {mine, theirs, queen, striker}, again, boardOver }.
 */
function resolveShot(state, seat, result) {
  const me = colorOf(state, seat);
  const them = me === "white" ? "black" : "white";
  const opp = 1 - seat;
  const mine = result.pocketed.filter((id) => kind(id) === me);
  const theirs = result.pocketed.filter((id) => kind(id) === them);
  const queenIn = result.pocketed.includes(19);
  state.pieces = result.pieces;

  const summary = { foul: false, foulReason: null, mine: mine.length, theirs: theirs.length, queen: queenIn, striker: result.strikerPocketed, covered: false, queenReturned: false, penalty: null, again: false };

  // Opponent coins always count for the opponent
  state.credit[opp] += theirs.length;

  // Is the queen covered once this shot counts? (already covered, or covered right now by
  // pocketing an own coin together with / right after the queen). Covering the queen with your
  // last coin is allowed — otherwise a player on 8 coins could never finish the board.
  const coversNow = (queenIn || state.queenPending === seat) && mine.length > 0;
  const queenOpen = state.queenBy === null && !coversNow;
  let foulReason = null;
  if (result.strikerPocketed) foulReason = "striker";
  else if (queenOpen && state.credit[seat] + mine.length >= COINS_EACH) foulReason = "own_last_before_queen";
  else if (queenOpen && state.credit[opp] >= COINS_EACH) foulReason = "their_last_before_queen";

  if (foulReason) {
    summary.foul = true;
    summary.foulReason = foulReason;
    // Own coins from this shot come back
    for (const id of mine) returnCoin(state, id);
    if (foulReason === "their_last_before_queen") {
      state.credit[opp] -= 1;
      returnCoin(state, theirs[theirs.length - 1] ?? pocketedIdOf(state, them));
    }
    // A queen pocketed now, or waiting for cover, goes back
    if (queenIn || state.queenPending === seat) {
      returnCoin(state, 19);
      summary.queenReturned = true;
    }
    state.queenPending = null;
    summary.penalty = payPenalty(state, seat);
    state.turn = opp;
    return summary;
  }

  // Own coins: pay any debt first (a paid coin goes back to the board)
  let kept = mine.length;
  while (kept > 0 && state.due[seat] > 0) {
    state.due[seat] -= 1;
    kept -= 1;
    returnCoin(state, mine[kept]);
  }
  state.credit[seat] += kept;

  // Queen and cover
  if (queenIn) {
    if (mine.length > 0) {
      state.queenBy = seat;
      summary.covered = true;
    } else {
      state.queenPending = seat;
    }
  } else if (state.queenPending === seat) {
    if (mine.length > 0) {
      state.queenBy = seat;
      summary.covered = true;
    } else {
      returnCoin(state, 19);
      summary.queenReturned = true;
    }
    state.queenPending = null;
  }

  summary.again = mine.length > 0 || state.queenPending === seat;
  state.turn = summary.again ? seat : opp;
  return summary;
}

/** Board over when one side has all nine coins pocketed. Returns the board winner or null. */
function boardWinner(state) {
  if (state.credit[state.white] >= COINS_EACH) return state.white;
  if (state.credit[1 - state.white] >= COINS_EACH) return 1 - state.white;
  return null;
}

function endBoard(state, winner) {
  const loser = 1 - winner;
  let points = COINS_EACH - state.credit[loser];
  const queenBonus = state.queenBy === winner && state.score[winner] < QUEEN_LIMIT ? QUEEN_POINTS : 0;
  points += queenBonus;
  state.score[winner] += points;
  state.boards.push({ winner, points, queenBy: state.queenBy });
  if (state.target === 0 || state.score[winner] >= state.target) {
    state.winner = winner;
    state.endReason = "normal";
    return { boardWinner: winner, points, queenBonus, matchOver: true };
  }
  state.boardNo += 1;
  newBoard(state, 1 - state.breaker);
  return { boardWinner: winner, points, queenBonus, matchOver: false };
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** Checks a shot intent. Returns an error code or null. */
function validateShot(state, seat, move) {
  const { x, dx, dy, power } = move;
  if (![x, dx, dy, power].every(finite)) return "invalid_shot";
  if (x < P.STRIKER_MIN_X || x > P.STRIKER_MAX_X) return "invalid_shot";
  if (power < P.MIN_POWER || power > 1) return "invalid_shot";
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return "invalid_shot";
  // Shots must go forward, away from your own baseline (at least ~6°)
  const forward = (seat === 0 ? -dy : dy) / len;
  if (forward < 0.1) return "shot_backwards";
  if (P.strikerBlocked(state.pieces, seat, x)) return "striker_blocked";
  return null;
}

/**
 * Intents: { type: 'shoot', x, dx, dy, power } (board coordinates; the server runs the physics),
 * { type: 'resign' }. Returns null on success or an error code.
 */
function applyMove(state, player, move, now = Date.now()) {
  if (state.winner !== null) return "game_over";
  if (state.turnStartedAt === null) return "not_started";
  if (!move || typeof move !== "object") return "invalid_move";
  if (move.type === "resign") {
    state.winner = 1 - player;
    state.endReason = "resign";
    return null;
  }
  if (move.type !== "shoot") return "invalid_move";
  if (player !== state.turn) return "not_your_turn";
  // Can't shoot while the previous shot is still rolling on the clients
  if (now < state.turnStartedAt) return "shot_in_progress";
  const err = validateShot(state, player, move);
  if (err) return err;

  const result = P.simulate(state.pieces, { seat: player, x: move.x, dx: move.dx, dy: move.dy, power: move.power });
  const summary = resolveShot(state, player, result);
  state.shots += 1;
  state.moves += 1;
  state.missed[player] = 0;
  const bw = boardWinner(state);
  summary.board = bw === null ? null : endBoard(state, bw);
  state.lastShot = {
    id: state.shots,
    by: player,
    x: move.x,
    dx: move.dx,
    dy: move.dy,
    power: move.power,
    frames: result.frames,
    events: result.events,
    frameMs: result.frameMs,
    durationMs: result.durationMs,
    summary,
  };
  state.lastEvent = { type: "shot", by: player, summary };
  // The next shot clock starts once the coins have stopped on screen
  state.turnStartedAt = now + result.durationMs + 300;
  return null;
}

function deadline(state) {
  if (state.winner !== null || state.turnStartedAt === null) return null;
  return state.turnStartedAt + state.shotMs;
}

/** Shot clock ran out: the turn passes; three in a row forfeits. */
function onDeadline(state, now) {
  const d = deadline(state);
  if (d === null || now < d) return false;
  const seat = state.turn;
  state.missed[seat] += 1;
  state.lastShot = null;
  if (state.missed[seat] >= MAX_MISSED) {
    state.winner = 1 - seat;
    state.endReason = "timeouts";
    state.lastEvent = { type: "forfeit", by: seat };
    return true;
  }
  // A queen waiting for cover goes back when the turn is lost
  if (state.queenPending === seat) {
    returnCoin(state, 19);
    state.queenPending = null;
  }
  state.turn = 1 - seat;
  state.turnStartedAt = now;
  state.lastEvent = { type: "timeout", by: seat };
  return true;
}

function view(state, _you, now = Date.now()) {
  return {
    pieces: state.pieces.map((p) => ({ id: p.id, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })),
    white: state.white,
    turn: state.turn,
    credit: state.credit,
    due: state.due,
    queenBy: state.queenBy,
    queenPending: state.queenPending,
    score: state.score,
    target: state.target,
    boardNo: state.boardNo,
    boards: state.boards,
    shotMs: state.shotMs,
    // Time left on the shot clock, relative to "now" so device clocks don't matter
    shotStartsIn: state.turnStartedAt === null ? null : Math.max(0, state.turnStartedAt - now),
    shotLeftMs: state.turnStartedAt === null || state.winner !== null ? null : Math.max(0, state.turnStartedAt + state.shotMs - now),
    missed: state.missed,
    lastShot: state.lastShot,
    lastEvent: state.lastEvent,
    shots: state.shots,
    winner: state.winner,
    endReason: state.endReason,
    moves: state.moves,
  };
}

const scores = (state) => state.score.slice();

function summary(state) {
  return { boards: state.boards, score: state.score, target: state.target, shots: state.shots, endReason: state.endReason };
}

function describe(state, player, move) {
  if (move.type === "shoot" && state.lastShot) {
    const { x, dx, dy, power, summary: s } = state.lastShot;
    return { type: "shoot", x, dx, dy, power, result: s };
  }
  return { type: move.type };
}

module.exports = {
  TARGETS,
  SHOT_TIMES,
  COINS_EACH,
  cleanOptions,
  create,
  start,
  applyMove,
  resolveShot,
  validateShot,
  deadline,
  onDeadline,
  view,
  scores,
  summary,
  describe,
  needsReady: true,
};
