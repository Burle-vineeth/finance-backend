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
    // Optional: a loan without a duration runs until it is repaid
    durationDays: {
      type: Number,
      min: [1, 'Duration must be at least 1 day'],
    },
    // The installment: set by hand (installmentIsCustom), or worked out as expectedReturnAmount / installments in the duration
    expectedDailyMonthlyPayment: {
      type: Number,
      required: true,
      min: [0.01, 'Installment must be greater than zero'],
    },
    installmentIsCustom: {
      type: Boolean,
      default: false,
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

  // Calculate expected payment based on frequency, unless the installment was set by hand
  if (!this.installmentIsCustom) {
    if (!this.durationDays) {
      this.invalidate('durationDays', 'Set an installment or a duration');
    } else if (this.isModified('expectedReturnAmount') || this.isModified('durationDays') || this.isModified('paymentFrequency')) {
      // The same count the payment schedule uses (at least 1, to avoid dividing by zero)
      const numberOfPayments = installmentCount(this.paymentFrequency, this.durationDays);
      this.expectedDailyMonthlyPayment = parseFloat((this.expectedReturnAmount / numberOfPayments).toFixed(2));
    }
  }
});

module.exports = mongoose.model('Loan', loanSchema);
