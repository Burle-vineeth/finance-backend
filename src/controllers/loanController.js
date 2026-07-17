const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');

// @desc    Get all loans
// @route   GET /api/loans
// @access  Public
const getLoans = async (req, res) => {
  try {
    const loans = await Loan.find().populate('client').sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: loans });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Originate a new loan
// @route   POST /api/loans
// @access  Public
const addLoan = async (req, res) => {
  try {
    const { client, principalAmount, expectedReturnAmount, paymentFrequency, durationDays, startDate } = req.body;

    // Create the loan
    const loan = await Loan.create({
      client,
      principalAmount,
      expectedReturnAmount,
      paymentFrequency,
      durationDays,
      startDate: startDate ? new Date(startDate) : new Date()
    });

    // Automatically log the DISBURSEMENT transaction to keep ledger perfectly in sync
    await Transaction.create({
      type: 'DISBURSEMENT',
      amount: principalAmount,
      client: client,
      loan: loan._id,
      date: startDate ? new Date(startDate) : new Date(),
      notes: 'Initial Loan Disbursement'
    });

    res.status(201).json({ success: true, data: loan });
  } catch (error) {
    console.error('ADD LOAN ERROR:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((val) => val.message);
      return res.status(400).json({ success: false, error: messages });
    } else {
      return res.status(500).json({ success: false, error: 'Server Error', details: error.message });
    }
  }
};

module.exports = {
  getLoans,
  addLoan,
};
