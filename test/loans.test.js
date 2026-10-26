// Creating loans: the installment can be set by hand, and the duration is optional
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, startDb, stopDb, clearDb, auth, seedTeam, today, models } = require('./helpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const setup = async () => {
  const { admin } = await seedTeam();
  await models.Transaction.create({ type: 'CAPITAL_INJECTION', amount: 1000000 });
  const client = await models.Client.create({ name: 'Ramesh Kumar', phone: '9848012345' });
  const create = (body) => request(app).post('/api/loans').set(auth(admin)).send({
    client: String(client._id), principalAmount: 10000, expectedReturnAmount: 12000, paymentFrequency: 'DAILY', startDate: today(), ...body,
  });
  return { admin, create };
};

describe('creating a loan', () => {
  it('works out the installment from the duration, as before', async () => {
    const { create } = await setup();
    const res = await create({ durationDays: 30 });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.expectedDailyMonthlyPayment, 400);
    assert.equal(res.body.data.installmentIsCustom, false);
  });

  it('takes an installment set by hand, without a duration', async () => {
    const { admin, create } = await setup();
    const res = await create({ installment: 500 });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.expectedDailyMonthlyPayment, 500);
    assert.equal(res.body.data.installmentIsCustom, true);
    assert.equal(res.body.data.durationDays, undefined);
    const [loan] = (await request(app).get('/api/loans').set(auth(admin))).body.data;
    assert.equal(loan.schedule.installmentsTotal, 24);
    assert.equal(loan.schedule.hasTerm, false);
    // The disbursement is still recorded
    assert.equal(await models.Transaction.countDocuments({ type: 'DISBURSEMENT', loan: loan._id }), 1);
  });

  it('takes both when the installment repays within the duration', async () => {
    const { create } = await setup();
    const res = await create({ installment: 500, durationDays: 30 });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.expectedDailyMonthlyPayment, 500);
    assert.equal(res.body.data.durationDays, 30);
  });

  it('refuses an installment too small for the duration, and says what would work', async () => {
    const { create } = await setup();
    const res = await create({ installment: 300, durationDays: 30 });
    assert.equal(res.status, 400);
    assert.match(res.body.error[0], /collects only ₹9,000 of ₹12,000/);
    assert.match(res.body.error[0], /at least ₹400/);
    assert.equal(await models.Loan.countDocuments(), 0);
  });

  it('needs an installment or a duration, and refuses bad values', async () => {
    const { create } = await setup();
    for (const body of [{}, { installment: '' , durationDays: '' }, { installment: 0 }, { installment: -5 }, { installment: 'abc' }, { durationDays: 0 }, { durationDays: 2.5 }, { installment: 20000 }]) {
      const res = await create(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(await models.Loan.countDocuments(), 0);
    assert.equal(await models.Transaction.countDocuments({ type: 'DISBURSEMENT' }), 0);
  });

  it('accepts numbers sent as text, as forms sometimes do', async () => {
    const { create } = await setup();
    const res = await create({ installment: '500', durationDays: '30' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.expectedDailyMonthlyPayment, 500);
    assert.equal(res.body.data.durationDays, 30);
  });
});

describe('interest rate in the loan list', () => {
  it('shows the agreed rate, and the actual rate once a loan is closed', async () => {
    const { admin, create } = await setup();
    const started = (await create({ durationDays: 100 })).body.data;
    const list = async () => (await request(app).get('/api/loans').set(auth(admin))).body.data;

    assert.deepEqual((await list())[0].interestRate, { agreed: 73, actual: null });

    // Repaid in full the next day: 20% over 1 day
    const repaid = await request(app).post('/api/transactions').set(auth(admin)).send({
      type: 'REPAYMENT', loan: started._id, amount: 12000, date: new Date(Date.now() + 86400000),
    });
    assert.equal(repaid.status, 201);
    assert.deepEqual((await list())[0].interestRate, { agreed: 73, actual: 7300 });
  });

  it('dates a loan closed before closing days were recorded by its last repayment', async () => {
    const { admin } = await setup();
    const client = await models.Client.findOne();
    const loan = await models.Loan.create({
      client: client._id, principalAmount: 10000, expectedReturnAmount: 12000, paymentFrequency: 'DAILY', durationDays: 100,
      startDate: new Date('2026-07-01T00:00:00Z'), status: 'CLOSED', totalRepaid: 12000,
    });
    await models.Transaction.create([
      { type: 'REPAYMENT', loan: loan._id, amount: 6000, date: new Date('2026-08-01T00:00:00Z') },
      { type: 'REPAYMENT', loan: loan._id, amount: 6000, date: new Date('2026-08-30T00:00:00Z') },
    ]);
    const [listed] = (await request(app).get('/api/loans').set(auth(admin))).body.data;
    // 1 Jul to 30 Aug is 60 days: 20% over 60 days
    assert.deepEqual(listed.interestRate, { agreed: 73, actual: 121.67 });
  });
});
