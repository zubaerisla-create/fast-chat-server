const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const c4 = require("../services/games/connectFour");
const dots = require("../services/games/dotsBoxes");
const hangman = require("../services/games/hangman");

const GRACE_MS = 400;
let srv, alice, bob, eve;

test.before(async () => {
  await h.resetDb();
  srv = await h.startServer({ socketOptions: { games: { graceMs: GRACE_MS } } });
  alice = await h.createUser("alice");
  bob = await h.createUser("bob");
  eve = await h.createUser("eve");
  await h.query("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'accepted')", [alice.id, bob.id]);
  for (const u of [alice, bob]) await h.query("INSERT INTO user_entitlements (user_id, entitlement, source) VALUES ($1, 'games_lifetime', 'promo')", [u.id]);
});

test.after(async () => {
  await srv.close();
  await h.pool.end();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, event, payload) => new Promise((resolve) => s.emit(event, payload, resolve));
/** Resolves with the next payload of `event` that matches `pred`. */
const next = (s, event, pred = () => true, ms = 2000) =>
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

/** alice invites bob, bob accepts; returns both sockets' first room views. */
async function startMatch(game, options = {}) {
  const a = await srv.socket(alice.token);
  const b = await srv.socket(bob.token);
  const invited = next(b, "game:invited");
  const inv = await call(a, "game:invite", { game, toUserId: bob.id, options });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  const { inviteId } = await invited;
  const stateA = next(a, "game:state");
  const stateB = next(b, "game:state");
  const res = await call(b, "game:invite:respond", { inviteId, accept: true });
  assert.equal(res.ok, true);
  return { a, b, roomId: res.roomId, viewA: await stateA, viewB: await stateB };
}

// ─── Rules engines ────────────────────────────────────────────────────────────

test("connect four: gravity, full columns, wins in every direction, draws", () => {
  const s = c4.create();
  for (const col of [0, 1, 0, 1, 0, 1]) assert.equal(c4.applyMove(s, s.turn, { col }), null);
  assert.equal(c4.applyMove(s, 1, { col: 2 }), "not_your_turn");
  assert.equal(c4.applyMove(s, 0, { col: 7 }), "invalid_move");
  assert.equal(c4.applyMove(s, 0, { col: 0 }), null);
  assert.equal(s.winner, 0);
  assert.deepEqual(s.winLine, [14, 21, 28, 35]);
  assert.equal(c4.applyMove(s, 1, { col: 3 }), "game_over");

  const full = c4.create();
  for (let i = 0; i < 6; i++) c4.applyMove(full, full.turn, { col: 3 });
  assert.equal(c4.applyMove(full, full.turn, { col: 3 }), "column_full");

  // Diagonal (bottom-left → top-right) for player 0
  const d = c4.create();
  for (const col of [0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3]) assert.equal(c4.applyMove(d, d.turn, { col }), null);
  assert.equal(d.winner, 0);

  // A full board with no line is a draw
  const b = c4.create();
  b.board = [
    0, 0, 1, 1, 0, 0, 1,
    1, 1, 0, 0, 1, 1, 0,
    0, 0, 1, 1, 0, 0, 1,
    1, 1, 0, 0, 1, 1, 0,
    0, 0, 1, 1, 0, 0, 1,
    1, 1, 0, 0, 1, 1, -1,
  ];
  b.moves = 41;
  b.turn = 1;
  assert.equal(c4.applyMove(b, 1, { col: 6 }), null);
  assert.equal(b.winner, "draw");
});

test("dots & boxes: completing a box scores and keeps the turn", () => {
  const s = dots.create({ size: 4 });
  assert.equal(s.edges.length, 24);
  const [top, bottom, left, right] = dots.boxEdges(4, 0);
  assert.equal(dots.applyMove(s, 0, { edge: top }), null);
  assert.equal(dots.applyMove(s, 1, { edge: bottom }), null);
  assert.equal(dots.applyMove(s, 0, { edge: left }), null);
  assert.equal(dots.applyMove(s, 1, { edge: left }), "edge_taken");
  assert.equal(dots.applyMove(s, 1, { edge: right }), null);
  assert.deepEqual(s.score, [0, 1]);
  assert.equal(s.turn, 1, "player who closed the box moves again");
  assert.equal(s.boxes[0], 1);
  // Play out: the game ends when every box is owned
  while (s.winner === null) dots.applyMove(s, s.turn, { edge: s.edges.indexOf(-1) });
  assert.equal(s.score[0] + s.score[1], 9);
  assert.ok(s.winner === 0 || s.winner === 1);
  assert.equal(dots.create({ size: 9 }).size, 5, "unsupported sizes fall back to 5");
});

test("hangman: word validation and the guesser never sees the secret", () => {
  assert.equal(hangman.normalizeWord("  Planet ").word, "planet");
  for (const bad of ["ab", "hello world", "abc1", "aaaa", "a".repeat(17), 42, null]) {
    assert.equal(hangman.normalizeWord(bad).error, "invalid_word", String(bad));
  }
  const s = hangman.create();
  assert.equal(hangman.applyMove(s, 1, { type: "setWord", word: "planet" }), "not_your_turn");
  assert.equal(hangman.applyMove(s, 0, { type: "setWord", word: "planet", hint: "x".repeat(61) }), "invalid_hint");
  assert.equal(hangman.applyMove(s, 0, { type: "setWord", word: "planet", hint: "Orbits a star" }), null);
  const guesserView = hangman.view(s, 1);
  assert.equal(guesserView.word, undefined);
  assert.equal(guesserView.masked, "______");
  assert.ok(!JSON.stringify(guesserView).includes("planet"));
  assert.equal(hangman.view(s, 0).word, "planet");
  assert.equal(hangman.applyMove(s, 1, { type: "guess", letter: "a" }), null);
  assert.equal(hangman.applyMove(s, 1, { type: "guess", letter: "a" }), "already_guessed");
  assert.equal(hangman.view(s, 1).masked, "__a___");
  for (const l of "plnet") hangman.applyMove(s, 1, { type: "guess", letter: l });
  assert.deepEqual(s.score, [0, 1]);
  assert.equal(s.lastRound.word, "planet");
  assert.equal(s.setter, 1, "roles swap for the next round");
  assert.equal(s.phase, "setting");
  // Six wrong guesses lose the round for the guesser
  hangman.applyMove(s, 1, { type: "setWord", word: "zebra" });
  for (const l of "cdfghi") hangman.applyMove(s, 0, { type: "guess", letter: l });
  assert.deepEqual(s.score, [0, 2]);
});

// ─── Multiplayer over Socket.IO ──────────────────────────────────────────────

test("only friends can be invited, and a declined invite reaches the inviter", async () => {
  const e = await srv.socket(eve.token);
  assert.deepEqual(await call(e, "game:invite", { game: "connect4", toUserId: alice.id }), { ok: false, error: "not_friends" });
  assert.equal((await call(e, "game:invite", { game: "poker", toUserId: alice.id })).error, "invalid_game");
  assert.equal((await call(e, "game:invite", { game: "connect4", toUserId: eve.id })).error, "invalid_user");

  const a = await srv.socket(alice.token);
  const b = await srv.socket(bob.token);
  const invited = next(b, "game:invited");
  await call(a, "game:invite", { game: "dots", toUserId: bob.id, options: { size: 6, evil: true } });
  const invite = await invited;
  assert.equal(invite.from.username, "alice");
  assert.deepEqual(invite.options, { size: 6 });
  // Eve can't answer someone else's invite
  assert.equal((await call(e, "game:invite:respond", { inviteId: invite.inviteId, accept: true })).error, "invite_not_found");
  const update = next(a, "game:invite:update");
  await call(b, "game:invite:respond", { inviteId: invite.inviteId, accept: false });
  assert.equal((await update).status, "declined");
  [a, b, e].forEach((s) => s.close());
});

test("connect four over sockets: synced state, turn order, stale and foreign moves rejected, result saved", async () => {
  const { a, b, roomId, viewA, viewB } = await startMatch("connect4");
  assert.equal(viewA.you, 0);
  assert.equal(viewB.you, 1);
  assert.deepEqual(viewA.players.map((p) => p.username), ["alice", "bob"]);
  assert.equal(viewA.seq, viewB.seq);

  let seq = viewA.seq;
  assert.equal((await call(b, "game:move", { roomId, seq, move: { col: 3 } })).error, "not_your_turn");
  const e = await srv.socket(eve.token);
  assert.equal((await call(e, "game:move", { roomId, seq, move: { col: 3 } })).error, "room_not_found");
  assert.equal((await call(e, "game:sync", { roomId })).error, "room_not_found");

  const seen = next(b, "game:state");
  const r1 = await call(a, "game:move", { roomId, seq, move: { col: 3 } });
  assert.equal(r1.ok, true);
  const bView = await seen;
  assert.equal(bView.state.board[5 * 7 + 3], 0, "bob sees alice's disc");
  // The same move sent twice (stale seq) is rejected
  assert.equal((await call(a, "game:move", { roomId, seq, move: { col: 3 } })).error, "stale_state");
  assert.equal((await call(b, "game:move", { roomId, seq: bView.seq, move: { col: 9 } })).error, "invalid_move");

  // alice: 3,3,3,3 vertical; bob: 0,0,0
  seq = bView.seq;
  for (const [s, col] of [[b, 0], [a, 3], [b, 0], [a, 3], [b, 0]]) {
    const r = await call(s, "game:move", { roomId, seq, move: { col } });
    assert.equal(r.ok, true, JSON.stringify(r));
    seq = r.seq;
  }
  const over = next(b, "game:state", (v) => v.status === "over");
  await call(a, "game:move", { roomId, seq, move: { col: 3 } });
  const final = await over;
  assert.deepEqual(final.result, { winner: 0, reason: "normal" });
  assert.deepEqual(final.state.winLine.length, 4);
  assert.deepEqual(final.tally, [1, 0, 0]);

  await wait(100);
  const stats = await srv.call("GET", "/api/games/stats", { token: alice.token });
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body.stats.connect4, { wins: 1, losses: 0, draws: 0 });
  const bobStats = await srv.call("GET", "/api/games/stats", { token: bob.token });
  assert.deepEqual(bobStats.body.stats.connect4, { wins: 0, losses: 1, draws: 0 });
  assert.equal(bobStats.body.recent[0].opponent.username, "alice");
  assert.equal((await srv.call("GET", "/api/games/stats")).status, 401);

  // Rematch: needs both votes, then a fresh board where bob starts
  assert.equal((await call(a, "game:rematch", { roomId })).ok, true);
  const fresh = next(a, "game:state", (v) => v.status === "playing");
  await call(b, "game:rematch", { roomId });
  const rematch = await fresh;
  assert.equal(rematch.state.turn, 1);
  assert.ok(rematch.state.board.every((x) => x === -1));
  assert.deepEqual(rematch.tally, [1, 0, 0]);

  // Leaving a running game forfeits it
  const left = next(b, "game:state", (v) => v.status === "over");
  await call(a, "game:leave", { roomId });
  assert.deepEqual((await left).result, { winner: 1, reason: "left" });
  assert.equal((await call(b, "game:rematch", { roomId })).error, "opponent_left");
  [a, b, e].forEach((s) => s.close());
});

test("hangman over sockets: the secret word is only sent to the setter", async () => {
  const { a, b, roomId, viewA } = await startMatch("hangman");
  const bobPayloads = [];
  b.on("game:state", (v) => bobPayloads.push(JSON.stringify(v)));
  const secret = "quokka";
  assert.equal((await call(a, "game:move", { roomId, seq: viewA.seq, move: { type: "setWord", word: "no" } })).error, "invalid_word");
  const bobSees = next(b, "game:state", (v) => v.state.phase === "guessing");
  const aliceSees = next(a, "game:state", (v) => v.state.phase === "guessing");
  const r = await call(a, "game:move", { roomId, seq: viewA.seq, move: { type: "setWord", word: secret, hint: "A happy marsupial" } });
  assert.equal(r.ok, true);
  const bv = await bobSees;
  assert.equal(bv.state.masked, "______");
  assert.equal(bv.state.hint, "A happy marsupial");
  assert.equal(bv.state.word, undefined);
  assert.equal((await aliceSees).state.word, secret);
  const sync = await call(b, "game:sync", { roomId });
  assert.ok(!JSON.stringify(sync).includes(secret));

  let seq = r.seq;
  for (const letter of "qk") {
    const res = await call(b, "game:move", { roomId, seq, move: { type: "guess", letter } });
    seq = res.seq;
  }
  assert.ok(bobPayloads.every((p) => !p.includes(secret)), "no update to the guesser contains the word");
  // Finish the round: the word is revealed to both afterwards
  const roundOver = next(b, "game:state", (v) => v.state.round === 2);
  for (const letter of "uoa") {
    const res = await call(b, "game:move", { roomId, seq, move: { type: "guess", letter } });
    seq = res.seq;
  }
  const after = await roundOver;
  assert.equal(after.state.lastRound.word, secret);
  assert.equal(after.state.lastRound.solved, true);
  assert.equal(after.state.setter, 1);
  assert.equal(after.state.turn, 1);
  await call(a, "game:leave", { roomId });
  [a, b].forEach((s) => s.close());
});

test("reconnecting within the grace period resumes the game; staying away forfeits it", async () => {
  const { a, b, roomId, viewA } = await startMatch("dots", { size: 4 });
  const offline = next(a, "game:state", (v) => v.players[1].connected === false);
  b.close();
  await offline;

  const b2 = await srv.socket(bob.token);
  const back = await next(a, "game:state", (v) => v.players[1].connected === true);
  assert.equal(back.status, "playing");
  const resumed = await call(b2, "game:sync", {});
  const mine = resumed.rooms.find((r) => r.roomId === roomId);
  assert.equal(mine.status, "playing");
  assert.equal(mine.you, 1);
  assert.equal((await call(a, "game:move", { roomId, seq: back.seq, move: { edge: 0 } })).ok, true);

  const forfeited = next(a, "game:state", (v) => v.status === "over", GRACE_MS + 2000);
  b2.close();
  const end = await forfeited;
  assert.deepEqual(end.result, { winner: 0, reason: "disconnected" });
  await wait(100);
  const { rows } = await h.query("SELECT reason, winner_id FROM game_matches WHERE room_id = $1", [roomId]);
  assert.deepEqual(rows, [{ reason: "disconnected", winner_id: alice.id }]);
  assert.ok(viewA);
  a.close();
});
