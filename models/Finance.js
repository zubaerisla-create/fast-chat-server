const { query, withTransaction } = require("../config/db");

// ─── Simulation Calculation Engine (from mayramao) ───────────────────────────
function calculateSimulation(payload) {
  const monthlyIncome = Number(payload.monthlyIncome) || 0;
  const rent = Number(payload.rent) || 0;
  const utilities = Number(payload.utilities) || 0;
  const subscriptionsInsurance = Number(payload.subscriptionsInsurance) || 0;
  const existingLoans = Number(payload.existingLoans) || 0;
  const variableExpenses = Number(payload.variableExpenses) || 0;
  const currentSavings = Number(payload.currentSavings) || 0;
  const purchaseAmount = Number(payload.purchaseAmount) || 0;
  const paymentType = payload.paymentType === "Financing" || payload.paymentType === "loan" ? "loan" : "full";
  const loanDuration = Math.max(Number(payload.loanDuration) || 12, 1);
  const interestRate = Number(payload.interestRate) || 0;
  const dependents = Number(payload.dependents) || 0;
  const incomeStability = payload.incomeStability || "mostly_stable";

  // 1. Expense Breakdown & Baseline Disposable Income
  const fixedExpenses = rent + utilities + subscriptionsInsurance + existingLoans;
  const totalMonthlyExpenses = fixedExpenses + variableExpenses;
  const baselineDisposableIncome = Math.max(monthlyIncome - totalMonthlyExpenses, 0);

  // 2. Financing / Loan Calculations
  const annualRate = interestRate / 100;
  const monthlyRate = annualRate / 12;

  let financingMonthlyPayment = 0;
  if (monthlyRate > 0) {
    financingMonthlyPayment = Math.round(
      (purchaseAmount * monthlyRate * Math.pow(1 + monthlyRate, loanDuration)) /
        (Math.pow(1 + monthlyRate, loanDuration) - 1)
    );
  } else {
    financingMonthlyPayment = Math.round(purchaseAmount / loanDuration);
  }

  const financingTotalCost = financingMonthlyPayment * loanDuration;
  const financingNewDisposable = baselineDisposableIncome - financingMonthlyPayment;
  const financingRecoveryMonths = loanDuration;

  // Financing Risk Assessment
  const paymentToIncomeRatio = monthlyIncome > 0 ? financingMonthlyPayment / monthlyIncome : 1;
  const paymentToDisposableRatio =
    baselineDisposableIncome > 0 ? financingMonthlyPayment / baselineDisposableIncome : 1;

  let financingRiskLevel = "SAFE";
  if (financingNewDisposable < 0 || paymentToIncomeRatio > 0.35 || paymentToDisposableRatio > 0.6) {
    financingRiskLevel = "RISKY";
  } else if (
    paymentToIncomeRatio > 0.18 ||
    paymentToDisposableRatio > 0.3 ||
    incomeStability === "unpredictable"
  ) {
    financingRiskLevel = "TIGHT";
  }

  // 3. Pay In Full Calculations
  const fullTotalCost = purchaseAmount;
  const canCoverFromCashflow = baselineDisposableIncome >= purchaseAmount;
  const postPurchaseSavings = canCoverFromCashflow
    ? currentSavings
    : Math.max(0, currentSavings - (purchaseAmount - Math.min(baselineDisposableIncome, purchaseAmount)));

  const monthlySavingsCapacity = Math.max(baselineDisposableIncome * 0.5, 1);
  const fullRecoveryMonths = Math.ceil(purchaseAmount / monthlySavingsCapacity);
  const emergencyFundTarget = Math.max(totalMonthlyExpenses * 3, 1000);
  const totalAvailableLiquidity = currentSavings + baselineDisposableIncome;

  let fullRiskLevel = "SAFE";
  if (baselineDisposableIncome <= 0 && currentSavings < purchaseAmount) {
    fullRiskLevel = "RISKY";
  } else if (purchaseAmount > totalAvailableLiquidity) {
    fullRiskLevel = "RISKY";
  } else if (baselineDisposableIncome >= purchaseAmount * 1.5) {
    fullRiskLevel = "SAFE";
  } else if (baselineDisposableIncome >= purchaseAmount) {
    fullRiskLevel = currentSavings >= emergencyFundTarget ? "SAFE" : "TIGHT";
  } else if (currentSavings >= purchaseAmount) {
    const remainingSavings = currentSavings - purchaseAmount;
    if (remainingSavings >= emergencyFundTarget) {
      fullRiskLevel = "SAFE";
    } else if (
      remainingSavings < emergencyFundTarget * 0.25 ||
      fullRecoveryMonths > 6 ||
      incomeStability === "unpredictable"
    ) {
      fullRiskLevel = "RISKY";
    } else {
      fullRiskLevel = "TIGHT";
    }
  } else {
    fullRiskLevel = "RISKY";
  }

  // 4. Overall Assessment for Selected Method
  const activeMethod = paymentType === "loan" ? "financing" : "pay_in_full";
  const overallRisk = activeMethod === "financing" ? financingRiskLevel : fullRiskLevel;

  let assessmentTitle = "";
  let guidanceText = "";

  if (overallRisk === "SAFE") {
    assessmentTitle = "Fiscally Healthy Purchase";
    guidanceText =
      activeMethod === "financing"
        ? `Financing this purchase over ${loanDuration} months maintains a healthy financial buffer with manageable monthly payments of $${financingMonthlyPayment.toLocaleString()}.`
        : `You can comfortably pay in full ($${purchaseAmount.toLocaleString()}) without compromising your emergency fund reserves or monthly liquidity.`;
  } else if (overallRisk === "TIGHT") {
    assessmentTitle = "Moderate Financial Caution";
    guidanceText =
      activeMethod === "financing"
        ? `A monthly payment of $${financingMonthlyPayment.toLocaleString()} is workable but will narrow your monthly disposable cushion. Avoid taking on new debt.`
        : `Paying $${purchaseAmount.toLocaleString()} upfront will dip into your savings cushion. It will take approximately ${fullRecoveryMonths} months of disciplined saving to recover this buffer.`;
  } else {
    assessmentTitle = "High Risk / Unadvisable";
    guidanceText =
      activeMethod === "financing"
        ? `This loan will heavily strain your disposable cash flow and exceeds the recommended debt-to-income threshold. Consider postponing or choosing a lower cost tier.`
        : `Paying $${purchaseAmount.toLocaleString()} upfront exceeds your safe liquidity or will completely deplete your emergency reserves.`;
  }

  const keyInsights = [
    `Baseline Monthly Disposable Income: $${baselineDisposableIncome.toLocaleString()}`,
    `Total Fixed Expenses: $${fixedExpenses.toLocaleString()} / mo | Variable: $${variableExpenses.toLocaleString()} / mo`,
    activeMethod === "financing"
      ? `Financing Payment: $${financingMonthlyPayment.toLocaleString()}/mo for ${loanDuration} months (Total: $${financingTotalCost.toLocaleString()})`
      : `Pay in full cost: $${fullTotalCost.toLocaleString()} (Estimated recovery: ${fullRecoveryMonths} months)`,
    `Recommended Emergency Fund: $${emergencyFundTarget.toLocaleString()} (${currentSavings >= emergencyFundTarget ? "Fully funded ✅" : "Under-funded ⚠️"})`,
  ];

  const saferAlternatives = [];
  if (overallRisk !== "SAFE") {
    if (activeMethod === "financing" && loanDuration < 24) {
      saferAlternatives.push(`Extend loan tenure to reduce monthly burden below $${Math.round(financingMonthlyPayment * 0.7)}/mo.`);
    }
    if (activeMethod === "pay_in_full") {
      saferAlternatives.push(`Save for another ${Math.min(fullRecoveryMonths, 6)} months to build additional buffer before buying.`);
    }
    saferAlternatives.push("Explore low-interest financing or split the purchase across multiple billing cycles.");
  }

  return {
    scenario_summary: {
      active_method: activeMethod,
      purchase_amount: purchaseAmount,
      baseline_disposable_income: baselineDisposableIncome,
      post_purchase_disposable_income: activeMethod === "financing" ? financingNewDisposable : baselineDisposableIncome,
      monthly_payment: activeMethod === "financing" ? financingMonthlyPayment : purchaseAmount,
      recovery_months: activeMethod === "financing" ? financingRecoveryMonths : fullRecoveryMonths,
      post_purchase_savings: activeMethod === "financing" ? currentSavings : postPurchaseSavings,
      comparisons: {
        pay_in_full: {
          total_cost: fullTotalCost,
          monthly_impact: fullTotalCost,
          recovery_months: fullRecoveryMonths,
          risk_level: fullRiskLevel,
          post_savings: postPurchaseSavings,
        },
        financing: {
          total_cost: financingTotalCost,
          monthly_payment: financingMonthlyPayment,
          loan_duration: loanDuration,
          recovery_months: financingRecoveryMonths,
          risk_level: financingRiskLevel,
        },
      },
    },
    ai_guidance: {
      risk_level: overallRisk,
      assessment_title: assessmentTitle,
      guidance: guidanceText,
      key_insights: keyInsights,
      safer_alternatives: saferAlternatives,
    },
  };
}

// ─── Profile Operations ──────────────────────────────────────────────────────
async function getProfile(userId) {
  const { rows } = await query(
    `SELECT * FROM financial_profiles WHERE user_id = $1`,
    [userId]
  );
  if (rows.length > 0) return rows[0];

  const { rows: created } = await query(
    `INSERT INTO financial_profiles (user_id) VALUES ($1) RETURNING *`,
    [userId]
  );
  return created[0];
}

async function updateProfile(userId, data) {
  const current = await getProfile(userId);
  const fieldMapping = {
    monthly_income: data.monthly_income ?? data.monthlyIncome,
    rent: data.rent,
    utilities: data.utilities,
    subscriptions_insurance: data.subscriptions_insurance ?? data.subscriptionsInsurance,
    existing_loans: data.existing_loans ?? data.existingLoans,
    variable_expenses: data.variable_expenses ?? data.variableExpenses,
    current_savings: data.current_savings ?? data.currentSavings,
    dependents: data.dependents,
    household_responsibility_level: data.household_responsibility_level ?? data.householdResponsibilityLevel,
    income_stability: data.income_stability ?? data.incomeStability,
    risk_tolerance: data.risk_tolerance ?? data.riskTolerance,
    target_amount: data.target_amount ?? data.targetAmount,
    target_date: data.target_date ?? data.targetDate,
    goal_description: data.goal_description ?? data.goalDescription,
    currency: data.currency,
    currency_symbol: data.currency_symbol ?? data.currencySymbol,
  };

  const updates = [];
  const values = [];
  let idx = 1;

  for (const [col, val] of Object.entries(fieldMapping)) {
    if (val !== undefined) {
      updates.push(`${col} = $${idx++}`);
      values.push(val);
    }
  }

  if (updates.length === 0) return current;

  updates.push(`updated_at = NOW()`);
  values.push(userId);

  const { rows } = await query(
    `UPDATE financial_profiles SET ${updates.join(", ")} WHERE user_id = $${idx} RETURNING *`,
    values
  );
  return rows[0];
}

// ─── Simulation Operations ───────────────────────────────────────────────────
async function runSimulation(userId, payload) {
  const profile = await getProfile(userId);

  const simPayload = {
    monthlyIncome: Number(payload.monthlyIncome ?? profile.monthly_income) || 0,
    rent: Number(payload.rent ?? profile.rent) || 0,
    utilities: Number(payload.utilities ?? profile.utilities) || 0,
    subscriptionsInsurance: Number(payload.subscriptionsInsurance ?? profile.subscriptions_insurance) || 0,
    existingLoans: Number(payload.existingLoans ?? profile.existing_loans) || 0,
    variableExpenses: Number(payload.variableExpenses ?? profile.variable_expenses) || 0,
    currentSavings: Number(payload.currentSavings ?? profile.current_savings) || 0,
    dependents: Number(payload.dependents ?? profile.dependents) || 0,
    incomeStability: payload.incomeStability || profile.income_stability || "mostly_stable",
    riskTolerance: payload.riskTolerance || profile.risk_tolerance || "balanced",
    purchaseAmount: Number(payload.purchaseAmount) || 0,
    paymentType: payload.paymentType || "full",
    loanDuration: Number(payload.loanDuration) || 12,
    interestRate: Number(payload.interestRate) || 0,
    planName: payload.planName || "Purchase Simulation",
  };

  const result = calculateSimulation(simPayload);

  const { rows } = await query(
    `INSERT INTO financial_simulations 
     (user_id, purchase_amount, payment_type, loan_duration, interest_rate, plan_name, risk_level, request_payload, simulation_result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      userId,
      simPayload.purchaseAmount,
      simPayload.paymentType,
      simPayload.loanDuration,
      simPayload.interestRate,
      simPayload.planName,
      result.ai_guidance.risk_level,
      JSON.stringify(simPayload),
      JSON.stringify(result),
    ]
  );

  await query(
    `UPDATE financial_profiles SET total_simulations_used = total_simulations_used + 1 WHERE user_id = $1`,
    [userId]
  );

  return rows[0];
}

async function listSimulations(userId, limit = 20) {
  const { rows } = await query(
    `SELECT * FROM financial_simulations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getSimulationById(userId, simulationId) {
  const { rows } = await query(
    `SELECT * FROM financial_simulations WHERE id = $1 AND user_id = $2`,
    [simulationId, userId]
  );
  return rows[0] || null;
}

// ─── Business & Portfolio Operations (Enhanced from mayramao) ────────────────
async function calculateBusinessStats(businessId, targetDate = new Date()) {
  const { rows: txRows } = await query(
    `SELECT type, SUM(amount)::numeric AS total, COUNT(*)::int AS count
     FROM financial_transactions WHERE business_id = $1 GROUP BY type`,
    [businessId]
  );

  let totalInvestment = 0;
  let totalSales = 0;
  let totalExpenses = 0;
  let totalWithdrawals = 0;
  let transactionCount = 0;

  for (const r of txRows) {
    const amt = Number(r.total) || 0;
    transactionCount += r.count;
    if (r.type === "INVESTMENT") totalInvestment += amt;
    else if (r.type === "PROFIT" || r.type === "SELL" || r.type === "SALE") totalSales += amt;
    else if (r.type === "EXPENSE") totalExpenses += amt;
    else if (r.type === "WITHDRAWAL") totalWithdrawals += amt;
  }

  // Monthly stats
  const startOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
  const endOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0, 23, 59, 59, 999);

  const { rows: monthRows } = await query(
    `SELECT type, SUM(amount)::numeric AS total
     FROM financial_transactions 
     WHERE business_id = $1 AND transaction_date >= $2 AND transaction_date <= $3
     GROUP BY type`,
    [businessId, startOfMonth, endOfMonth]
  );

  let monthlySales = 0;
  let monthlyInvestment = 0;
  let monthlyExpense = 0;
  for (const r of monthRows) {
    const amt = Number(r.total) || 0;
    if (r.type === "PROFIT" || r.type === "SELL" || r.type === "SALE") monthlySales += amt;
    if (r.type === "INVESTMENT") monthlyInvestment += amt;
    if (r.type === "EXPENSE") monthlyExpense += amt;
  }

  const netProfit = totalSales - totalInvestment - totalExpenses;
  const monthlyProfit = monthlySales - monthlyInvestment - monthlyExpense;

  return {
    totalInvestment,
    totalSales,
    totalExpenses,
    totalWithdrawals,
    netProfit,
    monthlySales,
    monthlyInvestment,
    monthlyExpense,
    monthlyProfit,
    transactionCount,
  };
}

async function createBusiness(userId, { name, description = "", startDate, initialInvestment = 0, openingBalance = 0 }) {
  return withTransaction(async (client) => {
    const { rows: bRows } = await client.query(
      `INSERT INTO financial_businesses (user_id, name, description, start_date, initial_investment, opening_balance)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6) RETURNING *`,
      [userId, name.trim(), description.trim(), startDate || null, Number(initialInvestment) || 0, Number(openingBalance) || 0]
    );
    const business = bRows[0];

    if (Number(initialInvestment) > 0) {
      await client.query(
        `INSERT INTO financial_transactions (user_id, business_id, type, name, amount, note, transaction_date)
         VALUES ($1, $2, 'INVESTMENT', 'Initial Capital / Investment', $3, 'Opening investment', NOW())`,
        [userId, business.id, Number(initialInvestment)]
      );
    }

    return business;
  });
}

async function getBusinessById(userId, businessId, targetMonth = null) {
  const { rows } = await query(
    `SELECT * FROM financial_businesses WHERE id = $1 AND user_id = $2`,
    [businessId, userId]
  );
  if (rows.length === 0) return null;
  const b = rows[0];

  const targetDate = targetMonth ? new Date(targetMonth) : new Date();
  const stats = await calculateBusinessStats(b.id, targetDate);
  const currentBalance = Number(b.opening_balance) + stats.totalSales - stats.totalInvestment - stats.totalExpenses - stats.totalWithdrawals;

  const { rows: recentTx } = await query(
    `SELECT * FROM financial_transactions WHERE business_id = $1 ORDER BY transaction_date DESC LIMIT 30`,
    [businessId]
  );

  return {
    ...b,
    ...stats,
    currentBalance,
    recentTransactions: recentTx,
  };
}

async function updateBusiness(userId, businessId, data) {
  const fields = ["name", "description", "start_date", "opening_balance"];
  const updates = [];
  const values = [];
  let idx = 1;

  for (const f of fields) {
    if (data[f] !== undefined) {
      updates.push(`${f} = $${idx++}`);
      values.push(data[f]);
    }
  }

  if (updates.length === 0) return null;

  updates.push(`updated_at = NOW()`);
  values.push(businessId, userId);

  const { rows } = await query(
    `UPDATE financial_businesses SET ${updates.join(", ")} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function listBusinesses(userId) {
  const { rows: businesses } = await query(
    `SELECT * FROM financial_businesses WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );

  const results = [];
  for (const b of businesses) {
    const stats = await calculateBusinessStats(b.id);
    const currentBalance = Number(b.opening_balance) + stats.totalSales - stats.totalInvestment - stats.totalExpenses - stats.totalWithdrawals;

    results.push({
      ...b,
      ...stats,
      currentBalance,
    });
  }

  return results;
}

async function deleteBusiness(userId, businessId) {
  const { rowCount } = await query(
    `DELETE FROM financial_businesses WHERE id = $1 AND user_id = $2`,
    [businessId, userId]
  );
  return rowCount > 0;
}

// ─── Transaction Operations ──────────────────────────────────────────────────
async function createTransaction(userId, { businessId, type, name, amount, note = "", transactionDate }) {
  const { rows } = await query(
    `INSERT INTO financial_transactions (user_id, business_id, type, name, amount, note, transaction_date)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW())) RETURNING *`,
    [userId, businessId || null, type, name.trim(), Number(amount), note.trim(), transactionDate || null]
  );
  return rows[0];
}

async function updateTransaction(userId, transactionId, data) {
  const fields = ["type", "name", "amount", "note", "transaction_date", "business_id"];
  const updates = [];
  const values = [];
  let idx = 1;

  for (const f of fields) {
    if (data[f] !== undefined) {
      updates.push(`${f} = $${idx++}`);
      values.push(data[f]);
    }
  }

  if (updates.length === 0) return null;

  values.push(transactionId, userId);

  const { rows } = await query(
    `UPDATE financial_transactions SET ${updates.join(", ")} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function listTransactions(userId, { businessId = null, type = null, search = "", limit = 50, page = 1 } = {}) {
  let q = `SELECT t.*, b.name as business_name FROM financial_transactions t
           LEFT JOIN financial_businesses b ON t.business_id = b.id
           WHERE t.user_id = $1`;
  const vals = [userId];

  if (businessId) {
    vals.push(businessId);
    q += ` AND t.business_id = $${vals.length}`;
  }

  if (type) {
    vals.push(type);
    q += ` AND t.type = $${vals.length}`;
  }

  if (search && search.trim()) {
    vals.push(`%${search.trim().toLowerCase()}%`);
    q += ` AND LOWER(t.name) LIKE $${vals.length}`;
  }

  const offset = (Math.max(page, 1) - 1) * limit;
  vals.push(limit, offset);
  q += ` ORDER BY t.transaction_date DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`;

  const { rows } = await query(q, vals);
  return rows;
}

async function deleteTransaction(userId, transactionId) {
  const { rowCount } = await query(
    `DELETE FROM financial_transactions WHERE id = $1 AND user_id = $2`,
    [transactionId, userId]
  );
  return rowCount > 0;
}

// ─── Goal Operations ─────────────────────────────────────────────────────────
async function createGoal(userId, { title, category = "general", targetAmount, currentAmount = 0, targetDate, notes = "" }) {
  const { rows } = await query(
    `INSERT INTO financial_goals (user_id, title, category, target_amount, current_amount, target_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, title.trim(), category, Number(targetAmount) || 0, Number(currentAmount) || 0, targetDate || null, notes.trim()]
  );
  return rows[0];
}

async function listGoals(userId) {
  const { rows } = await query(
    `SELECT * FROM financial_goals WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  return rows;
}

async function updateGoal(userId, goalId, data) {
  const fields = ["title", "category", "target_amount", "current_amount", "target_date", "notes", "status"];
  const updates = [];
  const values = [];
  let idx = 1;

  for (const f of fields) {
    if (data[f] !== undefined) {
      updates.push(`${f} = $${idx++}`);
      values.push(data[f]);
    }
  }

  if (updates.length === 0) return null;

  updates.push(`updated_at = NOW()`);
  values.push(goalId, userId);

  const { rows } = await query(
    `UPDATE financial_goals SET ${updates.join(", ")} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function deleteGoal(userId, goalId) {
  const { rowCount } = await query(
    `DELETE FROM financial_goals WHERE id = $1 AND user_id = $2`,
    [goalId, userId]
  );
  return rowCount > 0;
}

// ─── Full Dashboard & Monthly Trends (Ported directly from mayramao) ──────────
async function getDashboardSummary(userId, { month, year } = {}) {
  const profile = await getProfile(userId);
  const businesses = await listBusinesses(userId);
  const recentTransactions = await listTransactions(userId, { limit: 15 });
  const goals = await listGoals(userId);
  const recentSimulations = await listSimulations(userId, 5);

  const now = new Date();
  const targetYear = year || now.getFullYear();
  const targetMonth = month ? month - 1 : now.getMonth();
  const targetDate = new Date(targetYear, targetMonth, 1);

  let totalInvestment = 0;
  let totalSales = 0;
  let totalExpenses = 0;
  let totalBusinessBalance = 0;

  businesses.forEach((b) => {
    totalInvestment += b.totalInvestment;
    totalSales += b.totalSales;
    totalExpenses += b.totalExpenses;
    totalBusinessBalance += b.currentBalance;
  });

  const fixedExpenses =
    Number(profile.rent) +
    Number(profile.utilities) +
    Number(profile.subscriptions_insurance) +
    Number(profile.existing_loans);
  const totalMonthlyExpenses = fixedExpenses + Number(profile.variable_expenses);
  const monthlyDisposable = Math.max(Number(profile.monthly_income) - totalMonthlyExpenses, 0);
  const netProfit = totalSales - totalInvestment - totalExpenses;
  const netWorthEstimate = Number(profile.current_savings) + totalBusinessBalance;

  // 6-month historical trend
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthlyTrends = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(targetDate.getFullYear(), targetDate.getMonth() - i, 1);
    const mStart = new Date(d.getFullYear(), d.getMonth(), 1);
    const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);

    const { rows: mRows } = await query(
      `SELECT type, SUM(amount)::numeric AS total
       FROM financial_transactions
       WHERE user_id = $1 AND transaction_date >= $2 AND transaction_date <= $3
       GROUP BY type`,
      [userId, mStart, mEnd]
    );

    let mSales = 0;
    let mInvestment = 0;
    let mExpense = 0;
    for (const r of mRows) {
      const amt = Number(r.total) || 0;
      if (r.type === "PROFIT" || r.type === "SELL" || r.type === "SALE") mSales += amt;
      if (r.type === "INVESTMENT") mInvestment += amt;
      if (r.type === "EXPENSE") mExpense += amt;
    }
    const mProfit = mSales - mInvestment - mExpense;

    monthlyTrends.push({
      monthKey: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: `${monthNames[d.getMonth()]} '${String(d.getFullYear()).slice(-2)}`,
      profit: mProfit,
      sales: mSales,
      investment: mInvestment,
      expense: mExpense,
    });
  }

  // Calculate Safe vs Risky decision ratio from simulations
  let safeSimCount = 0;
  let riskySimCount = 0;
  recentSimulations.forEach((s) => {
    if (s.risk_level === "SAFE") safeSimCount++;
    else riskySimCount++;
  });
  const totalSims = recentSimulations.length;
  const safePercentage = totalSims > 0 ? Math.round((safeSimCount / totalSims) * 100) : 100;
  const riskyPercentage = totalSims > 0 ? Math.round((riskySimCount / totalSims) * 100) : 0;

  return {
    profile: {
      monthlyIncome: Number(profile.monthly_income),
      rent: Number(profile.rent),
      utilities: Number(profile.utilities),
      subscriptionsInsurance: Number(profile.subscriptions_insurance),
      existingLoans: Number(profile.existing_loans),
      variableExpenses: Number(profile.variable_expenses),
      fixedExpenses,
      totalMonthlyExpenses,
      monthlyDisposable,
      currentSavings: Number(profile.current_savings),
      dependents: profile.dependents,
      incomeStability: profile.income_stability,
      riskTolerance: profile.risk_tolerance,
      totalSimulationsUsed: profile.total_simulations_used,
      currency: profile.currency || "USD",
      currencySymbol: profile.currency_symbol || "$",
    },
    currency: profile.currency || "USD",
    currencySymbol: profile.currency_symbol || "$",
    portfolio: {
      businessesCount: businesses.length,
      totalInvestment,
      totalSales,
      totalExpenses,
      netProfit,
      totalBusinessBalance,
      netWorthEstimate,
      businesses,
    },
    decisionStats: {
      safePercentage,
      riskyPercentage,
      totalSimulations: totalSims,
    },
    goals: {
      total: goals.length,
      items: goals,
    },
    monthlyTrends,
    recentTransactions,
    recentSimulations,
  };
}

module.exports = {
  calculateSimulation,
  getProfile,
  updateProfile,
  runSimulation,
  listSimulations,
  getSimulationById,
  createBusiness,
  getBusinessById,
  updateBusiness,
  listBusinesses,
  deleteBusiness,
  createTransaction,
  updateTransaction,
  listTransactions,
  deleteTransaction,
  createGoal,
  listGoals,
  updateGoal,
  deleteGoal,
  getDashboardSummary,
};
