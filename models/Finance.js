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

async function createExpense(userId, { title, amount, category = "Other", expenseDate, paymentMethod = "Cash", note = null }) {
  const dateVal = expenseDate || new Date().toISOString().split("T")[0];
  const res = await query(
    `INSERT INTO financial_lifetime_expenses (user_id, title, amount, category, expense_date, payment_method, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, title.trim(), Number(amount), category.trim(), dateVal, paymentMethod.trim(), note ? note.trim() : null]
  );
  return res.rows[0];
}

async function listExpenses(userId, { startDate, endDate, category, limit = 100, offset = 0 } = {}) {
  let q = `SELECT * FROM financial_lifetime_expenses WHERE user_id = $1`;
  const params = [userId];
  let idx = 2;

  if (startDate) {
    q += ` AND expense_date >= $${idx++}`;
    params.push(startDate);
  }
  if (endDate) {
    q += ` AND expense_date <= $${idx++}`;
    params.push(endDate);
  }
  if (category && category !== "ALL") {
    q += ` AND category = $${idx++}`;
    params.push(category);
  }

  q += ` ORDER BY expense_date DESC, created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(limit, offset);

  const res = await query(q, params);
  return res.rows;
}

async function getLifetimeExpenseAnalytics(userId) {
  const totalsRes = await query(
    `SELECT
       COALESCE(SUM(amount), 0) AS lifetime_total,
       COUNT(*) AS total_count,
       COALESCE(SUM(CASE WHEN expense_date = CURRENT_DATE THEN amount ELSE 0 END), 0) AS today_total,
       COALESCE(SUM(CASE WHEN DATE_TRUNC('month', expense_date) = DATE_TRUNC('month', CURRENT_DATE) THEN amount ELSE 0 END), 0) AS this_month_total,
       COALESCE(SUM(CASE WHEN DATE_TRUNC('year', expense_date) = DATE_TRUNC('year', CURRENT_DATE) THEN amount ELSE 0 END), 0) AS this_year_total,
       MIN(expense_date) AS first_expense_date,
       MAX(expense_date) AS last_expense_date,
       COALESCE(MAX(amount), 0) AS max_single_expense
     FROM financial_lifetime_expenses
     WHERE user_id = $1`,
    [userId]
  );
  const totals = totalsRes.rows[0] || {};

  const catRes = await query(
    `SELECT
       category,
       SUM(amount) AS total,
       COUNT(*) AS count
     FROM financial_lifetime_expenses
     WHERE user_id = $1
     GROUP BY category
     ORDER BY total DESC`,
    [userId]
  );

  const monthlyRes = await query(
    `SELECT
       TO_CHAR(expense_date, 'YYYY-MM') AS month_key,
       TO_CHAR(expense_date, 'Mon YYYY') AS month_label,
       SUM(amount) AS total,
       COUNT(*) AS count
     FROM financial_lifetime_expenses
     WHERE user_id = $1
     GROUP BY month_key, month_label
     ORDER BY month_key DESC
     LIMIT 24`,
    [userId]
  );

  const yearlyRes = await query(
    `SELECT
       TO_CHAR(expense_date, 'YYYY') AS year_key,
       SUM(amount) AS total,
       COUNT(*) AS count
     FROM financial_lifetime_expenses
     WHERE user_id = $1
     GROUP BY year_key
     ORDER BY year_key DESC`,
    [userId]
  );

  const recentRes = await query(
    `SELECT * FROM financial_lifetime_expenses
     WHERE user_id = $1
     ORDER BY expense_date DESC, created_at DESC
     LIMIT 50`,
    [userId]
  );

  const lifetimeTotal = Number(totals.lifetime_total) || 0;
  const categories = catRes.rows.map(r => ({
    category: r.category,
    total: Number(r.total) || 0,
    count: Number(r.count) || 0,
    percentage: lifetimeTotal > 0 ? Math.round((Number(r.total) / lifetimeTotal) * 100) : 0,
  }));

  const firstDate = totals.first_expense_date ? new Date(totals.first_expense_date) : new Date();
  const daysActive = Math.max(1, Math.round((Date.now() - firstDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  const dailyAverage = lifetimeTotal > 0 ? Number((lifetimeTotal / daysActive).toFixed(2)) : 0;
  const monthlyAverage = Number((dailyAverage * 30.41).toFixed(2));

  return {
    totals: {
      lifetimeTotal,
      todayTotal: Number(totals.today_total) || 0,
      thisMonthTotal: Number(totals.this_month_total) || 0,
      thisYearTotal: Number(totals.this_year_total) || 0,
      maxSingleExpense: Number(totals.max_single_expense) || 0,
      totalCount: Number(totals.total_count) || 0,
      firstExpenseDate: totals.first_expense_date,
      daysActive,
      dailyAverage,
      monthlyAverage,
    },
    categories,
    monthlyHistory: monthlyRes.rows.map(r => ({
      monthKey: r.month_key,
      monthLabel: r.month_label,
      total: Number(r.total) || 0,
      count: Number(r.count) || 0,
    })),
    yearlyHistory: yearlyRes.rows.map(r => ({
      yearKey: r.year_key,
      total: Number(r.total) || 0,
      count: Number(r.count) || 0,
      monthlyAverage: Number(((Number(r.total) || 0) / 12).toFixed(2)),
    })),
    recentExpenses: recentRes.rows,
  };
}

async function deleteExpense(userId, id) {
  const res = await query(
    `DELETE FROM financial_lifetime_expenses WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId]
  );
  return res.rows[0];
}

async function createIncome(userId, { title, amount, sourceCategory = "Salary", incomeDate, paymentMethod = "Cash", note = null }) {
  const dateVal = incomeDate || new Date().toISOString().split("T")[0];
  const res = await query(
    `INSERT INTO financial_lifetime_incomes (user_id, title, amount, source_category, income_date, payment_method, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, title.trim(), Number(amount), sourceCategory.trim(), dateVal, paymentMethod.trim(), note ? note.trim() : null]
  );
  return res.rows[0];
}

async function listIncomes(userId, { startDate, endDate, sourceCategory, limit = 100, offset = 0 } = {}) {
  let q = `SELECT * FROM financial_lifetime_incomes WHERE user_id = $1`;
  const params = [userId];
  let idx = 2;

  if (startDate) {
    q += ` AND income_date >= $${idx++}`;
    params.push(startDate);
  }
  if (endDate) {
    q += ` AND income_date <= $${idx++}`;
    params.push(endDate);
  }
  if (sourceCategory && sourceCategory !== "ALL") {
    q += ` AND source_category = $${idx++}`;
    params.push(sourceCategory);
  }

  q += ` ORDER BY income_date DESC, created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(Math.min(Number(limit) || 100, 500));
  params.push(Number(offset) || 0);

  const res = await query(q, params);
  return res.rows;
}

async function getLifetimeIncomeAnalytics(userId) {
  const totalsRes = await query(
    `SELECT
       COALESCE(SUM(amount), 0) AS lifetime_total,
       COUNT(*) AS total_count,
       COALESCE(SUM(CASE WHEN income_date = CURRENT_DATE THEN amount ELSE 0 END), 0) AS today_total,
       COALESCE(SUM(CASE WHEN DATE_TRUNC('month', income_date) = DATE_TRUNC('month', CURRENT_DATE) THEN amount ELSE 0 END), 0) AS this_month_total,
       COALESCE(SUM(CASE WHEN DATE_TRUNC('year', income_date) = DATE_TRUNC('year', CURRENT_DATE) THEN amount ELSE 0 END), 0) AS this_year_total,
       MIN(income_date) AS first_income_date,
       MAX(income_date) AS last_income_date,
       COALESCE(MAX(amount), 0) AS max_single_income
     FROM financial_lifetime_incomes
     WHERE user_id = $1`,
    [userId]
  );
  const totals = totalsRes.rows[0] || {};

  const sourceRes = await query(
    `SELECT
       source_category,
       SUM(amount) AS total,
       COUNT(*) AS count
     FROM financial_lifetime_incomes
     WHERE user_id = $1
     GROUP BY source_category
     ORDER BY total DESC`,
    [userId]
  );

  const monthlyRes = await query(
    `SELECT
       TO_CHAR(income_date, 'YYYY-MM') AS month_key,
       TO_CHAR(income_date, 'Mon YYYY') AS month_label,
       SUM(amount) AS total,
       COUNT(*) AS count
     FROM financial_lifetime_incomes
     WHERE user_id = $1
     GROUP BY month_key, month_label
     ORDER BY month_key DESC
     LIMIT 24`,
    [userId]
  );

  const yearlyRes = await query(
    `SELECT
       TO_CHAR(income_date, 'YYYY') AS year_key,
       SUM(amount) AS total,
       COUNT(*) AS count
     FROM financial_lifetime_incomes
     WHERE user_id = $1
     GROUP BY year_key
     ORDER BY year_key DESC`,
    [userId]
  );

  const recentRes = await query(
    `SELECT * FROM financial_lifetime_incomes
     WHERE user_id = $1
     ORDER BY income_date DESC, created_at DESC
     LIMIT 50`,
    [userId]
  );

  const lifetimeTotal = Number(totals.lifetime_total) || 0;
  const sources = sourceRes.rows.map(r => ({
    sourceCategory: r.source_category,
    category: r.source_category,
    total: Number(r.total) || 0,
    count: Number(r.count) || 0,
    percentage: lifetimeTotal > 0 ? Math.round((Number(r.total) / lifetimeTotal) * 100) : 0,
  }));

  const firstDate = totals.first_income_date ? new Date(totals.first_income_date) : new Date();
  const lastDate = totals.last_income_date ? new Date(totals.last_income_date) : new Date();
  const daysActive = Math.max(1, Math.round(Math.abs(lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  const dailyAverage = Number((lifetimeTotal / daysActive).toFixed(2));

  return {
    lifetimeTotal,
    totalCount: Number(totals.total_count) || 0,
    todayTotal: Number(totals.today_total) || 0,
    thisMonthTotal: Number(totals.this_month_total) || 0,
    thisYearTotal: Number(totals.this_year_total) || 0,
    firstIncomeDate: totals.first_income_date,
    lastIncomeDate: totals.last_income_date,
    maxSingleIncome: Number(totals.max_single_income) || 0,
    dailyAverage,
    daysActive,
    sources,
    monthlyHistory: monthlyRes.rows.map(r => ({
      monthKey: r.month_key,
      monthLabel: r.month_label,
      total: Number(r.total) || 0,
      count: Number(r.count) || 0,
    })),
    yearlyHistory: yearlyRes.rows.map(r => ({
      yearKey: r.year_key,
      total: Number(r.total) || 0,
      count: Number(r.count) || 0,
      monthlyAverage: Number(((Number(r.total) || 0) / 12).toFixed(2)),
    })),
    recentIncomes: recentRes.rows,
  };
}

async function deleteIncome(userId, id) {
  const res = await query(
    `DELETE FROM financial_lifetime_incomes WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId]
  );
  return res.rows[0];
}

async function getLifetimeFinancialSummary(userId) {
  const [expenseData, incomeData] = await Promise.all([
    getLifetimeExpenseAnalytics(userId),
    getLifetimeIncomeAnalytics(userId),
  ]);

  // Expense analytics nests its totals under `totals` (income analytics doesn't)
  const exp = expenseData.totals || expenseData;
  const lifetimeIncome = incomeData.lifetimeTotal || 0;
  const lifetimeExpense = exp.lifetimeTotal || 0;
  const netLifetime = Number((lifetimeIncome - lifetimeExpense).toFixed(2));

  const thisMonthIncome = incomeData.thisMonthTotal || 0;
  const thisMonthExpense = exp.thisMonthTotal || 0;
  const thisMonthNet = Number((thisMonthIncome - thisMonthExpense).toFixed(2));

  const thisYearIncome = incomeData.thisYearTotal || 0;
  const thisYearExpense = exp.thisYearTotal || 0;
  const thisYearNet = Number((thisYearIncome - thisYearExpense).toFixed(2));

  const todayIncome = incomeData.todayTotal || 0;
  const todayExpense = exp.todayTotal || 0;
  const todayNet = Number((todayIncome - todayExpense).toFixed(2));

  const savingsRate = lifetimeIncome > 0
    ? Math.max(0, Math.round(((lifetimeIncome - lifetimeExpense) / lifetimeIncome) * 100))
    : 0;

  return {
    lifetimeIncome,
    lifetimeExpense,
    netLifetime,
    thisMonthIncome,
    thisMonthExpense,
    thisMonthNet,
    thisYearIncome,
    thisYearExpense,
    thisYearNet,
    todayIncome,
    todayExpense,
    todayNet,
    savingsRate,
    expenseAnalytics: expenseData,
    incomeAnalytics: incomeData,
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
  createExpense,
  listExpenses,
  getLifetimeExpenseAnalytics,
  deleteExpense,
  createIncome,
  listIncomes,
  getLifetimeIncomeAnalytics,
  deleteIncome,
  getLifetimeFinancialSummary,
};
