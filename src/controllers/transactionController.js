const Transaction = require('../models/Transaction');
const Loan = require('../models/Loan');

// @desc    Get all transactions (Ledger)
// @route   GET /api/transactions
// @access  Public
const getTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find()
      .populate('client')
      .populate('loan')
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Log a new transaction (Repayment, Capital Injection, etc)
// @route   POST /api/transactions
// @access  Public
const addTransaction = async (req, res) => {
  try {
    const { type, amount, client, loan, notes, date } = req.body;

    let principalPortion = 0;
    let profitPortion = 0;

    // --- SMART SPLIT LOGIC FOR REPAYMENTS ---
    if (type === 'REPAYMENT') {
      if (!loan) {
        return res.status(400).json({ success: false, error: 'Loan ID is required for a repayment' });
      }

      const activeLoan = await Loan.findById(loan);
      if (!activeLoan) {
        return res.status(404).json({ success: false, error: 'Loan not found' });
      }

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
      }

      await activeLoan.save();
    }

    // Create the transaction record
    const transaction = await Transaction.create({
      type,
      amount,
      client: client || null,
      loan: loan || null,
      date: date ? new Date(date) : new Date(),
      principalPortion,
      profitPortion,
      notes
    });

    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((val) => val.message);
      return res.status(400).json({ success: false, error: messages });
    } else {
      console.error(error);
      return res.status(500).json({ success: false, error: 'Server Error' });
    }
  }
};

// @desc    Delete/Undo a transaction
// @route   DELETE /api/transactions/:id
// @access  Public
const deleteTransaction = async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    // Reverse loan calculations if it was a repayment
    if (transaction.type === 'REPAYMENT' && transaction.loan) {
      const activeLoan = await Loan.findById(transaction.loan);
      if (activeLoan) {
        activeLoan.totalRepaid -= transaction.amount;
        activeLoan.pendingAmount += transaction.amount;
        activeLoan.principalRecovered -= (transaction.principalPortion || 0);
        activeLoan.profitRealized -= (transaction.profitPortion || 0);

        // If the loan was marked closed but now has pending amount, reactivate it
        if (activeLoan.status === 'CLOSED' && activeLoan.pendingAmount > 0) {
          activeLoan.status = 'ACTIVE';
        }

        await activeLoan.save();
      }
    }

    await transaction.deleteOne();

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

module.exports = {
  getTransactions,
  addTransaction,
  deleteTransaction,
};
