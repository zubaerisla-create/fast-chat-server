const express = require("express");
const c = require("../controllers/conversationController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(protect);

// Direct chats (original API)
router.post("/", c.createConversation);
router.get("/", c.getUserConversations); // ?type=direct|group|channel&archived=true
router.get("/search", c.searchConversations); // ?q=

// Groups
router.post("/groups", c.createGroup);
router.get("/join/:code", c.previewInvite);
router.post("/join/:code", c.joinByInvite);

router.get("/:id", c.getConversationById);
router.patch("/:id", c.updateGroup);
router.get("/:id/media", c.getConversationMedia);
router.patch("/:id/membership", c.updateMembership); // mute / pin / archive (per user)
router.post("/:id/members", c.addMembers);
router.delete("/:id/members/:userId", c.removeMember); // own id = leave
router.patch("/:id/members/:userId", c.setMemberRole);
router.post("/:id/invite-link", c.getInviteLink);

module.exports = router;
