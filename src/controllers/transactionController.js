const Transaction = require('../models/Transaction');
const Loan = require('../models/Loan');
const CollectionEntry = require('../models/CollectionEntry');
const { applyRepayment } = require('../services/repayments');
const { withTransaction } = require('../utils/withTransaction');
const { HttpError, sendError } = require('../utils/httpError');

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

// @desc    Log a new transaction (Repayment, Capital Injection, etc)
// @route   POST /api/transactions
// @access  Admin
const addTransaction = async (req, res) => {
  try {
    const { type, amount, client, loan, notes, date } = req.body;

    if (type === 'REPAYMENT') {
      if (!loan) {
        return res.status(400).json({ success: false, error: 'Loan ID is required for a repayment' });
      }
      // The loan update and the ledger entry are saved together, or not at all
      const transaction = await withTransaction((session) =>
        applyRepayment({ loanId: loan, amount, date, notes, client }, session)
      );
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
  addTransaction,
  deleteTransaction,
};
