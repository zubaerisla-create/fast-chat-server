const express = require("express");
const s = require("../controllers/socialController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(protect);
router.get("/", s.listNotifications);
router.post("/read", s.markNotificationsRead);
router.get("/preferences", s.getPreferences);
router.put("/preferences/:category", s.setPreference);
module.exports = router;
