const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  app, request, startDb, stopDb, clearDb, auth, login, seedTeam, seedLoan, today, models,
} = require('./helpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const submit = (token, body) => request(app).post('/api/collections').set(auth(token)).send(body);
const dashboard = async (token) => (await request(app).get('/api/dashboard').set(auth(token))).body.data;

describe('staff view of loans', () => {
  it('shows only what collecting needs', async () => {
    const { staff } = await seedTeam();
    await seedLoan();
    const res = await request(app).get('/api/collections/loans').set(auth(staff));
    assert.equal(res.status, 200);
    const [loan] = res.body.data;
    assert.deepEqual(Object.keys(loan).sort(), [
      '_id', 'awaitingApproval', 'client', 'installment', 'isCollectedToday', 'nextPaymentDate', 'paymentFrequency', 'pendingAmount',
    ]);
    assert.equal(loan.client.name, 'Ramesh Kumar');
    assert.equal(loan.installment, 120);
    assert.equal(loan.pendingAmount, 1200);
    assert.equal(loan.principalAmount, undefined);
    assert.equal(loan.profitAmount, undefined);
  });

  it('lists only active loans', async () => {
    const { staff } = await seedTeam();
    const { loan } = await seedLoan();
    await models.Loan.updateOne({ _id: loan._id }, { status: 'CLOSED' });
    const res = await request(app).get('/api/collections/loans').set(auth(staff));
    assert.equal(res.body.data.length, 0);
  });
});

describe('submitting a collection', () => {
  it('waits for approval and changes nothing until then', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan();
    const before = await dashboard(admin);

    const res = await submit(staff, { loan: loan._id, amount: 120, date: today(), notes: 'Paid in cash' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'PENDING');

    const loanAfter = await models.Loan.findById(loan._id).lean();
    assert.equal(loanAfter.totalRepaid, 0);
    assert.equal(loanAfter.pendingAmount, 1200);
    assert.equal(await models.Transaction.countDocuments({ type: 'REPAYMENT' }), 0);
    assert.deepEqual((await dashboard(admin)).finances, before.finances);

    const loans = (await request(app).get('/api/collections/loans').set(auth(staff))).body.data;
    assert.deepEqual(loans[0].awaitingApproval, { count: 1, amount: 120, today: true });
  });

  it('saves a resent submission only once', async () => {
    const { staff } = await seedTeam();
    const { loan } = await seedLoan();
    const body = { loan: loan._id, amount: 120, date: today(), requestId: 'req-1' };
    const results = await Promise.all([submit(staff, body), submit(staff, body), submit(staff, body)]);
    assert.ok(results.every((r) => r.status === 200 || r.status === 201));
    assert.equal(new Set(results.map((r) => r.body.data._id)).size, 1);
    assert.equal(await models.CollectionEntry.countDocuments(), 1);
  });

  it('refuses bad input', async () => {
    const { staff } = await seedTeam();
    const { loan } = await seedLoan();
    const future = new Date(Date.now() + 3 * 86400000).toISOString().substring(0, 10);
    for (const body of [
      { loan: loan._id, amount: 0, date: today() },
      { loan: loan._id, amount: -5, date: today() },
      { loan: loan._id, amount: '120', date: today() },
      { loan: loan._id, amount: 120 },
      { loan: loan._id, amount: 120, date: future },
      { loan: 'not-an-id', amount: 120, date: today() },
    ]) {
      const res = await submit(staff, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it('refuses closed loans', async () => {
    const { staff } = await seedTeam();
    const { loan } = await seedLoan();
    await models.Loan.updateOne({ _id: loan._id }, { status: 'CLOSED' });
    const res = await submit(staff, { loan: loan._id, amount: 120, date: today() });
    assert.equal(res.status, 409);
  });

  it('shows staff only their own entries', async () => {
    const { admin, staff } = await seedTeam();
    await request(app).post('/api/users').set(auth(admin)).send({ name: 'Suma', username: 'suma', pin: '1357' });
    const suma = await login('suma', '1357');
    const { loan } = await seedLoan();
    await submit(staff, { loan: loan._id, amount: 120, date: today() });
    await submit(suma, { loan: loan._id, amount: 240, date: today() });

    const mine = (await request(app).get('/api/collections').set(auth(staff))).body.data;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].amount, 120);
    const all = (await request(app).get('/api/collections').set(auth(admin))).body.data;
    assert.equal(all.length, 2);
  });
});

describe('approving', () => {
  it('records the repayment principal first, exactly like the admin entering it', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan({ principal: 1000, expected: 1200 });
    // 900 already repaid: 100 of principal left, so a 300 payment is 100 principal + 200 profit
    await request(app).post('/api/transactions').set(auth(admin)).send({ type: 'REPAYMENT', loan: loan._id, amount: 900, date: today() });

    const entry = (await submit(staff, { loan: loan._id, amount: 300, date: today(), notes: 'Paid in cash' })).body.data;
    const res = await request(app).post(`/api/collections/${entry._id}/approve`).set(auth(admin)).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'APPROVED');

    const transaction = await models.Transaction.findById(res.body.data.transaction).lean();
    assert.equal(transaction.type, 'REPAYMENT');
    assert.equal(transaction.amount, 300);
    assert.equal(transaction.principalPortion, 100);
    assert.equal(transaction.profitPortion, 200);
    assert.equal(String(transaction.collectedBy), String(entry.submittedBy));
    assert.equal(String(transaction.client), String(entry.client));
    assert.match(transaction.notes, /Collected by Ravi · Paid in cash/);

    const loanAfter = await models.Loan.findById(loan._id).lean();
    assert.equal(loanAfter.totalRepaid, 1200);
    assert.equal(loanAfter.pendingAmount, 0);
    assert.equal(loanAfter.status, 'CLOSED');

    const ledger = (await request(app).get('/api/transactions').set(auth(admin))).body.data;
    assert.equal(ledger.find((t) => t._id === String(transaction._id)).collectedBy.name, 'Ravi');
  });

  it('updates the dashboard only once approved', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan();
    const before = (await dashboard(admin)).finances;
    const entry = (await submit(staff, { loan: loan._id, amount: 120, date: today() })).body.data;
    await request(app).post(`/api/collections/${entry._id}/approve`).set(auth(admin)).send({});
    const after = (await dashboard(admin)).finances;
    assert.equal(after.cashOnHand, before.cashOnHand + 120);
    assert.equal(after.moneyInMarket, before.moneyInMarket - 120);
  });

  it('records it once when approved twice at the same moment', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan();
    const entry = (await submit(staff, { loan: loan._id, amount: 120, date: today() })).body.data;
    const results = await Promise.all([1, 2, 3].map(() =>
      request(app).post(`/api/collections/${entry._id}/approve`).set(auth(admin)).send({})
    ));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
    assert.equal(await models.Transaction.countDocuments({ type: 'REPAYMENT' }), 1);
    assert.equal((await models.Loan.findById(loan._id).lean()).totalRepaid, 120);
  });

  it('keeps every payment when several for one loan are approved at once', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan();
    const entries = [];
    for (const amount of [100, 200, 300]) {
      entries.push((await submit(staff, { loan: loan._id, amount, date: today() })).body.data);
    }
    const results = await Promise.all(entries.map((e) =>
      request(app).post(`/api/collections/${e._id}/approve`).set(auth(admin)).send({})
    ));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    const loanAfter = await models.Loan.findById(loan._id).lean();
    assert.equal(loanAfter.totalRepaid, 600);
    assert.equal(loanAfter.pendingAmount, 600);
    assert.equal(loanAfter.principalRecovered, 600);
  });

  it('records a corrected amount and date but keeps what staff reported', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan();
    const entry = (await submit(staff, { loan: loan._id, amount: 150, date: today() })).body.data;
    const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);
    const res = await request(app).post(`/api/collections/${entry._id}/approve`).set(auth(admin)).send({ amount: 120, date: yesterday });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.amount, 150);
    assert.equal(res.body.data.approvedAmount, 120);
    const transaction = await models.Transaction.findById(res.body.data.transaction).lean();
    assert.equal(transaction.amount, 120);
    assert.equal(transaction.date.toISOString().substring(0, 10), yesterday);
  });

  it('changes nothing when the loan was closed in the meantime', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan();
    const entry = (await submit(staff, { loan: loan._id, amount: 120, date: today() })).body.data;
    await models.Loan.updateOne({ _id: loan._id }, { status: 'CLOSED' });

    const res = await request(app).post(`/api/collections/${entry._id}/approve`).set(auth(admin)).send({});
    assert.equal(res.status, 409);
    // The entry was claimed inside the transaction, so it must have rolled back to pending
    assert.equal((await models.CollectionEntry.findById(entry._id).lean()).status, 'PENDING');
    assert.equal(await models.Transaction.countDocuments({ type: 'REPAYMENT' }), 0);
  });

  it('flags entries to look at before approving', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan();
    await request(app).post('/api/transactions').set(auth(admin)).send({ type: 'REPAYMENT', loan: loan._id, amount: 120, date: today() });
    await submit(staff, { loan: loan._id, amount: 120, date: today() });
    await submit(staff, { loan: loan._id, amount: 5000, date: today() });

    const queue = (await request(app).get('/api/collections?status=PENDING').set(auth(admin))).body.data;
    assert.equal(queue.length, 2);
    assert.deepEqual(queue[0].warnings.sort(), ['ALREADY_PAID_THAT_DAY', 'DUPLICATE_ENTRY']);
    assert.deepEqual(queue[1].warnings.sort(), ['ALREADY_PAID_THAT_DAY', 'DUPLICATE_ENTRY', 'MORE_THAN_OWED']);

    const summary = (await request(app).get('/api/collections/summary').set(auth(admin))).body.data;
    assert.deepEqual(summary, { pendingCount: 2, pendingAmount: 5120 });
  });
});

describe('rejecting, withdrawing and undoing', () => {
  it('rejects with a reason the staff member can see, and nothing is recorded', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan();
    const entry = (await submit(staff, { loan: loan._id, amount: 120, date: today() })).body.data;

    assert.equal((await request(app).post(`/api/collections/${entry._id}/reject`).set(auth(admin)).send({})).status, 400);
    const res = await request(app).post(`/api/collections/${entry._id}/reject`).set(auth(admin)).send({ reason: 'Client says they paid ₹100' });
    assert.equal(res.status, 200);

    const mine = (await request(app).get('/api/collections').set(auth(staff))).body.data;
    assert.equal(mine[0].status, 'REJECTED');
    assert.equal(mine[0].rejectionReason, 'Client says they paid ₹100');
    assert.equal(await models.Transaction.countDocuments({ type: 'REPAYMENT' }), 0);
    assert.equal((await request(app).post(`/api/collections/${entry._id}/approve`).set(auth(admin)).send({})).status, 409);
  });

  it('lets staff withdraw only their own pending entries', async () => {
    const { admin, staff } = await seedTeam();
    await request(app).post('/api/users').set(auth(admin)).send({ name: 'Suma', username: 'suma', pin: '1357' });
    const suma = await login('suma', '1357');
    const { loan } = await seedLoan();
    const entry = (await submit(staff, { loan: loan._id, amount: 120, date: today() })).body.data;

    assert.equal((await request(app).post(`/api/collections/${entry._id}/cancel`).set(auth(suma))).status, 404);
    assert.equal((await request(app).post(`/api/collections/${entry._id}/cancel`).set(auth(staff))).status, 200);
    assert.equal((await request(app).post(`/api/collections/${entry._id}/cancel`).set(auth(staff))).status, 409);
    assert.equal((await request(app).post(`/api/collections/${entry._id}/approve`).set(auth(admin)).send({})).status, 409);
  });

  it('marks the entry reversed when the admin undoes the approved repayment', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan();
    const entry = (await submit(staff, { loan: loan._id, amount: 120, date: today() })).body.data;
    const approved = (await request(app).post(`/api/collections/${entry._id}/approve`).set(auth(admin)).send({})).body.data;

    const res = await request(app).delete(`/api/transactions/${approved.transaction}`).set(auth(admin));
    assert.equal(res.status, 200);
    assert.equal((await models.CollectionEntry.findById(entry._id).lean()).status, 'REVERSED');
    const loanAfter = await models.Loan.findById(loan._id).lean();
    assert.equal(loanAfter.totalRepaid, 0);
    assert.equal(loanAfter.pendingAmount, 1200);
  });
});

describe('the admin\'s own entries still work as before', () => {
  it('records a direct repayment and its undo', async () => {
    const { admin } = await seedTeam();
    const { loan } = await seedLoan({ principal: 1000, expected: 1200 });
    const res = await request(app).post('/api/transactions').set(auth(admin)).send({ type: 'REPAYMENT', loan: loan._id, amount: 1100, date: today() });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.principalPortion, 1000);
    assert.equal(res.body.data.profitPortion, 100);
    assert.equal(res.body.data.client, null);

    const del = await request(app).delete(`/api/transactions/${res.body.data._id}`).set(auth(admin));
    assert.equal(del.status, 200);
    const loanAfter = await models.Loan.findById(loan._id).lean();
    assert.equal(loanAfter.totalRepaid, 0);
    assert.equal(loanAfter.principalRecovered, 0);
    assert.equal(loanAfter.profitRealized, 0);
  });

  it('keeps the dashboard\'s next due date: one day after the latest repayment for a daily loan', async () => {
    const { admin } = await seedTeam();
    const { loan } = await seedLoan();
    const paidOn = new Date(Date.now() - 2 * 86400000).toISOString().substring(0, 10);
    await request(app).post('/api/transactions').set(auth(admin)).send({ type: 'REPAYMENT', loan: loan._id, amount: 120, date: paidOn });
    const [active] = (await dashboard(admin)).collections.activeLoans;
    const expected = new Date(paidOn);
    expected.setDate(expected.getDate() + 1);
    assert.equal(new Date(active.nextPaymentDate).getTime(), expected.getTime());
    assert.equal(active.isCollectedToday, false);
  });

  it('still records capital, withdrawals and expenses', async () => {
    const { admin } = await seedTeam();
    for (const type of ['CAPITAL_INJECTION', 'CAPITAL_WITHDRAWAL', 'BUSINESS_EXPENSE']) {
      const res = await request(app).post('/api/transactions').set(auth(admin)).send({ type, amount: 500, date: today() });
      assert.equal(res.status, 201, type);
    }
  });

  it('refuses a repayment without a positive amount instead of corrupting the loan', async () => {
    const { admin } = await seedTeam();
    const { loan } = await seedLoan();
    const res = await request(app).post('/api/transactions').set(auth(admin)).send({ type: 'REPAYMENT', loan: loan._id, date: today() });
    assert.equal(res.status, 400);
    assert.equal((await models.Loan.findById(loan._id).lean()).totalRepaid, 0);
  });
});
