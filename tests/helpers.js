/**
 * Shared test setup. Tests run against a separate local database (fastchat_test by
 * default) and never touch the development or production databases.
 */
const crypto = require("crypto");
const os = require("os");
const path = require("path");

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://localhost/fastchat_test";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.MAIL_TRANSPORT = "log";
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `fastchat-test-uploads-${process.pid}`);
if (/fastchat_local|fastchat$|prod/i.test(process.env.DATABASE_URL)) {
  throw new Error(`Refusing to run tests against ${process.env.DATABASE_URL}`);
}

const fs = require("fs");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Paddle, Environment } = require("@paddle/paddle-node-sdk");
const { pool, query } = require("../config/db");
const { loadBillingConfig, setBillingConfigForTests } = require("../config/billing");

const WEBHOOK_SECRET = "pdl_ntfset_test_secret";
// Test price IDs, keyed like config/plans.js OFFERS
const PRICES = {
  starter_month: "pri_starter_month",
  starter_year: "pri_starter_year",
  pro_month: "pri_pro_month",
  pro_year: "pri_pro_year",
  advanced_lifetime: "pri_advanced_lifetime",
};

// What the stub Paddle API returns for each price (SDK camelCase shape). Mirrors the
// final live catalog: Starter $5/mo + $40/yr, Pro $8/mo + $40/yr, Advanced Lifetime $1,000.
const PRODUCTS = { starter: "pro_starter", pro: "pro_pro", advanced: "pro_advanced" };
const paddlePrice = (id, { amount, interval = null, trialDays = null, status = "active", currency = "USD", productId = PRODUCTS[id.split("_")[1]] }) => ({
  id,
  status,
  productId,
  unitPrice: { amount: String(amount), currencyCode: currency },
  billingCycle: interval ? { interval, frequency: 1 } : null,
  trialPeriod: trialDays ? { interval: "day", frequency: trialDays, requiresPaymentMethod: true } : null,
});
const defaultPaddlePrices = () => [
  paddlePrice(PRICES.starter_month, { amount: 500, interval: "month", trialDays: 7 }),
  paddlePrice(PRICES.starter_year, { amount: 4000, interval: "year", trialDays: 7 }),
  paddlePrice(PRICES.pro_month, { amount: 800, interval: "month", trialDays: 7 }),
  paddlePrice(PRICES.pro_year, { amount: 4000, interval: "year" }),
  paddlePrice(PRICES.advanced_lifetime, { amount: 100000 }),
];

const testEnv = (overrides = {}) => ({
  PADDLE_ENVIRONMENT: "sandbox",
  PADDLE_API_KEY: "pdl_sdbx_apikey_test",
  PADDLE_CLIENT_TOKEN: "test_clienttoken",
  PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PADDLE_CHECKOUT_ENABLED: "true",
  PADDLE_STARTER_MONTHLY_PRICE_ID: PRICES.starter_month,
  PADDLE_STARTER_YEARLY_PRICE_ID: PRICES.starter_year,
  PADDLE_PRO_MONTHLY_PRICE_ID: PRICES.pro_month,
  PADDLE_PRO_YEARLY_PRICE_ID: PRICES.pro_year,
  PADDLE_ADVANCED_LIFETIME_PRICE_ID: PRICES.advanced_lifetime,
  ...overrides,
});

const { clearPriceCacheForTests } = require("../services/paddleCatalog");
const useBillingEnv = (overrides) => {
  setBillingConfigForTests(loadBillingConfig(testEnv(overrides)));
  clearPriceCacheForTests();
};
useBillingEnv();

process.on("exit", () => fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }));

async function resetDb() {
  const schema = fs.readFileSync(path.join(__dirname, "../config/schema.sql"), "utf8");
  await query(schema);
  await query("TRUNCATE webhook_events, lifetime_purchases, billing_transactions, subscriptions, billing_customers, notifications, users RESTART IDENTITY CASCADE");
}

async function createUser(username, { role = "user" } = {}) {
  const { rows } = await query(
    "INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id",
    [username, `${username}@example.test`, role]
  );
  const id = rows[0].id;
  return { id, email: `${username}@example.test`, token: jwt.sign({ id }, process.env.JWT_SECRET) };
}

/** Direct conversation between two users, with membership rows (as the API creates it). */
async function directConversation(userA, userB) {
  const [a, b] = [userA, userB].sort();
  const id = (await query("INSERT INTO conversations (user_a, user_b) VALUES ($1, $2) RETURNING id", [a, b])).rows[0].id;
  await query("INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)", [id, a, b]);
  return id;
}

/** Same mounting order as server.js: raw webhook router before express.json. */
function buildApp() {
  const { billingRouter, billingWebhookRouter } = require("../routes/billingRoutes");
  const adminRoutes = require("../routes/adminRoutes");
  const uploadRoutes = require("../routes/uploadRoutes");
  const app = express();
  app.use("/api/billing/webhooks", billingWebhookRouter);
  app.use(express.json({ limit: "10kb" }));
  app.use("/api/billing", billingRouter);
  app.use("/api/admin", adminRoutes);
  app.use("/api/upload", uploadRoutes);
  app.use("/api/friends", require("../routes/friendRoutes"));
  app.use("/api/requests", require("../routes/friendRoutes"));
  app.use("/api/conversations", require("../routes/conversationRoutes"));
  app.use("/api/messages", require("../routes/messageRoutes"));
  app.use("/api/notifications", require("../routes/notificationRoutes"));
  app.use("/api/users", require("../routes/userRoutes"));
  {
    const { workspaces, organizations, invitations } = require("../routes/workspaceRoutes");
    app.use("/api/workspaces", workspaces);
    app.use("/api/organizations", organizations);
    app.use("/api/invitations", invitations);
  }
  app.use("/api/tasks", require("../routes/taskRoutes"));
  for (const [path, file] of extraRoutes) app.use(path, require(file));
  return app;
}

// Routes added by later phases register here so every test server mounts them
const extraRoutes = [];
const addRoutes = (path, file) => extraRoutes.push([path, file]);

/** HTTP API + Socket.IO (same handler as production) on a random port. */
async function startServer() {
  const http = require("http");
  const { Server } = require("socket.io");
  const server = http.createServer(buildApp());
  const io = new Server(server);
  require("../sockets/socketHandler").initializeSocket(io);
  require("../services/realtime").setIo(io);
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { token, body, headers = {}, raw } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, body: json };
  };
  const sockets = [];
  /** Authenticated socket.io client, connected and announced online. */
  const socket = async (token) => {
    const { io: connect } = require("socket.io-client");
    const s = connect(base, { auth: { token }, transports: ["websocket"], reconnection: false });
    sockets.push(s);
    await new Promise((res, rej) => {
      s.once("connect", res);
      s.once("connect_error", rej);
    });
    return s;
  };
  const close = async () => {
    sockets.forEach((s) => s.close());
    io.close();
    await new Promise((r) => server.close(() => r()));
  };
  return { server, base, call, socket, close };
}

// ─── Paddle webhook payloads (Paddle's real snake_case JSON) ─────────────────

const iso = (d) => new Date(d).toISOString();

function subscriptionPayload({ id = "sub_1", customerId = "ctm_1", status = "trialing", priceId = PRICES.starter_month, updatedAt, periodStart, periodEnd, trialEnd, scheduledChange = null, canceledAt = null }) {
  const now = Date.now();
  const interval = priceId.endsWith("year") ? "year" : "month";
  const start = iso(periodStart ?? now);
  const end = iso(periodEnd ?? now + 30 * 86400000);
  return {
    id,
    status,
    customer_id: customerId,
    address_id: "add_1",
    business_id: null,
    currency_code: "USD",
    created_at: start,
    updated_at: iso(updatedAt ?? now),
    started_at: start,
    first_billed_at: null,
    next_billed_at: end,
    paused_at: null,
    canceled_at: canceledAt,
    discount: null,
    collection_mode: "automatic",
    billing_details: null,
    current_billing_period: { starts_at: start, ends_at: end },
    billing_cycle: { interval, frequency: 1 },
    scheduled_change: scheduledChange,
    management_urls: null,
    items: [
      {
        status: status === "trialing" ? "trialing" : "active",
        quantity: 1,
        recurring: true,
        created_at: start,
        updated_at: start,
        previously_billed_at: null,
        next_billed_at: end,
        trial_dates: trialEnd ? { starts_at: start, ends_at: iso(trialEnd) } : null,
        price: {
          id: priceId,
          product_id: "pro_plan",
          description: "plan",
          name: null,
          type: "standard",
          billing_cycle: { interval, frequency: 1 },
          trial_period: { interval: "day", frequency: 7 },
          tax_mode: "account_setting",
          unit_price: { amount: "1000", currency_code: "USD" },
          unit_price_overrides: [],
          quantity: { minimum: 1, maximum: 1 },
          status: "active",
          custom_data: null,
          import_meta: null,
          created_at: start,
          updated_at: start,
        },
        product: {
          id: "pro_plan",
          name: "Plan",
          description: null,
          type: "standard",
          tax_category: "standard",
          image_url: null,
          custom_data: null,
          status: "active",
          import_meta: null,
          created_at: start,
          updated_at: start,
        },
      },
    ],
    custom_data: null,
    import_meta: null,
    next_transaction: null,
    recurring_transaction_details: null,
  };
}

let eventCounter = 0;
function event(eventType, data, { eventId } = {}) {
  return {
    event_id: eventId || `evt_test_${++eventCounter}_${crypto.randomBytes(3).toString("hex")}`,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    notification_id: `ntf_${eventCounter}`,
    data,
  };
}

function sign(body, secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) {
  const h1 = crypto.createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

/** Paddle transaction webhook payload (snake_case, as Paddle sends it). */
function transactionPayload({ id = "txn_1", customerId = "ctm_1", status = "completed", priceId = PRICES.advanced_lifetime, subscriptionId = null, total = "100000", currency = "USD" } = {}) {
  const now = new Date().toISOString();
  return {
    id,
    status,
    customer_id: customerId,
    address_id: "add_1",
    business_id: null,
    custom_data: null,
    currency_code: currency,
    origin: "web",
    subscription_id: subscriptionId,
    invoice_id: null,
    invoice_number: null,
    collection_mode: "automatic",
    discount_id: null,
    billing_details: null,
    billing_period: null,
    items: [{ price: { id: priceId, product_id: "pro_plan", description: "plan", name: null, billing_cycle: null, trial_period: null, unit_price: { amount: total, currency_code: currency }, unit_price_overrides: [], status: "active", type: "standard", tax_mode: "account_setting", quantity: { minimum: 1, maximum: 1 }, custom_data: null, import_meta: null, created_at: now, updated_at: now }, quantity: 1, proration: null }],
    details: { totals: { subtotal: total, tax: "0", discount: "0", total, grand_total: total, fee: null, earnings: null, currency_code: currency }, line_items: [], tax_rates_used: [], payout_totals: null, adjusted_payout_totals: null },
    payments: [],
    checkout: null,
    created_at: now,
    updated_at: now,
    billed_at: now,
  };
}

/** Stub Paddle client: real webhook verification, recorded API calls, controllable prices. */
function paddleStub({ prices = defaultPaddlePrices(), pricesFail = false } = {}) {
  const calls = { customersCreated: [], transactions: [], portal: [], priceLists: 0 };
  const real = new Paddle("pdl_sdbx_apikey_test", { environment: Environment.sandbox });
  const stub = {
    webhooks: real.webhooks,
    customers: {
      list: () => ({ next: async () => [] }),
      create: async ({ email }) => {
        calls.customersCreated.push(email);
        return { id: `ctm_${calls.customersCreated.length}_${crypto.randomBytes(2).toString("hex")}` };
      },
    },
    transactions: {
      create: async (params) => {
        calls.transactions.push(params);
        return { id: `txn_${calls.transactions.length}` };
      },
    },
    prices: {
      list: ({ id }) => {
        calls.priceLists += 1;
        let done = false;
        return {
          hasMore: false,
          next: async () => {
            if (pricesFail) throw new Error("Paddle unavailable");
            if (done) return [];
            done = true;
            return prices.filter((p) => id.includes(p.id));
          },
        };
      },
    },
    customerPortalSessions: {
      create: async (customerId, subscriptionIds) => {
        calls.portal.push({ customerId, subscriptionIds });
        return { urls: { general: { overview: `https://sandbox-customer-portal.paddle.com/cpl_test?c=${customerId}` } } };
      },
    },
  };
  return { stub, calls };
}

module.exports = { pool, query, resetDb, createUser, directConversation, addRoutes, startServer, useBillingEnv, testEnv, PRICES, PRODUCTS, paddlePrice, defaultPaddlePrices, subscriptionPayload, transactionPayload, event, sign, paddleStub, WEBHOOK_SECRET };
