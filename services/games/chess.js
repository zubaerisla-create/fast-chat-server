/**
 * Chess for online matches (server-authoritative). Move legality, check, mate, stalemate,
 * castling, en passant, promotion, threefold repetition, the 50-move rule and insufficient
 * material all come from chess.js; this file adds what a two-player match needs on top:
 * colours, clocks with increment, resign, draw offers and take-back requests.
 *
 * Players are seat indexes (0 = inviter, 1 = invitee). `white` says which seat has white;
 * `turn` is always the seat to move, so the shared room code can treat chess like the others.
 */
const { Chess } = require("chess.js");

// Time controls offered in the app: base minutes + increment seconds (0 = untimed)
const TIME_CONTROLS = {
  "1+0": [1, 0],
  "3+2": [3, 2],
  "5+0": [5, 0],
  "10+0": [10, 0],
  "15+10": [15, 10],
  untimed: [0, 0],
};
const DEFAULT_TC = "10+0";
const COLORS = ["random", "white", "black"];

function cleanOptions(options = {}) {
  return {
    time: Object.prototype.hasOwnProperty.call(TIME_CONTROLS, options.time) ? options.time : DEFAULT_TC,
    color: COLORS.includes(options.color) ? options.color : "random",
  };
}

/** `first` is the seat that plays white this game. */
function create(options = {}, first = 0) {
  const opts = cleanOptions(options);
  const [min, inc] = TIME_CONTROLS[opts.time];
  return {
    chess: new Chess(), // live engine, never sent to clients (see view)
    white: first,
    turn: first,
    timed: min > 0,
    baseMs: min * 60000,
    incMs: inc * 1000,
    clock: [min * 60000, min * 60000],
    turnStartedAt: null, // null until the match is live (clocks frozen while waiting)
    history: [], // [{ san, from, to, color, piece, captured?, promotion?, flags }]
    winner: null,
    endReason: null,
    drawOffer: null, // seat that offered a draw
    undoRequest: null, // seat that asked for a take-back
    moves: 0,
  };
}

const colorOf = (state, seat) => (seat === state.white ? "w" : "b");
const seatOf = (state, color) => (color === "w" ? state.white : 1 - state.white);

/** Called when both players are connected and the match goes live. */
function start(state, now) {
  state.turnStartedAt = now;
}

/** Milliseconds left on each clock right now (the running clock is counted down). */
function liveClock(state, now) {
  const clock = state.clock.slice();
  if (state.timed && state.winner === null && state.turnStartedAt !== null) {
    clock[state.turn] = Math.max(0, clock[state.turn] - Math.max(0, now - state.turnStartedAt));
  }
  return clock;
}

/** A side that runs out of time loses, unless the opponent cannot possibly mate (then it's a draw). */
function canMate(chess, color) {
  const pieces = chess.board().flat().filter((p) => p && p.color === color && p.type !== "k");
  if (pieces.some((p) => p.type === "q" || p.type === "r" || p.type === "p")) return true;
  const minors = pieces.length;
  return minors >= 2;
}

function finish(state, winner, reason) {
  state.winner = winner;
  state.endReason = reason;
  state.drawOffer = null;
  state.undoRequest = null;
}

function flag(state, seat) {
  state.clock[seat] = 0;
  const opponentColor = colorOf(state, 1 - seat);
  if (canMate(state.chess, opponentColor)) finish(state, 1 - seat, "timeout");
  else finish(state, "draw", "timeout_insufficient");
}

/** Draw / mate detection after a move. */
function checkEnd(state) {
  const c = state.chess;
  if (c.isCheckmate()) return finish(state, seatOf(state, c.turn() === "w" ? "b" : "w"), "checkmate");
  if (c.isStalemate()) return finish(state, "draw", "stalemate");
  if (c.isInsufficientMaterial()) return finish(state, "draw", "insufficient_material");
  if (c.isThreefoldRepetition()) return finish(state, "draw", "threefold_repetition");
  if (c.isDrawByFiftyMoves()) return finish(state, "draw", "fifty_moves");
}

const SQUARE_RE = /^[a-h][1-8]$/;

/**
 * Validates and applies one intent. Returns null on success or an error code.
 * Intents: { type: 'move', from, to, promotion? } (also the default), 'resign',
 * 'offerDraw', 'answerDraw' { accept }, 'requestUndo', 'answerUndo' { accept }.
 */
function applyMove(state, player, move, now = Date.now()) {
  if (state.winner !== null) return "game_over";
  if (state.turnStartedAt === null) return "not_started";
  if (!move || typeof move !== "object") return "invalid_move";
  const type = move.type || "move";

  // A move or request after the flag fell ends the game on time instead
  if (state.timed && liveClock(state, now)[state.turn] <= 0) {
    flag(state, state.turn);
    return null;
  }

  if (type === "resign") {
    finish(state, 1 - player, "resign");
    return null;
  }
  if (type === "offerDraw") {
    if (state.drawOffer === player) return "already_offered";
    if (state.drawOffer === 1 - player) {
      finish(state, "draw", "agreement");
      return null;
    }
    if (state.history.length < 2) return "too_early";
    state.drawOffer = player;
    return null;
  }
  if (type === "answerDraw") {
    if (state.drawOffer !== 1 - player) return "no_offer";
    if (move.accept === true) finish(state, "draw", "agreement");
    else state.drawOffer = null;
    return null;
  }
  if (type === "requestUndo") {
    // Only your own last move can be taken back (one take-back per request)
    if (!state.history.some((h) => h.color === colorOf(state, player))) return "nothing_to_undo";
    if (state.undoRequest !== null) return "already_requested";
    state.undoRequest = player;
    return null;
  }
  if (type === "answerUndo") {
    if (state.undoRequest !== 1 - player) return "no_request";
    const requester = state.undoRequest;
    state.undoRequest = null;
    if (move.accept !== true) return null;
    takeBack(state, requester, now);
    return null;
  }
  if (type !== "move") return "invalid_move";

  if (player !== state.turn) return "not_your_turn";
  const { from, to } = move;
  if (typeof from !== "string" || typeof to !== "string" || !SQUARE_RE.test(from) || !SQUARE_RE.test(to)) return "invalid_move";
  const promotion = move.promotion === undefined ? undefined : move.promotion;
  if (promotion !== undefined && !["q", "r", "b", "n"].includes(promotion)) return "invalid_move";

  const piece = state.chess.get(from);
  if (!piece || piece.color !== colorOf(state, player)) return "not_your_piece";
  // Without an explicit choice chess.js would reject a promotion; make the client choose
  const needsPromotion = piece.type === "p" && (to[1] === "8" || to[1] === "1");
  if (needsPromotion && !promotion) {
    const legal = state.chess.moves({ square: from, verbose: true }).some((m) => m.to === to);
    return legal ? "promotion_required" : "illegal_move";
  }

  let result;
  try {
    result = state.chess.move({ from, to, promotion: needsPromotion ? promotion : undefined });
  } catch {
    return "illegal_move";
  }

  if (state.timed) {
    state.clock[player] = Math.max(0, state.clock[player] - Math.max(0, now - state.turnStartedAt)) + state.incMs;
  }
  state.history.push({
    san: result.san,
    from: result.from,
    to: result.to,
    color: result.color,
    piece: result.piece,
    captured: result.captured || null,
    promotion: result.promotion || null,
    flags: result.flags,
  });
  state.moves += 1;
  state.turn = 1 - player;
  state.turnStartedAt = now;
  state.drawOffer = state.drawOffer === player ? player : null; // a reply move declines the offer
  state.undoRequest = null;
  checkEnd(state);
  return null;
}

/** Takes back the requester's last move (and the opponent's reply, if they already moved). */
function takeBack(state, requester, now) {
  const myColor = colorOf(state, requester);
  const undoOnce = () => {
    state.chess.undo();
    state.history.pop();
    state.moves -= 1;
  };
  if (state.history.length && state.history[state.history.length - 1].color !== myColor) undoOnce();
  if (state.history.length && state.history[state.history.length - 1].color === myColor) undoOnce();
  // Clocks keep their current values; the requester is to move again
  if (state.timed) state.clock = liveClock(state, now);
  state.turn = requester;
  state.turnStartedAt = now;
  state.drawOffer = null;
}

/** When the side to move runs out of time (null when untimed or over). */
function deadline(state) {
  if (!state.timed || state.winner !== null || state.turnStartedAt === null) return null;
  return state.turnStartedAt + state.clock[state.turn];
}

function onDeadline(state, now) {
  if (deadline(state) === null || liveClock(state, now)[state.turn] > 0) return false;
  flag(state, state.turn);
  return true;
}

function view(state, _you, now = Date.now()) {
  const c = state.chess;
  return {
    fen: c.fen(),
    white: state.white,
    turn: state.turn,
    history: state.history,
    inCheck: state.winner === null ? c.inCheck() : c.isCheckmate(),
    timed: state.timed,
    baseMs: state.baseMs,
    incMs: state.incMs,
    clock: liveClock(state, now),
    clockRunning: state.timed && state.winner === null && state.turnStartedAt !== null,
    winner: state.winner,
    endReason: state.endReason,
    drawOffer: state.drawOffer,
    undoRequest: state.undoRequest,
    moves: state.moves,
  };
}

// Scores for the match record: material captured (pawn 1, minor 3, rook 5, queen 9)
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
function scores(state) {
  const s = [0, 0];
  for (const h of state.history) if (h.captured) s[seatOf(state, h.color)] += VALUES[h.captured];
  return s;
}

function summary(state) {
  return { pgn: state.chess.pgn(), fen: state.chess.fen(), white: state.white, endReason: state.endReason, plies: state.history.length };
}

/** Compact record of one intent for the action log. */
function describe(state, _player, move) {
  const type = (move && move.type) || "move";
  if (type === "move") {
    const last = state.history[state.history.length - 1];
    return { type, san: last ? last.san : null, from: move.from, to: move.to, promotion: move.promotion || null, fen: state.chess.fen() };
  }
  return { type, accept: move.accept === true ? true : undefined };
}

module.exports = {
  TIME_CONTROLS,
  COLORS,
  cleanOptions,
  create,
  start,
  applyMove,
  deadline,
  onDeadline,
  view,
  scores,
  summary,
  describe,
  liveClock,
  needsReady: true,
};
