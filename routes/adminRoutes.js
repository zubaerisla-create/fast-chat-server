const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/entitlementMiddleware");
const { getBillingSummary } = require("../controllers/adminController");

const router = express.Router();

// Admins are set in the database: UPDATE users SET role = 'admin' WHERE email = '…';
router.use(protect, requireRole("admin"));

// GET /api/admin/billing/summary → users per plan, subscription statuses, MRR, revenue, recent events
router.get("/billing/summary", getBillingSummary);

// Platform administration
const p = require("../controllers/platformAdminController");
router.get("/overview", p.overview); // ?days=
router.get("/users", p.listUsers); // ?q=&limit=&offset=
router.get("/organizations", p.listOrganizations); // ?q=
router.get("/audit", p.auditLog); // ?before=&limit=
router.get("/reports", p.listReports);
router.patch("/reports/:id", p.updateReport);

module.exports = router;
