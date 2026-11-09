const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const agoraService = require("../services/agoraService");
const { sendVoipNotification } = require("../services/pushNotificationService");

/**
 * In-memory map: userId (string) → Set of socketIds — a user can be online on several devices at once.
 * Every socket of a user also joins userRoom(userId), so emits reach all of that user's devices.
 * For multi-server deployments, replace this with Redis.
 */
const onlineUsers = new Map();

const userRoom = (userId) => `user:${userId}`;

/**
 * In-memory map: channelName (string) → { callerId, receiverId, callType }
 * Tracks active calls so we always have the authoritative channel name.
 */
const activeCalls = new Map();

const initializeSocket = (io) => {
  // Every socket must present the same JWT the REST API uses (sent by the app as auth.token).
  // The verified id — never a client-supplied one — identifies the user.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication required"));
      socket.authUserId = jwt.verify(token, process.env.JWT_SECRET).id;
      next();
    } catch (error) {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);
    // The token is already verified, so deliveries start immediately; "userOnline" only adds presence
    socket.join(userRoom(socket.authUserId));

    // ─── USER COMES ONLINE ───────────────────────────────────────────────────
    socket.on("userOnline", async (claimedUserId) => {
      const userId = socket.authUserId;
      if (claimedUserId && claimedUserId !== userId) {
        console.warn(`⚠️ [Online] Socket ${socket.id} claimed ${claimedUserId} but token is for ${userId}`);
      }

      let sockets = onlineUsers.get(userId);
      if (!sockets) onlineUsers.set(userId, (sockets = new Set()));
      sockets.add(socket.id);
      socket.join(userRoom(userId));
      socket.userId = userId;

      console.log(`👤 [Online] ${userId} → socket ${socket.id} (${sockets.size} device(s))`);
      console.log(`📋 [Online] Users connected: ${onlineUsers.size}`);

      io.emit("onlineUsers", Array.from(onlineUsers.keys()));

      try {
        await User.update(userId, { isOnline: true });
      } catch (err) {
        console.error("Failed to update online status:", err.message);
      }
    });

    // ─── MESSAGES ────────────────────────────────────────────────────────────
    // Handle both "sendMessage" and "send_message" — client uses "send_message"
    // Real-time delivery is handled by messageController when a message is saved through the API.
    // This fallback only re-sends a message that is already stored, was sent by this socket's
    // verified user, and goes to a participant of its conversation — never client-supplied content.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const handleSendMessage = async ({ receiverId, message } = {}) => {
      const userId = socket.authUserId;
      const messageId = message?._id;
      if (!receiverId || typeof messageId !== "string" || !UUID_RE.test(messageId)) return;
      try {
        const row = await Message.findById(messageId);
        if (!row || row.sender_id !== userId) return;
        const conversation = await Conversation.findForUser(row.conversation_id, userId);
        if (!conversation || !(await Conversation.memberIds(conversation.id)).includes(receiverId)) return;
        io.to(userRoom(receiverId)).emit("receiveMessage", { message: await Message.getFull(messageId) });
      } catch (err) {
        console.error("Socket message relay failed:", err.message);
      }
    };

    socket.on("sendMessage", handleSendMessage);
    socket.on("send_message", handleSendMessage);

    // Members of a conversation, cached briefly per socket so typing events don't hit the DB each keystroke
    const memberCache = new Map();
    const membersOf = async (conversationId) => {
      const hit = memberCache.get(conversationId);
      if (hit && Date.now() - hit.at < 60000) return hit.ids;
      const conv = await Conversation.findForUser(conversationId, socket.authUserId);
      const ids = conv ? await Conversation.memberIds(conversationId) : null;
      memberCache.set(conversationId, { at: Date.now(), ids });
      return ids;
    };
    const toOtherMembers = async (conversationId, event, payload) => {
      if (typeof conversationId !== "string" || !UUID_RE.test(conversationId)) return;
      const ids = await membersOf(conversationId);
      if (!ids) return;
      for (const id of ids) if (id !== socket.authUserId) io.to(userRoom(id)).emit(event, payload);
    };

    // Reader marks a conversation read; everyone else in it is told (works for direct chats and groups)
    socket.on("markMessagesSeen", async ({ conversationId, senderId } = {}) => {
      const readerId = socket.authUserId;
      if (!readerId || typeof conversationId !== "string" || !UUID_RE.test(conversationId)) return;
      try {
        if (!(await Conversation.findForUser(conversationId, readerId))) return;
        const updated = await Message.markRead(conversationId, readerId, senderId && UUID_RE.test(senderId) ? senderId : null);
        await toOtherMembers(conversationId, "messagesSeen", {
          conversationId,
          messageIds: updated.map((m) => m.id),
          seenBy: readerId,
          seenAt: new Date(),
        });
      } catch (err) {
        console.error("Failed to mark messages as seen:", err.message);
      }
    });

    // Recipient's device acknowledges receipt → senders see "delivered"
    socket.on("messagesDelivered", async ({ messageIds } = {}) => {
      if (!Array.isArray(messageIds)) return;
      const ids = messageIds.filter((id) => typeof id === "string" && UUID_RE.test(id)).slice(0, 200);
      try {
        const updated = await Message.markDelivered(ids, socket.authUserId);
        const bySender = new Map();
        for (const m of updated) (bySender.get(m.senderId) || bySender.set(m.senderId, []).get(m.senderId)).push(m);
        for (const [sender, list] of bySender) {
          io.to(userRoom(sender)).emit("messagesDelivered", {
            messageIds: list.map((m) => m.id),
            conversationId: list[0].conversationId,
            deliveredTo: socket.authUserId,
            deliveredAt: new Date(),
          });
        }
      } catch (err) {
        console.error("Failed to mark delivered:", err.message);
      }
    });

    // ─── TYPING ──────────────────────────────────────────────────────────────
    // Only relayed to the other members of a conversation the sender belongs to
    socket.on("typing", ({ conversationId } = {}) => {
      toOtherMembers(conversationId, "userTyping", { senderId: socket.authUserId, conversationId }).catch(() => {});
    });
    socket.on("stopTyping", ({ conversationId } = {}) => {
      toOtherMembers(conversationId, "userStoppedTyping", { senderId: socket.authUserId, conversationId }).catch(() => {});
    });

    // ─── CALL SIGNALING ──────────────────────────────────────────────────────

    /**
     * Step 1: Caller initiates a call.
     * The SERVER generates the authoritative channelName to prevent mismatches.
     * Payload: { receiverId, callType: "audio"|"video", callerName? }
     */
    socket.on("initiate_call", async ({ receiverId, callType, callerName }) => {
      if (process.env.CALLS_ENABLED !== "true") {
        socket.emit("call_error", { message: "Calls are currently disabled" });
        return;
      }

      const callerId = socket.userId;

      if (!callerId) {
        socket.emit("call_error", { message: "You are not authenticated" });
        return;
      }

      console.log(`📞 [Call] initiate_call from ${callerId} → ${receiverId} (${callType})`);

      // SERVER generates the channel name — single source of truth
      const channelName = `ch_${callerId.slice(-8)}_${receiverId.slice(-8)}_${Date.now().toString(36)}`;

      // Store the active call
      activeCalls.set(channelName, { callerId, receiverId, callType });

      console.log(`📡 [Call] Channel created: ${channelName}`);

      // Notify receiver via socket if they happen to be online
      io.to(userRoom(receiverId)).emit("incomingCall", {
        callerId,
        callerName: callerName || "User",
        channelName,
        callType,
      });

      // Trigger Native VoIP Push (wakes up killed/backgrounded apps)
      try {
        const receiverUser = await User.findById(receiverId);
        if (receiverUser) {
          await sendVoipNotification({
            user: receiverUser,
            callerName: callerName || "User",
            callType,
            uuid: channelName, // Using channelName as the Call UUID
          });
        }
      } catch (err) {
        console.error("Failed to fetch receiver for VoIP push:", err);
      }

      // Confirm to caller
      socket.emit("call_initiated", { receiverId, channelName, callType });
    });

    /**
     * Step 2: Receiver accepts the call.
     * Backend generates & broadcasts Agora tokens to BOTH parties with the SAME channelName.
     * Payload: { callerId, channelName }
     */
    socket.on("accept_call", ({ callerId, channelName }) => {
      const receiverId = socket.userId;

      console.log(`✅ [Call] accept_call for channel: ${channelName} by ${receiverId}`);

      if (!onlineUsers.has(callerId)) {
        socket.emit("call_error", { message: "Caller is no longer online" });
        return;
      }

      try {
        // Generate tokens for SAME channel, different UIDs
        const callerToken = agoraService.getRtcToken(channelName, 1);
        const receiverToken = agoraService.getRtcToken(channelName, 2);

        console.log(`🎫 [Agora] Tokens generated for channel: ${channelName}`);
        console.log(`   Caller UID: 1, Receiver UID: 2`);

        // Send to Caller (uid=1)
        io.to(userRoom(callerId)).emit("call_joined", {
          channelName,
          token: callerToken.token,
          uid: 1,
          appId: callerToken.appId,
          otherUserId: receiverId,
          callType: activeCalls.get(channelName)?.callType || "audio",
        });

        // Send to Receiver (uid=2)
        socket.emit("call_joined", {
          channelName,
          token: receiverToken.token,
          uid: 2,
          appId: receiverToken.appId,
          otherUserId: callerId,
          callType: activeCalls.get(channelName)?.callType || "audio",
        });

        console.log(`🚀 [Call] call_joined emitted to both parties. Channel: ${channelName}`);
      } catch (error) {
        console.error("[Agora] Token generation FAILED:", error.message);
        socket.emit("call_error", { message: "Failed to generate Agora token" });
        io.to(userRoom(callerId)).emit("call_error", { message: "Failed to generate Agora token" });
      }
    });

    /**
     * Step 3a: Receiver rejects the call.
     * Payload: { callerId, channelName }
     */
    socket.on("reject_call", ({ callerId, channelName }) => {
      activeCalls.delete(channelName);
      io.to(userRoom(callerId)).emit("call_rejected", { receiverId: socket.userId });
      console.log(`🚫 [Call] Rejected: ${socket.userId} → ${callerId}`);
    });

    /**
     * Step 4: Either party ends the call.
     * Payload: { otherUserId, channelName }
     */
    socket.on("end_call", ({ otherUserId, channelName }) => {
      activeCalls.delete(channelName);

      console.log(`🏁 [Call] end_call from ${socket.userId}, channel: ${channelName}`);

      io.to(userRoom(otherUserId)).emit("call_ended", { channelName });
      socket.emit("call_ended", { channelName });
    });

    // ─── DISCONNECT ──────────────────────────────────────────────────────────
    socket.on("disconnect", async () => {
      // The user stays online while any other device (or a newer reconnect) still has a socket open
      const sockets = socket.userId && onlineUsers.get(socket.userId);
      if (sockets && sockets.delete(socket.id) && sockets.size === 0) {
        onlineUsers.delete(socket.userId);
        io.emit("onlineUsers", Array.from(onlineUsers.keys()));

        try {
          await User.update(socket.userId, {
            isOnline: false,
            lastSeen: new Date(),
          });
        } catch (err) {
          console.error("Failed to update offline status:", err.message);
        }

        console.log(`❌ [Disconnect] ${socket.userId} offline. Total: ${onlineUsers.size}`);
      }
    });
  });
};

module.exports = { initializeSocket, onlineUsers, userRoom };
