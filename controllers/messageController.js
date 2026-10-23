const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const User = require("../models/User");
const { saveFile, deleteFileByUrl } = require("../utils/storage");
const { sendPushNotification } = require("../services/pushNotificationService");

/**
 * Emits `event` to every online participant of a conversation except `skipUserId`.
 */
const emitToParticipants = (req, conversation, event, payload, skipUserId = null) => {
  const io = req.app.get("io");
  if (!io) return;
  const { onlineUsers } = require("../sockets/socketHandler");
  for (const participantId of Conversation.participantIds(conversation)) {
    if (participantId === skipUserId) continue;
    const socketId = onlineUsers.get(participantId);
    if (socketId) io.to(socketId).emit(event, payload);
  }
};

/**
 * Sends a push notification about `message` to the other participant(s).
 * Push failure must never break message delivery.
 */
const notifyReceivers = async (conversation, message, senderId) => {
  for (const participantId of Conversation.participantIds(conversation)) {
    // Don't notify the sender
    if (participantId === senderId) continue;

    // ALWAYS send push — even if the receiver has an active socket.
    // A connected socket does NOT mean the user is looking at the app: on mobile
    // the socket stays alive in the background. The app suppresses the banner
    // itself when the user is already inside this chat.
    try {
      const receiver = await User.findById(participantId);
      if (!receiver?.expoPushToken) {
        console.log(`[Push] No push token for user ${participantId} — skipping.`);
        continue;
      }

      const senderName = message.senderId?.username || "Someone";
      const notificationBody = message.text
        ? `${senderName}: ${message.text.slice(0, 100)}`
        : `${senderName} sent ${
            message.fileType === "image"
              ? "a photo"
              : message.fileType === "video"
              ? "a video"
              : message.fileType === "audio"
              ? "a voice message"
              : "a file"
          }`;

      await sendPushNotification({
        to: receiver.expoPushToken,
        title: "New Message",
        body: notificationBody,
        data: {
          type: "chat",
          chatId: conversation.id,
          senderId,
        },
      });
    } catch (pushError) {
      console.error("[Push] Error sending notification:", pushError.message);
    }
  }
};

/**
 * Real-time delivery + push for a freshly created message.
 */
const deliverMessage = async (req, conversation, message, senderId) => {
  emitToParticipants(req, conversation, "receiveMessage", { message }, senderId);
  await notifyReceivers(conversation, message, senderId);
};

/**
 * POST /api/messages
 * Send a new message (text, file, or both) in a conversation.
 * Body: { conversationId, text?, fileUrl?, fileType?, fileName?, fileSize? }
 */
const sendMessage = async (req, res, next) => {
  try {
    const {
      conversationId,
      text,
      fileUrl,
      fileType,
      fileName,
      fileSize,
      audioDuration,
      replyToMessageId,
      replyToText,
      replyToSenderId,
      replyToSender,
    } = req.body;
    const senderId = req.user._id;

    if (!conversationId) {
      return res.status(400).json({ success: false, message: "Conversation ID is required." });
    }

    // Must have at least text or a file
    if (!text && !fileUrl) {
      return res.status(400).json({
        success: false,
        message: "A message must contain text or a file.",
      });
    }

    // Verify the sender is a participant in this conversation
    const conversation = await Conversation.findForUser(conversationId, senderId);
    if (!conversation) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this conversation.",
      });
    }

    const replyToSenderValue = replyToSenderId || replyToSender || null;

    const message = await Message.create({
      conversationId,
      senderId,
      text: text ? String(text).trim() : "",
      fileUrl,
      fileType,
      fileName,
      fileSize,
      audioDuration,
      replyToMessageId,
      replyToText,
      replyToSenderId: typeof replyToSenderValue === "object" ? replyToSenderValue?._id : replyToSenderValue,
    });

    // Respond first so the sender's UI isn't held up by push delivery
    res.status(201).json({ success: true, message });

    deliverMessage(req, conversation, message, senderId).catch((err) =>
      console.error("Message delivery error:", err.message)
    );
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/messages/:conversationId
 * Get all messages in a conversation (oldest first).
 */
const getMessages = async (req, res, next) => {
  try {
    const { conversationId } = req.params;

    // Security: verify user belongs to the conversation
    const conversation = await Conversation.findForUser(conversationId, req.user._id);
    if (!conversation) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this conversation.",
      });
    }

    const messages = await Message.listForConversation(conversationId);

    res.status(200).json({
      success: true,
      total: messages.length,
      page: 1,
      pages: 1,
      messages,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/messages/:conversationId/mark-read
 * Mark all incoming unread messages in a conversation as read.
 */
const markMessagesAsRead = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user._id;

    const conversation = await Conversation.findForUser(conversationId, userId);
    if (!conversation) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this conversation.",
      });
    }

    const updated = await Message.markRead(conversationId, userId);
    const messageIds = updated.map((m) => m.id);

    // ─── Real-time: notify the original senders that their messages were seen ──
    if (updated.length > 0) {
      emitToParticipants(
        req,
        conversation,
        "messagesSeen",
        { conversationId, messageIds, seenBy: userId, seenAt: new Date() },
        userId
      );
    }

    res.status(200).json({
      success: true,
      updatedCount: messageIds.length,
      messageIds,
    });
  } catch (error) {
    next(error);
  }
};


/**
 * POST /api/messages/voice
 * Upload a voice message (audio file) and save it as a message.
 * Body: { conversationId }, File: audio
 */
const uploadVoiceMessage = async (req, res, next) => {
  try {
    const { conversationId, audioDuration } = req.body;
    const senderId = req.user._id;

    if (!conversationId) {
      return res.status(400).json({ success: false, message: "Conversation ID is required." });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No audio file provided." });
    }

    // Verify conversation access
    const conversation = await Conversation.findForUser(conversationId, senderId);
    if (!conversation) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const { url } = await saveFile(req, req.file, "voice-messages");

    const message = await Message.create({
      conversationId,
      senderId,
      text: "",
      fileUrl: url,
      fileType: "audio",
      fileName: req.file.originalname || "voice-message.webm",
      fileSize: req.file.size,
      audioDuration: audioDuration ? Number(audioDuration) : null,
    });

    res.status(201).json({ success: true, message });

    deliverMessage(req, conversation, message, senderId).catch((err) =>
      console.error("Voice message delivery error:", err.message)
    );
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/messages/:messageId
 * Delete a message (only by the sender) and remove its file if any.
 */
const deleteMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found." });
    }

    // Only the sender can delete their message
    if (message.sender_id !== userId) {
      return res.status(403).json({ success: false, message: "You can only delete your own messages." });
    }

    await Message.remove(messageId);

    if (message.file_url) {
      deleteFileByUrl(message.file_url).catch((err) => console.error("Error deleting message file:", err.message));
    }

    // Notify other users via socket
    const conversation = await Conversation.findForUser(message.conversation_id, userId);
    if (conversation) {
      emitToParticipants(
        req,
        conversation,
        "messageDeleted",
        { messageId, conversationId: message.conversation_id },
        userId
      );
    }

    res.status(200).json({ success: true, message: "Message deleted successfully." });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/messages/:messageId/react
 * Add, remove, or update a reaction on a message.
 * Body: { emoji }
 */
const reactToMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user._id;

    if (!emoji) {
      return res.status(400).json({ success: false, message: "Emoji is required." });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found." });
    }

    // Verify user is a participant in this conversation
    const conversation = await Conversation.findForUser(message.conversation_id, userId);
    if (!conversation) {
      return res.status(403).json({ success: false, message: "You are not a participant in this conversation." });
    }

    const reactions = await Message.toggleReaction(messageId, userId, emoji);

    // ─── Real-time: broadcast to all participants ──
    emitToParticipants(req, conversation, "messageReactionUpdated", {
      messageId,
      conversationId: message.conversation_id,
      reactions,
    });

    res.status(200).json({ success: true, reactions });
  } catch (error) {
    next(error);
  }
};

module.exports = { sendMessage, getMessages, uploadVoiceMessage, markMessagesAsRead, deleteMessage, reactToMessage };
