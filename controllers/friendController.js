const FriendRequest = require("../models/FriendRequest");
const User = require("../models/User");
const { emitToUsers } = require("../services/realtime");
const notifications = require("../services/notifications");

const fail = (res, status, message) => res.status(status).json({ success: false, message });

/** POST /api/friends/requests { receiverId?, username? } */
const sendFriendRequest = async (req, res, next) => {
  try {
    let receiverId = req.body?.receiverId;
    if (!receiverId && req.body?.username) {
      const user = await User.findByExactUsername(req.body.username);
      if (!user) return fail(res, 404, "User not found.");
      receiverId = user._id;
    }
    if (!receiverId) return fail(res, 400, "Receiver ID or exact username is required.");

    const request = await FriendRequest.sendRequest(req.user._id, receiverId);

    // Real-time events
    emitToUsers([receiverId], "friendRequestReceived", { request });
    emitToUsers([req.user._id], "friendRequestSent", { request });

    // Notification
    await notifications.notify([receiverId], {
      type: "friend_request",
      title: `${req.user.username} sent you a message request`,
      data: { requestId: request.id, senderId: req.user._id },
      actorId: req.user._id,
      dedupeKey: `friend_request:${request.id}`,
    });

    res.status(201).json({ success: true, request });
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    next(err);
  }
};

/** GET /api/friends/requests */
const listRequests = async (req, res, next) => {
  try {
    const incoming = await FriendRequest.listIncoming(req.user._id);
    const outgoing = await FriendRequest.listOutgoing(req.user._id);
    res.json({ success: true, incoming, outgoing });
  } catch (err) {
    next(err);
  }
};

/** POST /api/friends/requests/:id/accept */
const acceptFriendRequest = async (req, res, next) => {
  try {
    const { request, conversation } = await FriendRequest.acceptRequest(req.params.id, req.user._id);

    // Real-time events to both participants
    emitToUsers([request.senderId, req.user._id], "friendRequestAccepted", { request, conversation });
    emitToUsers([request.senderId, req.user._id], "conversationAdded", { conversationId: conversation.id });

    // Notification to sender
    await notifications.notify([request.senderId], {
      type: "friend_request_accepted",
      title: `${req.user.username} accepted your message request`,
      data: { conversationId: conversation.id, userId: req.user._id },
      actorId: req.user._id,
      dedupeKey: `friend_request_accepted:${request.id}`,
    });

    res.json({ success: true, request, conversation });
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    next(err);
  }
};

/** POST /api/friends/requests/:id/reject */
const rejectFriendRequest = async (req, res, next) => {
  try {
    const request = await FriendRequest.rejectRequest(req.params.id, req.user._id);
    emitToUsers([request.senderId, req.user._id], "friendRequestRejected", { requestId: request.id });
    res.json({ success: true, request });
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    next(err);
  }
};

/** POST /api/friends/requests/:id/cancel */
const cancelFriendRequest = async (req, res, next) => {
  try {
    const request = await FriendRequest.cancelRequest(req.params.id, req.user._id);
    emitToUsers([request.receiverId, req.user._id], "friendRequestCanceled", { requestId: request.id });
    res.json({ success: true, request });
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    next(err);
  }
};

/** GET /api/friends */
const listFriends = async (req, res, next) => {
  try {
    const friends = await FriendRequest.listAcceptedFriends(req.user._id);
    res.json({ success: true, count: friends.length, friends });
  } catch (err) {
    next(err);
  }
};

/** GET /api/friends/status/:userId */
const getRelationshipStatus = async (req, res, next) => {
  try {
    const status = await FriendRequest.getRelationshipStatus(req.user._id, req.params.userId);
    res.json({ success: true, ...status });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  sendFriendRequest,
  listRequests,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  listFriends,
  getRelationshipStatus,
};
