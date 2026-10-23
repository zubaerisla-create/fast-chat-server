const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

/**
 * Shared PostgreSQL connection pool.
 * DATABASE_URL example: postgres://fastchat:secret@db:5432/fastchat
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
});

pool.on("error", (err) => {
  console.error("❌ Unexpected PostgreSQL pool error:", err.message);
});

const query = (text, params) => pool.query(text, params);

/**
 * Runs a callback inside a transaction, passing a dedicated client.
 */
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Connects to PostgreSQL and applies the idempotent schema.
 * Retries for a while so the API can start before the database container is ready.
 * Exits process on failure to prevent running without a database.
 */
const connectDB = async ({ retries = 15, delayMs = 2000 } = {}) => {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(schema);
      const { rows } = await pool.query("SELECT current_database() AS db");
      console.log(`✅ PostgreSQL connected: ${rows[0].db}`);
      return;
    } catch (error) {
      console.error(`❌ PostgreSQL connection attempt ${attempt}/${retries} failed: ${error.message}`);
      if (attempt === retries) process.exit(1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

module.exports = { pool, query, withTransaction, connectDB };
