const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const fc = require("../controllers/financeController");

const router = express.Router();

router.use(protect);

// Dashboard & Profile
router.get("/dashboard", fc.getDashboard);
router.get("/profile", fc.getProfile);
router.put("/profile", fc.updateProfile);

// Simulations
router.post("/simulate", fc.simulate);
router.get("/simulations", fc.listSimulations);
router.get("/simulations/:id", fc.getSimulationById);

// Businesses & Portfolio
router.get("/businesses", fc.listBusinesses);
router.post("/businesses", fc.createBusiness);
router.get("/businesses/:id", fc.getBusinessById);
router.put("/businesses/:id", fc.updateBusiness);
router.delete("/businesses/:id", fc.deleteBusiness);

// Transactions
router.get("/transactions", fc.listTransactions);
router.post("/transactions", fc.createTransaction);
router.put("/transactions/:id", fc.updateTransaction);
router.delete("/transactions/:id", fc.deleteTransaction);

// Goals
router.get("/goals", fc.listGoals);
router.post("/goals", fc.createGoal);
router.patch("/goals/:id", fc.updateGoal);
router.delete("/goals/:id", fc.deleteGoal);

module.exports = router;
