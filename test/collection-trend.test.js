// The collections chart: money expected (from the installment schedules) and collected, day by day
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, startDb, stopDb, clearDb, auth, seedTeam, today, models } = require('./helpers');
const { addDays, keyToDate } = require('../src/services/schedule');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const sum = (days, field) => days.reduce((total, d) => total + d[field], 0);

// A daily loan of ₹1,000 for ₹1,200 over 10 days, given 5 days ago: ₹120 due each day from the day after
const setup = async () => {
  const team = await seedTeam();
  const start = addDays(today(), -5);
  const client = await models.Client.create({ name: 'Ramesh Kumar', phone: '9848012345' });
  const loan = await models.Loan.create({
    client: client._id, principalAmount: 1000, expectedReturnAmount: 1200, paymentFrequency: 'DAILY', durationDays: 10,
    startDate: keyToDate(start),
  });
  const trend = (query = '', token = team.admin) => request(app).get(`/api/dashboard/collections${query}`).set(auth(token));
  const repay = (amount, day) => request(app).post('/api/transactions').set(auth(team.admin))
    .send({ type: 'REPAYMENT', loan: String(loan._id), amount, date: day });
  return { ...team, start, client, loan, trend, repay };
};

describe('collections chart', () => {
  it('runs from the first loan to today by default, a row for every day', async () => {
    const { start, trend, repay } = await setup();
    assert.equal((await repay(300, addDays(start, 2))).status, 201);

    const res = await trend();
    assert.equal(res.status, 200);
    const { from, to, firstLoanDay, days } = res.body.data;
    assert.equal(from, start);
    assert.equal(firstLoanDay, start);
    assert.equal(to, today());
    assert.equal(days.length, 6);
    // Nothing is due on the day the loan is given; ₹120 on each of the 5 days after
    assert.deepEqual(days.map((d) => d.expected), [0, 120, 120, 120, 120, 120]);
    assert.deepEqual(days.map((d) => d.collected), [0, 0, 300, 0, 0, 0]);
  });

  it('shows what is still to come when the range runs past today', async () => {
    const { start, trend } = await setup();
    const { days } = (await trend(`?from=${start}&to=${addDays(start, 12)}`)).body.data;
    assert.equal(days.length, 13);
    assert.equal(sum(days, 'expected'), 1200);
    assert.equal(days[10].expected, 120);
    assert.equal(days[11].expected, 0);
  });

  it('counts only the installments inside the range', async () => {
    const { start, trend } = await setup();
    const { days } = (await trend(`?from=${addDays(start, 3)}&to=${addDays(start, 4)}`)).body.data;
    assert.deepEqual(days.map((d) => [d.date, d.expected]), [[addDays(start, 3), 120], [addDays(start, 4), 120]]);
  });

  it('keeps a closed loan\'s schedule, and follows a custom plan\'s dates', async () => {
    const { start, client, trend, repay } = await setup();
    await repay(1200, addDays(start, 1));
    assert.equal((await models.Loan.findOne()).status, 'CLOSED');
    await models.Loan.create({
      client: client._id, principalAmount: 500, expectedReturnAmount: 600, paymentFrequency: 'MONTHLY', startDate: keyToDate(start),
      customInstallments: [{ date: keyToDate(addDays(start, 2)), amount: 250 }, { date: keyToDate(addDays(start, 4)), amount: 350 }],
    });
    const { days } = (await trend(`?from=${start}&to=${addDays(start, 5)}`)).body.data;
    assert.deepEqual(days.map((d) => d.expected), [0, 120, 370, 120, 470, 120]);
    assert.deepEqual(days.map((d) => d.collected), [0, 1200, 0, 0, 0, 0]);
  });

  it('refuses bad ranges', async () => {
    const { trend } = await setup();
    assert.equal((await trend('?from=2026-13-01')).status, 400);
    assert.equal((await trend('?from=2026-02-30')).status, 400);
    assert.equal((await trend('?from=26-10-01')).status, 400);
    assert.equal((await trend('?from=2026-10-10&to=2026-10-01')).status, 400);
    const tooLong = await trend('?from=2010-01-01&to=2026-01-01');
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /10 years/);
  });

  it('is the admin\'s only', async () => {
    const { staff, trend } = await setup();
    assert.equal((await trend('', staff)).status, 403);
  });
});
