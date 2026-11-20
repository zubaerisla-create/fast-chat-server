/**
 * Dots & Boxes rules (server copy; the app mirrors them in game/mini/dotsBoxes/rules.ts).
 * `size` is dots per side (4, 5 or 6). Edges are numbered: first the horizontal ones
 * (row r = 0..size-1, col c = 0..size-2), then the vertical ones (r = 0..size-2, c = 0..size-1).
 */
const SIZES = [4, 5, 6];

const hCount = (n) => n * (n - 1);
const edgeCount = (n) => 2 * n * (n - 1);
const boxCount = (n) => (n - 1) * (n - 1);
const hEdge = (n, r, c) => r * (n - 1) + c;
const vEdge = (n, r, c) => hCount(n) + r * n + c;

/** The four edges of box (r, c): top, bottom, left, right. */
function boxEdges(n, b) {
  const r = Math.floor(b / (n - 1));
  const c = b % (n - 1);
  return [hEdge(n, r, c), hEdge(n, r + 1, c), vEdge(n, r, c), vEdge(n, r, c + 1)];
}

/** The one or two boxes an edge borders. */
function edgeBoxes(n, e) {
  const out = [];
  if (e < hCount(n)) {
    const r = Math.floor(e / (n - 1));
    const c = e % (n - 1);
    if (r > 0) out.push((r - 1) * (n - 1) + c);
    if (r < n - 1) out.push(r * (n - 1) + c);
  } else {
    const k = e - hCount(n);
    const r = Math.floor(k / n);
    const c = k % n;
    if (c > 0) out.push(r * (n - 1) + c - 1);
    if (c < n - 1) out.push(r * (n - 1) + c);
  }
  return out;
}

function create(options = {}) {
  const size = SIZES.includes(options.size) ? options.size : 5;
  return {
    size,
    edges: Array(edgeCount(size)).fill(-1),
    boxes: Array(boxCount(size)).fill(-1),
    score: [0, 0],
    turn: 0,
    winner: null,
    lastMove: null,
    moves: 0,
  };
}

/** Validates and applies a move in place. Completing a box keeps the turn. */
function applyMove(state, player, move) {
  if (state.winner !== null) return "game_over";
  if (player !== state.turn) return "not_your_turn";
  const e = move && move.edge;
  const n = state.size;
  if (!Number.isInteger(e) || e < 0 || e >= edgeCount(n)) return "invalid_move";
  if (state.edges[e] !== -1) return "edge_taken";
  state.edges[e] = player;
  state.moves += 1;
  const closed = [];
  for (const b of edgeBoxes(n, e)) {
    if (boxEdges(n, b).every((x) => state.edges[x] !== -1)) {
      state.boxes[b] = player;
      closed.push(b);
    }
  }
  state.score[player] += closed.length;
  state.lastMove = { edge: e, player, closed };
  if (state.boxes.every((o) => o !== -1)) {
    state.winner = state.score[0] === state.score[1] ? "draw" : state.score[0] > state.score[1] ? 0 : 1;
  } else if (!closed.length) {
    state.turn = 1 - player;
  }
  return null;
}

const scores = (state) => state.score.slice();
const view = (state) => state;

module.exports = { SIZES, create, applyMove, boxEdges, edgeBoxes, edgeCount, boxCount, scores, view };
