const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const agoraService = require("../services/agoraService");
const { sendVoipNotification } = require("../services/pushNotificationService");

/**
 * In-memory map: userId (string) → socketId (string)
 * For multi-server deployments, replace this with Redis.
 */
const onlineUsers = new Map();

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

    // ─── USER COMES ONLINE ───────────────────────────────────────────────────
    socket.on("userOnline", async (claimedUserId) => {
      const userId = socket.authUserId;
      if (claimedUserId && claimedUserId !== userId) {
        console.warn(`⚠️ [Online] Socket ${socket.id} claimed ${claimedUserId} but token is for ${userId}`);
      }

      onlineUsers.set(userId, socket.id);
      socket.userId = userId;

      console.log(`👤 [Online] ${userId} → socket ${socket.id}`);
      console.log(`📋 [Online] All connected: ${JSON.stringify(Array.from(onlineUsers.entries()))}`);

      io.emit("onlineUsers", Array.from(onlineUsers.keys()));

      try {
        await User.update(userId, { isOnline: true });
      } catch (err) {
        console.error("Failed to update online status:", err.message);
      }
    });

    // ─── MESSAGES ────────────────────────────────────────────────────────────
    // Handle both "sendMessage" and "send_message" — client uses "send_message"
    const handleSendMessage = ({ receiverId, message, conversationId: convId }) => {
      // Note: Real-time delivery is primarily handled by messageController via API.
      // This socket handler is a fallback for direct socket sends.
      if (!message) return;
      if (receiverId) {
        const receiverSocketId = onlineUsers.get(receiverId);
        if (receiverSocketId) {
          io.to(receiverSocketId).emit("receiveMessage", { message });
        }
      }
    };

    socket.on("sendMessage", handleSendMessage);
    socket.on("send_message", handleSendMessage);

    // senderId = original message sender (who we notify)
    // seenBy = person who read the messages (same as socket.userId)
    socket.on("markMessagesSeen", async ({ conversationId, senderId, seenBy, messageIds }) => {
      const readerId = socket.userId;
      // Accept senderId from frontend (targetUserId passed explicitly)
      const notifyUserId = senderId || null;

      if (!readerId || !conversationId) return;

      try {
        if (notifyUserId) {
          // Only participants may mark a conversation's messages as read
          if (!(await Conversation.findForUser(conversationId, readerId))) return;
          await Message.markRead(conversationId, readerId, notifyUserId);

          const senderSocketId = onlineUsers.get(notifyUserId);
          if (senderSocketId) {
            io.to(senderSocketId).emit("messagesSeen", {
              conversationId,
              messageIds: messageIds || [],
              seenBy: readerId,
              seenAt: new Date(),
            });
          }
        }
      } catch (err) {
        console.error("Failed to mark messages as seen:", err.message);
      }
    });

    // ─── TYPING ──────────────────────────────────────────────────────────────
    socket.on("typing", ({ receiverId, conversationId }) => {
      const receiverSocketId = onlineUsers.get(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("userTyping", { senderId: socket.userId, conversationId });
      }
    });

    socket.on("stopTyping", ({ receiverId, conversationId }) => {
      const receiverSocketId = onlineUsers.get(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("userStoppedTyping", { senderId: socket.userId, conversationId });
      }
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

      const receiverSocketId = onlineUsers.get(receiverId);
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
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("incomingCall", {
          callerId,
          callerName: callerName || "User",
          channelName,
          callType,
        });
      }

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
      const callerSocketId = onlineUsers.get(callerId);
      const receiverId = socket.userId;

      console.log(`✅ [Call] accept_call for channel: ${channelName} by ${receiverId}`);
      console.log(`🔍 [Call] Caller socket: ${callerSocketId}, Receiver socket: ${socket.id}`);

      if (!callerSocketId) {
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
        io.to(callerSocketId).emit("call_joined", {
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
        io.to(callerSocketId).emit("call_error", { message: "Failed to generate Agora token" });
      }
    });

    /**
     * Step 3a: Receiver rejects the call.
     * Payload: { callerId, channelName }
     */
    socket.on("reject_call", ({ callerId, channelName }) => {
      const callerSocketId = onlineUsers.get(callerId);
      activeCalls.delete(channelName);
      if (callerSocketId) {
        io.to(callerSocketId).emit("call_rejected", { receiverId: socket.userId });
        console.log(`🚫 [Call] Rejected: ${socket.userId} → ${callerId}`);
      }
    });

    /**
     * Step 4: Either party ends the call.
     * Payload: { otherUserId, channelName }
     */
    socket.on("end_call", ({ otherUserId, channelName }) => {
      const otherSocketId = onlineUsers.get(otherUserId);
      activeCalls.delete(channelName);

      console.log(`🏁 [Call] end_call from ${socket.userId}, channel: ${channelName}`);

      if (otherSocketId) {
        io.to(otherSocketId).emit("call_ended", { channelName });
      }
      socket.emit("call_ended", { channelName });
    });

    // ─── DISCONNECT ──────────────────────────────────────────────────────────
    socket.on("disconnect", async () => {
      // Ignore a stale socket closing after the user already reconnected on a new one
      if (socket.userId && onlineUsers.get(socket.userId) === socket.id) {
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

module.exports = { initializeSocket, onlineUsers };
