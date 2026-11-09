const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const Block = require("../models/Block");
const { emitToConversation, emitToUsers } = require("../services/realtime");
const notifications = require("../services/notifications");
const { deliverMessage } = require("./messageController");

const fail = (res, status, message, code) => res.status(status).json({ success: false, message, code });
const MAX_GROUP_MEMBERS = 500;
const isAdmin = (role) => role === "owner" || role === "admin";

/** Posts a system line ("Ana added Ben") into a group and delivers it. */
async function systemMessage(conversationId, actorId, text) {
  const message = await Message.create({ conversationId, senderId: actorId, text, kind: "system" });
  await emitToConversation(conversationId, "receiveMessage", { message });
}

// ─── Direct ──────────────────────────────────────────────────────────────────

/** POST /api/conversations { receiverId } — find or create a direct chat. */
const createConversation = async (req, res, next) => {
  try {
    const receiverId = req.body.receiverId || (req.body.participants && req.body.participants[0]);
    const senderId = req.user._id;
    if (!receiverId) return fail(res, 400, "Receiver ID is required.");
    if (senderId === receiverId) return fail(res, 400, "Cannot create conversation with yourself.");
    if (!(await User.findById(receiverId))) return fail(res, 404, "User not found.");
    if (await Block.between(senderId, receiverId)) return fail(res, 403, "You can't message this person.");

    const { conversation, created } = await Conversation.getOrCreate(senderId, receiverId);
    res.status(created ? 201 : 200).json({ success: true, message: created ? "Conversation created." : "Conversation already exists.", conversation });
  } catch (error) {
    next(error);
  }
};

/** GET /api/conversations?type=direct|group|channel&archived=true */
const getUserConversations = async (req, res, next) => {
  try {
    const type = ["direct", "group", "channel"].includes(req.query.type) ? req.query.type : undefined;
    // Channels are listed per workspace (/api/workspaces/:id/channels); the main list shows direct + groups
    const conversations = (await Conversation.listForUser(req.user._id, { type, includeArchived: req.query.archived === "true" })).filter(
      (c) => type || c.type !== "channel"
    );
    res.json({ success: true, count: conversations.length, conversations });
  } catch (error) {
    next(error);
  }
};

/** GET /api/conversations/search?q= */
const searchConversations = async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 1) return res.json({ success: true, conversations: [] });
    res.json({ success: true, conversations: await Conversation.searchForUser(req.user._id, q.slice(0, 60)) });
  } catch (error) {
    next(error);
  }
};

const getConversationById = async (req, res, next) => {
  try {
    if (!(await Conversation.findForUser(req.params.id, req.user._id))) return fail(res, 404, "Conversation not found.");
    res.json({ success: true, conversation: await Conversation.getFull(req.params.id, req.user._id) });
  } catch (error) {
    next(error);
  }
};

const getConversationMedia = async (req, res, next) => {
  try {
    if (!(await Conversation.findForUser(req.params.id, req.user._id))) return fail(res, 404, "Conversation not found or access denied.");
    const media = await Message.listMedia(req.params.id);
    res.json({ success: true, count: media.length, media });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/conversations/:id/membership { mutedUntil?: ISO|null, muted?: bool, pinned?: bool, archived?: bool } */
const updateMembership = async (req, res, next) => {
  try {
    const userId = req.user._id;
    if (!(await Conversation.findForUser(req.params.id, userId))) return fail(res, 404, "Conversation not found.");
    const b = req.body || {};
    let mutedUntil;
    if (b.muted === true) mutedUntil = "infinity";
    else if (b.muted === false) mutedUntil = null;
    else if (b.mutedUntil !== undefined) mutedUntil = b.mutedUntil ? new Date(b.mutedUntil).toISOString() : null;
    await Conversation.updateMembership(req.params.id, userId, {
      mutedUntil,
      pinned: typeof b.pinned === "boolean" ? b.pinned : undefined,
      archived: typeof b.archived === "boolean" ? b.archived : undefined,
    });
    res.json({ success: true, conversation: await Conversation.getFull(req.params.id, userId) });
  } catch (error) {
    next(error);
  }
};

// ─── Groups ──────────────────────────────────────────────────────────────────

const cleanTitle = (t) => String(t || "").trim().slice(0, 80);

/** POST /api/conversations/groups { title, description?, memberIds: [] } */
const createGroup = async (req, res, next) => {
  try {
    const title = cleanTitle(req.body?.title);
    if (!title) return fail(res, 400, "Group name is required.");
    const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map(String) : [];
    if (memberIds.length + 1 > MAX_GROUP_MEMBERS) return fail(res, 400, `Groups can have up to ${MAX_GROUP_MEMBERS} members.`);

    // People who blocked the creator are not added
    const blockers = await Block.blockersOf(req.user._id);
    const allowed = memberIds.filter((id) => !blockers.has(id));
    const conversation = await Conversation.createGroup({
      creatorId: req.user._id,
      title,
      description: req.body?.description ? String(req.body.description).slice(0, 500) : null,
      memberIds: allowed,
    });
    await systemMessage(conversation.id, req.user._id, `${req.user.username} created the group "${title}"`);
    const full = await Conversation.getFull(conversation.id, req.user._id);
    emitToUsers(allowed, "conversationAdded", { conversationId: conversation.id });
    await notifications.notify(allowed, {
      type: "group_added",
      title: `${req.user.username} added you to "${title}"`,
      data: { conversationId: conversation.id },
      actorId: req.user._id,
      dedupeKey: `group_added:${conversation.id}`,
    });
    res.status(201).json({ success: true, conversation: full });
  } catch (error) {
    next(error);
  }
};

/** Loads a group/channel the user belongs to, enforcing an admin role if required. */
async function loadGroup(req, res, { admin = false } = {}) {
  const conv = await Conversation.findForUser(req.params.id, req.user._id);
  if (!conv || conv.type === "direct") {
    fail(res, 404, "Group not found.");
    return null;
  }
  if (admin && !isAdmin(conv.my_role)) {
    fail(res, 403, "Only group admins can do this.");
    return null;
  }
  return conv;
}

/** PATCH /api/conversations/:id { title?, description?, avatar?, adminsOnlyPost? } — admins. */
const updateGroup = async (req, res, next) => {
  try {
    const conv = await loadGroup(req, res, { admin: true });
    if (!conv) return;
    const b = req.body || {};
    const fields = {};
    if (b.title !== undefined) {
      fields.title = cleanTitle(b.title);
      if (!fields.title) return fail(res, 400, "Name can't be empty.");
    }
    if (b.description !== undefined) fields.description = b.description ? String(b.description).slice(0, 500) : null;
    if (b.avatar !== undefined) fields.avatar = typeof b.avatar === "string" && /^https?:\/\//.test(b.avatar) ? b.avatar.slice(0, 1000) : null;
    if (typeof b.adminsOnlyPost === "boolean") fields.adminsOnlyPost = b.adminsOnlyPost;
    await Conversation.update(conv.id, fields);
    if (fields.title && fields.title !== conv.title) await systemMessage(conv.id, req.user._id, `${req.user.username} renamed the group to "${fields.title}"`);
    await emitToConversation(conv.id, "conversationUpdated", { conversationId: conv.id });
    res.json({ success: true, conversation: await Conversation.getFull(conv.id, req.user._id) });
  } catch (error) {
    next(error);
  }
};

/** POST /api/conversations/:id/members { userIds: [] } — admins. */
const addMembers = async (req, res, next) => {
  try {
    const conv = await loadGroup(req, res, { admin: true });
    if (!conv) return;
    if (conv.workspace_id) return fail(res, 400, "Manage channel members from the workspace.");
    const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.map(String).slice(0, 100) : [];
    const blockers = await Block.blockersOf(req.user._id);
    const added = await Conversation.addMembers(conv.id, ids.filter((id) => !blockers.has(id)));
    if (added.length) {
      const names = (await Promise.all(added.map((id) => User.findById(id)))).map((u) => u.username);
      await systemMessage(conv.id, req.user._id, `${req.user.username} added ${names.join(", ")}`);
      emitToUsers(added, "conversationAdded", { conversationId: conv.id });
      await emitToConversation(conv.id, "conversationUpdated", { conversationId: conv.id });
      await notifications.notify(added, {
        type: "group_added",
        title: `${req.user.username} added you to "${conv.title}"`,
        data: { conversationId: conv.id },
        actorId: req.user._id,
        dedupeKey: `group_added:${conv.id}`,
      });
    }
    res.json({ success: true, added, conversation: await Conversation.getFull(conv.id, req.user._id) });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/conversations/:id/members/:userId
 * Admins remove members (not the owner; admins can't remove other admins). Anyone can remove themselves (leave).
 * If the owner leaves, ownership passes to the oldest admin, else the oldest member.
 */
const removeMember = async (req, res, next) => {
  try {
    const conv = await loadGroup(req, res);
    if (!conv) return;
    const targetId = req.params.userId;
    const self = targetId === req.user._id;
    const target = await Conversation.getMember(conv.id, targetId);
    if (!target) return fail(res, 404, "Member not found.");
    if (!self) {
      if (!isAdmin(conv.my_role)) return fail(res, 403, "Only group admins can remove members.");
      if (target.role === "owner" || (target.role === "admin" && conv.my_role !== "owner")) return fail(res, 403, "You can't remove this member.");
    }

    await Conversation.removeMember(conv.id, targetId);
    if (target.role === "owner") {
      const next = await Conversation.successor(conv.id, targetId);
      if (next) await Conversation.setRole(conv.id, next, "owner");
    }
    const who = (await User.findById(targetId))?.username || "A member";
    await systemMessage(conv.id, req.user._id, self ? `${who} left` : `${req.user.username} removed ${who}`);
    emitToUsers([targetId], "conversationRemoved", { conversationId: conv.id });
    await emitToConversation(conv.id, "conversationUpdated", { conversationId: conv.id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/conversations/:id/members/:userId { role: 'admin'|'member'|'owner' } — owner only ('owner' transfers ownership). */
const setMemberRole = async (req, res, next) => {
  try {
    const conv = await loadGroup(req, res);
    if (!conv) return;
    if (conv.my_role !== "owner") return fail(res, 403, "Only the group owner can change roles.");
    const role = req.body?.role;
    if (!["admin", "member", "owner"].includes(role)) return fail(res, 400, "Invalid role.");
    const targetId = req.params.userId;
    if (targetId === req.user._id) return fail(res, 400, "You can't change your own role.");
    if (!(await Conversation.getMember(conv.id, targetId))) return fail(res, 404, "Member not found.");

    await Conversation.setRole(conv.id, targetId, role);
    if (role === "owner") await Conversation.setRole(conv.id, req.user._id, "admin");
    await emitToConversation(conv.id, "conversationUpdated", { conversationId: conv.id });
    res.json({ success: true, conversation: await Conversation.getFull(conv.id, req.user._id) });
  } catch (error) {
    next(error);
  }
};

/** POST /api/conversations/:id/invite-link { regenerate? } — admins get a shareable join code. */
const getInviteLink = async (req, res, next) => {
  try {
    const conv = await loadGroup(req, res, { admin: true });
    if (!conv) return;
    if (conv.type !== "group") return fail(res, 400, "Invite links are for groups.");
    const code = await Conversation.ensureInviteCode(conv.id, Boolean(req.body?.regenerate));
    res.json({ success: true, code });
  } catch (error) {
    next(error);
  }
};

/** GET /api/conversations/join/:code — preview; POST joins. */
const previewInvite = async (req, res, next) => {
  try {
    const conv = await Conversation.findByInviteCode(req.params.code);
    if (!conv) return fail(res, 404, "This invite link is invalid or was reset.");
    const members = await Conversation.memberIds(conv.id);
    res.json({ success: true, group: { id: conv.id, title: conv.title, description: conv.description, avatar: conv.avatar, memberCount: members.length, isMember: members.includes(req.user._id) } });
  } catch (error) {
    next(error);
  }
};

const joinByInvite = async (req, res, next) => {
  try {
    const conv = await Conversation.findByInviteCode(req.params.code);
    if (!conv) return fail(res, 404, "This invite link is invalid or was reset.");
    const added = await Conversation.addMembers(conv.id, [req.user._id]);
    if (added.length) {
      await systemMessage(conv.id, req.user._id, `${req.user.username} joined using an invite link`);
      await emitToConversation(conv.id, "conversationUpdated", { conversationId: conv.id });
    }
    res.json({ success: true, conversation: await Conversation.getFull(conv.id, req.user._id) });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createConversation,
  getUserConversations,
  searchConversations,
  getConversationById,
  getConversationMedia,
  updateMembership,
  createGroup,
  updateGroup,
  addMembers,
  removeMember,
  setMemberRole,
  getInviteLink,
  previewInvite,
  joinByInvite,
  systemMessage,
  deliverMessage,
};
