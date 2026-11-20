// Automated API Test Suite for FastChat
require('dotenv').config({ path: __dirname + '/../.env' });
const jwt = require('jsonwebtoken');

const BASE_URL = 'http://localhost:5001';
const TEST_USER_ID = '2d38e014-5c20-4d0c-9340-0d037c2adf0b'; // carol_test in local db

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response
  }
  return { status: res.status, ok: res.ok, data };
}

async function runTests() {
  console.log('====================================================');
  console.log('🚀 FASTCHAT COMPREHENSIVE API TEST SUITE STARTING...');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name, condition, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name} ${details}`);
      failed++;
    }
  }

  // 1. Health check
  const healthRes = await request('/');
  assert('Server Root / Health Endpoint', healthRes.status === 200 || healthRes.status === 404);

  // 2. Auth Token generation
  console.log('\n--- 1. AUTHENTICATION & USER APIS ---');
  const token = jwt.sign({ id: TEST_USER_ID }, process.env.JWT_SECRET, { expiresIn: '1d' });
  assert('JWT Authentication Token generated', !!token);

  const authHeaders = { Authorization: `Bearer ${token}` };

  // GET /api/users/me
  const meRes = await request('/api/users/me', { headers: authHeaders });
  assert('GET /api/users/me', meRes.status === 200 && (meRes.data?.user || meRes.data?.id || meRes.data?._id));

  // GET /api/users/search?query=test
  const userSearchRes = await request('/api/users/search?query=test', { headers: authHeaders });
  assert('GET /api/users/search', userSearchRes.status === 200);

  console.log('\n--- 2. WORKSPACES & CHANNELS APIS ---');
  const wsRes = await request('/api/workspaces', { headers: authHeaders });
  assert('GET /api/workspaces', wsRes.status === 200);

  const chanRes = await request('/api/channels', { headers: authHeaders });
  assert('GET /api/channels', chanRes.status === 200 || chanRes.status === 404);

  console.log('\n--- 3. FINANCE CORE APIS ---');
  // GET /api/finance/dashboard
  const dashRes = await request('/api/finance/dashboard', { headers: authHeaders });
  assert('GET /api/finance/dashboard', dashRes.status === 200 && dashRes.data?.success === true);

  // GET /api/finance/profile
  const profGetRes = await request('/api/finance/profile', { headers: authHeaders });
  assert('GET /api/finance/profile', profGetRes.status === 200 && profGetRes.data?.success === true);

  // PUT /api/finance/profile
  const profUpdateRes = await request('/api/finance/profile', {
    method: 'PUT',
    headers: authHeaders,
    body: {
      monthly_income: 6500,
      rent: 1400,
      utilities: 250,
      current_savings: 18000,
      currency: 'USD',
      currency_symbol: '$',
    },
  });
  assert('PUT /api/finance/profile', profUpdateRes.status === 200 && profUpdateRes.data?.success === true);

  // POST /api/finance/simulate
  const simRes = await request('/api/finance/simulate', {
    method: 'POST',
    headers: authHeaders,
    body: {
      purchaseAmount: 3200,
      paymentType: 'loan',
      loanDuration: 12,
      interestRate: 5.5,
      planName: 'API Test Server Setup',
    },
  });
  assert('POST /api/finance/simulate (AI Simulator)', simRes.status === 200 && simRes.data?.success === true);

  // GET /api/finance/simulations
  const simListRes = await request('/api/finance/simulations?limit=5', { headers: authHeaders });
  assert('GET /api/finance/simulations', simListRes.status === 200 && simListRes.data?.success === true);

  // POST /api/finance/businesses
  let testBizId = '';
  const bizCreateRes = await request('/api/finance/businesses', {
    method: 'POST',
    headers: authHeaders,
    body: {
      name: `Test Venture ${Date.now()}`,
      description: 'Automated test business venture',
      initialInvestment: 5000,
      openingBalance: 2000,
    },
  });
  if (bizCreateRes.status === 201 || bizCreateRes.status === 200) {
    testBizId = bizCreateRes.data?.business?.id;
    assert('POST /api/finance/businesses (Create Venture)', true);
  } else {
    assert('POST /api/finance/businesses', false, JSON.stringify(bizCreateRes.data));
  }

  // GET /api/finance/businesses
  const bizListRes = await request('/api/finance/businesses', { headers: authHeaders });
  assert('GET /api/finance/businesses', bizListRes.status === 200 && bizListRes.data?.success === true);

  // POST /api/finance/transactions
  const txCreateRes = await request('/api/finance/transactions', {
    method: 'POST',
    headers: authHeaders,
    body: {
      businessId: testBizId || undefined,
      type: 'PROFIT',
      name: 'Initial Software Sale',
      amount: 750,
    },
  });
  assert('POST /api/finance/transactions', (txCreateRes.status === 201 || txCreateRes.status === 200) && txCreateRes.data?.success === true);

  // GET /api/finance/transactions
  const txListRes = await request('/api/finance/transactions', { headers: authHeaders });
  assert('GET /api/finance/transactions', txListRes.status === 200 && txListRes.data?.success === true);

  // POST /api/finance/goals
  let testGoalId = '';
  const goalCreateRes = await request('/api/finance/goals', {
    method: 'POST',
    headers: authHeaders,
    body: {
      title: 'API Test Savings Target',
      category: 'emergency',
      targetAmount: 10000,
      currentAmount: 2500,
    },
  });
  if (goalCreateRes.status === 201 || goalCreateRes.status === 200) {
    testGoalId = goalCreateRes.data?.goal?.id;
    assert('POST /api/finance/goals (Create Goal)', true);
  } else {
    assert('POST /api/finance/goals', false, JSON.stringify(goalCreateRes.data));
  }

  // GET /api/finance/goals
  const goalListRes = await request('/api/finance/goals', { headers: authHeaders });
  assert('GET /api/finance/goals', goalListRes.status === 200 && goalListRes.data?.success === true);

  // GET /api/finance/subscription
  const subRes = await request('/api/finance/subscription', { headers: authHeaders });
  assert('GET /api/finance/subscription', subRes.status === 200 && subRes.data?.success === true);

  // POST /api/finance/subscription/sync
  const subSyncRes = await request('/api/finance/subscription/sync', {
    method: 'POST',
    headers: authHeaders,
    body: {
      plan: 'monthly',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
      originalTransactionId: `test_tx_${Date.now()}`,
    },
  });
  assert('POST /api/finance/subscription/sync', subSyncRes.status === 200 && subSyncRes.data?.success === true);

  console.log('\n--- 4. LIFETIME EXPENSE APIS ---');
  // 1. GET /api/finance/expenses/analytics
  const expAnalyticsRes = await request('/api/finance/expenses/analytics', { headers: authHeaders });
  assert('GET /api/finance/expenses/analytics', expAnalyticsRes.status === 200 && expAnalyticsRes.data?.success === true);

  // 2. POST /api/finance/expenses (Create multiple daily expenses)
  const exp1Res = await request('/api/finance/expenses', {
    method: 'POST',
    headers: authHeaders,
    body: {
      title: 'Office Team Lunch',
      amount: 45.5,
      category: 'Food & Dining',
      expenseDate: new Date().toISOString().slice(0, 10),
      paymentMethod: 'Cash',
      note: 'Delicious lunch with colleagues',
    },
  });
  assert('POST /api/finance/expenses (Expense 1: Food)', (exp1Res.status === 201 || exp1Res.status === 200) && exp1Res.data?.success === true);
  const exp1Id = exp1Res.data?.expense?.id;

  const exp2Res = await request('/api/finance/expenses', {
    method: 'POST',
    headers: authHeaders,
    body: {
      title: 'Cloud Server Subscription',
      amount: 120.0,
      category: 'Tech & Gadgets',
      expenseDate: new Date().toISOString().slice(0, 10),
      paymentMethod: 'Card / Bank',
      note: 'Monthly cloud hosting fee',
    },
  });
  assert('POST /api/finance/expenses (Expense 2: Tech)', (exp2Res.status === 201 || exp2Res.status === 200) && exp2Res.data?.success === true);
  const exp2Id = exp2Res.data?.expense?.id;

  // 3. GET /api/finance/expenses (List expenses)
  const expListRes = await request('/api/finance/expenses?limit=10', { headers: authHeaders });
  assert('GET /api/finance/expenses (List)', expListRes.status === 200 && Array.isArray(expListRes.data?.expenses) && expListRes.data.expenses.length >= 2);

  // 4. Verify Analytics updated with newly created expenses
  const expAnalyticsAfterRes = await request('/api/finance/expenses/analytics', { headers: authHeaders });
  const lifetimeTotal = expAnalyticsAfterRes.data?.data?.totals?.lifetimeTotal || 0;
  assert(
    'GET /api/finance/expenses/analytics (Updated Totals)',
    expAnalyticsAfterRes.status === 200 && lifetimeTotal >= 165.5,
    `lifetimeTotal was: ${lifetimeTotal}`
  );

  // 5. DELETE /api/finance/expenses/:id
  if (exp1Id) {
    const delRes = await request(`/api/finance/expenses/${exp1Id}`, { method: 'DELETE', headers: authHeaders });
    assert('DELETE /api/finance/expenses/:id', delRes.status === 200 && delRes.data?.success === true);
  }

  console.log('\n--- 5. LIFETIME INCOME & NET BALANCE APIS ---');
  // 1. GET /api/finance/incomes/analytics
  const incAnalyticsRes = await request('/api/finance/incomes/analytics', { headers: authHeaders });
  assert('GET /api/finance/incomes/analytics', incAnalyticsRes.status === 200 && incAnalyticsRes.data?.success === true);

  // 2. POST /api/finance/incomes (Salary)
  const inc1Res = await request('/api/finance/incomes', {
    method: 'POST',
    headers: authHeaders,
    body: {
      title: 'Monthly Job Salary',
      amount: 1500,
      sourceCategory: 'Salary',
      incomeDate: new Date().toISOString().slice(0, 10),
      paymentMethod: 'Bank Transfer',
      note: 'November tech salary',
    },
  });
  assert('POST /api/finance/incomes (Salary)', (inc1Res.status === 201 || inc1Res.status === 200) && inc1Res.data?.success === true);
  const inc1Id = inc1Res.data?.income?.id;

  // 3. POST /api/finance/incomes (From Family / বাড়ি থেকে নেয়া)
  const inc2Res = await request('/api/finance/incomes', {
    method: 'POST',
    headers: authHeaders,
    body: {
      title: 'Allowance from Family',
      amount: 300,
      sourceCategory: 'From Family / Home',
      incomeDate: new Date().toISOString().slice(0, 10),
      paymentMethod: 'bKash',
      note: 'Bari theke pathaise',
    },
  });
  assert('POST /api/finance/incomes (From Family / Home)', (inc2Res.status === 201 || inc2Res.status === 200) && inc2Res.data?.success === true);
  const inc2Id = inc2Res.data?.income?.id;

  // 4. GET /api/finance/incomes (List)
  const incListRes = await request('/api/finance/incomes?limit=10', { headers: authHeaders });
  assert('GET /api/finance/incomes (List)', incListRes.status === 200 && Array.isArray(incListRes.data?.incomes) && incListRes.data.incomes.length >= 2);

  // 5. GET /api/finance/lifetime/summary (Combined Net Balance)
  const summaryRes = await request('/api/finance/lifetime/summary', { headers: authHeaders });
  const summaryData = summaryRes.data?.data || summaryRes.data;
  assert(
    'GET /api/finance/lifetime/summary (Net Balance)',
    summaryRes.status === 200 && summaryData.lifetimeIncome >= 1800 && typeof summaryData.netLifetime === 'number',
    `lifetimeIncome: ${summaryData?.lifetimeIncome}, netLifetime: ${summaryData?.netLifetime}`
  );

  // 6. DELETE /api/finance/incomes/:id
  if (inc1Id) {
    const delIncRes = await request(`/api/finance/incomes/${inc1Id}`, { method: 'DELETE', headers: authHeaders });
    assert('DELETE /api/finance/incomes/:id', delIncRes.status === 200 && delIncRes.data?.success === true);
  }

  // Clean up test business & goal
  if (testBizId) {
    await request(`/api/finance/businesses/${testBizId}`, { method: 'DELETE', headers: authHeaders });
  }
  if (testGoalId) {
    await request(`/api/finance/goals/${testGoalId}`, { method: 'DELETE', headers: authHeaders });
  }

  console.log('\n====================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner encountered unexpected error:', err);
  process.exit(1);
});
