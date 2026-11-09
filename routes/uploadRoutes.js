const express = require("express");
const multer = require("multer");
const { uploadFile, deleteUploadedFile } = require("../controllers/uploadController");
const { protect } = require("../middleware/authMiddleware");
const { loadEntitlement } = require("../middleware/entitlementMiddleware");

const router = express.Router();

// Store file in memory — we stream it to Cloudinary immediately
const storage = multer.memoryStorage();

// The size limit depends on the user's plan (25 MB on Free; see config/plans.js)
const uploadFor = (maxFileBytes) => multer({
    storage,
    limits: { fileSize: maxFileBytes },
    fileFilter: (_req, file, cb) => {
        // Allow images, videos, PDFs, docs, zip
        const allowed = [
            "image/",
            "video/",
            "audio/",
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/zip",
            "text/plain",
        ];
        const ok = allowed.some((t) => file.mimetype.startsWith(t));
        if (ok) return cb(null, true);
        cb(new Error("File type not allowed."));
    },
});

// POST /api/upload — authenticated
router.post("/", protect, loadEntitlement, (req, res, next) => {
    const { maxFileBytes } = req.entitlement.limits;
    uploadFor(maxFileBytes).single("file")(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
            const mb = Math.round(maxFileBytes / (1024 * 1024));
            return res.status(413).json({
                success: false,
                code: "file_too_large",
                message: `Files can be up to ${mb} MB on your plan.`,
            });
        }
        if (err instanceof multer.MulterError) {
            // A Multer error occurred when uploading (e.g. file too large)
            return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
        } else if (err) {
            // An unknown error occurred when uploading or filtered out
            return res.status(400).json({ success: false, message: err.message });
        }
        // Everything went fine — now check the plan's total storage
        require("../services/limits")
            .assertStorageAvailable(req.user._id, req.file?.size || 0)
            .then(() => next())
            .catch((e) => (require("../services/limits").sendLimitError(res, e) ? null : next(e)));
    });
}, uploadFile);

router.post("/delete", protect, deleteUploadedFile);

module.exports = router;
