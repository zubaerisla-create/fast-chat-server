/**
 * Seeds the STAGING (or local development) database with fake users,
 * conversations and messages. Refuses to run anywhere else.
 *   staging: docker exec -i fast-chat-staging-api-1 node - < seed-staging.js > seed-credentials.txt
 *   local:   FASTCHAT_ENV=development DATABASE_URL=… node deploy/staging/seed-staging.js > creds.txt
 * The generated test password goes to stdout only, so redirect it to a
 * private file instead of printing it.
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
const allowed =
  (process.env.FASTCHAT_ENV === "staging" && dbName.includes("staging")) ||
  (process.env.FASTCHAT_ENV === "development" && /_local$/.test(dbName));
if (!allowed) {
  console.error(`refusing to seed: FASTCHAT_ENV=${process.env.FASTCHAT_ENV} db=${dbName}`);
  process.exit(2);
}

const USERS = [
  "alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi",
].map((name) => ({ username: `${name}_test`, email: `${name}@example.com` }));

const LINES = [
  "Hey, how's it going?", "Did you see the latest build?", "Lunch at 1?",
  "Sending the file now", "Looks good to me 👍", "Can you review this?",
  "On my way", "Let's sync tomorrow", "Thanks!", "Ha, nice one 😄",
];

const main = async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const password = crypto.randomBytes(12).toString("base64url");
  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = [];
    for (const u of USERS) {
      const { rows } = await client.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [u.username, u.email, hash]
      );
      ids.push(rows[0].id);
    }

    let messages = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length && j <= i + 3; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        await client.query(
          `INSERT INTO conversations (user_a, user_b) VALUES ($1, $2)
           ON CONFLICT (user_a, user_b) DO NOTHING`,
          [a, b]
        );
        const { rows } = await client.query(
          `SELECT c.id, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)::int AS n
           FROM conversations c WHERE user_a = $1 AND user_b = $2`,
          [a, b]
        );
        if (rows[0].n > 0) continue;
        for (let k = 0; k < 60; k++) {
          await client.query(
            `INSERT INTO messages (conversation_id, sender_id, text, is_read, created_at)
             VALUES ($1, $2, $3, $4, NOW() - make_interval(mins => $5))`,
            [rows[0].id, k % 2 ? a : b, LINES[(k + i + j) % LINES.length], k > 2, (60 - k) * 37]
          );
          messages++;
        }
        await client.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [rows[0].id]);
      }
    }
    await client.query("COMMIT");
    console.error(`seeded ${ids.length} users, ${messages} new messages into ${dbName}`);
    console.log(`# Staging test accounts (fake). Password for all: ${password}`);
    for (const u of USERS) console.log(`${u.email}\t${u.username}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch((err) => {
  console.error("seed failed:", err.message);
  process.exit(1);
});
