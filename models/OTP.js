const crypto = require("crypto");
const { query } = require("../config/db");

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

const hashCode = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");

/**
 * Seconds the caller must still wait before a new code can be sent (0 = allowed).
 */
const cooldownRemaining = async (email, purpose) => {
  const { rows } = await query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) AS age
     FROM otps WHERE email = $1 AND purpose = $2
     ORDER BY created_at DESC LIMIT 1`,
    [email, purpose]
  );
  if (!rows[0]) return 0;
  return Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - Number(rows[0].age)));
};

/**
 * Creates a fresh 6-digit code, replacing any previous one for this email/purpose.
 * Returns the plain code (only the hash is stored).
 */
const issue = async (email, purpose) => {
  const code = crypto.randomInt(100000, 1000000).toString();
  await query("DELETE FROM otps WHERE email = $1 AND purpose = $2", [email, purpose]);
  await query(
    `INSERT INTO otps (email, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + make_interval(mins => $4))`,
    [email, purpose, hashCode(code), OTP_TTL_MINUTES]
  );
  return code;
};

/**
 * Checks a code. Returns { ok: true } or { ok: false, message }.
 * Wrong guesses count toward MAX_ATTEMPTS, after which the code is burned.
 */
const verify = async (email, purpose, code) => {
  const { rows } = await query(
    `SELECT id, code_hash, attempts, expires_at < NOW() AS expired
     FROM otps WHERE email = $1 AND purpose = $2
     ORDER BY created_at DESC LIMIT 1`,
    [email, purpose]
  );
  const record = rows[0];

  if (!record || record.expired) {
    return { ok: false, message: "Code expired or not found. Please request a new one." };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    return { ok: false, message: "Too many wrong attempts. Please request a new code." };
  }
  if (record.code_hash !== hashCode(code)) {
    await query("UPDATE otps SET attempts = attempts + 1 WHERE id = $1", [record.id]);
    return { ok: false, message: "Invalid verification code." };
  }
  return { ok: true };
};

const consume = (email, purpose) =>
  query("DELETE FROM otps WHERE email = $1 AND purpose = $2", [email, purpose]);

module.exports = { OTP_TTL_MINUTES, cooldownRemaining, issue, verify, consume };
