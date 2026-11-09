const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  sendFriendRequest,
  listRequests,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  listFriends,
  getRelationshipStatus,
} = require("../controllers/friendController");

router.post("/requests", protect, sendFriendRequest);
router.get("/requests", protect, listRequests);
router.post("/requests/:id/accept", protect, acceptFriendRequest);
router.post("/requests/:id/reject", protect, rejectFriendRequest);
router.post("/requests/:id/cancel", protect, cancelFriendRequest);
router.get("/status/:userId", protect, getRelationshipStatus);
router.get("/", protect, listFriends);

module.exports = router;
