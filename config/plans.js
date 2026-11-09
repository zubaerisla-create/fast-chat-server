/**
 * Plan catalog and entitlements: the single source of truth for what each plan
 * unlocks. Amounts, billing cycles and trials are NOT defined here; they are read
 * from the configured Paddle prices (services/paddleCatalog.js), so this file can
 * never disagree with what Paddle actually charges.
 *
 * Only three plans are sold: Starter, Pro and Advanced Lifetime. "free" is the
 * internal baseline for accounts without a paid plan (today's limits). It is not
 * sold and not shown as a plan.
 *
 * Limits here must be enforced in code before they are advertised on the website.
 * They are enforced by services/limits.js (server-side). `null` = unlimited.
 * The SaaS limits below are proposed defaults; the owner can change them here.
 */
const MB = 1024 * 1024;
const GB = 1024 * MB;

const PLANS = {
  free: {
    id: "free",
    name: "Free",
    rank: 0,
    limits: { maxFileBytes: 25 * MB, workspaces: 1, membersPerWorkspace: 10, channelsPerWorkspace: 5, storageBytes: 1 * GB, aiRequestsPerMonth: 20, groupCalls: false },
    features: [],
  },
  starter: {
    id: "starter",
    name: "Starter",
    rank: 1,
    limits: { maxFileBytes: 50 * MB, workspaces: 3, membersPerWorkspace: 25, channelsPerWorkspace: 25, storageBytes: 10 * GB, aiRequestsPerMonth: 200, groupCalls: false },
    features: [],
  },
  pro: {
    id: "pro",
    name: "Pro",
    rank: 2,
    recommended: true,
    limits: { maxFileBytes: 100 * MB, workspaces: 10, membersPerWorkspace: 100, channelsPerWorkspace: 100, storageBytes: 50 * GB, aiRequestsPerMonth: 1000, groupCalls: true },
    features: ["priority_support", "group_calls", "advanced_admin"],
  },
  advanced: {
    id: "advanced",
    name: "Advanced Lifetime",
    rank: 3,
    lifetime: true,
    limits: { maxFileBytes: 200 * MB, workspaces: 25, membersPerWorkspace: 500, channelsPerWorkspace: null, storageBytes: 200 * GB, aiRequestsPerMonth: 5000, groupCalls: true },
    features: ["priority_support", "group_calls", "advanced_admin"],
  },
};

const PAID_PLAN_IDS = ["starter", "pro", "advanced"];
const SUBSCRIPTION_PLAN_IDS = ["starter", "pro"];
const INTERVALS = ["month", "year"];

/**
 * Every purchasable offer and the env variable holding its Paddle price ID.
 * `interval` is the billing cycle the Paddle price must have ("lifetime" = one-time, no cycle).
 */
const OFFERS = [
  { key: "starter_month", plan: "starter", interval: "month", env: "PADDLE_STARTER_MONTHLY_PRICE_ID" },
  { key: "starter_year", plan: "starter", interval: "year", env: "PADDLE_STARTER_YEARLY_PRICE_ID" },
  { key: "pro_month", plan: "pro", interval: "month", env: "PADDLE_PRO_MONTHLY_PRICE_ID" },
  { key: "pro_year", plan: "pro", interval: "year", env: "PADDLE_PRO_YEARLY_PRICE_ID" },
  { key: "advanced_lifetime", plan: "advanced", interval: "lifetime", env: "PADDLE_ADVANCED_LIFETIME_PRICE_ID" },
];

const planById = (id) => PLANS[id] || null;

module.exports = { GB, PLANS, PAID_PLAN_IDS, SUBSCRIPTION_PLAN_IDS, INTERVALS, OFFERS, planById, MB };
