/**
 * POST /api/revenuecat/webhook — RevenueCat → FastChat. Authenticated with the Authorization
 * header configured in the RevenueCat dashboard (REVENUECAT_WEBHOOK_AUTH). Answers 2xx once an
 * event is stored and handled (duplicates included) and 5xx when processing failed, so
 * RevenueCat retries.
 */
const express = require("express");
const revenuecat = require("../services/revenuecat");

const router = express.Router();

router.post("/webhook", async (req, res) => {
  if (!revenuecat.verifyWebhookAuth(req.headers.authorization)) return res.status(401).json({ success: false });
  try {
    const result = await revenuecat.handleWebhook(req.body);
    res.json({ success: true, ...result });
  } catch (error) {
    if (error.code === "bad_request") return res.status(400).json({ success: false, message: error.message });
    console.error("[RevenueCat] webhook failed:", error.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
