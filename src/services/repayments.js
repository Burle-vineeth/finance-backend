const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const { HttpError } = require('../utils/httpError');
const { dayKey, addDays, keyToDate } = require('./schedule');

const isPositiveAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

// Records a repayment against its loan and in the ledger. Used for the admin's own entries and for
// approved staff collections, so both are worked out the same way.
//
// Principal first: the payment recovers whatever is left of the principal, and only money beyond
// that counts as profit. The loan closes once nothing is left to pay.
//
// Pass the session of a running MongoDB transaction (see withTransaction) so the loan update and the
// ledger entry are saved together. requireActive refuses loans that are already closed or defaulted.
const applyRepayment = async ({ loanId, amount, date, notes, client, requireActive = false, extra = {} }, session) => {
  if (!isPositiveAmount(amount)) {
    throw new HttpError(400, 'Amount must be a number greater than zero');
  }

  const activeLoan = await Loan.findById(loanId).session(session);
  if (!activeLoan) {
    throw new HttpError(404, 'Loan not found');
  }
  if (requireActive && activeLoan.status !== 'ACTIVE') {
    throw new HttpError(409, 'This loan is no longer active');
  }

  let principalPortion = 0;
  let profitPortion = 0;

  // --- PRINCIPAL FIRST RECOVERY LOGIC ---
  const remainingPrincipalToRecover = activeLoan.principalAmount - (activeLoan.principalRecovered || 0);

  if (remainingPrincipalToRecover > 0) {
    if (amount <= remainingPrincipalToRecover) {
      // Entire payment goes towards recovering principal
      principalPortion = amount;
      profitPortion = 0;
    } else {
      // Payment fully recovers principal, remainder is profit
      principalPortion = remainingPrincipalToRecover;
      profitPortion = amount - remainingPrincipalToRecover;
    }
  } else {
    // Principal already recovered, all payment is profit
    principalPortion = 0;
    profitPortion = amount;
  }

  // Update the Loan's tracking fields
  activeLoan.totalRepaid += amount;
  activeLoan.pendingAmount -= amount;
  activeLoan.principalRecovered += principalPortion;
  activeLoan.profitRealized += profitPortion;

  // Auto-close loan if fully paid
  if (activeLoan.pendingAmount <= 0) {
    activeLoan.status = 'CLOSED';
    activeLoan.resolvedAt = date ? new Date(date) : new Date();
  }

  await activeLoan.save({ session });

  const [transaction] = await Transaction.create([{
    type: 'REPAYMENT',
    amount,
    client: client || null,
    loan: loanId,
    date: date ? new Date(date) : new Date(),
    principalPortion,
    profitPortion,
    notes,
    ...extra,
  }], { session });

  return transaction;
};

// What was repaid on each loan on an India day ('YYYY-MM-DD'), as a Map of loan id -> amount
const repaidOnDayByLoan = async (day, loanIds, session = null) => {
  const repayments = await Transaction.find({
    type: 'REPAYMENT',
    loan: { $in: loanIds },
    // A generous UTC window around the India day, narrowed below
    date: { $gte: keyToDate(addDays(day, -1)), $lt: keyToDate(addDays(day, 2)) },
  }).select('loan amount date').session(session).lean();
  const byLoan = new Map();
  for (const t of repayments) {
    if (dayKey(t.date) !== day) continue;
    const loanId = String(t.loan);
    byLoan.set(loanId, (byLoan.get(loanId) || 0) + t.amount);
  }
  return byLoan;
};

module.exports = { applyRepayment, repaidOnDayByLoan };
