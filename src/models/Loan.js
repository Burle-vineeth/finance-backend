const mongoose = require('mongoose');
const { installmentCount } = require('../services/schedule');

const loanSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
    },
    // The core terms
    principalAmount: {
      type: Number,
      required: [true, 'Please specify the principal amount disbursed'],
    },
    expectedReturnAmount: {
      type: Number,
      required: [true, 'Please specify the total expected return amount'],
    },
    profitAmount: {
      type: Number,
      required: true, // Will be calculated before save: expectedReturnAmount - principalAmount
    },
    paymentFrequency: {
      type: String,
      enum: ['DAILY', 'WEEKLY', 'MONTHLY'],
      required: true,
    },
    durationDays: {
      type: Number,
      required: true, // E.g., 30 days
    },
    expectedDailyMonthlyPayment: {
      type: Number,
      required: true, // e.g., expectedReturnAmount / (durationDays / frequency)
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'CLOSED', 'DEFAULTED'],
      default: 'ACTIVE',
    },
    // Tracking Fields
    totalRepaid: {
      type: Number,
      default: 0,
    },
    pendingAmount: {
      type: Number,
      required: true, // Should default to expectedReturnAmount initially
    },
    principalRecovered: {
      type: Number,
      default: 0,
    },
    profitRealized: {
      type: Number,
      default: 0,
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    collectionStartDate: {
      type: Date,
    },
    resolvedAt: {
      type: Date,
    },
    // Corrections made after the loan was created: what changed, from what to what, when and by whom
    editHistory: [{
      _id: false,
      at: { type: Date, default: Date.now },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      byName: { type: String },
      changes: [{ _id: false, field: String, from: String, to: String }],
    }],
  },
  {
    timestamps: true,
  }
);

// Pre-save middleware to auto-calculate fields if they are new or modified
loanSchema.pre('validate', function() {
  if (this.isModified('principalAmount') || this.isModified('expectedReturnAmount')) {
    this.profitAmount = this.expectedReturnAmount - this.principalAmount;
    if (this.isNew) {
      this.pendingAmount = this.expectedReturnAmount;
    }
  }

  // Calculate expected payment based on frequency
  if (this.isModified('expectedReturnAmount') || this.isModified('durationDays') || this.isModified('paymentFrequency')) {
    // The same count the payment schedule uses (at least 1, to avoid dividing by zero)
    const numberOfPayments = installmentCount(this.paymentFrequency, this.durationDays);
    
    this.expectedDailyMonthlyPayment = parseFloat((this.expectedReturnAmount / numberOfPayments).toFixed(2));
  }
});

module.exports = mongoose.model('Loan', loanSchema);
