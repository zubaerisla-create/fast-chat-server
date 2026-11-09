const Block = require("../models/Block");
const User = require("../models/User");
const FriendRequest = require("../models/FriendRequest");
const { emitToUsers } = require("../services/realtime");
const notifications = require("../services/notifications");

const fail = (res, status, message) => res.status(status).json({ success: false, message });

/** GET /api/users/blocked */
const listBlocked = async (req, res, next) => {
  try {
    res.json({ success: true, users: await Block.listBlocked(req.user._id) });
  } catch (e) {
    next(e);
  }
};

/** POST /api/users/:id/block — blocked users can't message you, start chats with you or add you to groups. */
const blockUser = async (req, res, next) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user._id) return fail(res, 400, "You can't block yourself.");
    if (!(await User.findById(targetId))) return fail(res, 404, "User not found.");
    await Block.block(req.user._id, targetId);

    // Invalidate any friend/connection requests between both users so unblocking requires a fresh request
    await FriendRequest.cancelPendingBetween(req.user._id, targetId);
    // Also cancel any accepted relationship between them
    const { query } = require("../config/db");
    await query(
      `UPDATE friend_requests SET status = 'canceled', updated_at = NOW()
       WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
         AND status = 'accepted'`,
      [req.user._id, targetId]
    );

    emitToUsers([targetId, req.user._id], "userBlocked", { blockerId: req.user._id, blockedId: targetId });
    res.json({ success: true, blocked: true });
  } catch (e) {
    next(e);
  }
};

const unblockUser = async (req, res, next) => {
  try {
    const targetId = req.params.id;
    await Block.unblock(req.user._id, targetId);
    emitToUsers([targetId, req.user._id], "userUnblocked", { unblockerId: req.user._id, unblockedId: targetId });
    res.json({ success: true, blocked: false });
  } catch (e) {
    next(e);
  }
};

/** GET /api/notifications?before=&limit=&unread=true */
const listNotifications = async (req, res, next) => {
  try {
    res.json({ success: true, ...(await notifications.list(req.user._id, { before: req.query.before || null, limit: req.query.limit, unreadOnly: req.query.unread === "true" })) });
  } catch (e) {
    next(e);
  }
};

/** POST /api/notifications/read { ids?: [] } — no ids marks all read. */
const markNotificationsRead = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : null;
    await notifications.markRead(req.user._id, ids);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
};

const getPreferences = async (req, res, next) => {
  try {
    res.json({ success: true, preferences: await notifications.getPreferences(req.user._id) });
  } catch (e) {
    next(e);
  }
};

/** PUT /api/notifications/preferences/:category { push?, inApp? } */
const setPreference = async (req, res, next) => {
  try {
    const { push, inApp } = req.body || {};
    const preferences = await notifications.setPreference(req.user._id, req.params.category, {
      push: typeof push === "boolean" ? push : undefined,
      inApp: typeof inApp === "boolean" ? inApp : undefined,
    });
    res.json({ success: true, preferences });
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    next(e);
  }
};

module.exports = { listBlocked, blockUser, unblockUser, listNotifications, markNotificationsRead, getPreferences, setPreference };
