const Finance = require("../models/Finance");

// GET /api/finance/dashboard
exports.getDashboard = async (req, res, next) => {
  try {
    const month = req.query.month ? Number(req.query.month) : undefined;
    const year = req.query.year ? Number(req.query.year) : undefined;
    const data = await Finance.getDashboardSummary(req.user.id, { month, year });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/profile
exports.getProfile = async (req, res, next) => {
  try {
    const profile = await Finance.getProfile(req.user.id);
    res.json({ success: true, profile });
  } catch (err) {
    next(err);
  }
};

// PUT /api/finance/profile
exports.updateProfile = async (req, res, next) => {
  try {
    const profile = await Finance.updateProfile(req.user.id, req.body);
    res.json({ success: true, profile, message: "Profile updated successfully." });
  } catch (err) {
    next(err);
  }
};

// POST /api/finance/simulate
exports.simulate = async (req, res, next) => {
  try {
    const result = await Finance.runSimulation(req.user.id, req.body);
    res.json({ success: true, simulation: result });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/simulations
exports.listSimulations = async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const items = await Finance.listSimulations(req.user.id, limit);
    res.json({ success: true, simulations: items });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/simulations/:id
exports.getSimulationById = async (req, res, next) => {
  try {
    const sim = await Finance.getSimulationById(req.user.id, req.params.id);
    if (!sim) {
      return res.status(404).json({ success: false, message: "Simulation not found" });
    }
    res.json({ success: true, simulation: sim });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/businesses
exports.listBusinesses = async (req, res, next) => {
  try {
    const businesses = await Finance.listBusinesses(req.user.id);
    res.json({ success: true, businesses });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/businesses/:id
exports.getBusinessById = async (req, res, next) => {
  try {
    const b = await Finance.getBusinessById(req.user.id, req.params.id, req.query.month);
    if (!b) return res.status(404).json({ success: false, message: "Business not found." });
    res.json({ success: true, business: b });
  } catch (err) {
    next(err);
  }
};

// POST /api/finance/businesses
exports.createBusiness = async (req, res, next) => {
  try {
    const { name, description, startDate, initialInvestment, openingBalance } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Business name is required." });
    }
    const business = await Finance.createBusiness(req.user.id, {
      name,
      description,
      startDate,
      initialInvestment,
      openingBalance,
    });
    res.status(201).json({ success: true, business, message: "Business created successfully." });
  } catch (err) {
    next(err);
  }
};

// PUT /api/finance/businesses/:id
exports.updateBusiness = async (req, res, next) => {
  try {
    const business = await Finance.updateBusiness(req.user.id, req.params.id, req.body);
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    res.json({ success: true, business, message: "Business updated." });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/finance/businesses/:id
exports.deleteBusiness = async (req, res, next) => {
  try {
    const ok = await Finance.deleteBusiness(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: "Business not found." });
    res.json({ success: true, message: "Business deleted successfully." });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/transactions
exports.listTransactions = async (req, res, next) => {
  try {
    const transactions = await Finance.listTransactions(req.user.id, {
      businessId: req.query.businessId,
      type: req.query.type,
      search: req.query.search,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ success: true, transactions });
  } catch (err) {
    next(err);
  }
};

// POST /api/finance/transactions
exports.createTransaction = async (req, res, next) => {
  try {
    const { businessId, type, name, amount, note, transactionDate } = req.body;
    if (!name || !type || amount === undefined) {
      return res.status(400).json({ success: false, message: "Name, type, and amount are required." });
    }
    const tx = await Finance.createTransaction(req.user.id, {
      businessId,
      type,
      name,
      amount,
      note,
      transactionDate,
    });
    res.status(201).json({ success: true, transaction: tx, message: "Transaction recorded." });
  } catch (err) {
    next(err);
  }
};

// PUT /api/finance/transactions/:id
exports.updateTransaction = async (req, res, next) => {
  try {
    const tx = await Finance.updateTransaction(req.user.id, req.params.id, req.body);
    if (!tx) return res.status(404).json({ success: false, message: "Transaction not found." });
    res.json({ success: true, transaction: tx, message: "Transaction updated." });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/finance/transactions/:id
exports.deleteTransaction = async (req, res, next) => {
  try {
    const ok = await Finance.deleteTransaction(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: "Transaction not found." });
    res.json({ success: true, message: "Transaction deleted." });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/goals
exports.listGoals = async (req, res, next) => {
  try {
    const goals = await Finance.listGoals(req.user.id);
    res.json({ success: true, goals });
  } catch (err) {
    next(err);
  }
};

// POST /api/finance/goals
exports.createGoal = async (req, res, next) => {
  try {
    const { title, category, targetAmount, currentAmount, targetDate, notes } = req.body;
    if (!title || targetAmount === undefined) {
      return res.status(400).json({ success: false, message: "Title and target amount are required." });
    }
    const goal = await Finance.createGoal(req.user.id, {
      title,
      category,
      targetAmount,
      currentAmount,
      targetDate,
      notes,
    });
    res.status(201).json({ success: true, goal, message: "Goal created successfully." });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/finance/goals/:id
exports.updateGoal = async (req, res, next) => {
  try {
    const goal = await Finance.updateGoal(req.user.id, req.params.id, req.body);
    if (!goal) return res.status(404).json({ success: false, message: "Goal not found." });
    res.json({ success: true, goal, message: "Goal updated." });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/finance/goals/:id
exports.deleteGoal = async (req, res, next) => {
  try {
    const ok = await Finance.deleteGoal(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: "Goal not found." });
    res.json({ success: true, message: "Goal deleted." });
  } catch (err) {
    next(err);
  }
};

const { FinanceSubscription } = require("../models/FinanceSubscription");

// GET /api/finance/subscription
exports.getSubscription = async (req, res, next) => {
  try {
    const sub = await FinanceSubscription.getForUser(req.user.id, req.user.createdAt || req.user.created_at);
    res.json({ success: true, subscription: sub });
  } catch (err) {
    next(err);
  }
};

// POST /api/finance/subscription/sync
// The app calls this after a Google Play purchase / restore. Whatever the body says is ignored:
// access comes only from RevenueCat's record for this account (server secret key).
exports.syncSubscription = async (req, res, next) => {
  try {
    const revenuecat = require("../services/revenuecat");
    if (!revenuecat.isConfigured()) {
      return res.status(503).json({ success: false, code: "billing_unavailable", message: "Purchases are not available yet." });
    }
    const sub = await revenuecat.reconcileFinance(req.user.id);
    res.json({ success: true, subscription: sub, message: "Subscription checked with Google Play." });
  } catch (err) {
    if (err.code === "billing_upstream" || err.name === "TimeoutError") {
      return res.status(502).json({ success: false, code: "billing_upstream", message: "Could not reach the purchase service. Try again." });
    }
    next(err);
  }
};

// POST /api/finance/revenuecat-webhook — same handler as /api/revenuecat/webhook (one RevenueCat
// project, one webhook is enough). Always authenticated; events only trigger a reconcile.
exports.revenueCatWebhook = async (req, res) => {
  const revenuecat = require("../services/revenuecat");
  if (!revenuecat.verifyWebhookAuth(req.headers.authorization)) {
    return res.status(401).json({ success: false, message: "Unauthorized webhook" });
  }
  try {
    const result = await revenuecat.handleWebhook(req.body);
    res.json({ success: true, received: true, ...result });
  } catch (err) {
    if (err.code === "bad_request") return res.status(400).json({ success: false, message: "Malformed event" });
    console.error("RevenueCat webhook error:", err.message);
    res.status(500).json({ success: false });
  }
};

// Paid Fast Finance actions (same four the app puts behind the paywall)
exports.requireFinanceAccess = async (req, res, next) => {
  try {
    const sub = await FinanceSubscription.getForUser(req.user.id, req.user.createdAt || req.user.created_at);
    if (sub.hasAccess) return next();
    res.status(402).json({ success: false, code: "finance_subscription_required", message: "Your free trial has ended. Subscribe to Fast Finance Pro to continue.", subscription: sub });
  } catch (err) {
    next(err);
  }
};

// ─── Lifetime & Daily Expenses ────────────────────────────────────────────────
// GET /api/finance/expenses/analytics
exports.getLifetimeExpenseAnalytics = async (req, res, next) => {
  try {
    const analytics = await Finance.getLifetimeExpenseAnalytics(req.user.id);
    res.json({ success: true, data: analytics, ...analytics });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/expenses
exports.listExpenses = async (req, res, next) => {
  try {
    const expenses = await Finance.listExpenses(req.user.id, req.query);
    res.json({ success: true, expenses });
  } catch (err) {
    next(err);
  }
};

// POST /api/finance/expenses
exports.createExpense = async (req, res, next) => {
  try {
    const { title, amount, category, expenseDate, paymentMethod, note } = req.body;
    if (!title || !amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Valid title and positive amount are required." });
    }
    const expense = await Finance.createExpense(req.user.id, {
      title,
      amount,
      category,
      expenseDate,
      paymentMethod,
      note,
    });
    res.status(201).json({ success: true, expense, message: "Expense logged successfully." });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/finance/expenses/:id
exports.deleteExpense = async (req, res, next) => {
  try {
    const ok = await Finance.deleteExpense(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: "Expense record not found." });
    res.json({ success: true, message: "Expense record deleted." });
  } catch (err) {
    next(err);
  }
};

// ─── Lifetime & Daily Incomes ─────────────────────────────────────────────────
// GET /api/finance/incomes/analytics
exports.getLifetimeIncomeAnalytics = async (req, res, next) => {
  try {
    const analytics = await Finance.getLifetimeIncomeAnalytics(req.user.id);
    res.json({ success: true, data: analytics, ...analytics });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/incomes
exports.listIncomes = async (req, res, next) => {
  try {
    const incomes = await Finance.listIncomes(req.user.id, req.query);
    res.json({ success: true, incomes });
  } catch (err) {
    next(err);
  }
};

// POST /api/finance/incomes
exports.createIncome = async (req, res, next) => {
  try {
    const { title, amount, sourceCategory, incomeDate, paymentMethod, note } = req.body;
    if (!title || !amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Valid title and positive amount are required." });
    }
    const income = await Finance.createIncome(req.user.id, {
      title,
      amount,
      sourceCategory,
      incomeDate,
      paymentMethod,
      note,
    });
    res.status(201).json({ success: true, income, message: "Income logged successfully." });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/finance/incomes/:id
exports.deleteIncome = async (req, res, next) => {
  try {
    const ok = await Finance.deleteIncome(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: "Income record not found." });
    res.json({ success: true, message: "Income record deleted." });
  } catch (err) {
    next(err);
  }
};

// GET /api/finance/lifetime/summary
exports.getLifetimeFinancialSummary = async (req, res, next) => {
  try {
    const summary = await Finance.getLifetimeFinancialSummary(req.user.id);
    res.json({ success: true, data: summary, ...summary });
  } catch (err) {
    next(err);
  }
};

