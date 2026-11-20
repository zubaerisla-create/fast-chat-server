#!/usr/bin/env node
/**
 * Grants the app owner permanent Games Lifetime access and the super admin role, bound to the
 * account's immutable user id (not to an email typed into the app).
 *
 *   node scripts/provision-owner.js --email <owner email>   (looks the account up once)
 *   node scripts/provision-owner.js --id <user uuid>
 *
 * Run it on the server against the target database (DATABASE_URL from .env). Idempotent.
 */
require("dotenv").config();
const { query, pool } = require("../config/db");
const { provisionOwner } = require("../services/adminRoles");

(async () => {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  let id = get("--id");
  const email = get("--email");
  if (!id && email) {
    const { rows } = await query(`SELECT id FROM users WHERE email = lower($1)`, [email.trim()]);
    if (!rows.length) throw new Error("No account with that email. Register it in the app first, then run this again.");
    id = rows[0].id;
  }
  if (!id) throw new Error("Pass --email <address> or --id <uuid>");
  const owner = await provisionOwner(id);
  console.log(`Owner provisioned: user ${owner.id} — Games Lifetime (owner) + super_admin`);
  console.log(`Optional: set OWNER_USER_ID=${owner.id} in the server .env so it is re-checked at every start.`);
  await pool.end();
})().catch(async (e) => {
  console.error(e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
