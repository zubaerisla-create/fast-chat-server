/**
 * Multiplayer game rooms for Dots & Boxes, Hangman, Connect Four, Chess and Carrom.
 *
 * The server is authoritative: clients only send intents (a column, an edge, a letter, a
 * word); the rules engines validate them against the room's state, which never comes from
 * a client. Rooms live in memory (like presence and calls in sockets/socketHandler.js);
 * only finished matches are written to the database, once per match.
 *
 * Every event is delivered to the user's room (`user:<id>`), so all of a user's devices stay
 * in sync and a reconnecting socket gets the next update without re-joining anything.
 *
 * Lifecycle (chess and carrom, whose engines set `needsReady`; the older games start at once):
 *   invite: INVITED → ACCEPTED | DECLINED | EXPIRED | CANCELLED
 *   room:   WAITING_FOR_PLAYERS (both must open the match and send game:ready)
 *           → READY (short countdown, both connected) → IN_PROGRESS → COMPLETED
 *           or CANCELLED when nobody starts it in time / someone leaves before the start.
 * Engines may expose a deadline (chess clocks, the carrom shot clock); the room arms one timer
 * for it, so time runs out on the server, not on a client.
 *
 * Scale-out note: with more than one API process this state must move to Redis (same as
 * onlineUsers), with sticky sessions or a shared adapter.
 */
const crypto = require("crypto");
const engines = {
  connect4: require("./connectFour"),
  dots: require("./dotsBoxes"),
  hangman: require("./hangman"),
  chess: require("./chess"),
  carrom: require("./carrom"),
};

const GAMES = Object.keys(engines);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class GameError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Only the options each game understands, with safe defaults. */
function cleanOptions(game, options) {
  if (game === "dots") {
    const size = Number(options && options.size);
    return { size: engines.dots.SIZES.includes(size) ? size : 5 };
  }
  if (engines[game].cleanOptions) return engines[game].cleanOptions(options || {});
  return {};
}

class GameRooms {
  /**
   * deps:
   *  emit(userId, event, payload)          deliver to every device of a user
   *  loadUser(id) → {id, username, avatar}  public profile (or null)
   *  canPlay(a, b) → bool                   friends and not blocked
   *  persist(match) → Promise               store a finished match
   *  notifyInvite(toId, invite)             optional push notification
   *  track                                  optional persistence hooks (see sockets/gameHandler.js):
   *    inviteCreated(invite), inviteStatus(inviteId, status, roomId),
   *    matchStarted(match) → Promise<matchId>, matchAction(matchId, seq, playerId, action),
   *    matchEnded(matchId, result)
   */
  constructor(deps, { graceMs = 45000, inviteTtlMs = 60000, finishedIdleMs = 10 * 60000, playingIdleMs = 30 * 60000, readyTimeoutMs = 90000, countdownMs = 3000 } = {}) {
    this.deps = deps;
    this.graceMs = graceMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.countdownMs = countdownMs;
    this.inviteTtlMs = inviteTtlMs;
    this.finishedIdleMs = finishedIdleMs;
    this.playingIdleMs = playingIdleMs;
    this.invites = new Map();
    this.rooms = new Map();
    this.userRooms = new Map();
    this.socketCount = new Map();
    this.graceTimers = new Map(); // `${roomId}:${userId}` → timeout
  }

  // ─── Invitations ────────────────────────────────────────────────────────────

  async invite(fromId, { game, toUserId, options } = {}) {
    if (!GAMES.includes(game)) throw new GameError("invalid_game");
    if (typeof toUserId !== "string" || !UUID_RE.test(toUserId) || toUserId === fromId) throw new GameError("invalid_user");
    if (!(await this.deps.canPlay(fromId, toUserId))) throw new GameError("not_friends");
    const [from, to] = await Promise.all([this.deps.loadUser(fromId), this.deps.loadUser(toUserId)]);
    if (!from || !to) throw new GameError("invalid_user");
    // Already playing this game together: go back to that match instead of starting another
    const active = this.activeRoomBetween(fromId, toUserId, game);
    if (active) {
      const err = new GameError("match_in_progress");
      err.roomId = active.id;
      throw err;
    }

    // One pending invite per pair: a new one replaces the old
    for (const inv of this.invites.values()) {
      if (inv.from.id === fromId && inv.to.id === toUserId) this.dropInvite(inv, "canceled");
    }
    if ([...this.invites.values()].filter((i) => i.from.id === fromId).length >= 5) throw new GameError("too_many_invites");
    // Game availability, premium options and the global daily limit (services/gameEntitlements.js)
    if (this.deps.authorizeInvite) {
      const denied = await this.deps.authorizeInvite(fromId, game, cleanOptions(game, options));
      if (denied) throw new GameError(denied);
    }

    const invite = {
      id: crypto.randomUUID(),
      game,
      options: cleanOptions(game, options),
      from,
      to,
      expiresAt: Date.now() + this.inviteTtlMs,
    };
    invite.timer = setTimeout(() => this.dropInvite(invite, "expired"), this.inviteTtlMs);
    invite.timer.unref?.();
    this.invites.set(invite.id, invite);
    invite.saved = this.track("inviteCreated", publicInvite(invite));
    this.deps.emit(toUserId, "game:invited", publicInvite(invite));
    if (this.deps.notifyInvite) this.deps.notifyInvite(toUserId, publicInvite(invite));
    return publicInvite(invite);
  }

  dropInvite(invite, status, extra = {}) {
    if (!this.invites.delete(invite.id)) return;
    this.closeInvite(invite, status, extra);
  }

  /** Tells both sides an invitation is over (it is already out of the pending map). */
  closeInvite(invite, status, extra = {}) {
    clearTimeout(invite.timer);
    // After the insert, so a fast answer can't be written before the invitation exists
    Promise.resolve(invite.saved).then(() => this.track("inviteStatus", invite.id, status, extra.roomId || null));
    const payload = { inviteId: invite.id, game: invite.game, status, ...extra };
    this.deps.emit(invite.from.id, "game:invite:update", payload);
    this.deps.emit(invite.to.id, "game:invite:update", payload);
  }

  cancelInvite(userId, { inviteId } = {}) {
    const invite = this.invites.get(inviteId);
    if (!invite || invite.from.id !== userId) throw new GameError("invite_not_found");
    this.dropInvite(invite, "canceled");
    return { ok: true };
  }

  pendingInvitesFor(userId) {
    return [...this.invites.values()].filter((i) => i.to.id === userId).map(publicInvite);
  }

  async respond(userId, { inviteId, accept } = {}) {
    const invite = this.invites.get(inviteId);
    if (!invite || invite.to.id !== userId) throw new GameError("invite_not_found");
    if (!accept) {
      this.dropInvite(invite, "declined");
      return { ok: true };
    }
    // Claim the invitation first: a second accept (double tap, two devices) finds nothing
    this.invites.delete(invite.id);
    // The match counts against the inviter's daily limit (atomic; accepting is always free)
    if (this.deps.consumeMatch) {
      const charge = await this.deps.consumeMatch(invite.from.id);
      if (!charge.ok) {
        this.closeInvite(invite, "canceled", { reason: "inviter_limit" });
        throw new GameError("inviter_limit");
      }
    }
    const room = this.createRoom(invite.game, invite.options, [invite.from, invite.to]);
    this.closeInvite(invite, "accepted", { roomId: room.id });
    this.broadcast(room);
    return { ok: true, roomId: room.id };
  }

  track(hook, ...args) {
    const fn = this.deps.track && this.deps.track[hook];
    if (!fn) return undefined;
    try {
      return Promise.resolve(fn(...args)).catch((err) => console.error(`[Games] ${hook} failed:`, err.message));
    } catch (err) {
      console.error(`[Games] ${hook} failed:`, err.message);
      return undefined;
    }
  }

  activeRoomBetween(a, b, game) {
    for (const id of this.userRooms.get(a) || []) {
      const r = this.rooms.get(id);
      if (r && r.game === game && !["over", "cancelled"].includes(r.status) && r.players.some((p) => p.id === b) && !r.players.some((p) => p.left)) return r;
    }
    return null;
  }

  // ─── Rooms ──────────────────────────────────────────────────────────────────

  createRoom(game, options, players) {
    const room = {
      id: crypto.randomUUID(),
      game,
      options,
      players: players.map((p) => ({ id: p.id, username: p.username, avatar: p.avatar || "", connected: this.isConnected(p.id), left: false })),
      status: "playing",
      state: null,
      seq: 0,
      result: null,
      rematch: [false, false],
      tally: [0, 0, 0], // wins of player 0, wins of player 1, draws — across rematches in this room
      matchNo: 0,
      // Who moves first in match 0 (chess: inviter's colour choice; carrom: a coin toss)
      firstOffset: firstOffset(game, options),
      ready: [false, false],
      startsAt: null,
      timers: {},
      matchId: null, // database row of the current match (a promise until inserted)
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: null,
      lastActivity: Date.now(),
    };
    this.startMatch(room);
    this.rooms.set(room.id, room);
    for (const p of room.players) {
      if (!this.userRooms.has(p.id)) this.userRooms.set(p.id, new Set());
      this.userRooms.get(p.id).add(room.id);
    }
    return room;
  }

  /** Fresh game state; the first player alternates between rematches. */
  startMatch(room) {
    const engine = engines[room.game];
    const first = (room.matchNo + room.firstOffset) % 2;
    const state = engine.create(room.options, first);
    state.turn = first;
    if (room.game === "hangman") state.setter = first;
    room.state = state;
    room.result = null;
    room.rematch = [false, false];
    room.ready = [false, false];
    room.startsAt = null;
    room.endedAt = null;
    room.startedAt = Date.now();
    room.lastActivity = Date.now();
    room.seq += 1;
    this.clearTimer(room, "deadline");
    this.clearTimer(room, "countdown");
    if (engine.needsReady) {
      // Both players must open the match (and stay connected) before anything starts
      room.status = "waiting";
      this.armTimer(room, "readyTimeout", this.readyTimeoutMs, () => this.cancelRoom(room, "not_started"));
    } else {
      room.status = "playing";
    }
    room.matchId = this.track("matchStarted", this.matchInfo(room));
  }

  matchInfo(room) {
    return {
      game: room.game,
      roomId: room.id,
      matchNo: room.matchNo,
      playerA: room.players[0].id,
      playerB: room.players[1].id,
      options: room.options,
      status: room.status === "waiting" ? "waiting_for_players" : "in_progress",
      startedAt: new Date(room.startedAt),
    };
  }

  // ─── Timers ─────────────────────────────────────────────────────────────────

  armTimer(room, name, ms, fn) {
    this.clearTimer(room, name);
    const t = setTimeout(() => {
      delete room.timers[name];
      if (this.rooms.get(room.id) === room) fn();
    }, Math.max(0, ms));
    t.unref?.();
    room.timers[name] = t;
  }

  clearTimer(room, name) {
    if (room.timers && room.timers[name]) {
      clearTimeout(room.timers[name]);
      delete room.timers[name];
    }
  }

  /** Re-arms the engine's deadline (chess flag fall, carrom shot clock) after every change. */
  scheduleDeadline(room) {
    this.clearTimer(room, "deadline");
    const engine = engines[room.game];
    if (room.status !== "playing" || !engine.deadline) return;
    const at = engine.deadline(room.state);
    if (at === null || at === undefined) return;
    this.armTimer(room, "deadline", at - Date.now() + 5, () => {
      if (room.status !== "playing") return;
      if (engine.onDeadline(room.state, Date.now())) {
        room.seq += 1;
        room.lastActivity = Date.now();
        if (room.state.winner !== null) this.finish(room, room.state.winner, room.state.endReason || "normal");
        this.broadcast(room);
      }
      this.scheduleDeadline(room);
    });
  }

  // ─── Ready / start ──────────────────────────────────────────────────────────

  /** A player has the match open. When both are ready and connected, a short countdown starts. */
  ready(userId, { roomId } = {}) {
    const { room, idx } = this.roomFor(userId, roomId);
    if (room.status !== "waiting" && room.status !== "ready") return { status: room.status };
    if (!room.ready[idx]) {
      room.ready[idx] = true;
      room.seq += 1;
      room.lastActivity = Date.now();
      this.maybeCountdown(room);
      this.broadcast(room);
    }
    return { status: room.status };
  }

  maybeCountdown(room) {
    if (room.status !== "waiting") return;
    if (!room.ready.every(Boolean) || !room.players.every((p) => p.connected && !p.left)) return;
    room.status = "ready";
    room.startsAt = Date.now() + this.countdownMs;
    this.armTimer(room, "countdown", this.countdownMs, () => this.begin(room));
  }

  begin(room) {
    if (room.status !== "ready") return;
    this.clearTimer(room, "readyTimeout");
    const now = Date.now();
    room.status = "playing";
    room.startedAt = now;
    room.startsAt = null;
    room.seq += 1;
    room.lastActivity = now;
    if (engines[room.game].start) engines[room.game].start(room.state, now);
    const matchId = room.matchId;
    Promise.resolve(matchId).then((id) => id && this.track("matchStatus", id, "in_progress", new Date(now)));
    this.scheduleDeadline(room);
    this.broadcast(room);
  }

  /** Nobody started the match in time, or a player left before it began. No winner, no result. */
  cancelRoom(room, reason) {
    if (room.status !== "waiting" && room.status !== "ready") return;
    this.clearTimer(room, "countdown");
    this.clearTimer(room, "readyTimeout");
    room.status = "cancelled";
    room.result = { winner: null, reason };
    room.endedAt = Date.now();
    room.seq += 1;
    room.lastActivity = Date.now();
    Promise.resolve(room.matchId).then((id) => id && this.track("matchEnded", id, { status: "cancelled", winnerId: null, reason, scoreA: 0, scoreB: 0, moves: 0, detail: {} }));
    this.broadcast(room);
  }

  roomFor(userId, roomId) {
    const room = typeof roomId === "string" ? this.rooms.get(roomId) : null;
    const idx = room ? room.players.findIndex((p) => p.id === userId) : -1;
    if (!room || idx < 0) throw new GameError("room_not_found");
    return { room, idx };
  }

  move(userId, { roomId, seq, move } = {}) {
    const { room, idx } = this.roomFor(userId, roomId);
    if (room.status === "waiting" || room.status === "ready") throw new GameError("not_started");
    if (room.status !== "playing") throw new GameError("game_over");
    if (room.players[idx].left) throw new GameError("room_not_found");
    // seq is the state version the client saw: a stale or repeated move is rejected
    if (seq !== room.seq) throw new GameError("stale_state");
    const engine = engines[room.game];
    const error = engine.applyMove(room.state, idx, move, Date.now());
    if (error) throw new GameError(error);
    room.seq += 1;
    room.lastActivity = Date.now();
    if (engine.describe) {
      const action = engine.describe(room.state, idx, move);
      const seqNo = room.seq;
      const playerId = room.players[idx].id;
      Promise.resolve(room.matchId).then((id) => id && this.track("matchAction", id, seqNo, playerId, action));
    }
    if (room.state.winner !== null) this.finish(room, room.state.winner, room.state.endReason || "normal");
    else this.scheduleDeadline(room);
    this.broadcast(room);
    return { ok: true, seq: room.seq };
  }

  finish(room, winner, reason) {
    this.clearTimer(room, "deadline");
    room.status = "over";
    room.result = { winner, reason };
    room.endedAt = Date.now();
    room.lastActivity = Date.now();
    room.tally[winner === "draw" ? 2 : winner] += 1;
    const [a, b] = room.players;
    const engine = engines[room.game];
    const score = engine.scores(room.state);
    const ended = {
      status: "completed",
      winnerId: winner === "draw" ? null : room.players[winner].id,
      reason,
      scoreA: score[0],
      scoreB: score[1],
      moves: room.state.moves,
      detail: engine.summary ? engine.summary(room.state) : {},
      durationMs: room.endedAt - room.startedAt,
    };
    if (this.deps.track && this.deps.track.matchEnded) {
      Promise.resolve(room.matchId).then((id) => id && this.track("matchEnded", id, ended));
      return;
    }
    Promise.resolve(
      this.deps.persist({
        game: room.game,
        roomId: room.id,
        playerA: a.id,
        playerB: b.id,
        winnerId: winner === "draw" ? null : room.players[winner].id,
        reason,
        scoreA: score[0],
        scoreB: score[1],
        moves: room.state.moves,
        options: room.options,
        startedAt: new Date(room.startedAt),
      })
    ).catch((err) => console.error("[Games] failed to save match:", err.message));
  }

  async rematch(userId, { roomId } = {}) {
    const { room, idx } = this.roomFor(userId, roomId);
    if (room.status !== "over") throw new GameError("game_not_over");
    if (room.players.some((p) => p.left)) throw new GameError("opponent_left");
    if (room.rematch[idx]) return { ok: true };
    // A rematch is a new match: it counts for whoever asked first (checked now, charged when agreed)
    if (!room.rematch[1 - idx]) {
      if (this.deps.canCreateMatch && !(await this.deps.canCreateMatch(userId))) throw new GameError("daily_limit");
      room.rematchBy = idx;
    }
    room.rematch[idx] = true;
    room.lastActivity = Date.now();
    if (room.rematch.every(Boolean)) {
      if (this.deps.consumeMatch) {
        const payer = room.players[room.rematchBy ?? idx].id;
        const charge = await this.deps.consumeMatch(payer);
        if (!charge.ok) {
          room.rematch = [false, false];
          room.seq += 1;
          this.broadcast(room);
          throw new GameError("inviter_limit");
        }
      }
      room.matchNo += 1;
      this.startMatch(room);
      // Both just asked for the rematch from the result screen, so both are already here
      if (room.status === "waiting") {
        room.ready = room.players.map((p) => p.connected);
        this.maybeCountdown(room);
      }
    } else {
      room.seq += 1;
    }
    this.broadcast(room);
    return { ok: true };
  }

  leave(userId, { roomId } = {}) {
    const { room, idx } = this.roomFor(userId, roomId);
    if (room.status === "playing") this.finish(room, 1 - idx, "left");
    else if (room.status === "waiting" || room.status === "ready") this.cancelRoom(room, "left");
    room.players[idx].left = true;
    room.rematch[idx] = false;
    room.seq += 1;
    this.clearGrace(room.id, userId);
    this.userRooms.get(userId)?.delete(room.id);
    this.broadcast(room);
    if (room.players.every((p) => p.left)) this.deleteRoom(room);
    return { ok: true };
  }

  sync(userId, { roomId } = {}) {
    if (roomId) {
      const { room } = this.roomFor(userId, roomId);
      return { room: this.viewFor(room, userId) };
    }
    const rooms = [...(this.userRooms.get(userId) || [])].map((id) => this.rooms.get(id)).filter(Boolean);
    return { rooms: rooms.map((r) => this.viewFor(r, userId)), invites: this.pendingInvitesFor(userId) };
  }

  viewFor(room, userId) {
    const you = room.players.findIndex((p) => p.id === userId);
    const now = Date.now();
    return {
      roomId: room.id,
      game: room.game,
      options: room.options,
      players: room.players.map(({ id, username, avatar, connected, left }) => ({ id, username, avatar, connected, left })),
      you,
      status: room.status,
      seq: room.seq,
      state: engines[room.game].view(room.state, you, now),
      result: room.result,
      rematch: room.rematch.slice(),
      tally: room.tally.slice(),
      phase: PHASES[room.status],
      ready: room.ready.slice(),
      matchNo: room.matchNo,
      // Relative times, so device clocks don't have to match the server's
      startsIn: room.startsAt ? Math.max(0, room.startsAt - now) : null,
      elapsedMs: room.status === "playing" ? now - room.startedAt : room.endedAt && room.status === "over" ? room.endedAt - room.startedAt : 0,
    };
  }

  /** Each player gets their own view (Hangman hides the secret word from the guesser). */
  broadcast(room) {
    for (const p of room.players) if (!p.left) this.deps.emit(p.id, "game:state", this.viewFor(room, p.id));
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  /** Rooms that are not finished (for the admin control center). */
  listLive() {
    return [...this.rooms.values()]
      .filter((r) => !["over", "cancelled"].includes(r.status))
      .map((r) => ({
        roomId: r.id,
        game: r.game,
        status: r.status,
        phase: PHASES[r.status],
        matchNo: r.matchNo,
        players: r.players.map(({ id, username, connected, left }) => ({ id, username, connected, left })),
        startedAt: new Date(r.startedAt).toISOString(),
        moves: r.state && typeof r.state.moves === "number" ? r.state.moves : 0,
      }));
  }

  /** Stops a live match without a winner (moderation). */
  adminCancel(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || ["over", "cancelled"].includes(room.status)) throw new GameError("room_not_found");
    for (const name of Object.keys(room.timers || {})) this.clearTimer(room, name);
    const wasPlaying = room.status === "playing";
    room.status = "cancelled";
    room.result = { winner: null, reason: "admin_cancelled" };
    room.endedAt = Date.now();
    room.seq += 1;
    room.lastActivity = Date.now();
    const durationMs = wasPlaying ? room.endedAt - room.startedAt : 0;
    Promise.resolve(room.matchId).then((id) => id && this.track("matchEnded", id, { status: "cancelled", winnerId: null, reason: "admin_cancelled", scoreA: 0, scoreB: 0, moves: room.state?.moves || 0, detail: {}, durationMs }));
    this.broadcast(room);
    return { ok: true };
  }

  /** Live aim of the player to move (carrom), relayed to the opponent only — never stored. */
  aim(userId, { roomId, x, dx, dy, power } = {}) {
    const { room, idx } = this.roomFor(userId, roomId);
    if (room.game !== "carrom" || room.status !== "playing" || room.state.turn !== idx) throw new GameError("not_your_turn");
    if (![x, dx, dy, power].every((v) => typeof v === "number" && Number.isFinite(v))) throw new GameError("invalid_shot");
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const aim = { roomId: room.id, by: idx, x: clamp(x, 0, 740), dx: clamp(dx, -1, 1), dy: clamp(dy, -1, 1), power: clamp(power, 0, 1), shot: room.state.shots };
    const other = room.players[1 - idx];
    if (!other.left) this.deps.emit(other.id, "game:aim", aim);
    return {};
  }

  deleteRoom(room) {
    for (const name of Object.keys(room.timers || {})) this.clearTimer(room, name);
    this.rooms.delete(room.id);
    for (const p of room.players) {
      this.userRooms.get(p.id)?.delete(room.id);
      this.clearGrace(room.id, p.id);
    }
  }

  // ─── Connections ────────────────────────────────────────────────────────────

  isConnected(userId) {
    return (this.socketCount.get(userId) || 0) > 0;
  }

  connected(userId) {
    const n = (this.socketCount.get(userId) || 0) + 1;
    this.socketCount.set(userId, n);
    if (n > 1) return;
    for (const roomId of this.userRooms.get(userId) || []) {
      const room = this.rooms.get(roomId);
      if (!room) continue;
      this.clearGrace(roomId, userId);
      const p = room.players.find((x) => x.id === userId);
      if (p && !p.connected) {
        p.connected = true;
        room.seq += 1;
        this.maybeCountdown(room);
        this.broadcast(room);
      }
    }
  }

  /** Last socket of a user gone: the opponent is told, and a running game is forfeited after the grace period. */
  disconnected(userId) {
    const n = Math.max(0, (this.socketCount.get(userId) || 0) - 1);
    if (n > 0) return this.socketCount.set(userId, n);
    this.socketCount.delete(userId);
    for (const roomId of this.userRooms.get(userId) || []) {
      const room = this.rooms.get(roomId);
      if (!room) continue;
      const idx = room.players.findIndex((x) => x.id === userId);
      room.players[idx].connected = false;
      room.seq += 1;
      if (room.status === "waiting" || room.status === "ready") {
        // Not started yet: drop back to waiting; the player re-sends game:ready when back
        room.ready[idx] = false;
        if (room.status === "ready") {
          this.clearTimer(room, "countdown");
          room.status = "waiting";
          room.startsAt = null;
        }
      }
      this.broadcast(room);
      if (room.status !== "playing") continue;
      const key = `${roomId}:${userId}`;
      const timer = setTimeout(() => {
        this.graceTimers.delete(key);
        const current = this.rooms.get(roomId);
        if (current && current.status === "playing" && !current.players[idx].connected) {
          this.finish(current, 1 - idx, "disconnected");
          current.seq += 1;
          this.broadcast(current);
        }
      }, this.graceMs);
      timer.unref?.();
      this.graceTimers.set(key, timer);
    }
  }

  clearGrace(roomId, userId) {
    const key = `${roomId}:${userId}`;
    clearTimeout(this.graceTimers.get(key));
    this.graceTimers.delete(key);
  }

  /** Removes finished rooms nobody touched for a while and running games abandoned by both players. */
  sweep(now = Date.now()) {
    for (const room of [...this.rooms.values()]) {
      const idle = now - room.lastActivity;
      const nobodyHere = room.players.every((p) => !p.connected || p.left);
      if ((room.status === "over" || room.status === "cancelled") && idle > this.finishedIdleMs) this.deleteRoom(room);
      else if (room.status === "playing" && idle > this.playingIdleMs && nobodyHere) this.deleteRoom(room);
    }
  }
}

const PHASES = { waiting: "WAITING_FOR_PLAYERS", ready: "READY", playing: "IN_PROGRESS", over: "COMPLETED", cancelled: "CANCELLED" };

/** Seat that moves first in the first match of a room. */
function firstOffset(game, options) {
  if (game === "chess") {
    if (options.color === "white") return 0;
    if (options.color === "black") return 1;
    return crypto.randomInt(2);
  }
  if (game === "carrom") return crypto.randomInt(2); // toss for the break
  return 0;
}

// expiresIn (ms) lets clients count down without trusting that their clock matches the server's
const publicInvite = (i) => ({ inviteId: i.id, game: i.game, options: i.options, from: i.from, to: i.to, expiresAt: i.expiresAt, expiresIn: Math.max(0, i.expiresAt - Date.now()) });

module.exports = { GameRooms, GameError, GAMES, engines };
