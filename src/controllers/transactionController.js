const Transaction = require('../models/Transaction');
const Loan = require('../models/Loan');
const CollectionEntry = require('../models/CollectionEntry');
const { applyRepayment } = require('../services/repayments');
const { cashSplit } = require('../services/cash');
const { withTransaction } = require('../utils/withTransaction');
const { HttpError, sendError } = require('../utils/httpError');

const EPSILON = 0.005;
const CASH_HOLDERS = ['ADMIN', 'STAFF'];
const round2 = (value) => Math.round(value * 100) / 100;
const rupees = (amount) => `₹${Math.max(0, amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Where the cash is now: with staff, and in the admin's hand
const currentSplit = async (session = null) =>
  cashSplit(await Transaction.find().select('type amount cashWith').session(session).lean());

// @desc    Get all transactions (Ledger)
// @route   GET /api/transactions
// @access  Admin
const getTransactions = async (req, res) => {
  try {
    // The app only shows the client's name and groups by loan id, so populate just those
    // fields instead of embedding the full client and loan record in every transaction
    const transactions = await Transaction.find()
      .populate('client', 'name')
      .populate('loan', '_id')
      .populate('collectedBy', 'name')
      .sort({ date: -1, createdAt: -1 })
      .lean();
    res.status(200).json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Where the business's cash is: in the admin's hand, and with staff
// @route   GET /api/transactions/cash
// @access  Admin
const getCashSplit = async (req, res) => {
  try {
    res.json({ success: true, data: await currentSplit() });
  } catch (error) {
    sendError(res, error, 'Cash Split Error:');
  }
};

// @desc    Log a new transaction (Repayment, Capital Injection, etc)
// @route   POST /api/transactions
// @access  Admin
// A repayment says whose hand the money went to (cashWith: STAFF or ADMIN; left out, as older app versions do, it
// is the admin's). A CASH_TRANSFER moves cash between hands: cashWith ADMIN is received from staff, STAFF is moved
// to staff; it can't take more than the hand it leaves holds.
const addTransaction = async (req, res) => {
  try {
    const { type, amount, client, loan, notes, date, cashWith } = req.body;
    if (cashWith !== undefined && !CASH_HOLDERS.includes(cashWith)) {
      throw new HttpError(400, 'cashWith must be ADMIN or STAFF');
    }

    if (type === 'REPAYMENT') {
      if (!loan) {
        return res.status(400).json({ success: false, error: 'Loan ID is required for a repayment' });
      }
      // The loan update and the ledger entry are saved together, or not at all
      const transaction = await withTransaction((session) =>
        applyRepayment({ loanId: loan, amount, date, notes, client, extra: { cashWith: cashWith || 'ADMIN' } }, session)
      );
      return res.status(201).json({ success: true, data: transaction });
    }

    if (type === 'CASH_TRANSFER') {
      if (!cashWith) throw new HttpError(400, 'Say where the cash moved to: ADMIN (received from staff) or STAFF (moved to staff)');
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, 'Amount must be a number greater than zero');
      }
      const transaction = await withTransaction(async (session) => {
        const { withStaff, inHand } = await currentSplit(session);
        const available = cashWith === 'ADMIN' ? withStaff : inHand;
        if (amount > available + EPSILON) {
          throw new HttpError(400, cashWith === 'ADMIN' ? `Staff have only ${rupees(available)}` : `You have only ${rupees(available)}`);
        }
        const [created] = await Transaction.create([{
          type, amount: round2(amount), cashWith, date: date ? new Date(date) : new Date(), notes,
        }], { session });
        return created;
      });
      return res.status(201).json({ success: true, data: transaction });
    }

    // Create the transaction record
    const transaction = await Transaction.create({
      type,
      amount,
      client: client || null,
      loan: loan || null,
      date: date ? new Date(date) : new Date(),
      principalPortion: 0,
      profitPortion: 0,
      notes
    });

    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    sendError(res, error, 'Add Transaction Error:');
  }
};

// @desc    Delete/Undo a transaction
// @route   DELETE /api/transactions/:id
// @access  Admin
const deleteTransaction = async (req, res) => {
  try {
    await withTransaction(async (session) => {
      const transaction = await Transaction.findById(req.params.id).session(session);
      if (!transaction) {
        throw new HttpError(404, 'Transaction not found');
      }

      // Undoing money that went to staff can't leave them holding less than nothing: what they have since handed
      // over has to be undone first
      const leftStaff = transaction.cashWith === 'STAFF' && ['REPAYMENT', 'CASH_TRANSFER'].includes(transaction.type);
      if (leftStaff && (await currentSplit(session)).withStaff - transaction.amount < -EPSILON) {
        throw new HttpError(409, 'Staff have already given you this money. Undo the "Staff gave me" entry first.');
      }

      // Reverse loan calculations if it was a repayment
      if (transaction.type === 'REPAYMENT' && transaction.loan) {
        const activeLoan = await Loan.findById(transaction.loan).session(session);
        if (activeLoan) {
          activeLoan.totalRepaid -= transaction.amount;
          activeLoan.pendingAmount += transaction.amount;
          activeLoan.principalRecovered -= (transaction.principalPortion || 0);
          activeLoan.profitRealized -= (transaction.profitPortion || 0);

          // If the loan was marked closed but now has pending amount, reactivate it
          if (activeLoan.status === 'CLOSED' && activeLoan.pendingAmount > 0) {
            activeLoan.status = 'ACTIVE';
            activeLoan.resolvedAt = undefined;
          }

          await activeLoan.save({ session });
        }
      }

      await transaction.deleteOne({ session });

      // An approved staff collection that is undone shows as reversed to the staff member
      if (transaction.collectionEntry) {
        await CollectionEntry.updateOne(
          { _id: transaction.collectionEntry },
          { $set: { status: 'REVERSED' } },
          { session }
        );
      }
    });

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    sendError(res, error, 'Delete Transaction Error:');
  }
};

module.exports = {
  getTransactions,
  getCashSplit,
  addTransaction,
  deleteTransaction,
};
