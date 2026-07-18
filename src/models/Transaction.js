const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['DISBURSEMENT', 'REPAYMENT', 'CAPITAL_INJECTION', 'CAPITAL_WITHDRAWAL'],
      required: true,
    },
    amount: {
      type: Number,
      required: [true, 'Please specify the transaction amount'],
    },
    date: {
      type: Date,
      default: Date.now,
    },
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      // Required for Disbursement and Repayment
    },
    loan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
      // Required for Disbursement and Repayment
    },
    // The "Smart Split" tracking for Repayments
    principalPortion: {
      type: Number,
      default: 0,
    },
    profitPortion: {
      type: Number,
      default: 0,
    },
    notes: {
      type: String,
    }
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Transaction', transactionSchema);
