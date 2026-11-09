/**
 * Reads the configured Paddle prices (amount, currency, billing cycle, trial) from
 * the Paddle API, so the website shows exactly what Paddle charges and never a
 * hard-coded or invented amount.
 *
 * An offer is purchasable only when its price ID is configured AND Paddle reports
 * that price as active with the expected billing cycle (monthly, yearly or one-time),
 * AND each plan's prices belong to one Paddle product that no other plan uses (so a
 * price ID pasted into the wrong variable can't be sold under the wrong plan).
 * Results are cached for 10 minutes; if Paddle can't be reached, the last good
 * result is reused, and with no previous result nothing is purchasable.
 */
const { getBillingConfig } = require("../config/billing");
const { OFFERS } = require("../config/plans");

const CACHE_MS = 10 * 60 * 1000;
let cache = null; // { at, configKey, byPriceId }
let inflight = null;

const cycleMatches = (offer, billingCycle) => {
  if (offer.interval === "lifetime") return !billingCycle;
  return Boolean(billingCycle) && billingCycle.interval === offer.interval && billingCycle.frequency === 1;
};

/** Paddle amounts are strings in the currency's minor unit ("500" = $5.00). */
function formatAmount(amountMinor, currency) {
  const digits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  const major = Number(amountMinor) / 10 ** digits;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(major) ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(major);
}

async function fetchPrices(paddle, ids) {
  const byPriceId = {};
  const collection = paddle.prices.list({ id: ids, perPage: 50 });
  // The SDK paginates; five prices fit on one page, but follow pages anyway
  for (let page = await collection.next(); page.length; page = collection.hasMore ? await collection.next() : []) {
    for (const p of page) {
      byPriceId[p.id] = {
        status: p.status,
        productId: p.productId ?? null,
        amountMinor: p.unitPrice?.amount ?? null,
        currency: p.unitPrice?.currencyCode ?? null,
        billingCycle: p.billingCycle ? { interval: p.billingCycle.interval, frequency: p.billingCycle.frequency } : null,
        trialPeriod: p.trialPeriod
          ? { interval: p.trialPeriod.interval, frequency: p.trialPeriod.frequency, requiresPaymentMethod: p.trialPeriod.requiresPaymentMethod ?? true }
          : null,
      };
    }
  }
  return byPriceId;
}

async function loadPrices() {
  const config = getBillingConfig().paddle;
  const ids = Object.values(config.prices);
  const configKey = ids.join(",");
  if (cache && cache.configKey === configKey && Date.now() - cache.at < CACHE_MS) return { byPriceId: cache.byPriceId, fresh: true };
  if (!ids.length) return { byPriceId: {}, fresh: true };

  inflight ??= (async () => {
    try {
      // Lazy require avoids a cycle: paddleBilling also uses this module
      const { getPaddle } = require("./paddleBilling");
      const byPriceId = await fetchPrices(getPaddle(config), ids);
      cache = { at: Date.now(), configKey, byPriceId };
      return { byPriceId, fresh: true };
    } catch (error) {
      console.warn(`[Paddle] Could not load prices: ${error.message}`);
      if (cache && cache.configKey === configKey) return { byPriceId: cache.byPriceId, fresh: false };
      return { byPriceId: {}, fresh: false, error: true };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * offer key → { key, plan, interval, priceId, available, price, trial, issue }.
 * `issue` explains why an offer isn't purchasable (env variable names only, never values).
 */
async function getOffers() {
  const config = getBillingConfig().paddle;
  if (!config.enabled) {
    return Object.fromEntries(OFFERS.map((o) => [o.key, { ...publicOffer(o), priceId: null, available: false, price: null, trial: null, issue: "Paddle is not configured" }]));
  }
  const { byPriceId, error } = await loadPrices();
  const result = {};
  for (const offer of OFFERS) {
    const priceId = config.prices[offer.key] || null;
    const base = { ...publicOffer(offer), priceId, available: false, price: null, trial: null, issue: null };
    if (!priceId) {
      result[offer.key] = { ...base, issue: `${offer.env} is not set` };
      continue;
    }
    const p = byPriceId[priceId];
    if (!p) {
      result[offer.key] = { ...base, issue: error ? "Prices could not be loaded from Paddle" : `${offer.env} was not found in Paddle (${config.environment})` };
      continue;
    }
    const price = p.amountMinor !== null && p.currency ? { amountMinor: p.amountMinor, currency: p.currency, formatted: formatAmount(p.amountMinor, p.currency) } : null;
    let issue = null;
    if (p.status !== "active") issue = `${offer.env} is ${p.status} in Paddle`;
    else if (!cycleMatches(offer, p.billingCycle)) issue = `${offer.env} does not have a ${offer.interval === "lifetime" ? "one-time" : `1-${offer.interval}`} billing cycle in Paddle`;
    else if (!price) issue = `${offer.env} has no unit price in Paddle`;
    // Trials apply only to subscriptions and only when Paddle has one on the price
    const trial = offer.interval !== "lifetime" ? p.trialPeriod : null;
    result[offer.key] = { ...base, available: !issue, price, trial, issue, productId: p.productId };
  }

  // Product consistency: one product per plan, and no product shared between plans
  const productsByPlan = {};
  for (const o of Object.values(result)) if (o.productId) (productsByPlan[o.plan] ??= new Set()).add(o.productId);
  for (const o of Object.values(result)) {
    if (!o.productId || o.issue) continue;
    const env = OFFERS.find((x) => x.key === o.key).env;
    const sharedWith = Object.entries(productsByPlan).find(([plan, ids]) => plan !== o.plan && ids.has(o.productId));
    if (productsByPlan[o.plan].size > 1) o.issue = `${env}: the ${o.plan} prices belong to different Paddle products`;
    else if (sharedWith) o.issue = `${env} belongs to the same Paddle product as the ${sharedWith[0]} prices`;
    if (o.issue) o.available = false;
  }
  for (const o of Object.values(result)) delete o.productId;
  return result;
}

const publicOffer = (o) => ({ key: o.key, plan: o.plan, interval: o.interval });

/** The configured offer for a price ID, or null for prices we don't sell. */
function offerForPriceId(priceId, config = getBillingConfig().paddle) {
  if (!config.enabled || !priceId) return null;
  const offer = OFFERS.find((o) => config.prices[o.key] === priceId);
  return offer ? publicOffer(offer) : null;
}

const clearPriceCacheForTests = () => {
  cache = null;
  inflight = null;
};

module.exports = { getOffers, offerForPriceId, formatAmount, clearPriceCacheForTests };
