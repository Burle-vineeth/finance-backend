// Late fees: charged on a loan, they add to what the client owes, fall due alongside the installments,
// reopen a closed loan, and count as profit once paid
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, startDb, stopDb, clearDb, auth, seedTeam, today, models } = require('./helpers');
const { addDays, keyToDate } = require('../src/services/schedule');

before(startDb);
after(stopDb);
beforeEach(clearDb);

// ₹10,000 lent for ₹12,000 back, ₹1,200 a day for 10 days, given 20 days ago: its term is over
const setup = async ({ daysAgo = 20 } = {}) => {
  const team = await seedTeam();
  const start = addDays(today(), -daysAgo);
  const client = await models.Client.create({ name: 'Ramesh Kumar', phone: '9848012345' });
  await models.Transaction.create({ type: 'CAPITAL_INJECTION', amount: 100000 });
  const loan = await models.Loan.create({
    client: client._id, principalAmount: 10000, expectedReturnAmount: 12000, paymentFrequency: 'DAILY', durationDays: 10,
    startDate: keyToDate(start),
  });
  const as = (token) => ({
    repay: (amount, day = today()) => request(app).post('/api/transactions').set(auth(token))
      .send({ type: 'REPAYMENT', loan: String(loan._id), amount, date: day }),
    addFee: (body) => request(app).post(`/api/loans/${loan._id}/late-fees`).set(auth(token)).send(body),
    removeFee: (feeId) => request(app).delete(`/api/loans/${loan._id}/late-fees/${feeId}`).set(auth(token)),
    listed: async () => (await request(app).get('/api/loans').set(auth(token))).body.data.find((l) => String(l._id) === String(loan._id)),
  });
  return { ...team, start, loan, ...as(team.admin), staffApi: as(team.staff) };
};

describe('late fees', () => {
  it('lets ₹2,000 and then ₹1,000 be logged when a ₹1,000 fee makes ₹13,000 owed', async () => {
    const { repay, addFee, listed } = await setup();
    assert.equal((await repay(10000)).status, 201);

    const added = await addFee({ amount: 1000, date: today(), note: '3 weeks late' });
    assert.equal(added.status, 201);
    assert.equal(added.body.data.pendingAmount, 3000);
    assert.equal(added.body.data.profitAmount, 3000);

    await repay(2000);
    let loan = await listed();
    assert.equal(loan.status, 'ACTIVE');
    assert.equal(loan.pendingAmount, 1000);

    await repay(1000);
    loan = await listed();
    assert.equal(loan.status, 'CLOSED');
    assert.equal(loan.pendingAmount, 0);
    assert.equal(loan.totalRepaid, 13000);
    // Principal first, so all ₹3,000 beyond the ₹10,000 lent is profit
    assert.equal(loan.profitRealized, 3000);
    assert.equal(loan.lateFees.length, 1);
    assert.equal(loan.lateFees[0].note, '3 weeks late');
  });

  it('reopens a loan that was already paid off, until the fee is paid', async () => {
    const { repay, addFee, listed } = await setup();
    await repay(12000);
    assert.equal((await listed()).status, 'CLOSED');

    await addFee({ amount: 1000, date: today() });
    let loan = await listed();
    assert.equal(loan.status, 'ACTIVE');
    assert.equal(loan.resolvedAt, undefined);
    assert.equal(loan.pendingAmount, 1000);
    // The fee is what is due now, and the installments all stay paid
    assert.equal(loan.schedule.status, 'DUE_TODAY');
    assert.equal(loan.schedule.amountDue, 1000);
    assert.equal(loan.schedule.installmentsPaid, 10);
    assert.equal(loan.schedule.installmentsTotal, 10);
    assert.equal(loan.schedule.lateFees, 1000);

    await repay(1000);
    loan = await listed();
    assert.equal(loan.status, 'CLOSED');
    // ₹3,000 profit over the 20 days since it was given
    assert.equal(loan.interestRate.actual, 547.5);
  });

  it('shows an unpaid fee as overdue once its day has passed, and counts it in the chart', async () => {
    const { start, repay, addFee, listed, admin } = await setup();
    await repay(12000, addDays(today(), -5));
    await addFee({ amount: 500, date: addDays(today(), -2) });

    const loan = await listed();
    assert.equal(loan.schedule.status, 'OVERDUE');
    assert.equal(loan.schedule.overdueSince, addDays(today(), -2));
    assert.equal(loan.schedule.overdueBeforeToday, 500);

    const { days } = (await request(app).get(`/api/dashboard/collections?from=${start}`).set(auth(admin))).body.data;
    assert.equal(days.find((d) => d.date === addDays(today(), -2)).expected, 500);
    assert.equal(days.reduce((sum, d) => sum + d.expected, 0), 12500);
  });

  it('shows the fee to staff as owed, so they can collect it', async () => {
    const { repay, addFee, staff } = await setup();
    await repay(12000);
    await addFee({ amount: 1000, date: today() });

    const res = await request(app).get('/api/collections/loans').set(auth(staff));
    const [loan] = res.body.data;
    assert.equal(loan.pendingAmount, 1000);
    assert.equal(loan.schedule.amountDue, 1000);
    const sent = await request(app).post('/api/collections').set(auth(staff))
      .send({ loan: String(loan._id), amount: 1000, date: today(), requestId: 'fee-1' });
    assert.equal(sent.status, 201);
  });

  it('records the fee in the loan\'s change history', async () => {
    const { addFee, listed } = await setup();
    await addFee({ amount: 750, date: today(), note: 'Missed a week' });
    const { editHistory } = await listed();
    assert.equal(editHistory.length, 1);
    assert.ok(editHistory[0].byName);
    assert.equal(editHistory[0].changes[0].field, 'lateFee');
    assert.match(editHistory[0].changes[0].to, /^₹750 on .+ \(Missed a week\)$/);
  });

  it('refuses a bad fee', async () => {
    const { start, addFee, staffApi, admin } = await setup();
    assert.equal((await addFee({ amount: 0, date: today() })).status, 400);
    assert.equal((await addFee({ amount: '500', date: today() })).status, 400);
    assert.equal((await addFee({ amount: 500 })).status, 400);
    assert.equal((await addFee({ amount: 500, date: addDays(today(), 1) })).status, 400);
    assert.equal((await addFee({ amount: 500, date: addDays(start, -1) })).status, 400);
    assert.equal((await addFee({ amount: 500, date: today(), note: 'x'.repeat(201) })).status, 400);
    assert.equal((await staffApi.addFee({ amount: 500, date: today() })).status, 403);
    assert.equal((await request(app).post('/api/loans/not-an-id/late-fees').set(auth(admin)).send({ amount: 500, date: today() })).status, 404);
  });

  it('removes an unpaid fee, and closes the loan again if nothing else is owed', async () => {
    const { repay, addFee, removeFee, listed } = await setup();
    await repay(12000, addDays(today(), -3));
    const fee = (await addFee({ amount: 1000, date: today() })).body.data.lateFees[0];

    const removed = await removeFee(fee._id);
    assert.equal(removed.status, 200);
    const loan = await listed();
    assert.equal(loan.lateFees, undefined);
    assert.equal(loan.pendingAmount, 0);
    assert.equal(loan.profitAmount, 2000);
    assert.equal(loan.status, 'CLOSED');
    // Closed on the day of its last repayment, as before the fee
    assert.equal(new Date(loan.resolvedAt).toISOString().slice(0, 10), addDays(today(), -3));
    assert.equal(loan.editHistory.length, 2);
    assert.equal(loan.editHistory[1].changes[0].to, '');
  });

  it('won\'t remove a fee that has been paid', async () => {
    const { repay, addFee, removeFee, listed } = await setup();
    await repay(12000);
    const fee = (await addFee({ amount: 1000, date: today() })).body.data.lateFees[0];
    await repay(400);

    const res = await removeFee(fee._id);
    assert.equal(res.status, 409);
    assert.equal((await listed()).lateFees.length, 1);
    assert.equal((await removeFee('5f0000000000000000000000')).status, 404);
  });
});
