const bcrypt = require("bcryptjs");
const { query } = require("../config/db");

const SALT_ROUNDS = 10;

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

/**
 * Maps a users row to the API shape (keeps Mongo-style `_id` for the app).
 * Password hash is never included.
 */
const fromRow = (row) =>
  row && {
    _id: row.id,
    id: row.id,
    username: row.username,
    email: row.email,
    avatar: row.avatar,
    isOnline: row.is_online,
    lastSeen: row.last_seen,
    expoPushToken: row.expo_push_token,
    fcmToken: row.fcm_token,
    apnsVoipToken: row.apns_voip_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

/**
 * Public profile — safe to send to other users.
 */
const toPublic = (user) =>
  user && {
    _id: user._id,
    id: user._id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    isOnline: user.isOnline,
    lastSeen: user.lastSeen,
    createdAt: user.createdAt,
  };

const findById = async (id) => {
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [id]);
  return fromRow(rows[0]);
};

const findByEmail = async (email) => {
  const { rows } = await query("SELECT * FROM users WHERE email = $1", [normalizeEmail(email)]);
  return fromRow(rows[0]);
};

const usernameExists = async (username) => {
  const { rowCount } = await query("SELECT 1 FROM users WHERE lower(username) = lower($1)", [username]);
  return rowCount > 0;
};

const create = async ({ username, email, password, avatar = "" }) => {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await query(
    `INSERT INTO users (username, email, password_hash, avatar)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [String(username).trim(), normalizeEmail(email), passwordHash, avatar]
  );
  return fromRow(rows[0]);
};

/**
 * Checks a plain password against the stored bcrypt hash.
 */
const verifyPassword = async (email, password) => {
  const { rows } = await query("SELECT * FROM users WHERE email = $1", [normalizeEmail(email)]);
  const row = rows[0];
  if (!row || !(await bcrypt.compare(password, row.password_hash))) return null;
  return fromRow(row);
};

const updatePassword = async (id, password) => {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await query("UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1", [id, passwordHash]);
};

const UPDATABLE = {
  username: "username",
  avatar: "avatar",
  isOnline: "is_online",
  lastSeen: "last_seen",
  expoPushToken: "expo_push_token",
  fcmToken: "fcm_token",
  apnsVoipToken: "apns_voip_token",
};

/**
 * Updates the given camelCase fields and returns the updated user.
 */
const update = async (id, fields) => {
  const sets = [];
  const values = [id];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (fields[key] !== undefined) {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findById(id);

  const { rows } = await query(
    `UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    values
  );
  return fromRow(rows[0]);
};

const listExcept = async (id) => {
  const { rows } = await query("SELECT * FROM users WHERE id <> $1 ORDER BY username", [id]);
  return rows.map(fromRow).map(toPublic);
};

/**
 * Case-insensitive substring search on username or email.
 */
const search = async (excludeId, term) => {
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const { rows } = await query(
    `SELECT * FROM users
     WHERE id <> $1 AND (username ILIKE $2 OR email ILIKE $2)
     ORDER BY username LIMIT 50`,
    [excludeId, pattern]
  );
  return rows.map(fromRow).map(toPublic);
};

module.exports = {
  normalizeEmail,
  fromRow,
  toPublic,
  findById,
  findByEmail,
  usernameExists,
  create,
  verifyPassword,
  updatePassword,
  update,
  listExcept,
  search,
};
