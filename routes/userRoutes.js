const express = require("express");
const {
  getAllUsers,
  searchUsers,
  searchExactUsername,
  getUserById,
  updateProfile,
  savePushToken,
  removePushToken,
} = require("../controllers/userController");
const { protect } = require("../middleware/authMiddleware");
const social = require("../controllers/socialController");
const multer = require("multer");

// Multer setup for profile picture
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max for avatar
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only images are allowed for profile pictures."), false);
    }
  },
});

const router = express.Router();

// All user routes require authentication
router.use(protect);

// GET  /api/users              → get all users (excluding self)
// GET  /api/users/search?query → search by username or email
// GET  /api/users/:id          → get single user profile
// PUT  /api/users/profile      → update profile
// PUT  /api/users/push-token   → save Expo push token
// DELETE /api/users/push-token → remove Expo push token (logout)

// GET /api/users/me — the signed-in user, including their platform role
router.get("/me", (req, res) => {
  const User = require("../models/User");
  res.json({ success: true, user: { ...User.toPublic(req.user), role: req.user.role || "user" } });
});
router.get("/search/exact", searchExactUsername);
router.get("/search", searchUsers);
router.get("/blocked", social.listBlocked);
router.post("/:id/block", social.blockUser);
router.post("/:id/unblock", social.unblockUser);
router.delete("/:id/block", social.unblockUser);
router.put("/push-token", savePushToken);
router.delete("/push-token", removePushToken);
router.put("/profile", upload.single("avatar"), updateProfile);
router.get("/:id", getUserById);
router.get("/", getAllUsers);

module.exports = router;
