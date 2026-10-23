const mongoose = require('mongoose');
const CollectionEntry = require('../models/CollectionEntry');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { applyRepayment, repaidOnDayByLoan } = require('../services/repayments');
const { loanSchedule, todayKey, dayKey } = require('../services/schedule');
const { withTransaction } = require('../utils/withTransaction');
const { HttpError, sendError } = require('../utils/httpError');

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVERSED'];
const DAY_MS = 24 * 60 * 60 * 1000;

// Same India day (see services/schedule)
const sameDay = (a, b) => dayKey(a) === dayKey(b);

const parseAmount = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, 'Amount must be a number greater than zero');
  }
  return Math.round(value * 100) / 100;
};

// Collections can't be dated in the future; a day of slack covers time zones
const parseDate = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new HttpError(400, 'A valid date is required');
  if (date.getTime() > Date.now() + DAY_MS) throw new HttpError(400, 'The date can\'t be in the future');
  return date;
};

const requireId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Entry not found');
};

const groupBy = (items, keyOf) => {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return groups;
};

// Flags pending entries the admin should look at before approving
const addWarnings = async (entries) => {
  const pending = entries.filter((e) => e.status === 'PENDING');
  if (!pending.length) return;

  const loanIds = [...new Set(pending.map((e) => String(e.loan?._id || e.loan)))];
  const times = pending.map((e) => new Date(e.date).getTime());
  const repayments = await Transaction.find({
    type: 'REPAYMENT',
    loan: { $in: loanIds },
    date: { $gte: new Date(Math.min(...times) - DAY_MS), $lte: new Date(Math.max(...times) + DAY_MS) },
  }).select('loan date').lean();

  for (const entry of pending) {
    const loanId = String(entry.loan?._id || entry.loan);
    const warnings = [];
    if (!entry.loan || entry.loan.status !== 'ACTIVE') {
      warnings.push('LOAN_NOT_ACTIVE');
    } else if (entry.amount > entry.loan.pendingAmount) {
      warnings.push('MORE_THAN_OWED');
    }
    if (pending.some((other) => other !== entry && String(other.loan?._id || other.loan) === loanId && sameDay(other.date, entry.date))) {
      warnings.push('DUPLICATE_ENTRY');
    }
    if (repayments.some((t) => String(t.loan) === loanId && sameDay(t.date, entry.date))) {
      warnings.push('ALREADY_PAID_THAT_DAY');
    }
    entry.warnings = warnings;
  }
};

// @desc    Active loans to collect from, with only what collecting needs (no profit or capital figures)
// @route   GET /api/collections/loans
// @access  Staff and admin
const getCollectableLoans = async (req, res) => {
  try {
    const loans = await Loan.find({ status: 'ACTIVE' })
      .select('client paymentFrequency durationDays expectedReturnAmount expectedDailyMonthlyPayment installmentIsCustom customInstallments totalRepaid pendingAmount startDate collectionStartDate')
      .populate('client', 'name phone address')
      .lean();
    const loanIds = loans.map((loan) => loan._id);
    const today = todayKey();

    const [paidToday, pendingEntries] = await Promise.all([
      repaidOnDayByLoan(today, loanIds),
      CollectionEntry.find({ loan: { $in: loanIds }, status: 'PENDING' }).select('loan amount date').lean(),
    ]);
    const pendingByLoan = groupBy(pendingEntries, (e) => String(e.loan));

    const data = loans
      .map((loan) => {
        const id = String(loan._id);
        const pending = pendingByLoan.get(id) || [];
        const schedule = loanSchedule(loan, { today, paidToday: paidToday.get(id) || 0 });
        return {
          _id: loan._id,
          client: loan.client
            ? { name: loan.client.name, phone: loan.client.phone, address: loan.client.address }
            : null,
          paymentFrequency: loan.paymentFrequency,
          // The installment to expect (on a custom plan, the next unpaid one, as plan amounts can differ)
          installment: schedule.installment,
          pendingAmount: loan.pendingAmount,
          // Where the loan stands against its installments: due today, overdue, paid ahead...
          schedule,
          // Entries for this loan still waiting for the admin
          awaitingApproval: {
            count: pending.length,
            amount: pending.reduce((sum, e) => sum + e.amount, 0),
            today: pending.some((e) => dayKey(e.date) === today),
          },
        };
      })
      .sort((a, b) => (a.client?.name || '').localeCompare(b.client?.name || ''));

    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'Collectable Loans Error:');
  }
};

// @desc    Report a collection. It waits for the admin's approval before it counts anywhere.
// @route   POST /api/collections
// @access  Staff
const submitCollection = async (req, res) => {
  try {
    const { loan: loanId, notes, requestId } = req.body || {};
    const amount = parseAmount(req.body?.amount);
    const date = parseDate(req.body?.date);
    if (!mongoose.isValidObjectId(loanId)) throw new HttpError(400, 'Choose a loan');
    if (notes !== undefined && typeof notes !== 'string') throw new HttpError(400, 'Note must be text');
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 100)) {
      throw new HttpError(400, 'Invalid request id');
    }

    // The same submission sent again (e.g. after a dropped connection) returns the entry it already created
    const findResent = () => (requestId ? CollectionEntry.findOne({ submittedBy: req.user.id, requestId }) : null);
    const resent = await findResent();
    if (resent) return res.status(200).json({ success: true, data: resent });

    const loan = await Loan.findById(loanId).select('client status').lean();
    if (!loan) throw new HttpError(404, 'Loan not found');
    if (loan.status !== 'ACTIVE') throw new HttpError(409, 'This loan is no longer active');

    try {
      const entry = await CollectionEntry.create({
        loan: loanId,
        client: loan.client,
        amount,
        date,
        notes: notes?.trim() || undefined,
        submittedBy: req.user.id,
        requestId,
      });
      res.status(201).json({ success: true, data: entry });
    } catch (error) {
      // Two copies of the same submission arrived at once; the other one was saved
      if (error.code === 11000 && requestId) {
        return res.status(200).json({ success: true, data: await findResent() });
      }
      throw error;
    }
  } catch (error) {
    sendError(res, error, 'Submit Collection Error:');
  }
};

// @desc    Collection entries, newest first: staff see their own, the admin sees everyone's.
//          ?status=PENDING lists the queue oldest first, and for the admin adds warnings.
// @route   GET /api/collections
// @access  Staff and admin
const listCollections = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (req.user.role === 'STAFF') filter.submittedBy = req.user.id;
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
      filter.status = status;
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);

    const entries = await CollectionEntry.find(filter)
      .populate('client', 'name')
      .populate('loan', 'status pendingAmount expectedDailyMonthlyPayment paymentFrequency customInstallments')
      .populate('submittedBy', 'name')
      .populate('reviewedBy', 'name')
      .sort(status === 'PENDING' ? { date: 1, createdAt: 1 } : { createdAt: -1 })
      .limit(limit)
      .lean();

    if (req.user.role === 'ADMIN' && status === 'PENDING') await addWarnings(entries);
    // Whether the loan is on a custom installment plan is enough here; the plan itself stays on the loan
    // (a copy per entry: entries for the same loan can share one populated object)
    for (const entry of entries) {
      if (!entry.loan) continue;
      const { customInstallments, ...loan } = entry.loan;
      entry.loan = { ...loan, customPlan: Boolean(customInstallments?.length) };
    }
    res.json({ success: true, data: entries });
  } catch (error) {
    sendError(res, error, 'List Collections Error:');
  }
};

// @desc    How many collections are waiting for approval, and their total
// @route   GET /api/collections/summary
// @access  Admin
const getSummary = async (req, res) => {
  try {
    const [summary] = await CollectionEntry.aggregate([
      { $match: { status: 'PENDING' } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]);
    res.json({ success: true, data: { pendingCount: summary?.count || 0, pendingAmount: summary?.amount || 0 } });
  } catch (error) {
    sendError(res, error, 'Collections Summary Error:');
  }
};

// @desc    Withdraw your own entry while it is still waiting for approval
// @route   POST /api/collections/:id/cancel
// @access  Staff
const cancelCollection = async (req, res) => {
  try {
    requireId(req.params.id);
    const entry = await CollectionEntry.findOneAndUpdate(
      { _id: req.params.id, submittedBy: req.user.id, status: 'PENDING' },
      { $set: { status: 'CANCELLED' } },
      { new: true }
    );
    if (!entry) {
      const own = await CollectionEntry.exists({ _id: req.params.id, submittedBy: req.user.id });
      throw own
        ? new HttpError(409, 'Only entries still waiting for approval can be withdrawn')
        : new HttpError(404, 'Entry not found');
    }
    res.json({ success: true, data: entry });
  } catch (error) {
    sendError(res, error, 'Cancel Collection Error:');
  }
};

// @desc    Approve a collection: record the repayment, optionally with a corrected amount or date.
//          Claiming the entry, updating the loan and adding the ledger entry happen in one transaction,
//          so approving twice (double tap, two devices) records it once, and a failure records nothing.
// @route   POST /api/collections/:id/approve
// @access  Admin
const approveCollection = async (req, res) => {
  try {
    requireId(req.params.id);
    const correctedAmount = req.body?.amount !== undefined ? parseAmount(req.body.amount) : undefined;
    const correctedDate = req.body?.date !== undefined ? parseDate(req.body.date) : undefined;

    const entry = await withTransaction(async (session) => {
      const claimed = await CollectionEntry.findOneAndUpdate(
        { _id: req.params.id, status: 'PENDING' },
        { $set: { status: 'APPROVED', reviewedBy: req.user.id, reviewedAt: new Date() } },
        { new: true, session }
      );
      if (!claimed) {
        const exists = await CollectionEntry.exists({ _id: req.params.id }).session(session);
        throw exists ? new HttpError(409, 'This entry has already been reviewed') : new HttpError(404, 'Entry not found');
      }

      claimed.approvedAmount = correctedAmount ?? claimed.amount;
      claimed.approvedDate = correctedDate ?? claimed.date;

      const collector = await User.findById(claimed.submittedBy).select('name').session(session).lean();
      const transaction = await applyRepayment({
        loanId: claimed.loan,
        amount: claimed.approvedAmount,
        date: claimed.approvedDate,
        client: claimed.client,
        notes: [`Collected by ${collector?.name || 'staff'}`, claimed.notes].filter(Boolean).join(' · '),
        requireActive: true,
        extra: { collectedBy: claimed.submittedBy, collectionEntry: claimed._id },
      }, session);

      claimed.transaction = transaction._id;
      await claimed.save({ session });
      return claimed;
    });

    res.json({ success: true, data: entry });
  } catch (error) {
    sendError(res, error, 'Approve Collection Error:');
  }
};

// @desc    Reject a collection, with the reason the staff member will see
// @route   POST /api/collections/:id/reject
// @access  Admin
const rejectCollection = async (req, res) => {
  try {
    requireId(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) throw new HttpError(400, 'Please give a reason');
    if (reason.length > 300) throw new HttpError(400, 'Reason is too long');

    const entry = await CollectionEntry.findOneAndUpdate(
      { _id: req.params.id, status: 'PENDING' },
      { $set: { status: 'REJECTED', reviewedBy: req.user.id, reviewedAt: new Date(), rejectionReason: reason } },
      { new: true }
    );
    if (!entry) {
      const exists = await CollectionEntry.exists({ _id: req.params.id });
      throw exists ? new HttpError(409, 'This entry has already been reviewed') : new HttpError(404, 'Entry not found');
    }
    res.json({ success: true, data: entry });
  } catch (error) {
    sendError(res, error, 'Reject Collection Error:');
  }
};

module.exports = {
  getCollectableLoans,
  submitCollection,
  listCollections,
  getSummary,
  cancelCollection,
  approveCollection,
  rejectCollection,
};
