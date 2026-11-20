/**
 * Socket.IO wiring for multiplayer mini games. Uses the app's single authenticated socket
 * (socket.authUserId comes from the verified JWT); all game logic is in services/games/rooms.js.
 *
 * Client → server (every event takes an ack callback that receives { ok, ... } or { ok: false, error }):
 *   game:invite          { game, toUserId, options }
 *   game:invite:cancel   { inviteId }
 *   game:invite:respond  { inviteId, accept }
 *   game:move            { roomId, seq, move }
 *   game:rematch         { roomId }
 *   game:leave           { roomId }
 *   game:sync            { roomId? }
 *   game:ready           { roomId }               (chess / carrom: this player has the match open)
 *   game:aim             { roomId, x, dx, dy, power }  (carrom live aim, relayed, not stored)
 * Server → client:
 *   game:invited         invite                   (to the invited friend)
 *   game:invite:update   { inviteId, status, roomId? }
 *   game:state           room view for that player
 *   game:aim             { roomId, by, x, dx, dy, power, shot }  (opponent's live aim)
 */
const User = require("../models/User");
const FriendRequest = require("../models/FriendRequest");
const Block = require("../models/Block");
const GameMatch = require("../models/GameMatch");
const GameInvitation = require("../models/GameInvitation");
const { notify } = require("../services/notifications");
const { GameRooms, GameError } = require("../services/games/rooms");
const access = require("../services/gameEntitlements");

const GAME_NAMES = { connect4: "Connect Four", dots: "Dots & Boxes", hangman: "Hangman", chess: "Chess", carrom: "Carrom" };

let rooms = null;

function createGameRooms(io, options = {}) {
  const userRoom = (id) => `user:${id}`;
  return new GameRooms(
    {
      emit: (userId, event, payload) => io.to(userRoom(userId)).emit(event, payload),
      loadUser: async (id) => {
        const u = await User.findById(id);
        return u && { id: String(u._id), username: u.username, avatar: u.avatar || "" };
      },
      canPlay: async (a, b) => (await FriendRequest.areFriends(a, b)) && !(await Block.between(a, b)),
      persist: (match) => GameMatch.record(match),
      // One Games Lifetime entitlement + one global daily limit for every game
      authorizeInvite: (userId, game, options) => access.authorizeOnlineInvite(userId, game, options),
      consumeMatch: (userId) => access.consumeMatchCreation(userId),
      canCreateMatch: async (userId) => (await access.hasGamesLifetime(userId)) || (await access.quotaFor(userId)).remaining > 0,
      track: {
        inviteCreated: (invite) => GameInvitation.create(invite),
        inviteStatus: (id, status, roomId) => GameInvitation.setStatus(id, status, roomId),
        matchStarted: (match) => GameMatch.start(match),
        matchStatus: (id, status, startedAt) => GameMatch.setStatus(id, status, startedAt),
        matchAction: (id, seq, playerId, action) => GameMatch.addAction(id, seq, playerId, action),
        matchEnded: (id, result) => GameMatch.end(id, result),
      },
      notifyInvite: (toId, invite) =>
        notify([toId], {
          type: "game_invite",
          title: `${invite.from.username} challenged you`,
          body: `Play ${GAME_NAMES[invite.game]} in FastChat`,
          data: { inviteId: invite.inviteId, game: invite.game },
          actorId: invite.from.id,
          inApp: false,
        }),
    },
    options
  );
}

function initializeGames(io, options) {
  rooms = createGameRooms(io, options);
  // Rooms live in memory: anything left open by a previous process can't be resumed
  const bootedAt = new Date();
  // Wait for the schema (first start after an upgrade creates these tables)
  require("../config/db")
    .schemaReady.then(() => Promise.all([GameMatch.abandonStale(bootedAt), GameInvitation.expireStale(bootedAt)]))
    .catch((err) => console.error("[Games] cleanup failed:", err.message));
  const sweeper = setInterval(() => rooms.sweep(), 60000);
  sweeper.unref?.();
  return rooms;
}

// Simple per-socket flood guard: at most 20 game events per second
function rateLimited(socket) {
  const now = Date.now();
  if (!socket.gameRate || now - socket.gameRate.at > 1000) socket.gameRate = { at: now, n: 0 };
  return ++socket.gameRate.n > 20;
}

function registerGameHandlers(socket) {
  if (!rooms) return;
  const userId = String(socket.authUserId);
  rooms.connected(userId);

  const handle = (event, fn) => {
    socket.on(event, async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (rateLimited(socket)) return reply({ ok: false, error: "rate_limited" });
      try {
        reply({ ok: true, ...(await fn(payload && typeof payload === "object" ? payload : {})) });
      } catch (error) {
        if (!(error instanceof GameError)) console.error(`[Games] ${event} failed:`, error.message);
        reply({ ok: false, error: error instanceof GameError ? error.code : "server_error", ...(error.roomId ? { roomId: error.roomId } : {}) });
      }
    });
  };

  handle("game:invite", async (p) => ({ invite: await rooms.invite(userId, p) }));
  handle("game:invite:cancel", (p) => rooms.cancelInvite(userId, p));
  handle("game:invite:respond", (p) => rooms.respond(userId, p));
  handle("game:move", (p) => rooms.move(userId, p));
  handle("game:rematch", (p) => rooms.rematch(userId, p));
  handle("game:leave", (p) => rooms.leave(userId, p));
  handle("game:sync", (p) => rooms.sync(userId, p));
  handle("game:ready", (p) => rooms.ready(userId, p));
  handle("game:aim", (p) => rooms.aim(userId, p));

  socket.on("disconnect", () => rooms.disconnected(userId));
}

module.exports = { initializeGames, registerGameHandlers, createGameRooms, getGameRooms: () => rooms };
