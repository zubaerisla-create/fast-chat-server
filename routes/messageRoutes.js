const express = require("express");
const m = require("../controllers/messageController");
const { protect } = require("../middleware/authMiddleware");
const multer = require("multer");

const router = express.Router();

// Multer setup for voice messages
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = ["audio/webm", "audio/mpeg", "audio/wav", "audio/mp3", "audio/ogg", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac"];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only audio files (webm, mp3, wav, ogg) are allowed for voice messages."), false);
        }
    },
});

// All message routes require authentication
router.use(protect);

router.post("/", m.sendMessage);
router.post("/voice", upload.single("audio"), m.uploadVoiceMessage);
router.get("/search", m.searchMessages); // ?q=&conversationId=
router.get("/bookmarks", m.listBookmarks);
router.patch("/:conversationId/mark-read", m.markMessagesAsRead);
router.get("/:conversationId/read-receipts", m.getReadReceipts);
router.get("/:conversationId/pins", m.listPins);
router.patch("/:messageId/react", m.reactToMessage);
router.post("/:messageId/forward", m.forwardMessage);
router.post("/:messageId/pin", m.pinMessage);
router.delete("/:messageId/pin", m.unpinMessage);
router.post("/:messageId/bookmark", m.toggleBookmark);
router.post("/:messageId/report", m.reportMessage);
router.post("/:messageId/task", require("../controllers/taskController").taskFromMessage);
router.get("/:conversationId", m.getMessages); // ?limit=&before= for cursor pages
router.patch("/:messageId", m.editMessage);
router.delete("/:messageId", m.deleteMessage);

module.exports = router;
