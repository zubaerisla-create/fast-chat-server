/**
 * Connect Four rules (server-authoritative copy; the app has the same rules in
 * game/mini/connectFour/rules.ts for AI games). Board: 7 columns × 6 rows, row 0 is the top.
 */
const COLS = 7;
const ROWS = 6;

const create = () => ({ board: Array(COLS * ROWS).fill(-1), turn: 0, winner: null, winLine: null, lastMove: null, moves: 0 });

const idx = (r, c) => r * COLS + c;

/** Row a disc dropped into `col` would land on, or -1 when the column is full. */
function dropRow(board, col) {
  for (let r = ROWS - 1; r >= 0; r--) if (board[idx(r, col)] === -1) return r;
  return -1;
}

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

/** The four (or more) connected cells through (r, c) for the disc there, or null. */
function lineThrough(board, r, c) {
  const p = board[idx(r, c)];
  if (p < 0) return null;
  for (const [dr, dc] of DIRS) {
    const cells = [[r, c]];
    for (const s of [1, -1]) {
      let rr = r + dr * s;
      let cc = c + dc * s;
      while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && board[idx(rr, cc)] === p) {
        cells.push([rr, cc]);
        rr += dr * s;
        cc += dc * s;
      }
    }
    if (cells.length >= 4) return cells.map(([a, b]) => idx(a, b)).sort((a, b) => a - b);
  }
  return null;
}

/** Validates and applies a move in place. Returns null on success or an error code. */
function applyMove(state, player, move) {
  if (state.winner !== null) return "game_over";
  if (player !== state.turn) return "not_your_turn";
  const col = move && move.col;
  if (!Number.isInteger(col) || col < 0 || col >= COLS) return "invalid_move";
  const row = dropRow(state.board, col);
  if (row < 0) return "column_full";
  state.board[idx(row, col)] = player;
  state.lastMove = { row, col, player };
  state.moves += 1;
  const line = lineThrough(state.board, row, col);
  if (line) {
    state.winner = player;
    state.winLine = line;
  } else if (state.moves === COLS * ROWS) {
    state.winner = "draw";
  } else {
    state.turn = 1 - player;
  }
  return null;
}

const scores = () => [0, 0];
const view = (state) => state;

module.exports = { COLS, ROWS, create, applyMove, dropRow, lineThrough, view, scores };
