/**
 * Carrom stress tests: thousands of shots and complete games through the real server engine,
 * checking after every shot that the board stays physically and logically consistent, and that
 * the playback frames the clients animate end exactly where the authoritative state says.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../services/games/carromPhysics");
const carrom = require("../services/games/carrom");

/** Small seeded PRNG so failures are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const colorOfId = (id) => (id === 19 ? "queen" : id <= 9 ? "white" : "black");

/** Every invariant that must hold between shots. */
function checkState(s, label) {
  const ids = s.pieces.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicate coin ids`);
  for (const p of s.pieces) {
    assert.ok(p.id >= 1 && p.id <= 19, `${label}: bad id ${p.id}`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${label}: NaN position`);
    assert.ok(p.x >= P.COIN_R - 1e-6 && p.x <= P.BOARD - P.COIN_R + 1e-6, `${label}: coin ${p.id} off the board (x=${p.x})`);
    assert.ok(p.y >= P.COIN_R - 1e-6 && p.y <= P.BOARD - P.COIN_R + 1e-6, `${label}: coin ${p.id} off the board (y=${p.y})`);
    for (const [px, py] of P.POCKETS) assert.ok(Math.hypot(p.x - px, p.y - py) > P.POCKET_R, `${label}: coin ${p.id} resting inside a pocket`);
  }
  for (let i = 0; i < s.pieces.length; i++)
    for (let j = i + 1; j < s.pieces.length; j++) {
      const [a, b] = [s.pieces[i], s.pieces[j]];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 2 * P.COIN_R - 0.6, `${label}: coins ${a.id} and ${b.id} overlap at rest`);
    }
  // Coin conservation: on the board + credited to its owner = 9, for each colour
  for (const color of ["white", "black"]) {
    const seat = color === "white" ? s.white : 1 - s.white;
    const onBoard = s.pieces.filter((p) => colorOfId(p.id) === color).length;
    assert.equal(onBoard + s.credit[seat], 9, `${label}: ${color} coins not conserved (board ${onBoard} + credit ${s.credit[seat]})`);
  }
  // The queen is in exactly one place
  const queenOnBoard = s.pieces.some((p) => p.id === 19);
  const places = [queenOnBoard, s.queenPending !== null, s.queenBy !== null].filter(Boolean).length;
  assert.equal(places, 1, `${label}: queen on board=${queenOnBoard} pending=${s.queenPending} covered=${s.queenBy}`);
  assert.ok(s.due.every((d) => d >= 0) && s.credit.every((c) => c >= 0 && c <= 9), `${label}: negative or impossible counts`);
}

/** Replays the compact playback frames and returns where each body ends. */
function replayFrames(frames) {
  const pos = new Map();
  for (const frame of frames) for (let i = 0; i < frame.length; i += 3) pos.set(frame[i], [frame[i + 1] / 2, frame[i + 2] / 2]);
  return pos;
}

/** A plausible shot: a ghost-ball cut on one of the shooter's coins, or a random forward shot. */
function pickShot(s, seat, r) {
  const me = s.white === seat ? "white" : "black";
  const own = s.pieces.filter((p) => colorOfId(p.id) === me || (p.id === 19 && s.queenBy === null));
  const by = P.BASE_Y[seat];
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = P.STRIKER_MIN_X + r() * (P.STRIKER_MAX_X - P.STRIKER_MIN_X);
    if (P.strikerBlocked(s.pieces, seat, x)) continue;
    let dx;
    let dy;
    if (own.length && r() < 0.75) {
      const t = own[Math.floor(r() * own.length)];
      const [px, py] = P.POCKETS[Math.floor(r() * 4)];
      const l = Math.hypot(px - t.x, py - t.y);
      dx = t.x - ((px - t.x) / l) * (P.COIN_R + P.STRIKER_R) - x;
      dy = t.y - ((py - t.y) / l) * (P.COIN_R + P.STRIKER_R) - by;
    } else {
      dx = r() * 2 - 1;
      dy = seat === 0 ? -(0.2 + r()) : 0.2 + r();
    }
    const len = Math.hypot(dx, dy);
    if ((seat === 0 ? -dy : dy) / len < 0.12) continue;
    return { type: "shoot", x, dx: dx / len, dy: dy / len, power: 0.15 + r() * 0.85 };
  }
  return null;
}

test("carrom physics: 3,000 random shots keep every coin on the board, separated, and frames end on the final state", () => {
  const r = rng(42);
  let pocketedTotal = 0;
  for (let i = 0; i < 3000; i++) {
    // Random but legal layouts: start from the break position and scatter with a previous shot
    let pieces = P.initialPieces();
    if (i % 3) pieces = P.simulate(pieces, { seat: 0, x: 200 + r() * 340, dx: r() - 0.5, dy: -1, power: 0.4 + r() * 0.6 }).pieces;
    const seat = i % 2;
    let x = P.STRIKER_MIN_X + r() * (P.STRIKER_MAX_X - P.STRIKER_MIN_X);
    if (P.strikerBlocked(pieces, seat, x)) x = P.CENTER;
    if (P.strikerBlocked(pieces, seat, x)) continue;
    const res = P.simulate(pieces, { seat, x, dx: r() * 2 - 1, dy: seat === 0 ? -(0.1 + r()) : 0.1 + r(), power: 0.05 + r() * 0.95 });
    pocketedTotal += res.pocketed.length;
    assert.ok(res.steps < 240 * 12, `shot ${i} never came to rest`);
    // Every body either ends on the board (final state) or in the pocketed list — never both, never lost
    const finalIds = res.pieces.map((p) => p.id).sort((a, b) => a - b);
    const all = [...finalIds, ...res.pocketed.filter((id) => id !== 0)].sort((a, b) => a - b);
    assert.deepEqual(all, pieces.map((p) => p.id).sort((a, b) => a - b), `shot ${i}: coins lost or duplicated`);
    checkState({ pieces: res.pieces, white: 0, credit: [9 - res.pieces.filter((p) => p.id <= 9).length, 9 - res.pieces.filter((p) => p.id >= 10 && p.id <= 18).length], due: [0, 0], queenBy: res.pieces.some((p) => p.id === 19) ? null : 0, queenPending: null }, `shot ${i}`);
    // What the client animates ends where the server state is (within the half-mm frame precision)
    const end = replayFrames(res.frames);
    for (const p of res.pieces) {
      const [fx, fy] = end.get(p.id);
      assert.ok(Math.abs(fx - p.x) <= 0.26 && Math.abs(fy - p.y) <= 0.26, `shot ${i}: coin ${p.id} playback ends at ${fx},${fy} but state says ${p.x},${p.y}`);
    }
    // A pocketed coin's last frame is its pocket centre, and it has exactly one pocket event
    for (const id of res.pocketed) {
      const ev = res.events.filter((e) => e.type === "pocket" && e.a === id);
      assert.equal(ev.length, 1, `shot ${i}: pocket events for ${id}`);
      const [fx, fy] = end.get(id);
      const [px, py] = P.POCKETS[ev[0].pocket];
      assert.ok(Math.abs(fx - px) <= 0.26 && Math.abs(fy - py) <= 0.26, `shot ${i}: coin ${id} not shown in its pocket`);
    }
    // Event frame indexes are inside the playback
    for (const e of res.events) assert.ok(e.f >= 0 && e.f < res.frames.length, `shot ${i}: event outside playback`);
  }
  assert.ok(pocketedTotal > 100, `pockets actually happen (${pocketedTotal})`);
});

test("carrom rules: 40 complete games through the server engine stay consistent shot by shot and end correctly", () => {
  let boardsFinished = 0;
  let queenCovered = 0;
  let fouls = 0;
  let again = 0;
  let totalShots = 0;
  for (let g = 0; g < 40; g++) {
    const r = rng(1000 + g);
    const s = carrom.create({ target: g % 4 === 0 ? 13 : 0, shotTime: 30 }, g % 2);
    let now = 1_000_000;
    carrom.start(s, now);
    checkState(s, `game ${g} start`);
    let shots = 0;
    while (s.winner === null && shots < (s.target ? 6000 : 1500)) {
      const seat = s.turn;
      const move = pickShot(s, seat, r);
      now = Math.max(now, s.turnStartedAt) + 1;
      if (!move) {
        // Nowhere to place the striker: let the shot clock pass the turn
        assert.equal(carrom.onDeadline(s, now + s.shotMs), true);
        continue;
      }
      const before = { turn: s.turn, credit: s.credit.slice(), boardNo: s.boardNo, queenBy: s.queenBy, queenPending: s.queenPending, white: s.white };
      // Out-of-turn and duplicate attempts are always refused
      assert.equal(carrom.applyMove(s, 1 - seat, move, now), "not_your_turn");
      const err = carrom.applyMove(s, seat, move, now);
      assert.equal(err, null, `game ${g} shot ${shots}: ${err}`);
      assert.equal(carrom.applyMove(s, s.turn, move, now), s.winner !== null ? "game_over" : "shot_in_progress", "no second shot while the coins are still rolling");
      shots += 1;
      totalShots += 1;
      const sum = s.lastShot.summary;
      if (sum.foul) fouls += 1;
      if (sum.again) again += 1;
      if (sum.covered) queenCovered += 1;
      const label = `game ${g} shot ${shots}`;
      if (sum.board) {
        boardsFinished += 1;
        // The board went to the side that cleared its coins, scored as the rules say
        const bw = sum.board.boardWinner;
        assert.ok(sum.board.points >= 0 && sum.board.points <= 9 + 3, `${label}: points ${sum.board.points}`);
        if (!sum.board.matchOver) {
          assert.equal(s.pieces.length, 19, `${label}: new board is set up`);
          assert.equal(s.white, s.breaker);
          assert.equal(s.turn, s.breaker);
          assert.notEqual(s.breaker, before.white, "the break alternates");
        } else {
          assert.equal(s.winner, bw);
        }
        if (s.winner === null) checkState(s, label);
        continue;
      }
      checkState(s, label);
      // Turn logic: you keep the turn exactly when you pocketed your own coin (no foul) or must cover the queen
      if (sum.foul) assert.equal(s.turn, 1 - seat, `${label}: foul passes the turn`);
      else assert.equal(s.turn, sum.mine > 0 || s.queenPending === seat ? seat : 1 - seat, `${label}: wrong turn after ${JSON.stringify(sum)}`);
      // Credits only move in the allowed directions
      const opp = 1 - seat;
      assert.ok(s.credit[opp] >= before.credit[opp] - 1, `${label}: opponent lost more than one coin`);
      if (sum.foul && sum.penalty === "penalty") assert.equal(s.credit[seat], before.credit[seat] - 1, `${label}: penalty coin`);
    }
    assert.notEqual(s.winner, null, `game ${g} finished`);
    assert.ok(s.score[s.winner] > 0 || s.endReason !== "normal", `game ${g}: winner scored`);
    if (s.target === 0) assert.equal(s.boards.length, 1);
    else assert.ok(s.score[s.winner] >= s.target);
  }
  assert.ok(boardsFinished >= 40, `boards finished: ${boardsFinished}`);
  assert.ok(fouls > 0 && again > 0 && queenCovered > 0, `fouls ${fouls}, extra turns ${again}, queen covered ${queenCovered}`);
  console.log(`# carrom stress: ${totalShots} shots, ${boardsFinished} boards, ${fouls} fouls, ${again} extra turns, ${queenCovered} queens covered`);
});
