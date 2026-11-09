const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const Block = require("../models/Block");
const FriendRequest = require("../models/FriendRequest");
const { saveFile, deleteFileByUrl } = require("../utils/storage");
const { emitToConversation } = require("../services/realtime");
const notifications = require("../services/notifications");
const { firstUrl, fetchPreview } = require("../utils/linkPreview");

const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000; // messages can be edited for 48 hours
const MAX_TEXT = 2000;
const MAX_ATTACHMENTS = 10;
const FILE_TYPES = ["image", "video", "audio", "file"];
const REPORT_REASONS = ["spam", "abuse", "harassment", "illegal", "other"];

const fail = (res, status, message, code) => res.status(status).json({ success: false, message, code });

/** Who may post: members of the conversation, admins only in announcement groups, nobody blocked in a direct chat. */
async function checkCanPost(conversation, userId) {
  if (conversation.admins_only_post && !["owner", "admin"].includes(conversation.my_role)) {
    return "Only admins can post here.";
  }
  if (conversation.type === "direct") {
    const other = conversation.user_a === userId ? conversation.user_b : conversation.user_a;
    if (await Block.between(userId, other)) return "You can't message this person.";

    // Ensure friend request is not pending, rejected or canceled
    const { query } = require("../config/db");
    const { rows: reqs } = await query(
      `SELECT status FROM friend_requests
       WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
       ORDER BY updated_at DESC LIMIT 1`,
      [userId, other]
    );
    if (reqs.length > 0 && reqs[0].status !== "accepted") {
      return "Message request must be accepted before sending messages.";
    }
  }
  return null;
}

/** Real-time delivery, notifications, and a link preview fetched in the background. */
async function deliverMessage(conversation, message, senderId) {
  await emitToConversation(conversation.id, "receiveMessage", { message }, { skip: senderId });
  await notifications.notifyNewMessage(conversation, message, senderId);
  const url = message.text && firstUrl(message.text);
  if (url) {
    try {
      const preview = await fetchPreview(url);
      if (preview) {
        await Message.setLinkPreview(message.id, preview);
        await emitToConversation(conversation.id, "messageUpdated", { message: await Message.getFull(message.id) });
      }
    } catch {
      // previews are best-effort
    }
  }
}

const cleanAttachments = (list) => {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ATTACHMENTS).flatMap((a) =>
    a && typeof a.url === "string" && FILE_TYPES.includes(a.type)
      ? [{ url: a.url.slice(0, 1000), type: a.type, name: String(a.name || "").slice(0, 255) || null, size: Number(a.size) || null }]
      : []
  );
};

/**
 * POST /api/messages
 * Body: { conversationId, text?, fileUrl?, fileType?, fileName?, fileSize?, audioDuration?,
 *         attachments?: [{url,type,name,size}], replyToMessageId?, clientId? }
 * `clientId` makes retries idempotent (offline send queues).
 */
const sendMessage = async (req, res, next) => {
  try {
    const b = req.body || {};
    const senderId = req.user._id;
    if (!b.conversationId) return fail(res, 400, "Conversation ID is required.");

    const text = b.text ? String(b.text).trim() : "";
    const attachments = cleanAttachments(b.attachments);
    if (!text && !b.fileUrl && !attachments.length) return fail(res, 400, "A message must contain text or a file.");
    if (text.length > MAX_TEXT) return fail(res, 400, `Messages can be up to ${MAX_TEXT} characters.`);
    if (b.fileType && !FILE_TYPES.includes(b.fileType)) return fail(res, 400, "Unsupported file type.");

    const conversation = await Conversation.findForUser(b.conversationId, senderId);
    if (!conversation) return fail(res, 403, "You are not a participant in this conversation.");
    const blocked = await checkCanPost(conversation, senderId);
    if (blocked) return fail(res, 403, blocked, "cannot_post");

    // Reply snapshot comes from the stored message, never from the client
    let reply = {};
    if (b.replyToMessageId) {
      const original = await Message.findById(b.replyToMessageId);
      if (original && original.conversation_id === conversation.id && !original.deleted_at) {
        reply = { replyToMessageId: original.id, replyToText: (original.text || original.file_name || "").slice(0, 300), replyToSenderId: original.sender_id };
      }
    }

    // First attachment doubles as fileUrl so clients without album support still show it
    const primary = b.fileUrl ? { url: b.fileUrl, type: b.fileType, name: b.fileName, size: b.fileSize } : attachments.shift();
    const clientId = typeof b.clientId === "string" ? b.clientId.slice(0, 64) : null;

    const message = await Message.create({
      conversationId: conversation.id,
      senderId,
      text,
      fileUrl: primary?.url,
      fileType: primary?.type,
      fileName: primary?.name,
      fileSize: primary?.size,
      audioDuration: b.audioDuration,
      attachments,
      clientId,
      ...reply,
    });

    if (message.duplicate) {
      delete message.duplicate;
      return res.status(200).json({ success: true, message, duplicate: true });
    }
    res.status(201).json({ success: true, message });
    deliverMessage(conversation, message, senderId).catch((err) => console.error("Message delivery error:", err.message));
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/messages/:messageId/forward  { conversationIds: [] }
 * Copies the content (not the reply) into conversations the user belongs to.
 */
const forwardMessage = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const source = await Message.findById(req.params.messageId);
    if (!source || source.deleted_at || !(await Conversation.findForUser(source.conversation_id, userId))) return fail(res, 404, "Message not found.");
    const targets = [...new Set((req.body?.conversationIds || []).map(String))].slice(0, 20);
    if (!targets.length) return fail(res, 400, "Choose at least one conversation.");

    const sent = [];
    for (const conversationId of targets) {
      const conversation = await Conversation.findForUser(conversationId, userId);
      if (!conversation || (await checkCanPost(conversation, userId))) continue;
      const message = await Message.create({
        conversationId,
        senderId: userId,
        text: source.text,
        fileUrl: source.file_url,
        fileType: source.file_type,
        fileName: source.file_name,
        fileSize: source.file_size,
        audioDuration: source.audio_duration,
        attachments: source.attachments || [],
        forwarded: true,
      });
      sent.push(message);
      deliverMessage(conversation, message, userId).catch(() => {});
    }
    res.status(201).json({ success: true, messages: sent });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/messages/:conversationId
 * With ?limit= (and optional ?before=<messageId>): a cursor page, oldest first, plus hasMore.
 * Without: the whole history (older clients), excluding messages deleted for everyone.
 */
const getMessages = async (req, res, next) => {
  try {
    const conversation = await Conversation.findForUser(req.params.conversationId, req.user._id);
    if (!conversation) return fail(res, 403, "You are not a participant in this conversation.");

    if (req.query.limit || req.query.before) {
      const { messages, hasMore } = await Message.listPage(conversation.id, { before: req.query.before || null, limit: req.query.limit });
      return res.json({ success: true, messages, hasMore, nextCursor: hasMore && messages.length ? messages[0].id : null });
    }
    const messages = (await Message.listForConversation(conversation.id)).filter((m) => !m.deletedAt);
    res.json({ success: true, total: messages.length, page: 1, pages: 1, messages });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/messages/:conversationId/mark-read */
const markMessagesAsRead = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const conversation = await Conversation.findForUser(req.params.conversationId, userId);
    if (!conversation) return fail(res, 403, "You are not a participant in this conversation.");

    const updated = await Message.markRead(conversation.id, userId);
    const messageIds = updated.map((m) => m.id);
    await emitToConversation(conversation.id, "messagesSeen", { conversationId: conversation.id, messageIds, seenBy: userId, seenAt: new Date() }, { skip: userId });
    res.json({ success: true, updatedCount: messageIds.length, messageIds });
  } catch (error) {
    next(error);
  }
};

/** GET /api/messages/:conversationId/read-receipts — who has read up to when (groups). */
const getReadReceipts = async (req, res, next) => {
  try {
    const conversation = await Conversation.findForUser(req.params.conversationId, req.user._id);
    if (!conversation) return fail(res, 403, "You are not a participant in this conversation.");
    res.json({ success: true, readers: await Message.readPositions(conversation.id) });
  } catch (error) {
    next(error);
  }
};

/** POST /api/messages/voice (multipart: audio, conversationId, audioDuration?, clientId?) */
const uploadVoiceMessage = async (req, res, next) => {
  try {
    const { conversationId, audioDuration, clientId } = req.body;
    const senderId = req.user._id;
    if (!conversationId) return fail(res, 400, "Conversation ID is required.");
    if (!req.file) return fail(res, 400, "No audio file provided.");

    const conversation = await Conversation.findForUser(conversationId, senderId);
    if (!conversation) return fail(res, 403, "Access denied.");
    const blocked = await checkCanPost(conversation, senderId);
    if (blocked) return fail(res, 403, blocked, "cannot_post");

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
      clientId: typeof clientId === "string" ? clientId.slice(0, 64) : null,
    });
    res.status(201).json({ success: true, message });
    deliverMessage(conversation, message, senderId).catch((err) => console.error("Voice message delivery error:", err.message));
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/messages/:messageId { text } — sender only, within 48 h, text messages only. */
const editMessage = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const text = String(req.body?.text || "").trim();
    if (!text) return fail(res, 400, "Text is required.");
    if (text.length > MAX_TEXT) return fail(res, 400, `Messages can be up to ${MAX_TEXT} characters.`);
    const row = await Message.findById(req.params.messageId);
    if (!row || row.deleted_at) return fail(res, 404, "Message not found.");
    if (row.sender_id !== userId) return fail(res, 403, "You can only edit your own messages.");
    if (row.kind !== "user") return fail(res, 400, "This message can't be edited.");
    if (Date.now() - new Date(row.created_at).getTime() > EDIT_WINDOW_MS) return fail(res, 400, "Messages can only be edited within 48 hours.");

    const message = await Message.edit(row.id, text);
    await emitToConversation(row.conversation_id, "messageUpdated", { message });
    res.json({ success: true, message });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/messages/:messageId — delete for everyone.
 * The sender can delete their own; group owners/admins can delete any message.
 * Content and files are removed; a placeholder stays in the timeline.
 */
const deleteMessage = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const row = await Message.findById(req.params.messageId);
    if (!row) return fail(res, 404, "Message not found.");
    const conversation = await Conversation.findForUser(row.conversation_id, userId);
    if (!conversation) return fail(res, 404, "Message not found.");
    const moderator = conversation.type !== "direct" && ["owner", "admin"].includes(conversation.my_role);
    if (row.sender_id !== userId && !moderator) return fail(res, 403, "You can only delete your own messages.");

    const files = await Message.softDelete(row.id);
    for (const url of files) deleteFileByUrl(url).catch((err) => console.error("Error deleting message file:", err.message));

    await emitToConversation(row.conversation_id, "messageDeleted", { messageId: row.id, conversationId: row.conversation_id });
    res.json({ success: true, message: "Message deleted successfully." });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/messages/:messageId/react { emoji } */
const reactToMessage = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const emoji = typeof req.body?.emoji === "string" ? req.body.emoji.trim() : "";
    if (!emoji || emoji.length > 16) return fail(res, 400, "Emoji is required.");
    const row = await Message.findById(req.params.messageId);
    if (!row || row.deleted_at) return fail(res, 404, "Message not found.");
    if (!(await Conversation.findForUser(row.conversation_id, userId))) return fail(res, 403, "You are not a participant in this conversation.");

    const reactions = await Message.toggleReaction(row.id, userId, emoji);
    await emitToConversation(row.conversation_id, "messageReactionUpdated", { messageId: row.id, conversationId: row.conversation_id, reactions });
    res.json({ success: true, reactions });
  } catch (error) {
    next(error);
  }
};

/** POST/DELETE /api/messages/:messageId/pin — any member in direct chats; owners/admins in groups/channels. */
const setPinned = (pinned) => async (req, res, next) => {
  try {
    const userId = req.user._id;
    const row = await Message.findById(req.params.messageId);
    if (!row || row.deleted_at) return fail(res, 404, "Message not found.");
    const conversation = await Conversation.findForUser(row.conversation_id, userId);
    if (!conversation) return fail(res, 404, "Message not found.");
    if (conversation.type !== "direct" && !["owner", "admin"].includes(conversation.my_role)) return fail(res, 403, "Only admins can pin messages here.");

    if (pinned) await Message.pin(row.id, row.conversation_id, userId);
    else await Message.unpin(row.id);
    await emitToConversation(row.conversation_id, "messagePinned", { messageId: row.id, conversationId: row.conversation_id, pinned, by: userId });
    res.json({ success: true, pinned });
  } catch (error) {
    next(error);
  }
};

/** GET /api/messages/:conversationId/pins */
const listPins = async (req, res, next) => {
  try {
    const conversation = await Conversation.findForUser(req.params.conversationId, req.user._id);
    if (!conversation) return fail(res, 403, "You are not a participant in this conversation.");
    res.json({ success: true, messages: await Message.listPins(conversation.id) });
  } catch (error) {
    next(error);
  }
};

/** POST /api/messages/:messageId/bookmark — toggles a private bookmark. */
const toggleBookmark = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const row = await Message.findById(req.params.messageId);
    if (!row || !(await Conversation.findForUser(row.conversation_id, userId))) return fail(res, 404, "Message not found.");
    res.json({ success: true, bookmarked: await Message.toggleBookmark(userId, row.id) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/messages/bookmarks */
const listBookmarks = async (req, res, next) => {
  try {
    res.json({ success: true, messages: await Message.listBookmarks(req.user._id) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/messages/search?q=&conversationId= */
const searchMessages = async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, messages: [] });
    if (req.query.conversationId && !(await Conversation.findForUser(req.query.conversationId, req.user._id))) {
      return fail(res, 403, "You are not a participant in this conversation.");
    }
    const messages = await Message.search(req.user._id, q.slice(0, 100), { conversationId: req.query.conversationId || null });
    res.json({ success: true, messages });
  } catch (error) {
    next(error);
  }
};

/** POST /api/messages/:messageId/report { reason, details? } */
const reportMessage = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const reason = req.body?.reason;
    if (!REPORT_REASONS.includes(reason)) return fail(res, 400, `Reason must be one of: ${REPORT_REASONS.join(", ")}.`);
    const row = await Message.findById(req.params.messageId);
    if (!row || !(await Conversation.findForUser(row.conversation_id, userId))) return fail(res, 404, "Message not found.");
    if (row.sender_id === userId) return fail(res, 400, "You can't report your own message.");
    await Message.report(row.id, userId, reason, req.body?.details ? String(req.body.details).slice(0, 1000) : null);
    res.status(201).json({ success: true, message: "Thanks. Our team will review this message." });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  sendMessage,
  forwardMessage,
  getMessages,
  uploadVoiceMessage,
  markMessagesAsRead,
  getReadReceipts,
  editMessage,
  deleteMessage,
  reactToMessage,
  pinMessage: setPinned(true),
  unpinMessage: setPinned(false),
  listPins,
  toggleBookmark,
  listBookmarks,
  searchMessages,
  reportMessage,
  // used by group/channel controllers for system messages
  deliverMessage,
};
