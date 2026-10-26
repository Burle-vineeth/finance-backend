const mongoose = require('mongoose');
const { installmentCount, feesTotal } = require('../services/schedule');
const { planProblems } = require('../services/customInstallments');

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
    // A custom installment plan: each installment's date and amount, set one by one (see services/customInstallments).
    // With one, the plan is the schedule: the loan has no duration or collection start date, and the installment
    // above is just the plan's average. Left unset (not an empty list) for loans without one.
    customInstallments: {
      type: [{ _id: false, date: { type: Date, required: true }, amount: { type: Number, required: true } }],
      default: undefined,
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
    // Late fees charged on the loan. Each falls due on its date alongside the installments and adds to what the
    // client owes (see services/schedule); once paid it is profit. Left unset for loans without any.
    lateFees: {
      type: [{
        amount: { type: Number, required: true, min: [0.01, 'A late fee must be more than zero'] },
        date: { type: Date, required: true },
        note: { type: String, trim: true, maxlength: [200, 'A note can be at most 200 characters'] },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byName: { type: String },
      }],
      default: undefined,
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
  if (this.isModified('principalAmount') || this.isModified('expectedReturnAmount') || this.isModified('lateFees')) {
    // Late fees are profit too
    this.profitAmount = this.expectedReturnAmount - this.principalAmount + feesTotal(this);
    if (this.isNew) {
      this.pendingAmount = this.expectedReturnAmount;
    }
  }

  if (this.customInstallments?.length) {
    // The plan must stay good: its dates on or after the disbursement date, its amounts adding up to the expected return
    const problems = planProblems(this.customInstallments, { expected: this.expectedReturnAmount, startDate: this.startDate });
    if (problems.length) this.invalidate('customInstallments', problems[0]);
    if (this.durationDays) this.invalidate('durationDays', 'A loan on a custom installment plan has no duration');
    if (this.collectionStartDate) this.invalidate('collectionStartDate', 'A loan on a custom installment plan has no collection start date');
    if (this.isModified('customInstallments')) {
      this.installmentIsCustom = true;
      this.expectedDailyMonthlyPayment = parseFloat((this.expectedReturnAmount / this.customInstallments.length).toFixed(2));
    }
  } else if (!this.installmentIsCustom) {
    // Calculate expected payment based on frequency, unless the installment was set by hand
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
