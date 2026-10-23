// The installment schedule on its own: the scenarios from the due-date review, each with what it should show.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loanSchedule, todayKey, installmentCount } = require('../src/services/schedule');

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

  it('counts installments the same way as the loan\'s installment amount', () => {
    assert.equal(installmentCount('DAILY', 100), 100);
    assert.equal(installmentCount('WEEKLY', 70), 10);
    assert.equal(installmentCount('WEEKLY', 30), 5);
    assert.equal(installmentCount('MONTHLY', 180), 6);
    assert.equal(installmentCount('MONTHLY', 45), 2);
    assert.equal(installmentCount('DAILY', 0), 1);
  });
});
