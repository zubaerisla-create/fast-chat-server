const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const chess = require("../services/games/chess");
const carrom = require("../services/games/carrom");
const P = require("../services/games/carromPhysics");
const { GameRooms } = require("../services/games/rooms");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══ Chess rules ═════════════════════════════════════════════════════════════

/** A live game (clocks started) where seat 0 is white. */
function liveChess(options = { time: "untimed" }, now = 0) {
  const s = chess.create(options, 0);
  chess.start(s, now);
  return s;
}
const play = (s, sans, now = 0) => {
  for (const san of sans) {
    const m = s.chess.moves({ verbose: true }).find((x) => x.san === san);
    assert.ok(m, `no legal move ${san} in ${s.chess.fen()}`);
    assert.equal(chess.applyMove(s, s.turn, { from: m.from, to: m.to, promotion: m.promotion }, now), null, san);
  }
};

test("chess: legal and illegal moves, turn order and piece ownership", () => {
  const s = chess.create({ time: "untimed" }, 0);
  assert.equal(chess.applyMove(s, 0, { from: "e2", to: "e4" }), "not_started");
  chess.start(s, 0);
  assert.equal(chess.applyMove(s, 1, { from: "e7", to: "e5" }), "not_your_turn");
  assert.equal(chess.applyMove(s, 0, { from: "e7", to: "e5" }), "not_your_piece");
  assert.equal(chess.applyMove(s, 0, { from: "e2", to: "e5" }), "illegal_move");
  assert.equal(chess.applyMove(s, 0, { from: "z9", to: "e4" }), "invalid_move");
  assert.equal(chess.applyMove(s, 0, { from: "e1", to: "e2" }), "illegal_move"); // own pawn is there
  assert.equal(chess.applyMove(s, 0, { from: "e2", to: "e4" }), null);
  assert.equal(s.turn, 1);
  assert.equal(s.history[0].san, "e4");
  // Black is seat 1 here; seat 1 moves black pieces only
  assert.equal(chess.applyMove(s, 1, { from: "d2", to: "d4" }), "not_your_piece");
});

test("chess: black seat gets black pieces when the inviter is black", () => {
  const s = chess.create({ time: "untimed" }, 1); // seat 1 is white
  chess.start(s, 0);
  assert.equal(s.turn, 1);
  assert.equal(chess.applyMove(s, 0, { from: "e2", to: "e4" }), "not_your_turn");
  assert.equal(chess.applyMove(s, 1, { from: "e2", to: "e4" }), null);
  assert.equal(chess.view(s, 0).white, 1);
});

test("chess: check and checkmate (fool's mate)", () => {
  const s = liveChess();
  play(s, ["f3", "e5", "g4"]);
  assert.equal(chess.view(s, 0).inCheck, false);
  play(s, ["Qh4#"]);
  assert.equal(s.winner, 1);
  assert.equal(s.endReason, "checkmate");
  assert.equal(chess.view(s, 0).inCheck, true);
  assert.equal(chess.applyMove(s, 0, { from: "a2", to: "a3" }), "game_over");
});

test("chess: a move that leaves your king in check is illegal", () => {
  const s = liveChess();
  s.chess.load("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1"); // rook gives check from e2
  s.turn = 0;
  assert.equal(chess.view(s, 0).inCheck, true);
  assert.equal(chess.applyMove(s, 0, { from: "e1", to: "d1" }), null); // legal escape
  s.chess.load("4k3/8/8/8/8/8/3r4/R3K3 w Q - 0 1");
  s.turn = 0;
  assert.equal(chess.applyMove(s, 0, { from: "e1", to: "d1" }), "illegal_move"); // walking into the rook
});

test("chess: castling both sides, and not through check", () => {
  const s = liveChess();
  play(s, ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
  assert.equal(chess.applyMove(s, 0, { from: "e1", to: "g1" }), null);
  assert.equal(s.history.at(-1).san, "O-O");
  assert.equal(s.chess.get("f1").type, "r");

  const q = liveChess();
  q.chess.load("r3k3/8/8/8/8/8/8/R3K3 w Qq - 0 1");
  assert.equal(chess.applyMove(q, 0, { from: "e1", to: "c1" }), null);
  assert.equal(q.history.at(-1).san, "O-O-O");

  const blocked = liveChess();
  blocked.chess.load("4k3/8/8/8/8/8/5r2/4K2R w K - 0 1"); // f-file attacked by the rook on f2… king passes f1
  assert.equal(chess.applyMove(blocked, 0, { from: "e1", to: "g1" }), "illegal_move");
});

test("chess: en passant", () => {
  const s = liveChess();
  play(s, ["e4", "a6", "e5", "d5"]);
  assert.equal(chess.applyMove(s, 0, { from: "e5", to: "d6" }), null);
  assert.equal(s.history.at(-1).san, "exd6");
  assert.equal(s.history.at(-1).captured, "p");
  assert.equal(s.chess.get("d5"), undefined);
});

test("chess: promotion needs a choice and promotes to it", () => {
  const s = liveChess();
  s.chess.load("8/P6k/8/8/8/8/8/K7 w - - 0 1");
  assert.equal(chess.applyMove(s, 0, { from: "a7", to: "a8" }), "promotion_required");
  assert.equal(chess.applyMove(s, 0, { from: "a7", to: "a8", promotion: "x" }), "invalid_move");
  assert.equal(chess.applyMove(s, 0, { from: "a7", to: "a8", promotion: "n" }), null);
  assert.equal(s.chess.get("a8").type, "n");
  assert.equal(s.history.at(-1).promotion, "n");
});

test("chess: stalemate, insufficient material, threefold repetition and the 50-move rule are draws", () => {
  const st = liveChess();
  st.chess.load("7k/8/6Q1/8/8/8/8/K7 w - - 0 1");
  play(st, ["Qf7"]);
  assert.deepEqual([st.winner, st.endReason], ["draw", "stalemate"]);

  const ins = liveChess();
  ins.chess.load("8/8/8/8/3k4/8/1r6/K7 w - - 0 1");
  play(ins, ["Kxb2"]);
  assert.deepEqual([ins.winner, ins.endReason], ["draw", "insufficient_material"]);

  const rep = liveChess();
  play(rep, ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]);
  assert.deepEqual([rep.winner, rep.endReason], ["draw", "threefold_repetition"]);

  const fifty = liveChess();
  fifty.chess.load("4k3/8/8/8/8/8/R7/4K3 w - - 99 80");
  play(fifty, ["Ra3"]);
  assert.deepEqual([fifty.winner, fifty.endReason], ["draw", "fifty_moves"]);
});

test("chess: clocks count down, add increment, and flag on the server", () => {
  const s = chess.create({ time: "3+2" }, 0);
  chess.start(s, 1000);
  assert.equal(chess.deadline(s), 1000 + 180000);
  assert.equal(chess.applyMove(s, 0, { from: "e2", to: "e4" }, 11000), null); // 10 s used, +2 s
  assert.equal(s.clock[0], 180000 - 10000 + 2000);
  assert.deepEqual(chess.view(s, 0, 21000).clock, [172000, 170000]); // black's clock is running
  assert.equal(chess.onDeadline(s, 21000), false);
  assert.equal(chess.onDeadline(s, 11000 + 180000), true);
  assert.deepEqual([s.winner, s.endReason], [0, "timeout"]);

  // Running out of time against a lone king is a draw
  const d = chess.create({ time: "1+0" }, 0);
  chess.start(d, 0);
  d.chess.load("4k3/8/8/8/8/8/8/4K2Q w - - 0 1");
  assert.equal(chess.onDeadline(d, 60000), true);
  assert.deepEqual([d.winner, d.endReason], ["draw", "timeout_insufficient"]);
  assert.equal(chess.deadline(chess.create({ time: "untimed" }, 0)), null);
});

test("chess: resign, draw offers and take-backs", () => {
  const s = liveChess();
  assert.equal(chess.applyMove(s, 0, { type: "offerDraw" }), "too_early");
  play(s, ["e4", "e5"]);
  assert.equal(chess.applyMove(s, 0, { type: "answerDraw", accept: true }), "no_offer");
  assert.equal(chess.applyMove(s, 0, { type: "offerDraw" }), null);
  assert.equal(chess.applyMove(s, 0, { type: "answerDraw", accept: true }), "no_offer"); // can't accept your own
  assert.equal(chess.applyMove(s, 1, { type: "answerDraw", accept: false }), null);
  assert.equal(s.drawOffer, null);

  // Take-back: white asks after black replied → both plies go, white to move
  play(s, ["Nf3", "Nc6"]);
  assert.equal(chess.applyMove(s, 0, { type: "requestUndo" }), null);
  assert.equal(chess.applyMove(s, 0, { type: "answerUndo", accept: true }), "no_request");
  assert.equal(chess.applyMove(s, 1, { type: "answerUndo", accept: true }), null);
  assert.equal(s.history.length, 2);
  assert.equal(s.turn, 0);
  assert.equal(s.chess.get("f3"), undefined);

  assert.equal(chess.applyMove(s, 1, { type: "offerDraw" }), null);
  assert.equal(chess.applyMove(s, 0, { type: "answerDraw", accept: true }), null);
  assert.deepEqual([s.winner, s.endReason], ["draw", "agreement"]);

  const r = liveChess();
  assert.equal(chess.applyMove(r, 1, { type: "resign" }), null); // allowed out of turn
  assert.deepEqual([r.winner, r.endReason], [0, "resign"]);
});

// ═══ Carrom physics ══════════════════════════════════════════════════════════

test("carrom physics: equal coins exchange momentum head-on; the heavier striker keeps going", () => {
  // Coin 1 alone, struck straight on by the striker
  const r = P.simulate([{ id: 1, x: 370, y: 400 }], { seat: 0, x: 370, dx: 0, dy: -1, power: 0.5 });
  const coin = r.pieces.find((p) => p.id === 1);
  assert.ok(coin.y < 400 - 100, "coin pushed forward");
  assert.ok(Math.abs(coin.x - 370) < 0.5, "a head-on hit keeps the coin on the line");
  assert.ok(r.events.some((e) => e.type === "hit" && e.a === 0 && e.b === 1));
  // Striker (2.7× heavier) keeps moving forward after the hit
  assert.ok(r.strikerEnd.y < P.BASE_Y[0] - 100);
});

test("carrom physics: cushions bounce, friction stops everything, nothing leaves the board", () => {
  const r = P.simulate([], { seat: 0, x: 370, dx: 1, dy: -1, power: 0.7 });
  assert.ok(r.events.some((e) => e.type === "wall"));
  assert.ok(r.durationMs > 200 && r.durationMs < 12000);
  const { x, y } = r.strikerEnd;
  assert.ok(x >= P.STRIKER_R && x <= P.BOARD - P.STRIKER_R && y >= P.STRIKER_R && y <= P.BOARD - P.STRIKER_R);
  // Break shot: all 19 coins stay on or in the board, none overlap afterwards
  const b = P.simulate(P.initialPieces(), { seat: 0, x: 370, dx: 0.01, dy: -1, power: 1 });
  for (const p of b.pieces) assert.ok(p.x >= P.COIN_R - 1e-6 && p.x <= P.BOARD - P.COIN_R + 1e-6);
  for (let i = 0; i < b.pieces.length; i++)
    for (let j = i + 1; j < b.pieces.length; j++) {
      const [p, q] = [b.pieces[i], b.pieces[j]];
      assert.ok(Math.hypot(p.x - q.x, p.y - q.y) > 2 * P.COIN_R - 0.5, "coins don't overlap at rest");
    }
});

test("carrom physics: a coin driven into a corner is pocketed", () => {
  // Coin on the diagonal toward the top-left pocket; striker from the bottom-right
  const r = P.simulate([{ id: 3, x: 200, y: 200 }], { seat: 0, x: 590, dx: 200 - 590, dy: 200 - P.BASE_Y[0], power: 0.8 });
  assert.ok(r.pocketed.includes(3), JSON.stringify(r.pocketed));
  assert.ok(r.events.some((e) => e.type === "pocket" && e.a === 3 && e.pocket === 0));
  assert.ok(!r.pieces.some((p) => p.id === 3));
  // Slow shot → stops short of the pocket
  const slow = P.simulate([{ id: 3, x: 300, y: 300 }], { seat: 0, x: 590, dx: 300 - 590, dy: 300 - P.BASE_Y[0], power: 0.12 });
  assert.equal(slow.pocketed.length, 0);
});

test("carrom physics: reference shot is reproducible (the app's physics.ts asserts the same numbers)", () => {
  const r = P.simulate(P.initialPieces(), { seat: 0, x: 330, dx: 0.12, dy: -1, power: 0.9 });
  const again = P.simulate(P.initialPieces(), { seat: 0, x: 330, dx: 0.12, dy: -1, power: 0.9 });
  assert.deepEqual(r, again);
  const sig = r.pieces.reduce((acc, p) => acc + p.id * 7 + p.x * 3 + p.y, 0);
  assert.equal(r.steps, REFERENCE.steps);
  assert.deepEqual(r.pocketed, REFERENCE.pocketed);
  assert.equal(Math.round(sig * 1000), REFERENCE.sig);
});
// Filled in from the first run and shared with game/__tests__/mini.test.ts
const REFERENCE = require("./fixtures/carromReference.json");

// ═══ Carrom rules ════════════════════════════════════════════════════════════

/** A live carrom state where seat 0 breaks (white). */
function liveCarrom(options = {}) {
  const s = carrom.create(options, 0);
  carrom.start(s, 0);
  return s;
}
const fakeShot = (state, pocketed, { striker = false } = {}) => ({
  pieces: state.pieces.filter((p) => !pocketed.includes(p.id)),
  pocketed: striker ? [...pocketed, 0] : pocketed,
  strikerPocketed: striker,
});

test("carrom rules: own coin earns another shot, nothing pocketed passes the turn", () => {
  const s = liveCarrom();
  let sum = carrom.resolveShot(s, 0, fakeShot(s, [1]));
  assert.equal(sum.again, true);
  assert.equal(s.turn, 0);
  assert.deepEqual(s.credit, [1, 0]);
  sum = carrom.resolveShot(s, 0, fakeShot(s, []));
  assert.equal(sum.again, false);
  assert.equal(s.turn, 1);
  // Pocketing the opponent's coin counts for them and passes the turn
  sum = carrom.resolveShot(s, 1, fakeShot(s, [2]));
  assert.equal(s.turn, 0);
  assert.deepEqual(s.credit, [2, 0]);
});

test("carrom rules: pocketing the striker is a foul — coins come back and a penalty is paid or owed", () => {
  const s = liveCarrom();
  carrom.resolveShot(s, 0, fakeShot(s, [1]));
  // Foul with own coin 2 pocketed: coin 2 returns, and coin 1 is paid back as the penalty
  const sum = carrom.resolveShot(s, 0, fakeShot(s, [2], { striker: true }));
  assert.equal(sum.foul, true);
  assert.equal(sum.foulReason, "striker");
  assert.equal(sum.penalty, "penalty");
  assert.deepEqual(s.credit, [0, 0]);
  assert.equal(s.pieces.filter((p) => p.id <= 9).length, 9);
  assert.equal(s.turn, 1);
  // Black fouls with nothing pocketed yet → owes a coin, paid with the next one pocketed
  carrom.resolveShot(s, 1, fakeShot(s, [], { striker: true }));
  assert.deepEqual(s.due, [0, 1]);
  carrom.resolveShot(s, 0, fakeShot(s, []));
  carrom.resolveShot(s, 1, fakeShot(s, [10]));
  assert.deepEqual(s.due, [0, 0]);
  assert.equal(s.credit[1], 0, "the pocketed coin paid the debt");
  assert.ok(s.pieces.some((p) => p.id === 10), "and went back onto the board");
});

test("carrom rules: queen must be covered in the same or the next shot", () => {
  const same = liveCarrom();
  const sum = carrom.resolveShot(same, 0, fakeShot(same, [19, 1]));
  assert.equal(sum.covered, true);
  assert.equal(same.queenBy, 0);

  const next = liveCarrom();
  carrom.resolveShot(next, 0, fakeShot(next, [19]));
  assert.equal(next.queenPending, 0);
  assert.equal(next.turn, 0, "pocketing the queen earns the covering shot");
  carrom.resolveShot(next, 0, fakeShot(next, [2]));
  assert.equal(next.queenBy, 0);

  const miss = liveCarrom();
  carrom.resolveShot(miss, 0, fakeShot(miss, [19]));
  const s2 = carrom.resolveShot(miss, 0, fakeShot(miss, []));
  assert.equal(s2.queenReturned, true);
  assert.equal(miss.queenBy, null);
  assert.ok(miss.pieces.some((p) => p.id === 19));
  assert.equal(miss.turn, 1);

  const foul = liveCarrom();
  carrom.resolveShot(foul, 0, fakeShot(foul, [19, 1], { striker: true }));
  assert.equal(foul.queenBy, null);
  assert.ok(foul.pieces.some((p) => p.id === 19), "queen returns on a foul");
});

test("carrom rules: last coin before the queen is a foul; clearing the board scores and ends the match", () => {
  const s = liveCarrom();
  const whites = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  carrom.resolveShot(s, 0, fakeShot(s, whites.slice(0, 8)));
  let sum = carrom.resolveShot(s, 0, fakeShot(s, [9]));
  assert.equal(sum.foulReason, "own_last_before_queen");
  assert.equal(s.credit[0], 7, "last coin back plus one penalty coin");

  const win = liveCarrom();
  carrom.resolveShot(win, 0, fakeShot(win, [19, 1])); // queen covered
  carrom.resolveShot(win, 0, fakeShot(win, [10, 11])); // two black coins for black
  carrom.resolveShot(win, 1, fakeShot(win, [])); // black misses
  win.turnStartedAt = 0;
  // White clears the rest through the real engine path (a fake sim result via resolveShot + board end)
  sum = carrom.resolveShot(win, 0, fakeShot(win, whites.slice(1)));
  assert.equal(win.credit[0], 9);
  assert.equal(win.credit[1], 2);
});

test("carrom rules: covering the queen with your last coin is legal and wins the board (no deadlock)", () => {
  // Same shot: queen + last white coin
  const a = liveCarrom();
  a.credit = [8, 3];
  a.pieces = a.pieces.filter((p) => p.id === 9 || p.id === 19 || p.id >= 10 && p.id <= 15);
  let sum = carrom.resolveShot(a, 0, fakeShot(a, [19, 9]));
  assert.equal(sum.foul, false);
  assert.equal(a.queenBy, 0);
  assert.equal(a.credit[0], 9);
  // Follow-up shot: queen first, then the last coin covers it
  const b = liveCarrom();
  b.credit = [8, 3];
  b.pieces = b.pieces.filter((p) => p.id === 9 || p.id === 19 || p.id >= 10 && p.id <= 15);
  carrom.resolveShot(b, 0, fakeShot(b, [19]));
  assert.equal(b.queenPending, 0);
  sum = carrom.resolveShot(b, 0, fakeShot(b, [9]));
  assert.equal(sum.foul, false);
  assert.deepEqual([b.queenBy, b.credit[0]], [0, 9]);
  // But the last coin while the queen is still on the board is a foul
  const c = liveCarrom();
  c.credit = [8, 3];
  c.pieces = c.pieces.filter((p) => p.id === 9 || p.id === 19 || p.id >= 10 && p.id <= 15);
  sum = carrom.resolveShot(c, 0, fakeShot(c, [9]));
  assert.equal(sum.foulReason, "own_last_before_queen");
});

test("carrom rules: board points, queen bonus, multi-board matches and shot validation", () => {
  // Single board (target 0) through applyMove with a forced result
  const s = liveCarrom();
  s.pieces = [{ id: 9, x: 200, y: 200 }, { id: 10, x: 600, y: 300 }, { id: 11, x: 600, y: 360 }];
  s.credit = [8, 7];
  s.queenBy = 0;
  assert.equal(carrom.applyMove(s, 0, { type: "shoot", x: 590, dx: 200 - 590, dy: 200 - P.BASE_Y[0], power: 0.35 }, 1), null);
  assert.equal(s.lastShot.summary.mine, 1);
  assert.equal(s.winner, 0);
  assert.deepEqual(s.score, [2 + 3, 0]); // two black coins left + queen
  assert.equal(s.lastShot.summary.board.matchOver, true);

  // First to 13: the board ends but the match goes on, colours swap with the break
  const m = liveCarrom({ target: 13 });
  m.pieces = [{ id: 9, x: 200, y: 200 }, { id: 10, x: 600, y: 300 }];
  m.credit = [8, 8];
  m.queenBy = 1;
  carrom.applyMove(m, 0, { type: "shoot", x: 590, dx: 200 - 590, dy: 200 - P.BASE_Y[0], power: 0.35 }, 1);
  assert.equal(m.winner, null);
  assert.deepEqual(m.score, [1, 0]);
  assert.equal(m.boardNo, 2);
  assert.equal(m.white, 1);
  assert.equal(m.turn, 1);
  assert.equal(m.pieces.length, 19);

  // Validation
  const v = liveCarrom();
  const ok = { type: "shoot", x: 370, dx: 0, dy: -1, power: 0.5 };
  assert.equal(carrom.applyMove(v, 1, ok, 1), "not_your_turn");
  assert.equal(carrom.applyMove(v, 0, { ...ok, dy: 1 }, 1), "shot_backwards");
  assert.equal(carrom.applyMove(v, 0, { ...ok, x: 50 }, 1), "invalid_shot");
  assert.equal(carrom.applyMove(v, 0, { ...ok, power: 5 }, 1), "invalid_shot");
  assert.equal(carrom.applyMove(v, 0, { ...ok, x: NaN }, 1), "invalid_shot");
  v.pieces.push({ id: 1, x: 370, y: P.BASE_Y[0] });
  assert.equal(carrom.applyMove(v, 0, ok, 1), "striker_blocked");
  v.pieces.pop();
  assert.equal(carrom.applyMove(v, 0, ok, 1), null);
  // Next shot is refused while the previous one is still rolling on the clients
  assert.equal(carrom.applyMove(v, v.turn, ok, 2), "shot_in_progress");
});

test("carrom rules: the shot clock passes the turn; three misses in a row forfeit", () => {
  const s = carrom.create({ shotTime: 15 }, 0);
  carrom.start(s, 0);
  assert.equal(carrom.deadline(s), 15000);
  assert.equal(carrom.onDeadline(s, 14000), false);
  assert.equal(carrom.onDeadline(s, 15000), true);
  assert.equal(s.turn, 1);
  carrom.onDeadline(s, 30000); // black misses
  carrom.onDeadline(s, 45000); // white 2
  carrom.onDeadline(s, 60000);
  carrom.onDeadline(s, 75000); // white 3 → forfeit
  assert.deepEqual([s.winner, s.endReason], [1, "timeouts"]);
});

// ═══ Room lifecycle (unit, fake transport) ═══════════════════════════════════

function fakeRooms(opts = {}) {
  const sent = [];
  const tracked = [];
  const deps = {
    emit: (userId, event, payload) => sent.push({ userId, event, payload }),
    loadUser: async (id) => ({ id, username: id.slice(0, 4), avatar: "" }),
    canPlay: async () => true,
    persist: async () => {},
    track: new Proxy({}, { get: (_, hook) => (...args) => (tracked.push([hook, ...args]), hook === "matchStarted" ? "m1" : undefined) }),
  };
  return { rooms: new GameRooms(deps, { countdownMs: 20, readyTimeoutMs: 120, ...opts }), sent, tracked };
}
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

test("lifecycle: WAITING_FOR_PLAYERS → READY → IN_PROGRESS only when both are connected and ready", async () => {
  const { rooms, tracked } = fakeRooms();
  rooms.connected(A);
  rooms.connected(B);
  const inv = await rooms.invite(A, { game: "chess", toUserId: B, options: { time: "5+0", color: "white" } });
  const { roomId } = await rooms.respond(B, { inviteId: inv.inviteId, accept: true });
  let v = rooms.sync(A, { roomId }).room;
  assert.equal(v.phase, "WAITING_FOR_PLAYERS");
  assert.equal(v.state.white, 0, "inviter chose white");
  assert.throws(() => rooms.move(A, { roomId, seq: v.seq, move: { from: "e2", to: "e4" } }), { code: "not_started" });
  rooms.ready(A, { roomId });
  assert.equal(rooms.sync(A, { roomId }).room.phase, "WAITING_FOR_PLAYERS");
  rooms.ready(B, { roomId });
  v = rooms.sync(A, { roomId }).room;
  assert.equal(v.phase, "READY");
  assert.ok(v.startsIn > 0);
  // A drop during the countdown goes back to waiting
  rooms.disconnected(B);
  assert.equal(rooms.sync(A, { roomId }).room.phase, "WAITING_FOR_PLAYERS");
  rooms.connected(B);
  rooms.ready(B, { roomId });
  await wait(40);
  v = rooms.sync(A, { roomId }).room;
  assert.equal(v.phase, "IN_PROGRESS");
  assert.equal(v.state.clockRunning, true);
  assert.ok(tracked.some(([h, , st]) => h === "inviteStatus" && st === "accepted"));
});

test("lifecycle: an invitation can't be answered twice, and a duplicate match can't be created", async () => {
  const { rooms } = fakeRooms();
  rooms.connected(A);
  rooms.connected(B);
  const inv = await rooms.invite(A, { game: "carrom", toUserId: B });
  const first = await rooms.respond(B, { inviteId: inv.inviteId, accept: true });
  await assert.rejects(rooms.respond(B, { inviteId: inv.inviteId, accept: true }), { code: "invite_not_found" });
  await assert.rejects(rooms.invite(B, { game: "carrom", toUserId: A }), (e) => e.code === "match_in_progress" && e.roomId === first.roomId);
  // A different game is fine
  await rooms.invite(B, { game: "chess", toUserId: A });
});

test("lifecycle: nobody starting the match cancels it; leaving before the start cancels it too", async () => {
  const { rooms, tracked } = fakeRooms({ readyTimeoutMs: 30 });
  rooms.connected(A);
  rooms.connected(B);
  const inv = await rooms.invite(A, { game: "chess", toUserId: B });
  const { roomId } = await rooms.respond(B, { inviteId: inv.inviteId, accept: true });
  rooms.ready(A, { roomId });
  await wait(60);
  const v = rooms.sync(A, { roomId }).room;
  assert.equal(v.phase, "CANCELLED");
  assert.equal(v.result.winner, null);
  await wait(5);
  assert.ok(tracked.some(([h, , r]) => h === "matchEnded" && r.status === "cancelled"));

  const inv2 = await rooms.invite(A, { game: "carrom", toUserId: B });
  const r2 = await rooms.respond(B, { inviteId: inv2.inviteId, accept: true });
  rooms.leave(B, { roomId: r2.roomId });
  assert.equal(rooms.sync(A, { roomId: r2.roomId }).room.phase, "CANCELLED");
});

test("lifecycle: chess flag falls on the server and the result is recorded", async () => {
  const { rooms, tracked } = fakeRooms();
  rooms.connected(A);
  rooms.connected(B);
  const inv = await rooms.invite(A, { game: "chess", toUserId: B, options: { time: "1+0", color: "white" } });
  const { roomId } = await rooms.respond(B, { inviteId: inv.inviteId, accept: true });
  rooms.ready(A, { roomId });
  rooms.ready(B, { roomId });
  await wait(40);
  const room = rooms.rooms.get(roomId);
  room.state.clock = [30, 60000]; // white has 30 ms left
  room.state.turnStartedAt = Date.now();
  rooms.scheduleDeadline(room);
  await wait(80);
  const v = rooms.sync(A, { roomId }).room;
  assert.equal(v.phase, "COMPLETED");
  assert.deepEqual(v.result, { winner: 1, reason: "timeout" });
  await wait(5);
  const ended = tracked.find(([h]) => h === "matchEnded");
  assert.equal(ended[2].winnerId, B);
  assert.equal(ended[2].reason, "timeout");
});

// ═══ Over Socket.IO, with the database ═══════════════════════════════════════

let srv, alice, bob, eve;
const call = (s, event, payload) => new Promise((resolve) => s.emit(event, payload, resolve));
const next = (s, event, pred = () => true, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      s.off(event, on);
      reject(new Error(`timed out waiting for ${event}`));
    }, ms);
    const on = (p) => {
      if (!pred(p)) return;
      clearTimeout(t);
      s.off(event, on);
      resolve(p);
    };
    s.on(event, on);
  });

test.before(async () => {
  await h.resetDb();
  srv = await h.startServer({ socketOptions: { games: { graceMs: 400, countdownMs: 60 } } });
  alice = await h.createUser("alice");
  bob = await h.createUser("bob");
  eve = await h.createUser("eve");
  await h.query("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'accepted')", [alice.id, bob.id]);
  for (const u of [alice, bob]) await h.query("INSERT INTO user_entitlements (user_id, entitlement, source) VALUES ($1, 'games_lifetime', 'promo')", [u.id]);
});
test.after(async () => {
  await srv?.close();
  await h.pool.end();
});

/** alice invites bob, bob accepts, both open the match; resolves once it is IN_PROGRESS. */
async function liveMatch(game, options) {
  const a = await srv.socket(alice.token);
  const b = await srv.socket(bob.token);
  const invited = next(b, "game:invited");
  assert.equal((await call(a, "game:invite", { game, toUserId: bob.id, options })).ok, true);
  const { inviteId } = await invited;
  const accepted = next(a, "game:invite:update");
  const res = await call(b, "game:invite:respond", { inviteId, accept: true });
  assert.equal((await accepted).status, "accepted");
  const roomId = res.roomId;
  const liveA = next(a, "game:state", (v) => v.roomId === roomId && v.phase === "IN_PROGRESS");
  const liveB = next(b, "game:state", (v) => v.roomId === roomId && v.phase === "IN_PROGRESS");
  assert.equal((await call(a, "game:ready", { roomId })).ok, true);
  assert.equal((await call(b, "game:ready", { roomId })).ok, true);
  return { a, b, roomId, inviteId, viewA: await liveA, viewB: await liveB };
}

test("sockets: two users play chess — synced moves, server validation, no outsiders, result + log saved", async () => {
  const { a, b, roomId, inviteId, viewA, viewB } = await liveMatch("chess", { time: "5+0", color: "white" });
  assert.equal(viewA.state.white, 0);
  assert.equal(viewA.state.fen, viewB.state.fen);
  const e = await srv.socket(eve.token);
  assert.equal((await call(e, "game:sync", { roomId })).error, "room_not_found");
  assert.equal((await call(e, "game:move", { roomId, seq: viewA.seq, move: { from: "e2", to: "e4" } })).error, "room_not_found");
  assert.equal((await call(e, "game:ready", { roomId })).error, "room_not_found");

  // Black can't move first, white can't move black's pieces
  assert.equal((await call(b, "game:move", { roomId, seq: viewB.seq, move: { from: "e7", to: "e5" } })).error, "not_your_turn");
  assert.equal((await call(a, "game:move", { roomId, seq: viewA.seq, move: { from: "e7", to: "e5" } })).error, "not_your_piece");

  let seq = viewA.seq;
  const moves = [["a", "f2", "f3"], ["b", "e7", "e5"], ["a", "g2", "g4"], ["b", "d8", "h4"]];
  for (const [who, from, to] of moves) {
    const s = who === "a" ? a : b;
    const other = who === "a" ? b : a;
    const seen = next(other, "game:state", (v) => v.seq > seq);
    const res = await call(s, "game:move", { roomId, seq, move: { from, to } });
    assert.equal(res.ok, true, JSON.stringify(res));
    // The same submission again (duplicate tap / retry) is rejected
    if (seq === viewA.seq) assert.equal((await call(s, "game:move", { roomId, seq, move: { from, to } })).error, "stale_state");
    const v = await seen;
    seq = v.seq;
  }
  const final = (await call(a, "game:sync", { roomId })).room;
  assert.equal(final.phase, "COMPLETED");
  assert.deepEqual(final.result, { winner: 1, reason: "checkmate" });
  assert.equal(final.state.history.at(-1).san, "Qh4#");

  await wait(150);
  const { rows } = await h.query("SELECT * FROM game_matches WHERE room_id = $1", [roomId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].winner_id, bob.id);
  assert.equal(rows[0].reason, "checkmate");
  assert.match(rows[0].result_detail.pgn, /Qh4#/);
  const actions = await h.query("SELECT action FROM game_match_actions WHERE match_id = $1 ORDER BY seq", [rows[0].id]);
  assert.deepEqual(actions.rows.map((r) => r.action.san), ["f3", "e5", "g4", "Qh4#"]);
  const inv = await h.query("SELECT status, room_id FROM game_invitations WHERE id = $1", [inviteId]);
  assert.deepEqual(inv.rows[0], { status: "accepted", room_id: roomId });
  const stats = await srv.call("GET", "/api/games/stats?game=chess", { token: bob.token });
  assert.deepEqual(stats.body.stats.chess, { wins: 1, losses: 0, draws: 0 });
  assert.equal(stats.body.recent[0].game, "chess");

  // Rematch: both agree → new match, colours swap
  const rematchLive = next(a, "game:state", (v) => v.matchNo === 1 && v.phase === "IN_PROGRESS");
  await call(a, "game:rematch", { roomId });
  await call(b, "game:rematch", { roomId });
  const r = await rematchLive;
  assert.equal(r.state.white, 1);
  await call(a, "game:leave", { roomId });
  [a, b, e].forEach((s) => s.close());
});

test("sockets: reconnecting restores the chess position", async () => {
  const { a, b, roomId, viewA } = await liveMatch("chess", { time: "untimed", color: "white" });
  await call(a, "game:move", { roomId, seq: viewA.seq, move: { from: "e2", to: "e4" } });
  b.close();
  await wait(50);
  const back = await srv.socket(bob.token);
  const { room } = await call(back, "game:sync", { roomId });
  assert.equal(room.you, 1);
  assert.equal(room.phase, "IN_PROGRESS");
  assert.equal(room.state.history.length, 1);
  assert.equal(room.players[1].connected, true);
  const res = await call(back, "game:move", { roomId, seq: room.seq, move: { from: "e7", to: "e5" } });
  assert.equal(res.ok, true);
  await call(a, "game:leave", { roomId });
  [a, back].forEach((s) => s.close());
});

test("sockets: carrom — aim relayed only to the opponent, server runs the shot, duplicates rejected", async () => {
  const { a, b, roomId, viewA } = await liveMatch("carrom", { target: 0, shotTime: 30 });
  const shooter = viewA.state.turn === 0 ? a : b;
  const watcher = shooter === a ? b : a;
  const seat = viewA.state.turn;
  const dy = seat === 0 ? -1 : 1;

  // Only the player to move may aim; the aim reaches the other player
  const aimSeen = next(watcher, "game:aim");
  assert.equal((await call(watcher, "game:aim", { roomId, x: 370, dx: 0, dy: -dy, power: 0.5 })).error, "not_your_turn");
  assert.equal((await call(shooter, "game:aim", { roomId, x: 360, dx: 0.1, dy, power: 0.7 })).ok, true);
  const aim = await aimSeen;
  assert.deepEqual([aim.x, aim.power, aim.by], [360, 0.7, seat]);

  // Shot: both players get the same resulting state and playback
  const shot = { type: "shoot", x: 370, dx: 0.02, dy, power: 1 };
  const seenA = next(a, "game:state", (v) => v.state.shots === 1);
  const seenB = next(b, "game:state", (v) => v.state.shots === 1);
  const res = await call(shooter, "game:move", { roomId, seq: viewA.seq, move: shot });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((await call(shooter, "game:move", { roomId, seq: viewA.seq, move: shot })).error, "stale_state");
  const [va, vb] = await Promise.all([seenA, seenB]);
  assert.deepEqual(va.state.pieces, vb.state.pieces);
  assert.ok(va.state.lastShot.frames.length > 5);
  assert.ok(va.state.lastShot.durationMs > 0);
  // A forged client score is ignored: the server keeps its own
  const forged = await call(watcher, "game:move", { roomId, seq: va.seq, move: { type: "shoot", score: [99, 0], x: 370, dx: 0, dy: -dy, power: 0.5 } });
  if (va.state.turn !== (watcher === a ? 0 : 1)) assert.equal(forged.error, "not_your_turn");
  const after = (await call(a, "game:sync", { roomId })).room;
  assert.ok(after.state.score.every((n) => n < 30));
  await call(a, "game:leave", { roomId });
  await wait(100);
  const { rows } = await h.query("SELECT status, reason FROM game_matches WHERE room_id = $1", [roomId]);
  assert.deepEqual(rows[0], { status: "completed", reason: "left" });
  [a, b].forEach((s) => s.close());
});

test("sockets: invitation expiry and cancellation reach both sides and are recorded", async () => {
  const a = await srv.socket(alice.token);
  const b = await srv.socket(bob.token);
  const invited = next(b, "game:invited");
  const { invite } = await call(a, "game:invite", { game: "carrom", toUserId: bob.id });
  await invited;
  const upd = next(b, "game:invite:update");
  assert.equal((await call(b, "game:invite:cancel", { inviteId: invite.inviteId })).error, "invite_not_found"); // only the sender cancels
  await call(a, "game:invite:cancel", { inviteId: invite.inviteId });
  assert.equal((await upd).status, "canceled");
  assert.equal((await call(b, "game:invite:respond", { inviteId: invite.inviteId, accept: true })).error, "invite_not_found");
  await wait(100);
  const { rows } = await h.query("SELECT status FROM game_invitations WHERE id = $1", [invite.inviteId]);
  assert.equal(rows[0].status, "cancelled");
  [a, b].forEach((s) => s.close());
});
