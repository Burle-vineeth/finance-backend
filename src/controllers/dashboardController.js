const Transaction = require('../models/Transaction');
const Loan = require('../models/Loan');
const CollectionEntry = require('../models/CollectionEntry');
const { loanSchedule, installmentsBetween, todayKey, dayKey, keyToDate, addDays, daysBetween } = require('../services/schedule');
const { HttpError, sendError } = require('../utils/httpError');
const { scoreFor, TARGET_YEARLY_RATE, GRACE_DAYS } = require('../services/score');
const { cashSplit } = require('../services/cash');

const round2 = (value) => Math.round(value * 100) / 100;
const round1 = (value) => Math.round(value * 10) / 10;

// The longest range the collections chart can ask for: ten years of days
const MAX_RANGE_DAYS = 3660;

// A 'YYYY-MM-DD' query value (undefined when left out); anything else is refused
const parseDayKey = (value, name) => {
  if (value === undefined || value === '') return undefined;
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? keyToDate(value) : null;
  // A real day: 2026-02-30 doesn't come back as itself
  const valid = date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  if (!valid) throw new HttpError(400, `${name} must be a date as YYYY-MM-DD`);
  return value;
};

// Most urgent first on the dashboard: overdue, then due today, then the rest by next due date
const URGENCY = { OVERDUE: 0, PARTLY_PAID: 1, DUE_TODAY: 2, UPCOMING: 3, UP_TO_DATE: 3, PAID_AHEAD: 4, PAID: 5 };

// @desc    Get dashboard metrics
// @route   GET /api/dashboard
// @access  Public
const getDashboardMetrics = async (req, res) => {
  try {
    // 1. Calculate Capital and Cash Flow from Ledger
    // Both reads are independent, so run them together. The ledger is only read here,
    // so .lean() skips building full Mongoose documents for every transaction.
    const [transactions, activeLoans, pendingEntries] = await Promise.all([
      Transaction.find().lean(),
      Loan.find({ status: 'ACTIVE' }).populate('client'),
      CollectionEntry.find({ status: 'PENDING' }).select('loan amount date').lean(),
    ]);

    let totalCapitalInjected = 0;
    let totalCapitalWithdrawn = 0;
    let totalDisbursed = 0;
    let totalRepaid = 0;
    let realizedProfit = 0;
    let totalExpenses = 0;
    
    // Days are India days, so "today" doesn't flip at 5:30 am as it would on the server's UTC clock
    const today = todayKey();
    let todayCollections = 0;
    const paidTodayByLoan = new Map();

    transactions.forEach(t => {
      if (t.type === 'CAPITAL_INJECTION') totalCapitalInjected += t.amount;
      if (t.type === 'CAPITAL_WITHDRAWAL') totalCapitalWithdrawn += t.amount;
      if (t.type === 'DISBURSEMENT') totalDisbursed += t.amount;
      if (t.type === 'BUSINESS_EXPENSE') totalExpenses += t.amount;
      if (t.type === 'REPAYMENT') {
        totalRepaid += t.amount;
        realizedProfit += t.profitPortion || 0;
        
        if (dayKey(t.date) === today) {
          todayCollections += t.amount;
          if (t.loan) {
            const loanId = t.loan.toString();
            paidTodayByLoan.set(loanId, (paidTodayByLoan.get(loanId) || 0) + t.amount);
          }
        }
      }
    });

    const totalCapital = totalCapitalInjected - totalCapitalWithdrawn;
    const cashOnHand = totalCapital - totalDisbursed + totalRepaid - totalExpenses;
    // The same cash, split between the admin's hand and the staff's (collected, not yet handed over)
    const { withStaff: cashWithStaff, inHand: cashInHand } = cashSplit(transactions);
    const netProfit = realizedProfit - totalExpenses;

    // 2. Calculate Market Metrics from Active Loans
    let moneyInMarket = 0;
    let expectedProfitPending = 0;
    // Installments falling today, of every frequency, and how many of them are paid (early payments included)
    const dueToday = { amount: 0, count: 0, paidCount: 0 };
    // Unpaid installments from before today
    const overdue = { amount: 0, loans: 0 };

    // Staff collections still waiting for approval, per loan
    const pendingByLoan = new Map();
    pendingEntries.forEach(e => {
      const loanId = e.loan.toString();
      pendingByLoan.set(loanId, [...(pendingByLoan.get(loanId) || []), e]);
    });

    const activeLoansSummary = activeLoans.map(loan => {
      const outstandingPrincipal = loan.principalAmount - loan.principalRecovered;
      const outstandingProfit = loan.profitAmount - loan.profitRealized;
      
      moneyInMarket += outstandingPrincipal;
      expectedProfitPending += outstandingProfit;

      const loanId = loan._id.toString();
      const schedule = loanSchedule(loan, { today, paidToday: paidTodayByLoan.get(loanId) || 0 });
      if (schedule.installmentToday > 0) {
        dueToday.amount += schedule.installmentToday;
        dueToday.count += 1;
        if (schedule.installmentTodayPaid >= schedule.installmentToday) dueToday.paidCount += 1;
      }
      if (schedule.overdueBeforeToday > 0) {
        overdue.amount += schedule.overdueBeforeToday;
        overdue.loans += 1;
      }
      const pending = pendingByLoan.get(loanId) || [];

      return {
        loanId: loan._id,
        clientName: loan.client?.name || 'Unknown',
        frequency: loan.paymentFrequency,
        expectedPayment: schedule.installment,
        pendingAmount: loan.pendingAmount,
        // For app versions from before the schedule: the oldest unpaid installment, and whether anything was paid today
        nextPaymentDate: keyToDate(schedule.nextDueDate || schedule.lastDueDate),
        isCollectedToday: schedule.paidToday > 0,
        schedule,
        awaitingApproval: {
          count: pending.length,
          amount: round2(pending.reduce((sum, e) => sum + e.amount, 0)),
          today: pending.some(e => dayKey(e.date) === today),
        },
      };
    }).sort((a, b) =>
      (URGENCY[a.schedule.status] - URGENCY[b.schedule.status])
      || String(a.schedule.nextDueDate).localeCompare(String(b.schedule.nextDueDate))
    );

    // True Equity is Assets (Cash + Money currently out in market). Pending profit is not yet equity.
    const totalEquity = cashOnHand + moneyInMarket;

    res.status(200).json({
      success: true,
      data: {
        finances: {
          totalCapital,
          cashOnHand,
          cashInHand,
          cashWithStaff,
          moneyInMarket,
          expectedProfitPending,
          realizedProfit,
          totalExpenses,
          netProfit,
          totalEquity,
        },
        collections: {
          todayCollections,
          // Kept for app versions from before the schedule; now today's installments of every frequency
          totalExpectedDailyCollections: round2(dueToday.amount),
          dueToday: { ...dueToday, amount: round2(dueToday.amount) },
          overdue: { ...overdue, amount: round2(overdue.amount) },
          activeLoans: activeLoansSummary,
        }
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Money expected and collected, day by day
// @route   GET /api/dashboard/collections?from=YYYY-MM-DD&to=YYYY-MM-DD
// @access  Admin
// Expected is what the loans' installment schedules have falling due each day, closed loans included, as agreed.
// Collected is the repayments received that day; staff collections count once approved. Without from, the range
// starts on the day the first loan was given; without to, it ends today.
const getCollectionTrend = async (req, res) => {
  try {
    const today = todayKey();
    const loans = await Loan.find().lean();
    const firstLoanDay = loans.reduce((first, loan) => {
      const day = dayKey(loan.startDate);
      return day < first ? day : first;
    }, today);
    const from = parseDayKey(req.query.from, 'from') || firstLoanDay;
    const to = parseDayKey(req.query.to, 'to') || today;
    if (from > to) throw new HttpError(400, 'from must be on or before to');
    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new HttpError(400, 'Choose a range of up to 10 years');

    const days = new Map();
    for (let day = from; day <= to; day = addDays(day, 1)) days.set(day, { date: day, expected: 0, collected: 0 });

    for (const loan of loans) {
      for (const { date, amount } of installmentsBetween(loan, from, to)) days.get(date).expected += amount;
    }

    const repayments = await Transaction.find({
      type: 'REPAYMENT',
      // A generous UTC window around the India days, narrowed below
      date: { $gte: keyToDate(addDays(from, -1)), $lt: keyToDate(addDays(to, 2)) },
    }).select('amount date').lean();
    for (const t of repayments) {
      const row = days.get(dayKey(t.date));
      if (row) row.collected += t.amount;
    }

    res.status(200).json({
      success: true,
      data: {
        from,
        to,
        today,
        // The day the first loan was given, where "all time" starts
        firstLoanDay,
        days: [...days.values()].map((d) => ({ ...d, expected: round2(d.expected), collected: round2(d.collected) })),
      },
    });
  } catch (error) {
    sendError(res, error, 'Collection Trend Error:');
  }
};

// @desc    The business score for a range of days, out of 100, with what helped and hurt; and the score of a
//          period to compare it with (the app sends the one just before, e.g. September for October)
// @route   GET /api/dashboard/score?from=&to=&compareFrom=&compareTo=   (days as YYYY-MM-DD)
// @access  Admin
// Worked out only when asked for: nothing else in the app waits on it. Without from, the range starts on the
// day the first loan was given; without to, it ends today. See services/score for how it is worked out.
const getBusinessScore = async (req, res) => {
  try {
    const today = todayKey();
    const [loans, transactions] = await Promise.all([
      Loan.find().populate('client', 'name').lean(),
      Transaction.find().select('type amount date loan principalPortion').lean(),
    ]);
    const firstLoanDay = loans.reduce((first, loan) => {
      const day = dayKey(loan.startDate);
      return day < first ? day : first;
    }, today);
    const rangeOf = (fromName, toName, defaults) => {
      const from = parseDayKey(req.query[fromName], fromName) || defaults.from;
      const to = parseDayKey(req.query[toName], toName) || defaults.to;
      if (from > to) throw new HttpError(400, `${fromName} must be on or before ${toName}`);
      if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new HttpError(400, 'Choose a range of up to 10 years');
      return { from, to };
    };
    const { from, to } = rangeOf('from', 'to', { from: firstLoanDay, to: today });
    const compare = req.query.compareFrom || req.query.compareTo ? rangeOf('compareFrom', 'compareTo', {}) : null;

    const settings = { targetYearlyRate: TARGET_YEARLY_RATE, graceDays: GRACE_DAYS };
    if (from > today) {
      return res.json({ success: true, data: { from, to, today, firstLoanDay, notStarted: true, settings } });
    }
    const current = scoreFor({ loans, transactions, from, to, today });
    // Only a period when the business was already running is worth comparing with
    const scored = compare && compare.to >= firstLoanDay && compare.from <= today
      ? scoreFor({ loans, transactions, ...compare, today })
      : null;
    const before = scored && scored.total !== null ? scored : null;
    // Each part's points against the same part then: +5, -2.5 (null when either period couldn't score it)
    const pointsBefore = new Map((before?.parts || []).map((part) => [part.key, part.points]));
    const parts = current.parts.map((part) => {
      const then = pointsBefore.get(part.key);
      return { ...part, change: part.points !== null && then !== null && then !== undefined ? round1(part.points - then) : null };
    });

    res.json({
      success: true,
      data: {
        ...current,
        parts,
        today,
        firstLoanDay,
        previous: before ? { from: before.from, to: before.to, total: before.total, label: before.label } : null,
        settings,
      },
    });
  } catch (error) {
    sendError(res, error, 'Business Score Error:');
  }
};

module.exports = {
  getDashboardMetrics,
  getCollectionTrend,
  getBusinessScore,
};
