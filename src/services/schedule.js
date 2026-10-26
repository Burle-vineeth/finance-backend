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

// The installment amount and how many installments repay the expected return. A loan whose installment was
// set by hand (or that has no duration) needs as many as it takes at that amount, the last one smaller;
// otherwise the duration decides how many, and the amount is the expected return split evenly.
const installmentPlan = (loan) => {
  const expected = loan.expectedReturnAmount;
  const installment = loan.expectedDailyMonthlyPayment;
  if ((loan.installmentIsCustom || !loan.durationDays) && installment > 0) {
    const full = Math.floor((expected + EPSILON) / installment);
    // What's left after the full installments is one more, smaller installment; under a rupee it is
    // added to the last one instead (₹1,000 at ₹333.33 is 3 installments, not a 4th of 1 paisa)
    const remainder = round2(expected - full * installment);
    return { installment, total: Math.max(1, remainder >= 1 ? full + 1 : full) };
  }
  const total = installmentCount(loan.paymentFrequency, loan.durationDays);
  return { installment: installment || round2(expected / total), total };
};

const addPeriods = (frequency, key, periods) => {
  if (frequency === 'WEEKLY') return addDays(key, 7 * periods);
  if (frequency === 'MONTHLY') return addMonths(key, periods);
  return addDays(key, periods);
};

// How a loan's installments fall: their dates and the money due as they come in.
//   dueOn(i)                 date of installment i ('YYYY-MM-DD')
//   dueAmount(count)         money due once `count` installments have fallen due
//   installmentsDueBy(day)   installments due on or before a day
//   installmentsPaidBy(paid) installments fully covered by `paid`, oldest first
const regularTimeline = (loan) => {
  const frequency = loan.paymentFrequency;
  const { installment, total } = installmentPlan(loan);
  const expected = loan.expectedReturnAmount;

  // Installment i falls i periods after the collection start date, or i + 1 periods after disbursement.
  // Counting each from that anchor keeps monthly dates on the anchor's day (31 Jan → 28 Feb → 31 Mar).
  const anchor = loan.collectionStartDate ? dayKey(loan.collectionStartDate) : dayKey(loan.startDate);
  const offset = loan.collectionStartDate ? 0 : 1;
  const dueOn = (index) => addPeriods(frequency, anchor, index + offset);
  const firstDueDate = dueOn(0);

  return {
    total,
    installment,
    customPlan: false,
    // Only a loan with an agreed duration has a term that can end; one without just runs until repaid
    hasTerm: Boolean(loan.durationDays),
    dueOn,
    // The last installment makes up the rounding
    dueAmount: (count) => (count >= total ? expected : round2(Math.min(count * installment, expected))),
    installmentsDueBy: (day) => {
      if (day < firstDueDate) return 0;
      if (frequency === 'DAILY') return Math.min(total, daysBetween(firstDueDate, day) + 1);
      if (frequency === 'WEEKLY') return Math.min(total, Math.floor(daysBetween(firstDueDate, day) / 7) + 1);
      let count = 0;
      while (count < total && dueOn(count) <= day) count++;
      return count;
    },
    installmentsPaidBy: (paid) => (paid + EPSILON >= expected
      ? total
      : Math.min(total - 1, Math.floor((paid + EPSILON) / installment))),
  };
};

// A timeline from a list of dated amounts, oldest first, that add up to `expected`
const rowsTimeline = (rows, expected) => {
  const total = rows.length;
  const cumulative = [0];
  rows.forEach((row) => cumulative.push(round2(cumulative[cumulative.length - 1] + row.amount)));

  return {
    total,
    dueOn: (index) => rows[index].date,
    dueAmount: (count) => (count >= total ? expected : cumulative[count]),
    installmentsDueBy: (day) => {
      let count = 0;
      while (count < total && rows[count].date <= day) count++;
      return count;
    },
    installmentsPaidBy: (paid) => {
      if (paid + EPSILON >= expected) return total;
      let count = 0;
      while (count < total - 1 && cumulative[count + 1] <= paid + EPSILON) count++;
      return count;
    },
  };
};

// A custom installment plan: the dates and amounts were set one by one (see services/customInstallments)
const planTimeline = (loan) => {
  const rows = loan.customInstallments
    .map((row) => ({ date: dayKey(row.date), amount: row.amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    ...rowsTimeline(rows, loan.expectedReturnAmount),
    installment: null,
    customPlan: true,
    // A plan ends with its last installment
    hasTerm: true,
  };
};

// The loan's agreed installments, without late fees
const timelineOf = (loan) => (loan.customInstallments?.length ? planTimeline(loan) : regularTimeline(loan));

// The late fees charged on a loan, added up
const feesTotal = (loan) => round2((loan.lateFees || []).reduce((sum, fee) => sum + fee.amount, 0));

// Everything a loan has falling due: its installments and, on the day each was charged, its late fees. Payments
// cover whatever fell due first, installments and fees alike (an installment before a fee on the same day).
// A loan without late fees keeps its own timeline.
const dueTimelineOf = (loan) => {
  const timeline = timelineOf(loan);
  if (!loan.lateFees?.length) return timeline;
  const rows = [];
  for (let i = 0; i < timeline.total; i++) {
    rows.push({ date: timeline.dueOn(i), amount: round2(timeline.dueAmount(i + 1) - timeline.dueAmount(i)) });
  }
  rows.push(...loan.lateFees.map((fee) => ({ date: dayKey(fee.date), amount: fee.amount, fee: true })));
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return {
    ...rowsTimeline(rows, round2(loan.expectedReturnAmount + feesTotal(loan))),
    installment: timeline.installment,
    customPlan: timeline.customPlan,
    hasTerm: timeline.hasTerm,
    // How many of the first `count` rows are installments, for the counts shown (a fee isn't an installment)
    installmentsAmong: (count) => rows.slice(0, count).filter((row) => !row.fee).length,
  };
};

// Where a loan stands today, against its regular schedule or its custom installment plan.
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
// Late fees fall due alongside the installments (see dueTimelineOf): they count in what is due, overdue and next,
// but not in the installment counts, and the term still ends with the last agreed installment.
const loanSchedule = (loan, { today = todayKey(), paidToday = 0 } = {}) => {
  const timeline = dueTimelineOf(loan);
  const { total, hasTerm, dueOn, dueAmount, installmentsDueBy } = timeline;
  const installmentsAmong = timeline.installmentsAmong || ((count) => count);
  const agreed = timelineOf(loan);
  const owed = loan.expectedReturnAmount + feesTotal(loan);
  const paid = loan.totalRepaid || 0;
  const firstDueDate = dueOn(0);
  const lastDueDate = agreed.dueOn(agreed.total - 1);

  // Rows here are installments and late fees alike
  const installmentsPaid = timeline.installmentsPaidBy(paid);
  const installmentsDue = installmentsDueBy(today);
  const dueBeforeToday = installmentsDueBy(addDays(today, -1));
  const dueSoFar = dueAmount(installmentsDue);
  const amountDue = round2(Math.max(0, dueSoFar - paid));
  const overdueBeforeToday = round2(Math.max(0, dueAmount(dueBeforeToday) - paid));
  const nextDueDate = installmentsPaid < total ? dueOn(installmentsPaid) : null;
  // The next unpaid installment (or late fee) in full (for a plan, each can differ)
  const nextInstallmentAmount = installmentsPaid < total
    ? round2(dueAmount(installmentsPaid + 1) - dueAmount(installmentsPaid))
    : 0;
  const installment = timeline.installment ?? nextInstallmentAmount;

  // What falls due today (an installment, a late fee charged today, or both), and how much of it is paid (by any
  // payment, early ones included)
  const installmentToday = round2(dueSoFar - dueAmount(dueBeforeToday));
  const installmentTodayPaid = installmentToday
    ? round2(Math.min(installmentToday, Math.max(0, paid - dueAmount(dueBeforeToday))))
    : 0;

  let status;
  if ((loan.pendingAmount ?? owed - paid) <= EPSILON || installmentsPaid >= total) {
    status = 'PAID';
  } else if (amountDue > EPSILON) {
    // Only what falls today is unpaid
    if (dueBeforeToday <= installmentsPaid && nextDueDate === today) {
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
    // True when the loan follows a custom installment plan (dates and amounts set one by one)
    customPlan: timeline.customPlan,
    nextInstallmentAmount,
    installmentsTotal: installmentsAmong(total),
    installmentsDue: installmentsAmong(installmentsDue),
    installmentsPaid: installmentsAmong(installmentsPaid),
    firstDueDate,
    // The last installment's date: the end of the term, or when a loan without a duration should be repaid
    lastDueDate,
    hasTerm,
    termEnded: hasTerm && today > lastDueDate,
    // The oldest unpaid installment (in the past when overdue)
    nextDueDate,
    overdueSince: status === 'OVERDUE' ? nextDueDate : null,
    // The last installment fully covered, when paid ahead
    paidUntil: installmentsPaid > 0 ? dueOn(installmentsPaid - 1) : null,
    dueSoFar,
    // What brings the loan up to date today, today's installment included
    amountDue,
    // Paid beyond what is due so far (the client is ahead by this much)
    aheadAmount: round2(Math.max(0, paid - dueSoFar)),
    // Unpaid installments (and late fees) from before today, without today's
    overdueBeforeToday,
    unpaidInstallments: Math.max(0, installmentsAmong(installmentsDue) - installmentsAmong(installmentsPaid)),
    // Late fees charged on the loan, added up (they're in amountDue and overdueBeforeToday once they fall due)
    lateFees: feesTotal(loan),
    installmentToday,
    installmentTodayPaid,
    paidToday: round2(paidToday),
  };
};

// The installments (and late fees) of a loan that fall due from one day to another (both included), oldest
// first. Only those in the range are read, so a long loan costs no more than its days in the range.
const installmentsBetween = (loan, fromKey, toKey) => {
  const { dueOn, dueAmount, installmentsDueBy } = dueTimelineOf(loan);
  const rows = [];
  for (let i = installmentsDueBy(addDays(fromKey, -1)); i < installmentsDueBy(toKey); i++) {
    rows.push({ date: dueOn(i), amount: round2(dueAmount(i + 1) - dueAmount(i)) });
  }
  return rows;
};

// Flat interest a year, in percent: the profit as a share of the principal, scaled from the loan's days to a
// year. ₹10,000 lent for ₹12,000 back over 100 days is 20% in 100 days, 73% a year. null without any days
// to spread it over (repaid the day it was given).
const flatRate = (principal, profit, fromKey, toKey) => {
  const days = daysBetween(fromKey, toKey);
  return principal > 0 && days > 0 ? round2((profit / principal) * (365 / days) * 100) : null;
};

// A loan's flat interest a year:
//   agreed  over its agreed term, from disbursement to the last installment's due date
//   actual  over the days it really took, from disbursement to the final payment (closedOn, for loans closed
//           before it was recorded; defaults to resolvedAt). For an active loan past its last due date, up to
//           today, as if repaid in full today: it falls each day the money stays out. Otherwise null.
const interestRates = (loan, { closedOn = loan.resolvedAt, today = todayKey() } = {}) => {
  const timeline = timelineOf(loan);
  const start = dayKey(loan.startDate);
  const lastDueDate = timeline.dueOn(timeline.total - 1);
  const principal = loan.principalAmount;
  const profit = loan.expectedReturnAmount - principal;
  let actual = null;
  if (loan.status === 'CLOSED' && closedOn) {
    // What was really repaid, which a final payment can take past the expected return
    actual = flatRate(principal, (loan.totalRepaid || 0) - principal, start, dayKey(closedOn));
  } else if (loan.status === 'ACTIVE' && today > lastDueDate) {
    // Late fees are owed too
    actual = flatRate(principal, profit + feesTotal(loan), start, today);
  }
  return { agreed: flatRate(principal, profit, start, lastDueDate), actual };
};

module.exports = {
  BUSINESS_TIME_ZONE,
  dayKey,
  todayKey,
  addDays,
  daysBetween,
  keyToDate,
  installmentCount,
  installmentPlan,
  loanSchedule,
  feesTotal,
  installmentsBetween,
  interestRates,
};
