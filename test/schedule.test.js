// The installment schedule on its own: the scenarios from the due-date review, each with what it should show.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loanSchedule, interestRates, installmentsBetween, feesTotal, todayKey, installmentCount } = require('../src/services/schedule');

// Dates picked in the app are stored as UTC midnight of the picked day
const d = (ymd) => new Date(`${ymd}T00:00:00Z`);
const TODAY = '2026-10-22';

const daily = (overrides) => ({
  paymentFrequency: 'DAILY', durationDays: 100, expectedReturnAmount: 60000, expectedDailyMonthlyPayment: 600,
  totalRepaid: 0, ...overrides,
  pendingAmount: (overrides.expectedReturnAmount ?? 60000) - (overrides.totalRepaid ?? 0),
});

describe('loan schedule', () => {
  it('A. nothing paid for weeks: overdue since the first installment, not "pending today"', () => {
    const s = loanSchedule(daily({ startDate: d('2026-10-01') }), { today: TODAY });
    assert.equal(s.status, 'OVERDUE');
    assert.equal(s.firstDueDate, '2026-10-02');
    assert.equal(s.overdueSince, '2026-10-02');
    assert.equal(s.unpaidInstallments, 21);
    assert.equal(s.amountDue, 12600);
    assert.equal(s.overdueBeforeToday, 12000);
    assert.equal(s.installmentToday, 600);
  });

  it('B. collection starting in the future: nothing due yet, first due on the start date itself', () => {
    const s = loanSchedule(daily({ startDate: d('2026-10-20'), collectionStartDate: d('2026-10-25') }), { today: TODAY });
    assert.equal(s.status, 'UPCOMING');
    assert.equal(s.firstDueDate, '2026-10-25');
    assert.equal(s.nextDueDate, '2026-10-25');
    assert.equal(s.amountDue, 0);
    assert.equal(s.installmentToday, 0);
  });

  it('C. collection starting today: due today', () => {
    const s = loanSchedule(daily({ startDate: d('2026-10-20'), collectionStartDate: d('2026-10-22') }), { today: TODAY });
    assert.equal(s.status, 'DUE_TODAY');
    assert.equal(s.nextDueDate, TODAY);
    assert.equal(s.amountDue, 600);
  });

  it('D. paid three days at once: paid ahead, next due after those days', () => {
    // First due 21 Oct; ₹600 on 21 Oct, then ₹1,800 today covers 22, 23 and 24 Oct
    const s = loanSchedule(daily({ startDate: d('2026-10-20'), totalRepaid: 2400 }), { today: TODAY, paidToday: 1800 });
    assert.equal(s.status, 'PAID_AHEAD');
    assert.equal(s.paidUntil, '2026-10-24');
    assert.equal(s.aheadAmount, 1200);
    assert.equal(s.nextDueDate, '2026-10-25');
    assert.equal(s.amountDue, 0);
    assert.equal(s.installmentTodayPaid, 600);
  });

  it('E. paid only part of today\'s installment: partly paid, the rest still due', () => {
    const s = loanSchedule(daily({ startDate: d('2026-10-20'), totalRepaid: 700 }), { today: TODAY, paidToday: 100 });
    assert.equal(s.status, 'PARTLY_PAID');
    assert.equal(s.amountDue, 500);
    assert.equal(s.installmentToday, 600);
    assert.equal(s.installmentTodayPaid, 100);
  });

  it('F. missed days stay visible after a payment: overdue by what is still unpaid', () => {
    // First due 11 Oct; 11–17 Oct paid (₹4,200), then ₹600 today pays the oldest unpaid day, 18 Oct
    const s = loanSchedule(daily({ startDate: d('2026-10-10'), totalRepaid: 4800 }), { today: TODAY, paidToday: 600 });
    assert.equal(s.status, 'OVERDUE');
    assert.equal(s.overdueSince, '2026-10-19');
    assert.equal(s.unpaidInstallments, 4);
    assert.equal(s.amountDue, 2400);
    assert.equal(s.overdueBeforeToday, 1800);
  });

  it('G. a late weekly payment does not move later due dates', () => {
    // Disbursed Mon 5 Oct: due Mondays 12, 19, 26 Oct. Paid 12 Oct, and the 19 Oct installment late on Wed 21 Oct.
    const loan = { paymentFrequency: 'WEEKLY', durationDays: 70, expectedReturnAmount: 24000, expectedDailyMonthlyPayment: 2400, startDate: d('2026-10-05'), totalRepaid: 4800, pendingAmount: 19200 };
    const s = loanSchedule(loan, { today: TODAY });
    assert.equal(s.status, 'UP_TO_DATE');
    assert.equal(s.nextDueDate, '2026-10-26');
  });

  it('H. monthly from the 31st keeps the month: 28 Feb, 31 Mar, 30 Apr', () => {
    const loan = { paymentFrequency: 'MONTHLY', durationDays: 90, expectedReturnAmount: 3000, expectedDailyMonthlyPayment: 1000, startDate: d('2026-01-31'), totalRepaid: 0, pendingAmount: 3000 };
    assert.equal(loanSchedule(loan, { today: '2026-02-22' }).nextDueDate, '2026-02-28');
    assert.equal(loanSchedule({ ...loan, totalRepaid: 1000, pendingAmount: 2000 }, { today: '2026-03-01' }).nextDueDate, '2026-03-31');
    const s = loanSchedule({ ...loan, totalRepaid: 2000, pendingAmount: 1000 }, { today: '2026-04-01' });
    assert.equal(s.nextDueDate, '2026-04-30');
    assert.equal(s.lastDueDate, '2026-04-30');
  });

  it('H2. monthly with a collection start on the 31st: 31 Jan, 28 Feb, 31 Mar', () => {
    const loan = { paymentFrequency: 'MONTHLY', durationDays: 90, expectedReturnAmount: 3000, expectedDailyMonthlyPayment: 1000, startDate: d('2026-01-10'), collectionStartDate: d('2026-01-31'), totalRepaid: 0, pendingAmount: 3000 };
    const s = loanSchedule(loan, { today: '2026-01-20' });
    assert.equal(s.firstDueDate, '2026-01-31');
    assert.equal(s.lastDueDate, '2026-03-31');
    assert.equal(loanSchedule({ ...loan, totalRepaid: 1000, pendingAmount: 2000 }, { today: '2026-02-01' }).nextDueDate, '2026-02-28');
  });

  it('I. "today" is the India date: at 1 am on 23 Oct, yesterday\'s payment is not "today"', () => {
    const today = todayKey(new Date('2026-10-22T19:30:00Z'));
    assert.equal(today, '2026-10-23');
    // First due 21 Oct; 21 and 22 Oct paid, 23 Oct is due
    const s = loanSchedule(daily({ startDate: d('2026-10-20'), totalRepaid: 1200 }), { today, paidToday: 0 });
    assert.equal(s.status, 'DUE_TODAY');
    assert.equal(s.nextDueDate, '2026-10-23');
    assert.equal(s.paidToday, 0);
  });

  it('J. term ended with money owed: overdue, and the term end is known', () => {
    // 30 daily installments of ₹600, 2 Sep – 1 Oct; 22 paid
    const loan = daily({ startDate: d('2026-09-01'), durationDays: 30, expectedReturnAmount: 18000, totalRepaid: 13200 });
    const s = loanSchedule(loan, { today: TODAY });
    assert.equal(s.status, 'OVERDUE');
    assert.equal(s.lastDueDate, '2026-10-01');
    assert.equal(s.termEnded, true);
    assert.equal(s.amountDue, 4800);
    assert.equal(s.overdueSince, '2026-09-24');
  });

  it('paid today and nothing else due: up to date, collected today', () => {
    const s = loanSchedule(daily({ startDate: d('2026-10-20'), totalRepaid: 1200 }), { today: TODAY, paidToday: 600 });
    assert.equal(s.status, 'UP_TO_DATE');
    assert.equal(s.paidToday, 600);
    assert.equal(s.nextDueDate, '2026-10-23');
  });

  it('weekly installment falling today: due today', () => {
    const loan = { paymentFrequency: 'WEEKLY', durationDays: 70, expectedReturnAmount: 24000, expectedDailyMonthlyPayment: 2400, startDate: d('2026-10-15'), totalRepaid: 0, pendingAmount: 24000 };
    const s = loanSchedule(loan, { today: TODAY });
    assert.equal(s.status, 'DUE_TODAY');
    assert.equal(s.installmentToday, 2400);
  });

  it('weekly between installments with nothing missed: no installment today', () => {
    const loan = { paymentFrequency: 'WEEKLY', durationDays: 70, expectedReturnAmount: 24000, expectedDailyMonthlyPayment: 2400, startDate: d('2026-10-10'), totalRepaid: 2400, pendingAmount: 21600 };
    const s = loanSchedule(loan, { today: TODAY });
    assert.equal(s.status, 'UP_TO_DATE');
    assert.equal(s.installmentToday, 0);
    assert.equal(s.nextDueDate, '2026-10-24');
  });

  it('rounding: the last installment makes up the paise', () => {
    // ₹1,000 in 3 monthly installments of ₹333.33
    const loan = { paymentFrequency: 'MONTHLY', durationDays: 90, expectedReturnAmount: 1000, expectedDailyMonthlyPayment: 333.33, startDate: d('2026-01-01'), totalRepaid: 666.66, pendingAmount: 333.34 };
    const s = loanSchedule(loan, { today: '2026-04-01' });
    assert.equal(s.installmentsPaid, 2);
    assert.equal(s.amountDue, 333.34);
    assert.equal(loanSchedule({ ...loan, totalRepaid: 1000, pendingAmount: 0 }, { today: '2026-04-01' }).status, 'PAID');
  });

  it('a loan with nothing left to pay is paid', () => {
    const s = loanSchedule(daily({ startDate: d('2026-10-01'), expectedReturnAmount: 60000, totalRepaid: 60000 }), { today: TODAY });
    assert.equal(s.status, 'PAID');
    assert.equal(s.amountDue, 0);
  });

  it('a set installment without a duration: as many installments as it takes, never "term ended"', () => {
    // ₹10,000 at ₹600 a day: 16 installments of ₹600 and a last one of ₹400; first due 2 Oct, last 18 Oct
    const loan = { paymentFrequency: 'DAILY', expectedReturnAmount: 10000, expectedDailyMonthlyPayment: 600, installmentIsCustom: true, startDate: d('2026-10-01'), totalRepaid: 6000, pendingAmount: 4000 };
    const s = loanSchedule(loan, { today: TODAY });
    assert.equal(s.installmentsTotal, 17);
    assert.equal(s.lastDueDate, '2026-10-18');
    assert.equal(s.hasTerm, false);
    assert.equal(s.termEnded, false);
    assert.equal(s.status, 'OVERDUE');
    assert.equal(s.amountDue, 4000);
    // The last installment is the ₹400 left over
    const almost = loanSchedule({ ...loan, totalRepaid: 9600, pendingAmount: 400 }, { today: '2026-10-18' });
    assert.equal(almost.status, 'DUE_TODAY');
    assert.equal(almost.amountDue, 400);
  });

  it('a set installment with a duration: the installment decides, the duration gives the term', () => {
    // ₹12,000 over 30 days at ₹500 a day: done in 24 installments, 2–25 Oct
    const loan = { paymentFrequency: 'DAILY', durationDays: 30, expectedReturnAmount: 12000, expectedDailyMonthlyPayment: 500, installmentIsCustom: true, startDate: d('2026-10-01'), totalRepaid: 10500, pendingAmount: 1500 };
    const s = loanSchedule(loan, { today: TODAY });
    assert.equal(s.installmentsTotal, 24);
    assert.equal(s.lastDueDate, '2026-10-25');
    assert.equal(s.status, 'UP_TO_DATE');
    const late = loanSchedule(loan, { today: '2026-10-28' });
    assert.equal(late.status, 'OVERDUE');
    assert.equal(late.termEnded, true);
  });

  it('a set installment that divides evenly has no extra paise installment', () => {
    const loan = { paymentFrequency: 'MONTHLY', expectedReturnAmount: 1000, expectedDailyMonthlyPayment: 333.33, installmentIsCustom: true, startDate: d('2026-01-01'), totalRepaid: 0, pendingAmount: 1000 };
    assert.equal(loanSchedule(loan, { today: '2026-01-15' }).installmentsTotal, 3);
  });

  it('counts installments the same way as the loan\'s installment amount', () => {
    assert.equal(installmentCount('DAILY', 100), 100);
    assert.equal(installmentCount('WEEKLY', 70), 10);
    assert.equal(installmentCount('WEEKLY', 30), 5);
    assert.equal(installmentCount('MONTHLY', 180), 6);
    assert.equal(installmentCount('MONTHLY', 45), 2);
    assert.equal(installmentCount('DAILY', 0), 1);
  });
});

describe('flat interest a year', () => {
  // ₹10,000 lent for ₹12,000 back: 20% profit
  const lent = (overrides) => ({
    principalAmount: 10000, expectedReturnAmount: 12000, paymentFrequency: 'DAILY', durationDays: 100,
    expectedDailyMonthlyPayment: 120, startDate: d('2026-10-01'), status: 'ACTIVE', totalRepaid: 0, ...overrides,
  });

  it('spreads the profit over the agreed term: 20% in 100 days is 73% a year', () => {
    assert.deepEqual(interestRates(lent(), { today: TODAY }), { agreed: 73, actual: null });
  });

  it('counts up to today for an active loan past its last due date', () => {
    // The term ended on 9 Jan; on 20 Apr the money has been out 201 days
    const late = lent({ totalRepaid: 6000 });
    assert.deepEqual(interestRates(late, { today: '2027-04-20' }), { agreed: 73, actual: 36.32 });
    // On its last due date it is still on time
    assert.equal(interestRates(late, { today: '2027-01-09' }).actual, null);
  });

  it('counts the wait before collection starts as part of the term', () => {
    // 100 installments from 11 Oct: the last on 18 Jan, 109 days after disbursement
    assert.equal(interestRates(lent({ collectionStartDate: d('2026-10-11') })).agreed, 66.97);
  });

  it('runs a monthly loan to its last installment date', () => {
    // 4 installments, the last on 1 Feb: 123 days
    assert.equal(interestRates(lent({ paymentFrequency: 'MONTHLY', durationDays: 120, expectedDailyMonthlyPayment: 3000 })).agreed, 59.35);
  });

  it('takes the term of a loan without a duration from its installment', () => {
    // ₹500 a day repays ₹12,000 in 24 days
    const loan = lent({ durationDays: undefined, expectedDailyMonthlyPayment: 500, installmentIsCustom: true });
    assert.equal(interestRates(loan).agreed, 304.17);
  });

  it('ends a custom plan on its last installment', () => {
    const customInstallments = [
      { date: d('2026-11-30'), amount: 6000 },
      { date: d('2026-10-31'), amount: 6000 },
    ];
    assert.equal(interestRates(lent({ customInstallments, durationDays: undefined })).agreed, 121.67);
  });

  it('gives a closed loan its actual rate, from disbursement to the final payment', () => {
    const closed = lent({ status: 'CLOSED', totalRepaid: 12000, resolvedAt: d('2027-01-29') });
    // Paid late: 120 days instead of 100
    assert.deepEqual(interestRates(closed), { agreed: 73, actual: 60.83 });
    // Paid early: 90 days
    assert.equal(interestRates(closed, { closedOn: d('2026-12-30') }).actual, 81.11);
    // Paid more than agreed: ₹2,500 profit over 120 days
    assert.equal(interestRates({ ...closed, totalRepaid: 12500 }).actual, 76.04);
  });

  it('has no rate without days to spread the profit over', () => {
    assert.equal(interestRates(lent({ status: 'CLOSED', totalRepaid: 12000, resolvedAt: d('2026-10-01') })).actual, null);
    assert.equal(interestRates(lent({ status: 'CLOSED', totalRepaid: 12000 })).actual, null);
  });
});

describe('installments between two days', () => {
  it('lists only the installments in the range, with the last one making up the paise', () => {
    // ₹1,000 over 3 days: ₹333.33, ₹333.33, ₹333.34 on 2, 3 and 4 Oct
    const loan = { paymentFrequency: 'DAILY', durationDays: 3, expectedReturnAmount: 1000, expectedDailyMonthlyPayment: 333.33, startDate: d('2026-10-01') };
    assert.deepEqual(installmentsBetween(loan, '2026-10-01', '2026-10-31'), [
      { date: '2026-10-02', amount: 333.33 }, { date: '2026-10-03', amount: 333.33 }, { date: '2026-10-04', amount: 333.34 },
    ]);
    assert.deepEqual(installmentsBetween(loan, '2026-10-03', '2026-10-03'), [{ date: '2026-10-03', amount: 333.33 }]);
    assert.deepEqual(installmentsBetween(loan, '2026-10-05', '2026-12-31'), []);
  });

  it('follows monthly dates and custom plans', () => {
    const monthly = { paymentFrequency: 'MONTHLY', durationDays: 90, expectedReturnAmount: 3000, expectedDailyMonthlyPayment: 1000, startDate: d('2026-01-31') };
    assert.deepEqual(installmentsBetween(monthly, '2026-02-01', '2026-03-31').map((r) => r.date), ['2026-02-28', '2026-03-31']);
    const plan = { paymentFrequency: 'MONTHLY', expectedReturnAmount: 600, startDate: d('2026-10-01'),
      customInstallments: [{ date: d('2026-11-15'), amount: 400 }, { date: d('2026-10-20'), amount: 200 }] };
    assert.deepEqual(installmentsBetween(plan, '2026-10-01', '2026-11-30'), [{ date: '2026-10-20', amount: 200 }, { date: '2026-11-15', amount: 400 }]);
  });
});

describe('late fees in the schedule', () => {
  // ₹600 a day for 100 days from 1 Oct (first due 2 Oct), with a ₹500 fee charged on 10 Oct
  const fee = (overrides = {}) => ({
    ...daily({ startDate: d('2026-10-01'), status: 'ACTIVE', ...overrides }),
    lateFees: [{ amount: 500, date: d('2026-10-10') }],
    pendingAmount: 60500 - (overrides.totalRepaid ?? 0),
  });

  it('adds the fee to what falls due on its day, not to the installment counts', () => {
    // 20 installments by 21 Oct is ₹12,000, plus the fee
    const s = loanSchedule(fee({ totalRepaid: 12000 }), { today: '2026-10-21' });
    assert.equal(s.dueSoFar, 12500);
    assert.equal(s.amountDue, 500);
    // Oldest first: 2–10 Oct, the fee, then 11–20 Oct are paid, and ₹100 of today's installment
    assert.equal(s.status, 'PARTLY_PAID');
    assert.equal(s.overdueBeforeToday, 0);
    assert.equal(s.installmentsDue, 20);
    assert.equal(s.installmentsTotal, 100);
    assert.equal(s.lateFees, 500);
    // The term still ends with the last installment
    assert.equal(s.lastDueDate, '2027-01-09');
  });

  it('covers what fell due first: the installments up to the fee, then the fee', () => {
    // ₹5,400 pays 2–10 Oct (9 installments); the fee from 10 Oct is next
    const s = loanSchedule(fee({ totalRepaid: 5400 }), { today: '2026-10-10' });
    assert.equal(s.installmentsPaid, 9);
    assert.equal(s.nextInstallmentAmount, 500);
    assert.equal(s.installmentToday, 1100);
    assert.equal(s.status, 'DUE_TODAY');
  });

  it('is paid only once the fee is', () => {
    const loan = fee({ totalRepaid: 60000 });
    assert.equal(loanSchedule(loan, { today: '2027-02-01' }).status, 'OVERDUE');
    assert.equal(loanSchedule({ ...loan, totalRepaid: 60500, pendingAmount: 0 }, { today: '2027-02-01' }).status, 'PAID');
  });

  it('counts fees in the chart and the overdue rate, not in the agreed rate', () => {
    const loan = fee({ principalAmount: 50000 });
    assert.deepEqual(installmentsBetween(loan, '2026-10-10', '2026-10-10'), [{ date: '2026-10-10', amount: 600 }, { date: '2026-10-10', amount: 500 }]);
    assert.equal(feesTotal(loan), 500);
    // ₹10,000 profit over the 100-day term; 201 days on, the fee is owed too: 21% over 201 days
    assert.deepEqual(interestRates(loan, { today: '2027-04-20' }), { agreed: 73, actual: 38.13 });
  });
});
