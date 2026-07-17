const Transaction = require('../models/Transaction');
const Loan = require('../models/Loan');

// @desc    Get dashboard metrics
// @route   GET /api/dashboard
// @access  Public
const getDashboardMetrics = async (req, res) => {
  try {
    // 1. Calculate Capital and Cash Flow from Ledger
    const transactions = await Transaction.find();
    
    let totalCapitalInjected = 0;
    let totalCapitalWithdrawn = 0;
    let totalDisbursed = 0;
    let totalRepaid = 0;
    let realizedProfit = 0;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let todayCollections = 0;

    transactions.forEach(t => {
      if (t.type === 'CAPITAL_INJECTION') totalCapitalInjected += t.amount;
      if (t.type === 'CAPITAL_WITHDRAWAL') totalCapitalWithdrawn += t.amount;
      if (t.type === 'DISBURSEMENT') totalDisbursed += t.amount;
      if (t.type === 'REPAYMENT') {
        totalRepaid += t.amount;
        realizedProfit += t.profitPortion || 0;
        
        const tDate = new Date(t.date);
        tDate.setHours(0, 0, 0, 0);
        if (tDate.getTime() === today.getTime()) {
          todayCollections += t.amount;
        }
      }
    });

    const totalCapital = totalCapitalInjected - totalCapitalWithdrawn;
    const cashOnHand = totalCapital - totalDisbursed + totalRepaid;

    // 2. Calculate Market Metrics from Active Loans
    const activeLoans = await Loan.find({ status: 'ACTIVE' }).populate('client');
    
    let moneyInMarket = 0;
    let expectedProfitPending = 0;
    let totalExpectedDailyCollections = 0;

    const activeLoansSummary = activeLoans.map(loan => {
      const outstandingPrincipal = loan.principalAmount - loan.principalRecovered;
      const outstandingProfit = loan.profitAmount - loan.profitRealized;
      
      moneyInMarket += outstandingPrincipal;
      expectedProfitPending += outstandingProfit;

      // Only count daily ones for today's snapshot, or include all for a generalized "collection velocity"
      if (loan.paymentFrequency === 'DAILY') {
        totalExpectedDailyCollections += loan.expectedDailyMonthlyPayment;
      }

      // Calculate next payment date
      const loanTransactions = transactions.filter(t => t.loan && t.loan.toString() === loan._id.toString() && t.type === 'REPAYMENT');
      let lastPaymentDate = loan.startDate;
      let isCollectedToday = false;
      
      if (loanTransactions.length > 0) {
        loanTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
        lastPaymentDate = loanTransactions[0].date;
        isCollectedToday = new Date(lastPaymentDate).toDateString() === today.toDateString();
      }
      
      const nextDate = new Date(lastPaymentDate);
      if (loan.paymentFrequency === 'DAILY') {
        nextDate.setDate(nextDate.getDate() + 1);
      } else if (loan.paymentFrequency === 'WEEKLY') {
        nextDate.setDate(nextDate.getDate() + 7);
      } else if (loan.paymentFrequency === 'MONTHLY') {
        nextDate.setMonth(nextDate.getMonth() + 1);
      }

      return {
        loanId: loan._id,
        clientName: loan.client?.name || 'Unknown',
        frequency: loan.paymentFrequency,
        expectedPayment: loan.expectedDailyMonthlyPayment,
        pendingAmount: loan.pendingAmount,
        nextPaymentDate: nextDate,
        isCollectedToday
      };
    });

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
          totalEquity,
        },
        collections: {
          todayCollections,
          totalExpectedDailyCollections,
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
