const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");

/**
 * POST /api/conversations
 * Create a new 1-to-1 conversation between two users.
 * If a conversation already exists between them, return the existing one.
 */
const createConversation = async (req, res, next) => {
  try {
    const receiverId = req.body.receiverId || (req.body.participants && req.body.participants[0]);
    const senderId = req.user._id;

    if (!receiverId) {
      return res
        .status(400)
        .json({ success: false, message: "Receiver ID is required." });
    }

    if (senderId === receiverId) {
      return res
        .status(400)
        .json({ success: false, message: "Cannot create conversation with yourself." });
    }

    if (!(await User.findById(receiverId))) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const { conversation, created } = await Conversation.getOrCreate(senderId, receiverId);

    res.status(created ? 201 : 200).json({
      success: true,
      message: created ? "Conversation created." : "Conversation already exists.",
      conversation,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/conversations
 * Get all conversations for the currently logged-in user,
 * sorted by most recently updated (latest message first).
 */
const getUserConversations = async (req, res, next) => {
  try {
    const conversations = await Conversation.listForUser(req.user._id);

    res.status(200).json({
      success: true,
      count: conversations.length,
      conversations,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/conversations/:id
 * Get a single conversation by ID (must include current user as participant).
 */
const getConversationById = async (req, res, next) => {
  try {
    // Security: ensure user belongs to conversation
    const membership = await Conversation.findForUser(req.params.id, req.user._id);
    if (!membership) {
      return res
        .status(404)
        .json({ success: false, message: "Conversation not found." });
    }

    const conversation = await Conversation.getFull(req.params.id);
    res.status(200).json({ success: true, conversation });
  } catch (error) {
    next(error);
  }
};


/**
 * GET /api/conversations/:id/media
 * Get all shared images, videos, and files in a conversation.
 */
const getConversationMedia = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Verify conversation exists and user is a participant
    const conversation = await Conversation.findForUser(id, req.user._id);
    if (!conversation) {
      return res
        .status(404)
        .json({ success: false, message: "Conversation not found or access denied." });
    }

    const mediaMessages = await Message.listMedia(id);

    res.status(200).json({
      success: true,
      count: mediaMessages.length,
      media: mediaMessages,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createConversation,
  getUserConversations,
  getConversationById,
  getConversationMedia,
};
