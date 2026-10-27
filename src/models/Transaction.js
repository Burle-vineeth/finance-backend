const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      // CASH_TRANSFER moves cash between the admin's hand and the staff's, without changing the business's total
      enum: ['DISBURSEMENT', 'REPAYMENT', 'CAPITAL_INJECTION', 'CAPITAL_WITHDRAWAL', 'BUSINESS_EXPENSE', 'CASH_TRANSFER'],
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
    },
    // Whose hand the cash is in. A repayment: where the money went when it was paid, the admin's or the staff's
    // (as one pool, no one named). A cash transfer: where the money moved to (ADMIN: received from staff;
    // STAFF: moved to staff). Left out on older entries, which count as the admin's. See services/cash.
    cashWith: {
      type: String,
      enum: ['ADMIN', 'STAFF'],
    },
    // Set when the repayment came from a staff collection that the admin approved
    collectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    collectionEntry: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CollectionEntry',
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Transaction', transactionSchema);
