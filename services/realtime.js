/**
 * Socket.IO fan-out helpers. Every user joins the room `user:<id>` on connect
 * (sockets/socketHandler.js), so emitting to a user reaches all their devices.
 *
 * Scale-out note: with more than one API process, attach @socket.io/redis-adapter;
 * these helpers then work unchanged across processes.
 */
const Conversation = require("../models/Conversation");

let ioRef = null;
const setIo = (io) => {
  ioRef = io;
};
const getIo = () => ioRef;

const userRoom = (userId) => `user:${userId}`;

function emitToUsers(userIds, event, payload, { skip = null } = {}) {
  if (!ioRef) return;
  for (const id of new Set(userIds.map(String))) {
    if (skip && id === String(skip)) continue;
    ioRef.to(userRoom(id)).emit(event, payload);
  }
}

async function emitToConversation(conversationId, event, payload, opts = {}) {
  if (!ioRef) return;
  emitToUsers(await Conversation.memberIds(conversationId), event, payload, opts);
}

module.exports = { setIo, getIo, userRoom, emitToUsers, emitToConversation };
