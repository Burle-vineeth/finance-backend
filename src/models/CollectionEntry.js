const mongoose = require('mongoose');

// A collection reported by a staff member. It changes nothing on its own: only when the admin approves it
// is the REPAYMENT recorded (and linked in `transaction`), through the same code as the admin's own entries.
const collectionEntrySchema = new mongoose.Schema(
  {
    loan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
      required: true,
    },
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
    },
    // What the staff member reported
    amount: {
      type: Number,
      required: [true, 'Please specify the amount collected'],
      min: [0.01, 'Amount must be greater than zero'],
    },
    date: {
      type: Date,
      required: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Note is too long'],
    },
    // PENDING until the admin approves or rejects it; CANCELLED when the staff member withdraws it;
    // REVERSED when the admin later undoes the approved repayment
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVERSED'],
      default: 'PENDING',
    },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Sent by the app with each submission, so resending after a dropped connection doesn't create a second entry
    requestId: {
      type: String,
      maxlength: 100,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: {
      type: Date,
    },
    // What was actually recorded; differs from amount/date when the admin corrected them before approving
    approvedAmount: {
      type: Number,
    },
    approvedDate: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Reason is too long'],
    },
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
    },
  },
  {
    timestamps: true,
  }
);

collectionEntrySchema.index({ status: 1, date: 1 });
collectionEntrySchema.index({ submittedBy: 1, createdAt: -1 });
collectionEntrySchema.index(
  { submittedBy: 1, requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } }
);

module.exports = mongoose.model('CollectionEntry', collectionEntrySchema);
