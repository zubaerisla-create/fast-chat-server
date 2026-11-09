/**
 * Paddle Billing: checkout preparation, customer portal sessions and webhook fulfillment.
 *
 * Webhooks are the only way a Paddle subscription reaches our database:
 *   1. the raw body's signature is verified with the notification secret (never the API key)
 *   2. the event ID is recorded once in webhook_events (duplicates are acknowledged, not re-applied)
 *   3. subscription rows are upserted by Paddle ID, and an event older than the stored
 *      state (by Paddle's updated_at) never overwrites it
 *   4. a paid/completed transaction for the Advanced Lifetime price creates one
 *      lifetime_purchases row per transaction (never expires automatically)
 * Customers are linked to users only by our own checkout flow, never by matching emails.
 * The browser's "checkout completed" callback never grants access.
 */
const { Paddle, Environment } = require("@paddle/paddle-node-sdk");
const { query, withTransaction } = require("../config/db");
const { getBillingConfig } = require("../config/billing");
const { getEntitlement } = require("./entitlements");
const { getOffers, offerForPriceId } = require("./paddleCatalog");

let client;
let clientKey;
function getPaddle(config = getBillingConfig().paddle) {
  if (!config.enabled) throw Object.assign(new Error("Billing is not configured."), { status: 503 });
  if (!client || clientKey !== config.apiKey) {
    client = new Paddle(config.apiKey, {
      environment: config.environment === "production" ? Environment.production : Environment.sandbox,
    });
    clientKey = config.apiKey;
  }
  return client;
}
// Tests replace the SDK client with a stub
const setPaddleClientForTests = (stub) => {
  client = stub;
  clientKey = getBillingConfig().paddle.apiKey;
};

/** priceId → { key, plan, interval } for configured prices only ("lifetime" for Advanced). */
const planForPrice = (priceId, config) => offerForPriceId(priceId, config);

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

// ─── Checkout ────────────────────────────────────────────────────────────────

async function findOrCreateCustomer(user) {
  const { rows } = await query(
    "SELECT provider_customer_id FROM billing_customers WHERE user_id = $1 AND provider = 'paddle'",
    [user._id]
  );
  if (rows[0]) return rows[0].provider_customer_id;

  const paddle = getPaddle();
  // Reuse a Paddle customer with this exact email only if no other user is linked to it
  let customerId = null;
  const existing = paddle.customers.list({ email: [user.email] });
  const page = await existing.next();
  if (page.length) customerId = page[0].id;
  if (!customerId) customerId = (await paddle.customers.create({ email: user.email })).id;

  const inserted = await query(
    `INSERT INTO billing_customers (user_id, provider, provider_customer_id, email)
     VALUES ($1, 'paddle', $2, $3)
     ON CONFLICT (provider, provider_customer_id) DO NOTHING
     RETURNING provider_customer_id`,
    [user._id, customerId, user.email]
  );
  if (!inserted.rows[0]) throw httpError(409, "This billing account is already linked to another FastChat account. Please contact support.");
  return customerId;
}

/**
 * Creates a Paddle transaction for a validated, purchasable price. The browser opens
 * checkout with the returned transaction ID, so it can't change the price, customer or
 * custom data. Paid access is granted later, only by the verified webhook.
 */
async function createCheckout(user, priceId) {
  const config = getBillingConfig().paddle;
  if (!config.enabled) throw httpError(503, "Billing is not configured.");
  if (!config.checkoutEnabled) throw httpError(503, "Checkout is not open yet.");
  const match = planForPrice(priceId, config);
  if (!match) throw httpError(400, "Unknown price.");
  const offer = (await getOffers())[match.key];
  if (!offer?.available) throw httpError(503, "This plan isn't available to buy right now.", "offer_unavailable");

  const entitlement = await getEntitlement(user._id);
  if (entitlement.lifetime) {
    throw httpError(409, "You already have Advanced Lifetime access. There's nothing more to buy.", "already_lifetime");
  }
  const isLifetime = match.interval === "lifetime";
  // A subscriber may upgrade to Lifetime; they are told to cancel the subscription afterwards
  if (!isLifetime && entitlement.plan !== "free") {
    throw httpError(409, "You already have an active subscription. Manage or change it from your billing page.", "already_subscribed");
  }

  const customerId = await findOrCreateCustomer(user);
  const transaction = await getPaddle().transactions.create({
    items: [{ priceId, quantity: 1 }],
    customerId,
    customData: { userId: user._id, offer: match.key },
  });
  return {
    transactionId: transaction.id,
    plan: match.plan,
    interval: match.interval,
    hasActiveSubscription: isLifetime && entitlement.plan !== "free",
  };
}

async function createPortalSession(user) {
  const { rows } = await query(
    "SELECT provider_customer_id FROM billing_customers WHERE user_id = $1 AND provider = 'paddle'",
    [user._id]
  );
  if (!rows[0]) throw httpError(404, "You don't have a billing account yet.");
  const subs = await query(
    "SELECT provider_subscription_id FROM subscriptions WHERE user_id = $1 AND provider = 'paddle' AND status <> 'canceled'",
    [user._id]
  );
  const session = await getPaddle().customerPortalSessions.create(
    rows[0].provider_customer_id,
    subs.rows.map((r) => r.provider_subscription_id)
  );
  return { url: session.urls.general.overview };
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

async function upsertSubscription(db, sub) {
  const item = sub.items?.[0];
  const priceId = item?.price?.id || null;
  let match = planForPrice(priceId);
  if (match?.interval === "lifetime") match = null; // a one-time price can't be a subscription
  if (!match) console.warn(`[Paddle] Subscription ${sub.id} uses an unconfigured price ${priceId}`);

  const owner = await db.query(
    "SELECT user_id FROM billing_customers WHERE provider = 'paddle' AND provider_customer_id = $1",
    [sub.customerId]
  );
  const userId = owner.rows[0]?.user_id || null;
  if (!userId) console.warn(`[Paddle] Subscription ${sub.id} belongs to unlinked customer ${sub.customerId}`);

  const params = [
    userId,
    sub.id,
    sub.customerId,
    item?.price?.productId || null,
    priceId,
    match?.plan || null,
    match?.interval || null,
    sub.status,
    sub.currentBillingPeriod?.startsAt || null,
    sub.currentBillingPeriod?.endsAt || null,
    item?.trialDates?.startsAt || null,
    item?.trialDates?.endsAt || null,
    sub.scheduledChange?.action || null,
    sub.scheduledChange?.effectiveAt || null,
    sub.canceledAt || null,
    sub.updatedAt,
  ];
  // The WHERE clause drops events older than what we already stored (out-of-order delivery)
  const result = await db.query(
    `INSERT INTO subscriptions (user_id, provider, provider_subscription_id, provider_customer_id, product_id, price_id,
        plan, billing_interval, status, current_period_start, current_period_end, trial_start, trial_end,
        scheduled_change_action, scheduled_change_at, canceled_at, past_due_since, provider_updated_at)
     VALUES ($1, 'paddle', $2, $3, $4, $5, $6, $7, $8::varchar, $9, $10, $11, $12, $13, $14, $15,
        CASE WHEN $8::varchar = 'past_due' THEN NOW() END, $16)
     ON CONFLICT (provider, provider_subscription_id) DO UPDATE SET
        user_id = COALESCE(subscriptions.user_id, EXCLUDED.user_id),
        provider_customer_id = EXCLUDED.provider_customer_id,
        product_id = EXCLUDED.product_id,
        price_id = EXCLUDED.price_id,
        plan = EXCLUDED.plan,
        billing_interval = EXCLUDED.billing_interval,
        status = EXCLUDED.status,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        trial_start = EXCLUDED.trial_start,
        trial_end = EXCLUDED.trial_end,
        scheduled_change_action = EXCLUDED.scheduled_change_action,
        scheduled_change_at = EXCLUDED.scheduled_change_at,
        canceled_at = EXCLUDED.canceled_at,
        past_due_since = CASE
          WHEN EXCLUDED.status <> 'past_due' THEN NULL
          ELSE COALESCE(subscriptions.past_due_since, NOW()) END,
        provider_updated_at = EXCLUDED.provider_updated_at,
        updated_at = NOW()
     WHERE subscriptions.provider_updated_at <= EXCLUDED.provider_updated_at
     RETURNING id`,
    params
  );
  return result.rowCount ? "processed" : "ignored";
}

async function updateCustomer(db, customer) {
  const result = await db.query(
    "UPDATE billing_customers SET email = $2, updated_at = NOW() WHERE provider = 'paddle' AND provider_customer_id = $1",
    [customer.id, customer.email]
  );
  return result.rowCount ? "processed" : "ignored";
}

const toMinor = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

const ownerOfCustomer = async (db, customerId) => {
  if (!customerId) return null;
  const owner = await db.query("SELECT user_id FROM billing_customers WHERE provider = 'paddle' AND provider_customer_id = $1", [customerId]);
  return owner.rows[0]?.user_id || null;
};

// Paddle statuses meaning the money was collected
const PAID_TRANSACTION_STATUSES = ["paid", "completed"];

async function recordTransaction(db, txn) {
  const userId = await ownerOfCustomer(db, txn.customerId);
  const totals = txn.details?.totals || {};
  const priceIds = (txn.items || []).map((i) => i.price?.id).filter(Boolean);
  await db.query(
    `INSERT INTO billing_transactions (user_id, provider, provider_transaction_id, provider_subscription_id, provider_customer_id,
        price_id, status, currency_code, subtotal_minor, tax_minor, total_minor, billed_at)
     VALUES ($1, 'paddle', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (provider, provider_transaction_id) DO UPDATE SET
        status = EXCLUDED.status, total_minor = EXCLUDED.total_minor, billed_at = EXCLUDED.billed_at,
        user_id = COALESCE(billing_transactions.user_id, EXCLUDED.user_id),
        price_id = COALESCE(EXCLUDED.price_id, billing_transactions.price_id)`,
    [
      userId,
      txn.id,
      txn.subscriptionId,
      txn.customerId,
      priceIds[0] || null,
      txn.status,
      txn.currencyCode,
      toMinor(totals.subtotal),
      toMinor(totals.tax),
      toMinor(totals.grandTotal ?? totals.total),
      txn.billedAt,
    ]
  );
  // Remember the recurring amount (before tax) for MRR reporting
  if (txn.subscriptionId && totals.subtotal) {
    await db.query(
      "UPDATE subscriptions SET recurring_amount_minor = $2, currency_code = $3 WHERE provider = 'paddle' AND provider_subscription_id = $1",
      [txn.subscriptionId, toMinor(totals.subtotal), txn.currencyCode]
    );
  }

  // Advanced Lifetime: one-time price, no subscription. Granted once per paid transaction.
  const lifetimePriceId = getBillingConfig().paddle.prices.advanced_lifetime;
  const isLifetime = !txn.subscriptionId && lifetimePriceId && priceIds.includes(lifetimePriceId);
  if (isLifetime && PAID_TRANSACTION_STATUSES.includes(txn.status)) {
    if (!userId) console.warn(`[Paddle] Lifetime transaction ${txn.id} belongs to unlinked customer ${txn.customerId}`);
    await db.query(
      `INSERT INTO lifetime_purchases (user_id, provider, provider_transaction_id, provider_customer_id, price_id, plan,
          status, currency_code, total_minor, purchased_at)
       VALUES ($1, 'paddle', $2, $3, $4, 'advanced', 'active', $5, $6, COALESCE($7::timestamptz, NOW()))
       ON CONFLICT (provider, provider_transaction_id) DO UPDATE SET
          user_id = COALESCE(lifetime_purchases.user_id, EXCLUDED.user_id)`,
      [userId, txn.id, txn.customerId, lifetimePriceId, txn.currencyCode, toMinor(totals.grandTotal ?? totals.total), txn.billedAt]
    );
  }
  return "processed";
}

async function applyEvent(db, event) {
  const type = event.eventType;
  if (type.startsWith("subscription.")) return upsertSubscription(db, event.data);
  if (type === "customer.created" || type === "customer.updated") return updateCustomer(db, event.data);
  if (type === "transaction.completed" || type === "transaction.paid") return recordTransaction(db, event.data);
  return "ignored";
}

/**
 * Verifies and processes one webhook delivery.
 * Returns { status, body }: 2xx only after the event is safely stored, so Paddle retries failures.
 */
async function handlePaddleWebhook(rawBody, signature) {
  const config = getBillingConfig().paddle;
  if (!config.enabled) return { status: 503, body: { success: false, message: "Billing is not configured." } };
  if (!Buffer.isBuffer(rawBody) || !signature) return { status: 400, body: { success: false, message: "Missing signature." } };

  const body = rawBody.toString("utf8");
  const paddle = getPaddle();
  let valid = false;
  try {
    valid = await paddle.webhooks.isSignatureValid(body, config.webhookSecret, signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    console.warn("[Paddle] Webhook rejected: invalid signature");
    return { status: 401, body: { success: false, message: "Invalid signature." } };
  }

  // Signature is valid; a payload the SDK can't parse is a server-side problem, so answer
  // 5xx and let Paddle retry once it's fixed (never 401, which would hide the cause)
  let event;
  try {
    event = await paddle.webhooks.unmarshal(body, config.webhookSecret, signature);
  } catch (error) {
    console.error(`[Paddle] Signed webhook could not be parsed: ${error.message}`);
    return { status: 500, body: { success: false } };
  }
  if (!event) return { status: 401, body: { success: false, message: "Invalid signature." } };

  const claimed = await query(
    `INSERT INTO webhook_events (provider, event_id, event_type, status, occurred_at)
     VALUES ('paddle', $1, $2, 'received', $3)
     ON CONFLICT (provider, event_id) DO UPDATE SET status = 'received', error = NULL
       WHERE webhook_events.status IN ('failed', 'received')
     RETURNING id`,
    [event.eventId, event.eventType, event.occurredAt]
  );
  if (!claimed.rowCount) {
    console.log(`[Paddle] ${event.eventId} (${event.eventType}) already processed — duplicate ignored`);
    return { status: 200, body: { success: true, duplicate: true } };
  }

  try {
    const outcome = await withTransaction((db) => applyEvent(db, event));
    await query("UPDATE webhook_events SET status = $2, processed_at = NOW() WHERE provider = 'paddle' AND event_id = $1", [
      event.eventId,
      outcome,
    ]);
    console.log(`[Paddle] ${event.eventId} (${event.eventType}) → ${outcome}`);
    return { status: 200, body: { success: true } };
  } catch (error) {
    await query("UPDATE webhook_events SET status = 'failed', error = $2 WHERE provider = 'paddle' AND event_id = $1", [
      event.eventId,
      String(error.message).slice(0, 500),
    ]);
    console.error(`[Paddle] ${event.eventId} (${event.eventType}) failed: ${error.message}`);
    return { status: 500, body: { success: false } };
  }
}

module.exports = {
  getPaddle,
  setPaddleClientForTests,
  planForPrice,
  createCheckout,
  createPortalSession,
  handlePaddleWebhook,
};
