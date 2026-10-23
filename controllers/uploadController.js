const { query } = require("../config/db");
const { saveFile, deleteFile } = require("../utils/storage");

/**
 * POST /api/upload
 * Upload a single image or file to server storage.
 * Expects multipart/form-data with field name "file".
 * Returns { url, publicId, fileType, fileName, fileSize }
 */
const uploadFile = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file provided." });
        }

        const { mimetype, originalname, size } = req.file;
        console.log(`📤 Starting upload: ${originalname} (${mimetype})`);

        let fileType = "file";
        if (mimetype.startsWith("image/")) {
            fileType = "image";
        } else if (mimetype.startsWith("video/")) {
            fileType = "video";
        } else if (mimetype.startsWith("audio/")) {
            fileType = "audio";
        }

        const { url, publicId } = await saveFile(req, req.file, "chat-files");
        console.log(`✅ Upload successful: ${url}`);

        return res.status(200).json({
            success: true,
            url,
            publicId,
            fileType,
            fileName: originalname,
            fileSize: size,
        });
    } catch (error) {
        console.error("uploadFile controller error:", error.message);
        next(error);
    }
};

/**
 * POST /api/upload/delete
 * Delete an uploaded file that was never attached to a message.
 * Body: { publicId }
 */
const deleteUploadedFile = async (req, res, next) => {
    try {
        const { publicId } = req.body;

        if (!publicId) {
            return res.status(400).json({ success: false, message: "Public ID is required." });
        }

        // Only unsent chat uploads may be deleted this way; files attached to a
        // message are removed together with the message.
        const { rowCount } = await query("SELECT 1 FROM messages WHERE file_url LIKE '%/uploads/' || $1", [publicId]);
        if (!String(publicId).startsWith("chat-files/") || rowCount > 0) {
            return res.status(403).json({ success: false, message: "This file cannot be deleted." });
        }

        console.log(`🗑️ Deleting uploaded file: ${publicId}`);
        await deleteFile(publicId);

        return res.status(200).json({ success: true, message: "File deleted successfully." });
    } catch (error) {
        console.error("deleteUploadedFile controller error:", error.message);
        next(error);
    }
};

module.exports = { uploadFile, deleteUploadedFile };
