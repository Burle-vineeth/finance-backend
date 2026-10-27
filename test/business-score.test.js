// The business score: its five parts worked out from loans and the ledger, and the endpoint around it
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { scoreFor } = require('../src/services/score');
const { app, request, startDb, stopDb, clearDb, auth, seedTeam, today, models } = require('./helpers');
const { addDays, keyToDate } = require('../src/services/schedule');

const d = (key) => new Date(`${key}T00:00:00Z`);
// ₹10,000 lent on 1 Oct for ₹12,000 back: ₹1,200 a day, due 2-11 Oct
const loan = (overrides = {}) => ({
  _id: 'L1', client: { _id: 'C1', name: 'Ramesh' }, principalAmount: 10000, expectedReturnAmount: 12000,
  paymentFrequency: 'DAILY', durationDays: 10, expectedDailyMonthlyPayment: 1200, startDate: d('2026-10-01'), status: 'ACTIVE',
  ...overrides,
});
const tx = (type, amount, day, extra = {}) => ({ type, amount, date: d(day), ...extra });
const funded = (amount = 10000) => [tx('CAPITAL_INJECTION', amount, '2026-10-01'), tx('DISBURSEMENT', amount, '2026-10-01', { loan: 'L1' })];
const repaid = (amount, day, principal = amount, loanId = 'L1') => tx('REPAYMENT', amount, day, { loan: loanId, principalPortion: principal });
const part = (score, key) => score.parts.find((p) => p.key === key);
// Every sentence of a list of reasons, details included
const lines = (reasons) => reasons.flatMap((r) => [r.text, ...r.details]);

describe('business score', () => {
  it('scores a loan paid on time, with the parts adding up to the total', () => {
    const transactions = [...funded(), ...['02', '03', '04', '05', '06'].map((day) => repaid(1200, `2026-10-${day}`))];
    const s = scoreFor({ loans: [loan()], transactions, from: '2026-10-01', to: '2026-10-06', today: '2026-10-06' });
    assert.equal(part(s, 'collections').score, 100);
    assert.equal(part(s, 'overdue').score, 100);
    // ₹1,000 interest (a sixth of ₹6,000) on ₹7,000 lent on average, over 6 days: far above 45% a year
    assert.equal(part(s, 'earnings').score, 100);
    // ₹42,000 of lent-days against ₹18,000 of cash-days: 70% lent, of the 90% for full marks
    assert.equal(part(s, 'moneyAtWork').score, 78);
    // One borrower holds everything
    assert.equal(part(s, 'spread').score, 0);
    assert.equal(s.total, 87);
    assert.equal(s.label, 'Strong');
    assert.ok(lines(s.helping).some((r) => r.startsWith('100% of the payments due were made within a week')));
    assert.ok(lines(s.hurting).some((r) => r.startsWith('100% of the money lent is with one borrower: Ramesh')));
  });

  it('scores nothing paid, and names the loan in the reasons', () => {
    const s = scoreFor({ loans: [loan()], transactions: funded(), from: '2026-10-01', to: '2026-10-20', today: '2026-10-20' });
    assert.equal(part(s, 'collections').score, 0);
    assert.equal(part(s, 'overdue').score, 0);
    assert.equal(part(s, 'earnings').score, 0);
    assert.equal(part(s, 'moneyAtWork').score, 100);
    assert.equal(s.total, 15);
    assert.equal(s.label, 'At risk');
    assert.ok(lines(s.hurting).includes('Ramesh: ₹12,000 paid more than a week late, or not yet'));
    assert.ok(lines(s.hurting).includes('Ramesh: ₹12,000 overdue since 2 Oct'));
    assert.ok(lines(s.helping)[0].startsWith('On average 100% of your money was lent out'));
  });

  it('gives partial points rather than dropping to zero early', () => {
    // Half the payments within a week, a third of the money lent overdue, half the money lent out, two borrowers
    // holding half each: every part scores something
    const a = loan({ _id: 'A', client: { _id: 'CA', name: 'A' }, durationDays: 1, expectedDailyMonthlyPayment: 12000 });
    const b2 = loan({ _id: 'B', client: { _id: 'CB', name: 'B' }, durationDays: 1, expectedDailyMonthlyPayment: 12000 });
    const transactions = [
      tx('CAPITAL_INJECTION', 40000, '2026-10-01'),
      tx('DISBURSEMENT', 10000, '2026-10-01', { loan: 'A' }), tx('DISBURSEMENT', 10000, '2026-10-01', { loan: 'B' }),
      repaid(12000, '2026-10-02', 10000, 'A'),
    ];
    const s = scoreFor({ loans: [a, b2], transactions, from: '2026-10-01', to: '2026-10-20', today: '2026-10-20' });
    assert.equal(part(s, 'collections').score, 50);
    assert.ok(part(s, 'overdue').score === 0, 'B owes ₹12,000 on ₹10,000 lent: as bad as it gets');
    assert.ok(part(s, 'moneyAtWork').score > 0 && part(s, 'moneyAtWork').score < 100);
    assert.ok(s.total > 0 && s.total < 100);
  });

  it('gives a payment a week to come in', () => {
    // One installment of ₹12,000, due 2 Oct: its week ends on 9 Oct
    const single = loan({ durationDays: 1, expectedDailyMonthlyPayment: 12000 });
    const onDay = (day) => scoreFor({ loans: [single], transactions: [...funded(), repaid(12000, day, 10000)], from: '2026-10-01', to: '2026-10-20', today: '2026-10-20' });
    assert.equal(part(onDay('2026-10-09'), 'collections').score, 100);
    assert.equal(part(onDay('2026-10-10'), 'collections').score, 0);
  });

  it('doesn\'t count a payment as late while its week is still running', () => {
    const s = scoreFor({ loans: [loan()], transactions: funded(), from: '2026-10-01', to: '2026-10-06', today: '2026-10-06' });
    assert.equal(part(s, 'collections').score, null);
    assert.equal(part(s, 'collections').summary, 'What fell due still has its week to be paid');
    // The total is scaled over the parts that could be scored
    assert.equal(part(s, 'collections').points, null);
  });

  it('counts an unpaid late fee as a payment due', () => {
    const withFee = loan({ status: 'ACTIVE', lateFees: [{ amount: 1000, date: d('2026-10-12') }] });
    const transactions = [...funded(), ...Array.from({ length: 10 }, (_, i) => repaid(1200, `2026-10-${String(i + 2).padStart(2, '0')}`, i < 8 ? 1200 : (i === 8 ? 400 : 0)))];
    const s = scoreFor({ loans: [withFee], transactions, from: '2026-10-12', to: '2026-10-25', today: '2026-10-25' });
    assert.equal(part(s, 'collections').score, 0);
    assert.ok(lines(s.hurting).includes('Ramesh: ₹1,000 paid more than a week late, or not yet'));
  });

  it('rewards spreading the money over borrowers', () => {
    const loans = ['A', 'B', 'C'].map((id) => loan({ _id: id, client: { _id: `C${id}`, name: id } }));
    const transactions = [tx('CAPITAL_INJECTION', 30000, '2026-10-01'), ...loans.map((l) => tx('DISBURSEMENT', 10000, '2026-10-01', { loan: l._id }))];
    const s = scoreFor({ loans, transactions, from: '2026-10-01', to: '2026-10-01', today: '2026-10-01' });
    // A third each: two thirds of the way from everything with one borrower down to 25%
    assert.equal(part(s, 'spread').score, 89);
    assert.ok(lines(s.helping).includes('Risk is spread out: no borrower holds more than 33% of the money lent.'));
  });

  it('names the loan that pulls earnings down', () => {
    const cheap = loan({ principalAmount: 100000, expectedReturnAmount: 105000, paymentFrequency: 'WEEKLY', durationDays: 1000, expectedDailyMonthlyPayment: 734.27 });
    const s = scoreFor({ loans: [cheap], transactions: funded(100000), from: '2026-10-01', to: '2026-10-31', today: '2026-10-31' });
    assert.ok(part(s, 'earnings').score < 70);
    assert.ok(lines(s.hurting).includes('Ramesh: ₹1,00,000 lent at 1.8% a year pulls the average down'));
  });
});

describe('business score endpoint', () => {
  before(startDb);
  after(stopDb);
  beforeEach(clearDb);

  const setup = async () => {
    const team = await seedTeam();
    const client = await models.Client.create({ name: 'Ramesh Kumar', phone: '9848012345' });
    const start = addDays(today(), -40);
    await models.Transaction.create({ type: 'CAPITAL_INJECTION', amount: 50000, date: keyToDate(start) });
    const created = await models.Loan.create({
      client: client._id, principalAmount: 10000, expectedReturnAmount: 12000, paymentFrequency: 'DAILY', durationDays: 30, startDate: keyToDate(start),
    });
    await models.Transaction.create({ type: 'DISBURSEMENT', amount: 10000, client: client._id, loan: created._id, date: keyToDate(start) });
    const score = (query, token = team.admin) => request(app).get(`/api/dashboard/score${query}`).set(auth(token));
    return { ...team, start, score };
  };

  it('scores from the first loan to today by default, with names from the clients', async () => {
    const { start, score } = await setup();
    const res = await score('');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.from, start);
    assert.equal(res.body.data.measuredTo, today());
    assert.equal(res.body.data.parts.length, 5);
    assert.equal(typeof res.body.data.total, 'number');
    assert.ok(lines(res.body.data.hurting).some((r) => r.includes('Ramesh Kumar')));
    assert.deepEqual(res.body.data.settings, { targetYearlyRate: 45, graceDays: 7 });
  });

  it('compares with the period it is sent, when the business was running then', async () => {
    const { start, score } = await setup();
    const query = (from, to) => `?from=${from}&to=${to}`;
    const res = await score(`${query(addDays(today(), -9), today())}&compareFrom=${addDays(today(), -19)}&compareTo=${addDays(today(), -10)}`);
    assert.equal(res.body.data.previous.from, addDays(today(), -19));
    assert.equal(typeof res.body.data.previous.total, 'number');
    // Each part's change is its points now less its points then
    const then = (await score(query(addDays(today(), -19), addDays(today(), -10)))).body.data.parts;
    for (const part of res.body.data.parts) {
      const before = then.find((p) => p.key === part.key);
      if (part.points === null || before.points === null) assert.equal(part.change, null);
      else assert.equal(part.change, Math.round((part.points - before.points) * 10) / 10);
    }
    assert.ok(res.body.data.parts.some((p) => typeof p.change === 'number'));
    const early = await score(`?from=${start}&to=${today()}&compareFrom=${addDays(start, -30)}&compareTo=${addDays(start, -1)}`);
    assert.equal(early.body.data.previous, null);
    assert.ok(early.body.data.parts.every((p) => p.change === null));
  });

  it('says when a period hasn\'t started, refuses bad ranges, and is the admin\'s only', async () => {
    const { score, staff } = await setup();
    const future = await score(`?from=${addDays(today(), 3)}&to=${addDays(today(), 9)}`);
    assert.equal(future.status, 200);
    assert.equal(future.body.data.notStarted, true);
    assert.equal((await score('?from=2026-02-30')).status, 400);
    assert.equal((await score('?from=2026-10-10&to=2026-10-01')).status, 400);
    assert.equal((await score('?compareFrom=2026-10-10&compareTo=2026-10-01')).status, 400);
    assert.equal((await score('', staff)).status, 403);
  });
});
