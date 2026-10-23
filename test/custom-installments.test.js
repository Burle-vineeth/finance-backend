const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  app, request, startDb, stopDb, clearDb, auth, seedTeam, seedLoan, today, models,
} = require('./helpers');
const { planProblems, parseCustomInstallments } = require('../src/services/customInstallments');
const { loanSchedule, dayKey } = require('../src/services/schedule');

before(startDb);
after(stopDb);
beforeEach(clearDb);

// India days relative to now, as the server counts them
const day = (offset) => dayKey(new Date(Date.now() + offset * 86400000));
const patch = (token, id, body) => request(app).patch(`/api/loans/${id}`).set(auth(token)).send(body);
const start = new Date('2026-01-10T00:00:00.000Z');
const context = { expected: 12000, startDate: start };
const rows = (...pairs) => pairs.map(([date, amount]) => ({ date, amount }));

describe('checking a custom installment plan', () => {
  it('accepts a plan whose amounts add up to the expected return', () => {
    assert.deepEqual(planProblems(rows(['2026-02-10', 2000], ['2026-03-10', 4000], ['2026-04-10', 6000]), context), []);
    // On the disbursement day itself, and paise that add up exactly (333.33 × 3 + 0.01)
    assert.deepEqual(planProblems(rows(['2026-01-10', 333.33], ['2026-01-11', 333.33], ['2026-01-12', 333.33], ['2026-01-13', 0.01]),
      { expected: 1000, startDate: start }), []);
    // Amounts typed in a form arrive as text
    assert.deepEqual(planProblems(rows(['2026-02-10', '12000']), context), []);
  });

  it('needs 1 to 1,000 installments', () => {
    assert.deepEqual(planProblems([], context), ['Add at least one installment']);
    assert.deepEqual(planProblems('5 installments', context), ['The installments must be a list']);
    const many = Array.from({ length: 1001 }, (_, i) => ({ date: dayKey(new Date(start.getTime() + i * 86400000)), amount: 1 }));
    assert.match(planProblems(many, { expected: 1001, startDate: start })[0], /at most 1,000 installments/);
  });

  it('names each installment with a bad date', () => {
    const problems = planProblems(rows(['', 3000], ['2026-02-30', 3000], ['2026-01-09', 3000], ['2036-01-11', 3000]), context);
    assert.deepEqual(problems, [
      'Installment 1 needs a date',
      'Installment 2: pick a valid date',
      'Installment 3 (9 Jan 2026) is before the disbursement date, 10 Jan 2026',
      'Installment 4 (11 Jan 2036) is more than 10 years after the disbursement',
    ]);
  });

  it('refuses two installments on the same day', () => {
    assert.deepEqual(planProblems(rows(['2026-02-10', 4000], ['2026-03-10', 4000], ['2026-02-10', 4000]), context),
      ['Installments 1 and 3 are both on 10 Feb 2026']);
  });

  it('names each installment with a bad amount', () => {
    const problems = planProblems(rows(['2026-02-10', ''], ['2026-03-10', 0], ['2026-04-10', -5], ['2026-05-10', 'abc'], ['2026-06-10', 100.555]), context);
    assert.deepEqual(problems, [
      'Installment 1 needs an amount',
      'Installment 2: the amount must be more than zero',
      'Installment 3: the amount must be more than zero',
      'Installment 4 needs an amount',
      'Installment 5: the amount can\'t go below a paisa (2 decimal places)',
    ]);
  });

  it('says how far the total is from the expected return', () => {
    assert.deepEqual(planProblems(rows(['2026-02-10', 5000], ['2026-03-10', 6500]), context),
      ['The installments add up to ₹11,500, but the expected return is ₹12,000 (₹500 short)']);
    assert.deepEqual(planProblems(rows(['2026-02-10', 6000], ['2026-03-10', 6000.5]), context),
      ['The installments add up to ₹12,000.5, but the expected return is ₹12,000 (₹0.5 over)']);
  });

  it('puts the plan in date order for storing, and reports the first problem with a count of the rest', () => {
    const plan = parseCustomInstallments(rows(['2026-03-10', 7000], ['2026-02-10', '5000']), context);
    assert.deepEqual(plan.map((r) => [r.date.toISOString(), r.amount]),
      [['2026-02-10T00:00:00.000Z', 5000], ['2026-03-10T00:00:00.000Z', 7000]]);
    assert.throws(() => parseCustomInstallments(rows(['2026-01-01', 0], ['2026-02-10', 100]), context),
      { status: 400, message: 'Installment 1 (1 Jan 2026) is before the disbursement date, 10 Jan 2026 (and 1 more problem)' });
  });
});

describe('the schedule of a loan on a custom plan', () => {
  // ₹12,000 in 3 installments of different sizes, listed out of order
  const loan = (paid = 0) => ({
    expectedReturnAmount: 12000,
    paymentFrequency: 'MONTHLY',
    startDate: start,
    customInstallments: rows([new Date('2026-03-10'), 4000], [new Date('2026-02-10'), 2000], [new Date('2026-04-10'), 6000]),
    totalRepaid: paid,
    pendingAmount: 12000 - paid,
  });

  it('follows the plan\'s dates and amounts', () => {
    const s = loanSchedule(loan(), { today: '2026-02-01' });
    assert.equal(s.status, 'UPCOMING');
    assert.equal(s.customPlan, true);
    assert.equal(s.installmentsTotal, 3);
    assert.equal(s.firstDueDate, '2026-02-10');
    assert.equal(s.lastDueDate, '2026-04-10');
    assert.equal(s.installment, 2000);
    assert.equal(s.hasTerm, true);

    const due = loanSchedule(loan(), { today: '2026-02-10' });
    assert.equal(due.status, 'DUE_TODAY');
    assert.equal(due.amountDue, 2000);
    assert.equal(due.installmentToday, 2000);
  });

  it('covers installments oldest first, each at its own amount', () => {
    let s = loanSchedule(loan(1500), { today: '2026-02-10' });
    assert.equal(s.status, 'PARTLY_PAID');
    assert.equal(s.amountDue, 500);

    s = loanSchedule(loan(3000), { today: '2026-03-15' });
    assert.equal(s.status, 'OVERDUE');
    assert.equal(s.amountDue, 3000);
    assert.equal(s.overdueSince, '2026-03-10');
    assert.equal(s.installmentsPaid, 1);
    // The next installment is ₹4,000, of which ₹1,000 is paid
    assert.equal(s.nextInstallmentAmount, 4000);

    // Part of the next installment paid early: up to date, ₹1,000 toward the ₹6,000 due in April
    s = loanSchedule(loan(7000), { today: '2026-03-15' });
    assert.equal(s.status, 'UP_TO_DATE');
    assert.equal(s.aheadAmount, 1000);
    assert.equal(s.nextDueDate, '2026-04-10');
    assert.equal(s.installment, 6000);

    // A whole installment paid early
    s = loanSchedule(loan(6000), { today: '2026-03-01' });
    assert.equal(s.status, 'PAID_AHEAD');
    assert.equal(s.paidUntil, '2026-03-10');
    assert.equal(s.aheadAmount, 4000);
  });

  it('ends its term with the last installment', () => {
    const s = loanSchedule(loan(11000), { today: '2026-05-01' });
    assert.equal(s.status, 'OVERDUE');
    assert.equal(s.termEnded, true);
    assert.equal(s.amountDue, 1000);
    assert.equal(loanSchedule(loan(12000), { today: '2026-05-01' }).status, 'PAID');
  });
});

describe('loans on a custom plan, through the API', () => {
  const newLoan = (token, body) => request(app).post('/api/loans').set(auth(token)).send(body);
  const seedClient = async () => {
    await models.Transaction.create({ type: 'CAPITAL_INJECTION', amount: 100000 });
    return models.Client.create({ name: 'Kavya Sharma', phone: '9000012345' });
  };
  const planBody = (client, customInstallments) => ({
    client: client._id, principalAmount: 10000, expectedReturnAmount: 12000, paymentFrequency: 'MONTHLY',
    startDate: day(-40), customInstallments,
  });

  it('creates a loan with a plan, in date order, without a duration', async () => {
    const { admin } = await seedTeam();
    const client = await seedClient();
    const res = await newLoan(admin, planBody(client, rows([day(20), 7000], [day(-10), 5000])));
    assert.equal(res.status, 201);
    const loan = await models.Loan.findById(res.body.data._id).lean();
    assert.deepEqual(loan.customInstallments.map((r) => [dayKey(r.date), r.amount]), [[day(-10), 5000], [day(20), 7000]]);
    assert.equal(loan.durationDays, undefined);
    assert.equal(loan.installmentIsCustom, true);
    assert.equal(loan.expectedDailyMonthlyPayment, 6000);

    const listed = (await request(app).get('/api/loans').set(auth(admin))).body.data[0];
    assert.equal(listed.schedule.customPlan, true);
    assert.equal(listed.schedule.status, 'OVERDUE');
    assert.equal(listed.schedule.amountDue, 5000);
  });

  it('refuses a bad plan before anything is disbursed', async () => {
    const { admin } = await seedTeam();
    const client = await seedClient();
    let res = await newLoan(admin, planBody(client, rows([day(10), 5000], [day(20), 5000])));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error, ['The installments add up to ₹10,000, but the expected return is ₹12,000 (₹2,000 short)']);
    res = await newLoan(admin, { ...planBody(client, rows([day(10), 12000])), durationDays: 30 });
    assert.equal(res.status, 400);
    assert.match(res.body.error[0], /custom installment plan has no duration/);
    res = await newLoan(admin, planBody(client, []));
    assert.deepEqual(res.body.error, ['Add at least one installment']);
    assert.equal(await models.Loan.countDocuments(), 0);
    assert.equal(await models.Transaction.countDocuments({ type: 'DISBURSEMENT' }), 0);
  });

  it('the model refuses a bad plan too, however it is saved', async () => {
    const client = await seedClient();
    await assert.rejects(models.Loan.create({
      client: client._id, principalAmount: 1000, expectedReturnAmount: 1200, paymentFrequency: 'DAILY',
      startDate: start, customInstallments: rows([new Date('2026-02-01'), 1000]),
    }), /add up to ₹1,000, but the expected return is ₹1,200/);
  });

  it('moves a loan onto a plan, dropping its duration and collection start date', async () => {
    const { admin } = await seedTeam();
    const { loan } = await seedLoan({ days: 10, expected: 1200 });
    await models.Loan.updateOne({ _id: loan._id }, { $set: { collectionStartDate: new Date(`${day(-2)}T00:00:00.000Z`) } });

    const plan = rows([day(-1), 200], [day(5), 400], [day(12), 600]);
    const preview = await patch(admin, loan._id, { customInstallments: plan, dryRun: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.data.saved, false);
    assert.equal(preview.body.data.schedule.after.customPlan, true);
    assert.equal(preview.body.data.schedule.after.installmentsTotal, 3);
    assert.equal(preview.body.data.schedule.after.status, 'OVERDUE');

    const res = await patch(admin, loan._id, { customInstallments: plan });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.changes.map((c) => c.field), ['collectionStartDate', 'customInstallments']);
    assert.equal(res.body.data.changes[1].from, '₹120 per day for 10 days');
    assert.match(res.body.data.changes[1].to, /^3 installments of ₹200 to ₹600, /);
    const saved = await models.Loan.findById(loan._id).lean();
    assert.equal(saved.durationDays, undefined);
    assert.equal(saved.collectionStartDate, undefined);
    assert.equal(saved.customInstallments.length, 3);
    assert.equal(saved.expectedDailyMonthlyPayment, 400);
  });

  it('changes a plan, and refuses a duration or installment alongside it', async () => {
    const { admin } = await seedTeam();
    const { loan } = await seedLoan({ days: 10, expected: 1200 });
    await patch(admin, loan._id, { customInstallments: rows([day(1), 600], [day(2), 600]) });

    let res = await patch(admin, loan._id, { customInstallments: rows([day(1), 400], [day(2), 800]) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.changes.length, 1);
    assert.match(res.body.data.changes[0].to, /^2 installments of ₹400 to ₹800, /);
    // Amounts swapped around: the summary reads the same, so the history says so
    res = await patch(admin, loan._id, { customInstallments: rows([day(1), 800], [day(2), 400]) });
    assert.match(res.body.data.changes[0].to, /\(dates or amounts changed\)$/);
    // The same plan in another order: nothing to save
    res = await patch(admin, loan._id, { customInstallments: rows([day(2), 400], [day(1), 800]) });
    assert.equal(res.body.data.changes.length, 0);

    res = await patch(admin, loan._id, { durationDays: 30 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /custom installment plan has no duration/);
    res = await patch(admin, loan._id, { installment: 100 });
    assert.equal(res.status, 400);
    res = await patch(admin, loan._id, { customInstallments: rows([day(1), 400], [day(2), 700]) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /₹100 short/);
  });

  it('keeps the plan\'s dates on or after a new disbursement date', async () => {
    const { admin } = await seedTeam();
    const { loan } = await seedLoan({ days: 10, expected: 1200 });
    await patch(admin, loan._id, { customInstallments: rows([day(-3), 600], [day(4), 600]) });
    let res = await patch(admin, loan._id, { startDate: day(-1) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /^Installment 1 .* is before the disbursement date/);
    // Both together are fine
    res = await patch(admin, loan._id, { startDate: day(-1), customInstallments: rows([day(0), 600], [day(4), 600]) });
    assert.equal(res.status, 200);
  });

  it('takes a loan off its plan, onto a tenure or a hand-set installment', async () => {
    const { admin } = await seedTeam();
    const { loan } = await seedLoan({ days: 10, expected: 1200 });
    await patch(admin, loan._id, { customInstallments: rows([day(1), 600], [day(2), 600]) });

    let res = await patch(admin, loan._id, { customInstallments: null });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /set a duration, an installment or both/);

    res = await patch(admin, loan._id, { customInstallments: null, durationDays: 12 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.changes[0].to, '₹100 per day for 12 days (from the duration)');
    let saved = await models.Loan.findById(loan._id).lean();
    assert.equal(saved.customInstallments, undefined);
    assert.equal(saved.durationDays, 12);
    assert.equal(saved.expectedDailyMonthlyPayment, 100);
    assert.equal(saved.installmentIsCustom, false);

    await patch(admin, loan._id, { customInstallments: rows([day(1), 1200]) });
    res = await patch(admin, loan._id, { customInstallments: null, installment: 300 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.changes[0].to, '₹300 per day, until repaid');
    saved = await models.Loan.findById(loan._id).lean();
    assert.equal(saved.installmentIsCustom, true);
    assert.equal(saved.durationDays, undefined);
  });

  it('repayments and collections work on a plan loan', async () => {
    const { admin, staff } = await seedTeam();
    const { loan } = await seedLoan({ days: 10, expected: 1200 });
    await patch(admin, loan._id, { customInstallments: rows([day(0), 300], [day(3), 900]) });

    let collectable = (await request(app).get('/api/collections/loans').set(auth(staff))).body.data[0];
    assert.equal(collectable.installment, 300);
    assert.equal(collectable.schedule.status, 'DUE_TODAY');

    const pay = await request(app).post('/api/transactions').set(auth(admin)).send({ type: 'REPAYMENT', loan: loan._id, amount: 300, date: today() });
    assert.equal(pay.status, 201);
    collectable = (await request(app).get('/api/collections/loans').set(auth(staff))).body.data[0];
    assert.equal(collectable.installment, 900);
    assert.equal(collectable.schedule.status, 'UP_TO_DATE');
    assert.equal(collectable.schedule.nextDueDate, day(3));

    const dashboard = (await request(app).get('/api/dashboard').set(auth(admin))).body.data;
    assert.equal(dashboard.collections.activeLoans[0].expectedPayment, 900);
  });
});
