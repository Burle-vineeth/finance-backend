// A loan's installment schedule, and where the client stands against it today.
//
// Installments fall on fixed dates: the first on the collection start date (or, without one, one period after
// disbursement), then one every day, week or month, until the term's installments run out. Payments cover
// installments oldest first, so the totals tell what is overdue, partly paid or paid ahead, and a late
// payment doesn't move later due dates. Daily loans collect every day, Sundays included.
//
// Days are 'YYYY-MM-DD' strings in the business's time zone (India), so "today" doesn't flip at
// 5:30 am India time as it would in the server's UTC.

const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || 'Asia/Kolkata';
const DAY_MS = 24 * 60 * 60 * 1000;
// Amounts are rupees with paise, so anything closer than half a paisa is equal
const EPSILON = 0.005;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

// The calendar day of a moment, in India. Dates picked in the app are stored as UTC midnight of the
// picked day, which is 5:30 am that same day in India, so they map back to the day that was picked.
const dayKey = (value) => dayFormatter.format(new Date(value));

const todayKey = (now = new Date()) => dayKey(now);

// Day arithmetic on 'YYYY-MM-DD' keys, done in UTC so there are no time-zone or daylight-saving surprises
const splitKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m: m - 1, d };
};
const keyOf = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const addDays = (key, days) => {
  const { y, m, d } = splitKey(key);
  return keyOf(y, m, d + days);
};
// Same day of the month, n months on; a day the month doesn't have becomes its last day (31 Jan → 28 Feb → 31 Mar)
const addMonths = (key, months) => {
  const { y, m, d } = splitKey(key);
  const lastDay = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  return keyOf(y, m + months, Math.min(d, lastDay));
};
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

// A day key as the Date the API sends for dates: UTC midnight of that day (as stored for picked dates)
const keyToDate = (key) => (key ? new Date(`${key}T00:00:00.000Z`) : null);

const round2 = (value) => Math.round(value * 100) / 100;

// How many installments a loan has. The Loan model uses this too, to work out the installment amount.
const installmentCount = (frequency, durationDays) => {
  let count = 1;
  if (frequency === 'DAILY') count = durationDays;
  else if (frequency === 'WEEKLY') count = Math.ceil(durationDays / 7);
  else if (frequency === 'MONTHLY') count = Math.ceil(durationDays / 30);
  // At least 1, to avoid dividing by zero
  return count > 0 ? count : 1;
};

const addPeriods = (frequency, key, periods) => {
  if (frequency === 'WEEKLY') return addDays(key, 7 * periods);
  if (frequency === 'MONTHLY') return addMonths(key, periods);
  return addDays(key, periods);
};

// Where a loan stands today.
//   today      'YYYY-MM-DD' in India (defaults to now)
//   paidToday  what was repaid on this loan today, for "collected today"
//
// status is one of:
//   UPCOMING      nothing due yet (the first installment is in the future)
//   UP_TO_DATE    everything due so far is paid, nothing more than that
//   PAID_AHEAD    paid beyond what is due so far
//   DUE_TODAY     only today's installment is unpaid
//   PARTLY_PAID   only today's installment is unpaid, and part of it is paid
//   OVERDUE       an installment from before today is unpaid (or the term has ended with money owed)
//   PAID          nothing left to pay
const loanSchedule = (loan, { today = todayKey(), paidToday = 0 } = {}) => {
  const frequency = loan.paymentFrequency;
  const total = installmentCount(frequency, loan.durationDays);
  const expected = loan.expectedReturnAmount;
  const installment = loan.expectedDailyMonthlyPayment || round2(expected / total);
  const paid = loan.totalRepaid || 0;

  // Installment i falls i periods after the collection start date, or i + 1 periods after disbursement.
  // Counting each from that anchor keeps monthly dates on the anchor's day (31 Jan → 28 Feb → 31 Mar).
  const anchor = loan.collectionStartDate ? dayKey(loan.collectionStartDate) : dayKey(loan.startDate);
  const offset = loan.collectionStartDate ? 0 : 1;
  const dueOn = (index) => addPeriods(frequency, anchor, index + offset);
  const firstDueDate = dueOn(0);
  const lastDueDate = dueOn(total - 1);

  // Money due once `count` installments have fallen due; the last one makes up the rounding
  const dueAmount = (count) => (count >= total ? expected : round2(Math.min(count * installment, expected)));

  // Installments due on or before a day
  const installmentsDueBy = (day) => {
    if (day < firstDueDate) return 0;
    if (frequency === 'DAILY') return Math.min(total, daysBetween(firstDueDate, day) + 1);
    if (frequency === 'WEEKLY') return Math.min(total, Math.floor(daysBetween(firstDueDate, day) / 7) + 1);
    let count = 0;
    while (count < total && dueOn(count) <= day) count++;
    return count;
  };

  // Installments fully covered by what has been paid, oldest first
  const installmentsPaid = paid + EPSILON >= expected
    ? total
    : Math.min(total - 1, Math.floor((paid + EPSILON) / installment));

  const installmentsDue = installmentsDueBy(today);
  const dueSoFar = dueAmount(installmentsDue);
  const amountDue = round2(Math.max(0, dueSoFar - paid));
  const overdueBeforeToday = round2(Math.max(0, dueAmount(installmentsDueBy(addDays(today, -1))) - paid));
  const nextDueDate = installmentsPaid < total ? dueOn(installmentsPaid) : null;
  const unpaidInstallments = Math.max(0, installmentsDue - installmentsPaid);

  // Today's own installment, if one falls today, and how much of it is paid (by any payment, early ones included)
  const installmentToday = installmentsDue > 0 && dueOn(installmentsDue - 1) === today
    ? round2(dueAmount(installmentsDue) - dueAmount(installmentsDue - 1))
    : 0;
  const installmentTodayPaid = installmentToday
    ? round2(Math.min(installmentToday, Math.max(0, paid - dueAmount(installmentsDue - 1))))
    : 0;

  let status;
  if ((loan.pendingAmount ?? expected - paid) <= EPSILON || installmentsPaid >= total) {
    status = 'PAID';
  } else if (amountDue > EPSILON) {
    if (unpaidInstallments === 1 && nextDueDate === today) {
      status = paid > dueAmount(installmentsPaid) + EPSILON ? 'PARTLY_PAID' : 'DUE_TODAY';
    } else {
      status = 'OVERDUE';
    }
  } else if (installmentsDue === 0 && paid <= EPSILON) {
    status = 'UPCOMING';
  } else if (installmentsPaid > installmentsDue) {
    status = 'PAID_AHEAD';
  } else {
    status = 'UP_TO_DATE';
  }

  return {
    status,
    today,
    installment,
    installmentsTotal: total,
    installmentsDue,
    installmentsPaid,
    firstDueDate,
    lastDueDate,
    termEnded: today > lastDueDate,
    // The oldest unpaid installment (in the past when overdue)
    nextDueDate,
    overdueSince: status === 'OVERDUE' ? nextDueDate : null,
    // The last installment fully covered, when paid ahead
    paidUntil: installmentsPaid > 0 ? dueOn(installmentsPaid - 1) : null,
    dueSoFar,
    // What brings the loan up to date today, today's installment included
    amountDue,
    // Unpaid installments from before today, without today's
    overdueBeforeToday,
    unpaidInstallments,
    installmentToday,
    installmentTodayPaid,
    paidToday: round2(paidToday),
  };
};

module.exports = {
  BUSINESS_TIME_ZONE,
  dayKey,
  todayKey,
  addDays,
  keyToDate,
  installmentCount,
  loanSchedule,
};
