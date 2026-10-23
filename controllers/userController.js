const User = require("../models/User");
const { saveFile, deleteFileByUrl } = require("../utils/storage");
const { isValidExpoPushToken } = require("../services/pushNotificationService");

/**
 * GET /api/users
 * Get all users except the currently logged-in user.
 */
const getAllUsers = async (req, res, next) => {
  try {
    const users = await User.listExcept(req.user._id);

    res.status(200).json({ success: true, count: users.length, users });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/users/search?query=...
 * Search users by username or email (case-insensitive).
 * Excludes the current user from results.
 */
const searchUsers = async (req, res, next) => {
  try {
    const { query } = req.query;

    if (!query || query.trim() === "") {
      return res
        .status(400)
        .json({ success: false, message: "Search query is required." });
    }

    const users = await User.search(req.user._id, query.trim());

    res.status(200).json({ success: true, count: users.length, users });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/users/:id
 * Get a single user's public profile by ID.
 */
const getUserById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    res.status(200).json({ success: true, user: User.toPublic(user) });
  } catch (error) {
    next(error);
  }
};


/**
 * PUT /api/users/profile
 * Update user profile (username, avatar).
 * Returns updated user including email.
 */
const updateProfile = async (req, res, next) => {
  try {
    const { username } = req.body;
    const updates = {};

    if (username && username.trim() !== req.user.username) {
      const trimmed = username.trim();
      if (!/^[a-zA-Z0-9._]{3,30}$/.test(trimmed)) {
        return res.status(400).json({
          success: false,
          message: "Username must be 3–30 characters: letters, numbers, dots or underscores.",
        });
      }
      const caseChangeOnly = trimmed.toLowerCase() === req.user.username.toLowerCase();
      if (!caseChangeOnly && (await User.usernameExists(trimmed))) {
        return res.status(409).json({ success: false, message: "This username is already taken." });
      }
      updates.username = trimmed;
    }

    // Handle avatar upload if a file is provided
    if (req.file) {
      const { url } = await saveFile(req, req.file, "profile-avatars");
      updates.avatar = url;
    }

    const updatedUser = await User.update(req.user._id, updates);

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // Remove the previous avatar file once the new one is saved
    if (updates.avatar && req.user.avatar) {
      deleteFileByUrl(req.user.avatar).catch((err) => console.error("Old avatar cleanup failed:", err.message));
    }

    res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      user: User.toPublic(updatedUser),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/users/push-token
 * Save or update the authenticated user's Expo push token.
 * Body: { expoPushToken: string }
 */
const savePushToken = async (req, res, next) => {
  try {
    const { expoPushToken } = req.body;

    if (!expoPushToken) {
      return res.status(400).json({ success: false, message: "expoPushToken is required." });
    }

    if (!isValidExpoPushToken(expoPushToken)) {
      return res.status(400).json({ success: false, message: "Invalid Expo push token format." });
    }

    await User.update(req.user._id, { expoPushToken });

    res.status(200).json({ success: true, message: "Push token saved successfully." });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/users/push-token
 * Remove the authenticated user's Expo push token (e.g. on logout).
 */
const removePushToken = async (req, res, next) => {
  try {
    await User.update(req.user._id, { expoPushToken: null });

    res.status(200).json({ success: true, message: "Push token removed successfully." });
  } catch (error) {
    next(error);
  }
};

module.exports = { getAllUsers, searchUsers, getUserById, updateProfile, savePushToken, removePushToken };
