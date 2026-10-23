const Transaction = require('../models/Transaction');
const Loan = require('../models/Loan');
const CollectionEntry = require('../models/CollectionEntry');
const { loanSchedule, todayKey, dayKey, keyToDate } = require('../services/schedule');

const round2 = (value) => Math.round(value * 100) / 100;

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

module.exports = {
  getDashboardMetrics
};
