const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const fc = require("../controllers/financeController");

const router = express.Router();

// RevenueCat webhook (no user session; always checked against REVENUECAT_WEBHOOK_AUTH)
router.post("/revenuecat-webhook", fc.revenueCatWebhook);

router.use(protect);

// Subscription & 7-Day Trial
router.get("/subscription", fc.getSubscription);
router.post("/subscription/sync", fc.syncSubscription);

// Dashboard & Profile
router.get("/dashboard", fc.getDashboard);
router.get("/profile", fc.getProfile);
router.put("/profile", fc.updateProfile);

// Simulations
router.post("/simulate", fc.requireFinanceAccess, fc.simulate);
router.get("/simulations", fc.listSimulations);
router.get("/simulations/:id", fc.getSimulationById);

// Businesses & Portfolio
router.get("/businesses", fc.listBusinesses);
router.post("/businesses", fc.requireFinanceAccess, fc.createBusiness);
router.get("/businesses/:id", fc.getBusinessById);
router.put("/businesses/:id", fc.updateBusiness);
router.delete("/businesses/:id", fc.deleteBusiness);

// Transactions
router.get("/transactions", fc.listTransactions);
router.post("/transactions", fc.requireFinanceAccess, fc.createTransaction);
router.put("/transactions/:id", fc.updateTransaction);
router.delete("/transactions/:id", fc.deleteTransaction);

// Goals
router.get("/goals", fc.listGoals);
router.post("/goals", fc.requireFinanceAccess, fc.createGoal);
router.patch("/goals/:id", fc.updateGoal);
router.delete("/goals/:id", fc.deleteGoal);

// Lifetime & Daily Expenses
router.get("/expenses/analytics", fc.getLifetimeExpenseAnalytics);
router.get("/expenses", fc.listExpenses);
router.post("/expenses", fc.createExpense);
router.delete("/expenses/:id", fc.deleteExpense);

// Lifetime & Daily Incomes
router.get("/incomes/analytics", fc.getLifetimeIncomeAnalytics);
router.get("/incomes", fc.listIncomes);
router.post("/incomes", fc.createIncome);
router.delete("/incomes/:id", fc.deleteIncome);

// Lifetime Financial Summary (Income + Expense + Net Balance)
router.get("/lifetime/summary", fc.getLifetimeFinancialSummary);

module.exports = router;
