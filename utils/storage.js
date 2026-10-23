const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

/**
 * Local disk storage for uploads (replaces Cloudinary).
 * Files live in UPLOAD_DIR (a Docker volume in production) and are served at /uploads.
 */
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "../uploads"));

const publicBaseUrl = (req) =>
  (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

const safeExtension = (originalName = "", mimetype = "") => {
  const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (ext && ext.length <= 10) return ext;
  const subtype = (mimetype.split("/")[1] || "").replace(/[^a-z0-9]/g, "");
  return subtype ? `.${subtype.slice(0, 8)}` : "";
};

/**
 * Saves a multer memory file under `folder` and returns { url, publicId }.
 * publicId is the path relative to UPLOAD_DIR, used later for deletion.
 */
const saveFile = async (req, file, folder) => {
  const dir = path.join(UPLOAD_DIR, folder);
  await fs.mkdir(dir, { recursive: true });

  const fileName = `${crypto.randomUUID()}${safeExtension(file.originalname, file.mimetype)}`;
  await fs.writeFile(path.join(dir, fileName), file.buffer);

  const publicId = `${folder}/${fileName}`;
  return { url: `${publicBaseUrl(req)}/uploads/${publicId}`, publicId };
};

/**
 * Resolves a publicId to an absolute path, refusing anything outside UPLOAD_DIR.
 */
const resolvePublicId = (publicId) => {
  const target = path.resolve(UPLOAD_DIR, String(publicId || ""));
  return target.startsWith(UPLOAD_DIR + path.sep) ? target : null;
};

const publicIdFromUrl = (url) => {
  const marker = "/uploads/";
  const index = String(url || "").indexOf(marker);
  return index === -1 ? null : decodeURIComponent(url.slice(index + marker.length).split("?")[0]);
};

/**
 * Deletes a stored file. Returns true if a file was removed.
 */
const deleteFile = async (publicId) => {
  const target = resolvePublicId(publicId);
  if (!target) return false;
  try {
    await fs.unlink(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const deleteFileByUrl = (url) => deleteFile(publicIdFromUrl(url));

module.exports = { UPLOAD_DIR, saveFile, deleteFile, deleteFileByUrl };
