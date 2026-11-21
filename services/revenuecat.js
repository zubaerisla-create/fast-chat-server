/**
 * RevenueCat (Google Play) → FastChat Games Lifetime.
 *
 * The RevenueCat App User ID is always the FastChat user UUID (the app calls Purchases.logIn
 * with it), so a purchase belongs to the account on every device.
 *
 * Source of truth: RevenueCat's REST API (GET /v1/subscribers/:id with the secret key, which
 * only lives on this server). Webhooks are authenticated, stored once (idempotent by event id)
 * and then trigger a reconcile of every FastChat user they mention (purchaser, transfer source
 * and destination). Without a secret key configured, Games Lifetime webhook events are applied
 * directly (they are still authenticated); Fast Finance Pro is only ever granted from the API.
 *
 * Only `user_entitlements` rows with source 'revenuecat' are ever changed here — promo and
 * owner access are independent of store purchases and refunds.
 */
const crypto = require("crypto");
const { query, pool } = require("../config/db");
const { ENTITLEMENT, REVENUECAT } = require("../config/games");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const config = () => ({
  apiBase: (process.env.REVENUECAT_API_BASE || "https://api.revenuecat.com").replace(/\/$/, ""),
  secretKey: process.env.REVENUECAT_SECRET_KEY || process.env.REVENUECAT_SECRET_API_KEY || "",
  // REVENUECAT_WEBHOOK_AUTH_TOKEN is the older name used by the Finance webhook
  webhookAuth: process.env.REVENUECAT_WEBHOOK_AUTH || process.env.REVENUECAT_WEBHOOK_AUTH_TOKEN || "",
  productId: process.env.REVENUECAT_PRODUCT_ID || REVENUECAT.productId,
  entitlement: ENTITLEMENT,
  // Fast Finance Pro (Google Play subscriptions monthly / yearly + one-time lifetime)
  financeEntitlement: process.env.REVENUECAT_FINANCE_ENTITLEMENT || "finance_pro",
});

const isConfigured = () => !!config().secretKey;

/** Timing-safe check of the Authorization header RevenueCat sends with every webhook. */
function verifyWebhookAuth(header) {
  const expected = config().webhookAuth;
  if (!expected || typeof header !== "string") return false;
  const a = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const b = Buffer.from(expected.replace(/^Bearer\s+/i, ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function fetchSubscriber(appUserId) {
  const { apiBase, secretKey } = config();
  if (!secretKey) throw Object.assign(new Error("RevenueCat is not configured"), { code: "billing_unavailable" });
  const res = await fetch(`${apiBase}/v1/subscribers/${encodeURIComponent(appUserId)}`, {
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw Object.assign(new Error(`RevenueCat API ${res.status}`), { code: "billing_upstream" });
  return (await res.json()).subscriber || {};
}

async function userExists(id) {
  if (!UUID_RE.test(String(id || ""))) return false;
  const { rows } = await query(`SELECT 1 FROM users WHERE id = $1`, [id]);
  return rows.length > 0;
}

/** Sets the user's 'revenuecat' entitlement row; returns true when the state changed. */
async function setStoreEntitlement(client, userId, active, reference, reason) {
  const { rows } = await client.query(`SELECT status FROM user_entitlements WHERE user_id = $1 AND entitlement = $2 AND source = 'revenuecat' FOR UPDATE`, [userId, ENTITLEMENT]);
  const current = rows[0] ? rows[0].status : null;
  if (active) {
    await client.query(
      `INSERT INTO user_entitlements (user_id, entitlement, source, status, reference)
       VALUES ($1, $2, 'revenuecat', 'active', $3)
       ON CONFLICT (user_id, entitlement, source) DO UPDATE
         SET status = 'active', reference = COALESCE(EXCLUDED.reference, user_entitlements.reference),
             revoked_at = NULL, revoke_reason = NULL, updated_at = NOW(),
             granted_at = CASE WHEN user_entitlements.status = 'active' THEN user_entitlements.granted_at ELSE NOW() END`,
      [userId, ENTITLEMENT, reference || null]
    );
    return current !== "active";
  }
  if (current === "active") {
    await client.query(`UPDATE user_entitlements SET status = 'revoked', revoked_at = NOW(), revoke_reason = $3, updated_at = NOW() WHERE user_id = $1 AND entitlement = $2 AND source = 'revenuecat'`, [userId, ENTITLEMENT, reason || "store"]);
    return true;
  }
  return false;
}

async function upsertPurchase(client, p) {
  await client.query(
    `INSERT INTO purchase_records (user_id, rc_app_user_id, product_id, store, store_transaction_id, environment, price, currency, price_usd, status, purchased_at, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (store_transaction_id) DO UPDATE
       SET user_id = EXCLUDED.user_id, rc_app_user_id = EXCLUDED.rc_app_user_id,
           status = CASE WHEN EXCLUDED.status = 'active' AND purchase_records.status IN ('refunded', 'revoked') THEN purchase_records.status ELSE EXCLUDED.status END,
           price = COALESCE(EXCLUDED.price, purchase_records.price), currency = COALESCE(EXCLUDED.currency, purchase_records.currency),
           price_usd = COALESCE(EXCLUDED.price_usd, purchase_records.price_usd), raw = purchase_records.raw || EXCLUDED.raw, updated_at = NOW()`,
    [p.userId, p.appUserId, p.productId, p.store || "PLAY_STORE", p.transactionId, p.environment || "PRODUCTION", p.price ?? null, p.currency || null, p.priceUsd ?? null, p.status || "active", p.purchasedAt, JSON.stringify(p.raw || {})]
  );
}

async function notifyAdmins(kind, title, body, data = {}) {
  await query(`INSERT INTO admin_notifications (kind, title, body, data) VALUES ($1, $2, $3, $4)`, [kind, title, body, JSON.stringify(data)]).catch(() => {});
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Brings one user's store entitlement and purchase records in line with RevenueCat.
 * Returns { active, changed, purchases }.
 */
async function reconcileUser(userId) {
  const { productId, entitlement } = config();
  const sub = await fetchSubscriber(userId);
  const ent = sub.entitlements && sub.entitlements[entitlement];
  const active = !!ent && (!ent.expires_date || new Date(ent.expires_date) > new Date());
  const purchases = ((sub.non_subscriptions && sub.non_subscriptions[productId]) || []).filter((p) => p && (p.store_transaction_id || p.id));
  return withTx(async (client) => {
    for (const p of purchases) {
      await upsertPurchase(client, {
        userId,
        appUserId: userId,
        productId,
        store: p.store ? String(p.store).toUpperCase() : "PLAY_STORE",
        transactionId: p.store_transaction_id || p.id,
        environment: p.is_sandbox ? "SANDBOX" : "PRODUCTION",
        status: active ? "active" : "revoked",
        purchasedAt: p.purchase_date || new Date().toISOString(),
        raw: { rc: p },
      });
    }
    // Purchases RevenueCat no longer lists for this user (refund, revoke, transfer away)
    const listed = purchases.map((p) => p.store_transaction_id || p.id);
    const gone = await client.query(
      `UPDATE purchase_records SET status = CASE WHEN status = 'active' THEN 'revoked' ELSE status END, updated_at = NOW()
        WHERE user_id = $1 AND product_id = $2 AND status = 'active' AND NOT (store_transaction_id = ANY($3::text[]))
        RETURNING store_transaction_id`,
      [userId, productId, listed]
    );
    if (!active) await client.query(`UPDATE purchase_records SET status = 'revoked', updated_at = NOW() WHERE user_id = $1 AND product_id = $2 AND status = 'active'`, [userId, productId]);
    const changed = await setStoreEntitlement(client, userId, active, listed[0] || null, "revenuecat_reconcile");
    if (changed && !active) await notifyAdmins("entitlement_revoked", "Games Lifetime removed", `RevenueCat no longer lists Games Lifetime for user ${userId}.`, { userId, gone: gone.rows.map((r) => r.store_transaction_id) });
    return { active, changed, purchases: listed.length };
  });
}

/**
 * Fast Finance Pro from RevenueCat's subscriber record (never from what the app sends).
 * Active entitlement → 'active' (with the store expiry) or 'lifetime' (no expiry).
 * No active entitlement → a previous store-granted 'active'/'lifetime' becomes 'expired'
 * (the 7-day trial still applies while it lasts). Returns the evaluated access.
 */
async function reconcileFinance(userId, subscriber) {
  const { FinanceSubscription } = require("../models/FinanceSubscription");
  const { financeEntitlement } = config();
  const sub = subscriber || (await fetchSubscriber(userId));
  const ent = sub.entitlements && sub.entitlements[financeEntitlement];
  const active = !!ent && (!ent.expires_date || new Date(ent.expires_date) > new Date());
  const u = await query(`SELECT created_at FROM users WHERE id = $1`, [userId]);
  if (!u.rows.length) return null;
  await FinanceSubscription.getForUser(userId, u.rows[0].created_at); // creates the trial row if missing
  if (active) {
    const pid = String(ent.product_identifier || "").toLowerCase();
    const lifetime = !ent.expires_date;
    const plan = lifetime ? "lifetime" : /year|annual/.test(pid) ? "yearly" : "monthly";
    return FinanceSubscription.syncPurchase(userId, {
      plan,
      status: lifetime ? "lifetime" : "active",
      revenuecatCustomerId: userId,
      originalTransactionId: ent.product_identifier || null,
      currentPeriodEnd: lifetime ? null : ent.expires_date,
    });
  }
  await query(
    `UPDATE finance_subscriptions SET status = 'expired', updated_at = NOW()
      WHERE user_id = $1 AND status IN ('active', 'lifetime')`,
    [userId]
  );
  return FinanceSubscription.getForUser(userId, u.rows[0].created_at);
}

/** Direct application of an event (used when no secret key is configured). */
async function applyEvent(ev, userId) {
  const { productId, entitlement } = config();
  const tx = ev.store_transaction_id || ev.transaction_id || ev.original_transaction_id || ev.id;
  const forUs = (ev.entitlement_ids || []).includes(entitlement) || ev.product_id === productId;
  if (!forUs && ev.type !== "TRANSFER") return "ignored";
  return withTx(async (client) => {
    switch (ev.type) {
      case "INITIAL_PURCHASE":
      case "NON_RENEWING_PURCHASE":
      case "REFUND_REVERSED":
      case "TEMPORARY_ENTITLEMENT_GRANT":
        if (ev.type !== "TEMPORARY_ENTITLEMENT_GRANT") {
          await upsertPurchase(client, eventPurchase(ev, userId, "active"));
        }
        await setStoreEntitlement(client, userId, true, tx);
        return "processed";
      case "CANCELLATION":
      case "EXPIRATION":
        // For a one-time product a cancellation means a refund / revoke
        await client.query(`UPDATE purchase_records SET status = 'refunded', refunded_at = NOW(), updated_at = NOW() WHERE store_transaction_id = $1`, [tx]);
        await setStoreEntitlement(client, userId, false, tx, `revenuecat_${String(ev.type).toLowerCase()}${ev.cancel_reason ? `:${ev.cancel_reason}` : ""}`);
        return "processed";
      default:
        return "ignored";
    }
  });
}

function eventPurchase(ev, userId, status) {
  return {
    userId,
    appUserId: ev.app_user_id,
    productId: ev.product_id || config().productId,
    store: ev.store || "PLAY_STORE",
    transactionId: ev.store_transaction_id || ev.transaction_id || ev.original_transaction_id || ev.id,
    environment: ev.environment || "PRODUCTION",
    price: typeof ev.price_in_purchased_currency === "number" ? ev.price_in_purchased_currency : null,
    currency: ev.currency || null,
    priceUsd: typeof ev.price === "number" ? ev.price : null,
    status,
    purchasedAt: ev.purchased_at_ms ? new Date(ev.purchased_at_ms).toISOString() : new Date().toISOString(),
    raw: { event: { id: ev.id, type: ev.type } },
  };
}

/**
 * Handles one webhook body. Returns { status, duplicate }.
 * Throws on processing errors (the caller answers 500 so RevenueCat retries).
 */
async function handleWebhook(body) {
  const ev = body && body.event;
  if (!ev || typeof ev.id !== "string" || typeof ev.type !== "string") throw Object.assign(new Error("malformed event"), { code: "bad_request" });
  const inserted = await query(
    `INSERT INTO revenuecat_webhook_events (id, type, app_user_id, environment, payload) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [ev.id.slice(0, 120), ev.type.slice(0, 40), ev.app_user_id ? String(ev.app_user_id).slice(0, 120) : null, ev.environment || null, JSON.stringify(body)]
  );
  if (!inserted.rows.length) {
    const prev = await query(`SELECT status FROM revenuecat_webhook_events WHERE id = $1`, [ev.id]);
    if (prev.rows[0] && prev.rows[0].status !== "failed") return { status: prev.rows[0].status, duplicate: true };
  }
  const mark = (status, error = null) =>
    query(`UPDATE revenuecat_webhook_events SET status = $2, error = $3, processed_at = NOW() WHERE id = $1`, [ev.id, status, error ? String(error).slice(0, 500) : null]);

  try {
    if (ev.type === "TEST") {
      await mark("ignored");
      return { status: "ignored" };
    }
    // Every FastChat account this event touches (purchaser, aliases, transfer from/to)
    const ids = new Set([ev.app_user_id, ev.original_app_user_id, ...(ev.aliases || []), ...(ev.transferred_from || []), ...(ev.transferred_to || [])].filter(Boolean));
    const users = [];
    for (const id of ids) if (await userExists(id)) users.push(id);
    if (!users.length) {
      await mark("ignored", "no FastChat user in event");
      return { status: "ignored" };
    }
    // Keep the purchase details RevenueCat sends (price, currency) even when reconciling via the API
    if ((ev.type === "INITIAL_PURCHASE" || ev.type === "NON_RENEWING_PURCHASE") && (await userExists(ev.app_user_id)) && ev.product_id === config().productId) {
      await withTx((c) => upsertPurchase(c, eventPurchase(ev, ev.app_user_id, "active")));
    }
    if (isConfigured()) {
      for (const id of users) {
        await reconcileUser(id);
        // Same subscriber record also decides Fast Finance Pro (separate entitlement)
        await reconcileFinance(id);
      }
    } else if (ev.type === "TRANSFER") {
      for (const id of ev.transferred_from || []) if (await userExists(id)) await applyEvent({ ...ev, type: "CANCELLATION", cancel_reason: "TRANSFER" }, id);
      for (const id of ev.transferred_to || []) if (await userExists(id)) await applyEvent({ ...ev, type: "NON_RENEWING_PURCHASE" }, id);
    } else {
      const result = await applyEvent(ev, ev.app_user_id);
      if (result === "ignored") {
        await mark("ignored", "not a Games Lifetime event");
        return { status: "ignored" };
      }
    }
    if (ev.type === "CANCELLATION" || ev.type === "TRANSFER") await notifyAdmins(`revenuecat_${ev.type.toLowerCase()}`, ev.type === "TRANSFER" ? "Games Lifetime transferred" : "Games Lifetime refunded / cancelled", `RevenueCat ${ev.type} for ${[...ids].join(", ")}`, { eventId: ev.id });
    await mark("processed");
    return { status: "processed" };
  } catch (e) {
    await mark("failed", e.message);
    await notifyAdmins("webhook_failed", "RevenueCat webhook failed", e.message, { eventId: ev.id });
    throw e;
  }
}

module.exports = { config, isConfigured, verifyWebhookAuth, fetchSubscriber, reconcileUser, reconcileFinance, handleWebhook, UUID_RE };
