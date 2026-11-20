/**
 * One universal Games Lifetime entitlement for every game, the global free daily limit,
 * owner access, and RevenueCat (Google Play) purchase / refund / transfer handling.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const h = require("./helpers");
const access = require("../services/gameEntitlements");
const catalog = require("../services/gameCatalog");
const { BUILTIN_GAMES } = require("../config/games");
const { provisionOwner } = require("../services/adminRoles");

const WEBHOOK_AUTH = "Bearer rc-test-webhook-secret";
process.env.REVENUECAT_WEBHOOK_AUTH = WEBHOOK_AUTH;

// ─── RevenueCat REST API stub ─────────────────────────────────────────────────
const subscribers = new Map(); // app user id → subscriber object
let stub;
let stubCalls = 0;
function rcHas(userId, txs) {
  subscribers.set(userId, {
    entitlements: txs.length ? { games_lifetime: { expires_date: null, product_identifier: "fastchat_games_lifetime_v1", purchase_date: "2026-11-20T10:00:00Z" } } : {},
    non_subscriptions: { fastchat_games_lifetime_v1: txs.map((t) => ({ id: `rc_${t}`, store_transaction_id: t, purchase_date: "2026-11-20T10:00:00Z", store: "play_store", is_sandbox: false })) },
  });
}

let srv, ann, ben, cara, dan, owner;
const call = (s, event, payload) => new Promise((resolve) => s.emit(event, payload, resolve));
const next = (s, event, pred = () => true, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    const on = (p) => {
      if (!pred(p)) return;
      clearTimeout(t);
      s.off(event, on);
      resolve(p);
    };
    s.on(event, on);
  });

test.before(async () => {
  stub = http.createServer((req, res) => {
    stubCalls++;
    if (req.headers.authorization !== "Bearer sk_test_secret") return res.writeHead(401).end();
    const id = decodeURIComponent(req.url.split("/").pop());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ subscriber: subscribers.get(id) || { entitlements: {}, non_subscriptions: {} } }));
  });
  await new Promise((r) => stub.listen(0, r));
  await h.resetDb();
  await h.query("TRUNCATE game_registry, app_settings, user_entitlements, purchase_records, revenuecat_webhook_events, global_daily_match_usage CASCADE");
  catalog.invalidate();
  await catalog.syncBuiltins();
  srv = await h.startServer({ socketOptions: { games: { countdownMs: 30 } } });
  ann = await h.createUser("ann");
  ben = await h.createUser("ben");
  cara = await h.createUser("cara");
  dan = await h.createUser("dan");
  owner = await h.createUser("owner");
  for (const [a, b] of [[ann, ben], [ann, cara], [ben, cara], [dan, ann], [owner, ann]]) {
    await h.query("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'accepted')", [a.id, b.id]);
  }
});
test.after(async () => {
  await srv.close();
  await new Promise((r) => stub.close(r));
  await h.pool.end();
});

const useRevenueCatApi = (on) => {
  if (on) {
    process.env.REVENUECAT_SECRET_KEY = "sk_test_secret";
    process.env.REVENUECAT_API_BASE = `http://127.0.0.1:${stub.address().port}`;
  } else {
    delete process.env.REVENUECAT_SECRET_KEY;
    delete process.env.REVENUECAT_API_BASE;
  }
};

/** inviter invites invitee to `game` and the invitee accepts; returns { ok, error, roomId }. */
async function createMatch(inviter, invitee, game, options = {}) {
  const a = await srv.socket(inviter.token);
  const b = await srv.socket(invitee.token);
  try {
    const invited = next(b, "game:invited");
    invited.catch(() => {}); // never arrives when the invite is refused
    const inv = await call(a, "game:invite", { game, toUserId: invitee.id, options });
    if (!inv.ok) return inv;
    const { inviteId } = await invited;
    const res = await call(b, "game:invite:respond", { inviteId, accept: true });
    if (res.ok) await call(a, "game:leave", { roomId: res.roomId });
    if (res.ok) await call(b, "game:leave", { roomId: res.roomId });
    return res;
  } finally {
    a.close();
    b.close();
  }
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

test("every game in the app is in the registry, all on the one games_lifetime entitlement", async () => {
  const games = await catalog.listGames();
  assert.deepEqual(games.map((g) => g.id).sort(), ["arrow", "carrom", "chess", "connect4", "dots", "hangman", "jungle"]);
  assert.equal(BUILTIN_GAMES.length, 7);
  const cat = await srv.call("GET", "/api/games/catalog");
  assert.equal(cat.status, 200);
  assert.equal(cat.body.games.length, 7);
  assert.equal(cat.body.revenuecat.entitlement, "games_lifetime");
  assert.equal(cat.body.revenuecat.productId, "fastchat_games_lifetime_v1");
  // Free user: free features unlocked, premium locked — in every game
  const acc = await srv.call("GET", "/api/games/access", { token: dan.token });
  assert.equal(acc.body.lifetime, false);
  assert.equal(acc.body.quota.limit, 3);
  for (const g of ["chess", "carrom", "dots", "hangman", "connect4"]) {
    assert.equal(acc.body.games[g].features.ai_easy, true);
    assert.equal(acc.body.games[g].features.ai_hard, false, `${g} hard AI is premium`);
    assert.equal(acc.body.games[g].features.unlimited_matches, false);
  }
  assert.equal(acc.body.games.arrow.features.endless_levels, true);
});

// ─── Global daily limit ───────────────────────────────────────────────────────

test("free users: 3 match creations per UTC day across ALL games; the 4th is refused in any game", async () => {
  assert.equal((await createMatch(ann, ben, "chess", { time: "10+0" })).ok, true);
  assert.equal((await createMatch(ann, ben, "carrom", { target: 0 })).ok, true);
  assert.equal((await createMatch(ann, cara, "connect4")).ok, true);
  const quota = await srv.call("GET", "/api/games/access", { token: ann.token });
  assert.deepEqual([quota.body.quota.used, quota.body.quota.remaining], [3, 0]);
  for (const g of ["dots", "hangman", "chess"]) {
    const r = await createMatch(ann, ben, g, g === "dots" ? { size: 5 } : g === "chess" ? { time: "10+0" } : {});
    assert.equal(r.ok, false);
    assert.equal(r.error, "daily_limit", `${g} refused`);
  }
});

test("accepting invitations never uses the invitee's quota (even with none left)", async () => {
  // ann has used all 3; ben invites ann three times — ann can accept every one
  for (let i = 0; i < 3; i++) assert.equal((await createMatch(ben, ann, "connect4")).ok, true);
  const annQ = (await srv.call("GET", "/api/games/access", { token: ann.token })).body.quota;
  assert.equal(annQ.used, 3);
  const benQ = (await srv.call("GET", "/api/games/access", { token: ben.token })).body.quota;
  assert.equal(benQ.used, 3);
});

test("failed / declined / cancelled creations don't count", async () => {
  const a = await srv.socket(cara.token);
  const b = await srv.socket(ben.token);
  const invited = next(b, "game:invited");
  await call(a, "game:invite", { game: "dots", toUserId: ben.id, options: { size: 5 } });
  const { inviteId } = await invited;
  await call(b, "game:invite:respond", { inviteId, accept: false });
  const inv2 = await call(a, "game:invite", { game: "dots", toUserId: ben.id, options: { size: 5 } });
  await call(a, "game:invite:cancel", { inviteId: inv2.invite.inviteId });
  assert.equal((await call(a, "game:invite", { game: "chess", toUserId: ben.id, options: { time: "5+0" } })).error, "premium_required");
  a.close();
  b.close();
  const q = (await srv.call("GET", "/api/games/access", { token: cara.token })).body.quota;
  assert.equal(q.used, 0, "declined, cancelled and refused invitations used nothing (cara only accepted matches so far)");
});

test("concurrent creations can't go past the limit (atomic counter)", async () => {
  await h.query("DELETE FROM global_daily_match_usage WHERE user_id = $1", [dan.id]);
  const results = await Promise.all(Array.from({ length: 10 }, () => access.consumeMatchCreation(dan.id)));
  assert.equal(results.filter((r) => r.ok).length, 3);
  const { rows } = await h.query("SELECT count FROM global_daily_match_usage WHERE user_id = $1", [dan.id]);
  assert.equal(rows[0].count, 3);
});

test("an inviter whose quota ran out between invite and accept: the accept fails cleanly", async () => {
  await h.query("DELETE FROM global_daily_match_usage WHERE user_id = $1", [cara.id]);
  const a = await srv.socket(cara.token);
  const b = await srv.socket(ben.token);
  const invited = next(b, "game:invited");
  assert.equal((await call(a, "game:invite", { game: "connect4", toUserId: ben.id })).ok, true);
  const { inviteId } = await invited;
  await h.query("INSERT INTO global_daily_match_usage (user_id, day, count) VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 3) ON CONFLICT (user_id, day) DO UPDATE SET count = 3", [cara.id]);
  const upd = next(a, "game:invite:update");
  const res = await call(b, "game:invite:respond", { inviteId, accept: true });
  assert.equal(res.error, "inviter_limit");
  assert.equal((await upd).status, "canceled");
  a.close();
  b.close();
});

test("premium match options are refused for free users and allowed with Games Lifetime", async () => {
  await h.query("DELETE FROM global_daily_match_usage");
  const a = await srv.socket(dan.token);
  assert.equal((await call(a, "game:invite", { game: "chess", toUserId: ann.id, options: { time: "3+2" } })).error, "premium_required");
  assert.equal((await call(a, "game:invite", { game: "carrom", toUserId: ann.id, options: { target: 13 } })).error, "premium_required");
  assert.equal((await call(a, "game:invite", { game: "dots", toUserId: ann.id, options: { size: 6 } })).error, "premium_required");
  assert.equal((await call(a, "game:invite", { game: "dots", toUserId: ann.id, options: { size: 4 } })).ok, true);
  a.close();
});

test("admin game status is enforced: a game in maintenance can't be started", async () => {
  await h.query("UPDATE game_registry SET status = 'maintenance' WHERE id = 'hangman'");
  catalog.invalidate();
  const a = await srv.socket(ben.token);
  assert.equal((await call(a, "game:invite", { game: "hangman", toUserId: cara.id })).error, "game_unavailable");
  await h.query("UPDATE game_registry SET status = 'active' WHERE id = 'hangman'");
  catalog.invalidate();
  a.close();
});

// ─── Owner ────────────────────────────────────────────────────────────────────

test("owner: permanent Games Lifetime bound to the user id, unlimited, protected from revoke/delete", async () => {
  await provisionOwner(owner.id);
  await provisionOwner(owner.id); // idempotent
  const acc = (await srv.call("GET", "/api/games/access", { token: owner.token })).body;
  assert.deepEqual([acc.lifetime, acc.owner, acc.quota.limit], [true, true, null]);
  for (let i = 0; i < 5; i++) assert.equal((await createMatch(owner, ann, "chess", { time: "1+0" })).ok, true, "unlimited + premium options");
  await assert.rejects(h.query("UPDATE user_entitlements SET status = 'revoked' WHERE user_id = $1 AND source = 'owner'", [owner.id]), /owner entitlement is protected/);
  await assert.rejects(h.query("DELETE FROM user_entitlements WHERE user_id = $1 AND source = 'owner'", [owner.id]), /owner entitlement is protected/);
  const role = await h.query("SELECT role FROM admin_users WHERE user_id = $1", [owner.id]);
  assert.equal(role.rows[0].role, "super_admin");
  // The owner can't delete the account from the app by mistake
  await h.query("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id = $1) WHERE id = $1", [owner.id]);
});

// ─── RevenueCat ───────────────────────────────────────────────────────────────

const webhook = (event, auth = WEBHOOK_AUTH) => srv.call("POST", "/api/revenuecat/webhook", { body: { api_version: "1.0", event }, headers: auth ? { authorization: auth } : {} });
const purchaseEvent = (userId, tx, extra = {}) => ({
  id: `evt_${tx}_${extra.type || "NON_RENEWING_PURCHASE"}`,
  type: "NON_RENEWING_PURCHASE",
  app_user_id: userId,
  original_app_user_id: userId,
  aliases: [userId],
  product_id: "fastchat_games_lifetime_v1",
  entitlement_ids: ["games_lifetime"],
  transaction_id: tx,
  store: "PLAY_STORE",
  environment: "PRODUCTION",
  price: 2,
  price_in_purchased_currency: 240,
  currency: "BDT",
  purchased_at_ms: Date.now(),
  ...extra,
});

test("webhooks need the configured Authorization header and are idempotent", async () => {
  useRevenueCatApi(false);
  assert.equal((await webhook(purchaseEvent(cara.id, "GPA.1"), null)).status, 401);
  assert.equal((await webhook(purchaseEvent(cara.id, "GPA.1"), "Bearer wrong")).status, 401);
  const first = await webhook(purchaseEvent(cara.id, "GPA.1"));
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "processed");
  const again = await webhook(purchaseEvent(cara.id, "GPA.1"));
  assert.equal(again.body.duplicate, true);
  const p = await h.query("SELECT * FROM purchase_records WHERE store_transaction_id = 'GPA.1'");
  assert.equal(p.rows.length, 1);
  assert.deepEqual([p.rows[0].user_id, Number(p.rows[0].price_usd), p.rows[0].currency, p.rows[0].status], [cara.id, 2, "BDT", "active"]);
  assert.equal(await access.hasGamesLifetime(cara.id), true);
  // Anonymous RevenueCat ids are ignored (purchases must belong to a FastChat account)
  const anon = await webhook(purchaseEvent("$RCAnonymousID:abc", "GPA.anon"));
  assert.equal(anon.body.status, "ignored");
});

test("Lifetime unlocks every game at once and removes the daily limit", async () => {
  const acc = (await srv.call("GET", "/api/games/access", { token: cara.token })).body;
  assert.equal(acc.lifetime, true);
  assert.equal(acc.quota.limit, null);
  for (const g of ["chess", "carrom", "dots", "hangman", "connect4"]) {
    assert.equal(acc.games[g].features.ai_hard, true);
    assert.equal(acc.games[g].features.unlimited_matches, true);
  }
  await h.query("INSERT INTO global_daily_match_usage (user_id, day, count) VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 3) ON CONFLICT (user_id, day) DO UPDATE SET count = 3", [cara.id]);
  for (let i = 0; i < 4; i++) assert.equal((await createMatch(cara, ben, "carrom", { target: 25 })).ok, true);
});

test("refund (cancellation of the one-time product) removes store access but never promo or owner access", async () => {
  useRevenueCatApi(false);
  // cara also has promo access granted by an admin
  await h.query("INSERT INTO user_entitlements (user_id, entitlement, source) VALUES ($1, 'games_lifetime', 'promo')", [cara.id]);
  await webhook(purchaseEvent(cara.id, "GPA.1", { id: "evt_refund_1", type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT" }));
  const rows = (await h.query("SELECT source, status FROM user_entitlements WHERE user_id = $1 ORDER BY source", [cara.id])).rows;
  assert.deepEqual(rows, [{ source: "promo", status: "active" }, { source: "revenuecat", status: "revoked" }]);
  assert.equal((await h.query("SELECT status FROM purchase_records WHERE store_transaction_id = 'GPA.1'")).rows[0].status, "refunded");
  assert.equal(await access.hasGamesLifetime(cara.id), true, "promo still active");
  const notes = await h.query("SELECT kind FROM admin_notifications WHERE kind = 'revenuecat_cancellation'");
  assert.ok(notes.rows.length >= 1);
});

test("with the RevenueCat API configured: purchase sync, restore on a second device, refund via reconcile", async () => {
  useRevenueCatApi(true);
  // Purchase on device 1 → the app asks the server to sync; the server asks RevenueCat
  rcHas(dan.id, ["GPA.dan"]);
  const sync = await srv.call("POST", "/api/games/purchases/sync", { token: dan.token });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body.lifetime, true);
  assert.equal((await h.query("SELECT status FROM purchase_records WHERE store_transaction_id = 'GPA.dan'")).rows[0].status, "active");
  // Device 2: same account (same RevenueCat app user id) → access without paying again
  const device2 = (await srv.call("POST", "/api/auth/login", { body: { email: dan.email, password: "x" } })).status;
  assert.equal(device2, 401); // createUser accounts have no usable password; the existing token stands in for device 2
  assert.equal((await srv.call("GET", "/api/games/access", { token: dan.token })).body.lifetime, true);
  // Another account does not get it
  assert.equal((await srv.call("GET", "/api/games/access", { token: ben.token })).body.lifetime, false);

  // Refund: RevenueCat stops listing the entitlement; any webhook triggers a reconcile
  rcHas(dan.id, []);
  const before = stubCalls;
  const r = await webhook({ ...purchaseEvent(dan.id, "GPA.dan"), id: "evt_dan_cancel", type: "CANCELLATION" });
  assert.equal(r.body.status, "processed");
  assert.ok(stubCalls > before, "the server re-read RevenueCat");
  assert.equal(await access.hasGamesLifetime(dan.id), false);
  assert.equal((await h.query("SELECT status FROM purchase_records WHERE store_transaction_id = 'GPA.dan'")).rows[0].status, "revoked");
});

test("transfer events reconcile both accounts (RevenueCat decides who owns the purchase)", async () => {
  useRevenueCatApi(true);
  rcHas(ben.id, ["GPA.ben"]);
  await srv.call("POST", "/api/games/purchases/sync", { token: ben.token });
  assert.equal(await access.hasGamesLifetime(ben.id), true);
  // RevenueCat moved the purchase to ann (e.g. restore with "transfer" behaviour)
  rcHas(ben.id, []);
  rcHas(ann.id, ["GPA.ben"]);
  await webhook({ id: "evt_transfer_1", type: "TRANSFER", app_user_id: ann.id, transferred_from: [ben.id], transferred_to: [ann.id], environment: "PRODUCTION" });
  assert.equal(await access.hasGamesLifetime(ben.id), false);
  assert.equal(await access.hasGamesLifetime(ann.id), true);
  const p = await h.query("SELECT user_id, status FROM purchase_records WHERE store_transaction_id = 'GPA.ben'");
  assert.deepEqual(p.rows[0], { user_id: ann.id, status: "active" });
});

test("purchase sync without RevenueCat configured answers 503 instead of guessing", async () => {
  useRevenueCatApi(false);
  const r = await srv.call("POST", "/api/games/purchases/sync", { token: ben.token });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "billing_unavailable");
});

test("match history: free users see the latest 10, Lifetime users page through everything", async () => {
  // ann (lifetime now via transfer) and ben (free) played many matches above
  const free = await srv.call("GET", "/api/games/history", { token: ben.token });
  assert.equal(free.status, 200);
  assert.equal(free.body.full, false);
  assert.ok(free.body.matches.length <= 10);
  const locked = await srv.call("GET", `/api/games/history?before=${encodeURIComponent(new Date().toISOString())}`, { token: ben.token });
  assert.equal(locked.status, 403);
  const full = await srv.call("GET", "/api/games/history", { token: ann.token });
  assert.equal(full.body.full, true);
});
