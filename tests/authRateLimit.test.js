const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
require("./helpers");
const authRoutes = require("../routes/authRoutes");
const { pool } = require("../config/db");

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const login = (email) =>
  fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "wrong" }) });

test("login is limited per email address, without affecting other accounts", async () => {
  for (let i = 0; i < 10; i++) assert.notEqual((await login("Target@Example.test")).status, 429);
  assert.equal((await login("target@example.test")).status, 429, "case-insensitive key");
  assert.notEqual((await login("someone.else@example.test")).status, 429);
});
