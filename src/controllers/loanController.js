const mongoose = require('mongoose');
const Loan = require('../models/Loan');
const Client = require('../models/Client');
const Transaction = require('../models/Transaction');
const CollectionEntry = require('../models/CollectionEntry');
const { loanSchedule, todayKey, dayKey, installmentCount } = require('../services/schedule');
const { parseCustomInstallments, planProblems, samePlan, planSummary } = require('../services/customInstallments');
const { repaidOnDayByLoan } = require('../services/repayments');
const { withTransaction } = require('../utils/withTransaction');
const { HttpError, sendError } = require('../utils/httpError');

const PERIOD_NAMES = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month' };
const rupees = (amount) => `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const isBlank = (value) => value === undefined || value === null || value === '';

// A hand-set installment can't be more than the expected return, and with a duration it must repay the
// expected return within it. Throws an HttpError saying what would work.
const checkInstallment = (amount, { expected, days, frequency }) => {
  if (amount > expected) throw new HttpError(400, 'The installment can\'t be more than the expected return');
  if (days) {
    const count = installmentCount(frequency, days);
    if (amount * count < expected - 0.005) {
      const needed = Math.ceil((expected / count) * 100) / 100;
      const period = PERIOD_NAMES[frequency] || 'installment';
      throw new HttpError(400, `${rupees(amount)} per ${period} for ${days} days collects only ${rupees(amount * count)} of ${rupees(expected)}. `
        + `Raise the installment to at least ${rupees(needed)}, or lengthen the duration.`);
    }
  }
};

// The installment of a new loan: set by hand, or (left out) worked out from the duration, which is then needed.
// With both, the installment must repay the expected return within the duration.
// Returns the fields to store, or throws an HttpError.
const installmentTerms = ({ installment, durationDays, expectedReturnAmount, paymentFrequency }) => {
  const hasInstallment = !isBlank(installment);
  const hasDuration = !isBlank(durationDays);
  if (!hasInstallment && !hasDuration) throw new HttpError(400, 'Set an installment or a duration');

  const amount = hasInstallment ? Number(installment) : undefined;
  const days = hasDuration ? Number(durationDays) : undefined;
  if (hasInstallment && !(Number.isFinite(amount) && amount > 0)) throw new HttpError(400, 'Installment must be a number greater than zero');
  if (hasDuration && !(Number.isInteger(days) && days >= 1)) throw new HttpError(400, 'Duration must be a whole number of days, at least 1');

  const expected = Number(expectedReturnAmount);
  if (hasInstallment && Number.isFinite(expected)) checkInstallment(amount, { expected, days, frequency: paymentFrequency });

  return {
    durationDays: days,
    ...(hasInstallment ? { expectedDailyMonthlyPayment: Math.round(amount * 100) / 100, installmentIsCustom: true } : {}),
  };
};

// A loan on a custom installment plan takes its dates and amounts from the plan, so it can't also have these
const NOT_WITH_A_PLAN = 'A loan on a custom installment plan has no duration, fixed installment or collection start date: '
  + 'the plan sets its dates and amounts';

// The repayment terms of a new loan: a custom installment plan, or an installment and/or a duration (see installmentTerms)
const loanTerms = (body) => {
  const { customInstallments, installment, durationDays, collectionStartDate, expectedReturnAmount, paymentFrequency, startDate } = body;
  if (customInstallments === undefined || customInstallments === null) {
    return { ...installmentTerms({ installment, durationDays, expectedReturnAmount, paymentFrequency }), collectionStartDate };
  }
  if (!isBlank(installment) || !isBlank(durationDays) || !isBlank(collectionStartDate)) throw new HttpError(400, NOT_WITH_A_PLAN);
  const expected = Number(expectedReturnAmount);
  if (!(Number.isFinite(expected) && expected > 0)) throw new HttpError(400, 'Enter the expected return before the installments');
  return { customInstallments: parseCustomInstallments(customInstallments, { expected, startDate: startDate ? new Date(startDate) : new Date() }) };
};

// How a loan repays, for its edit history: "10 installments of ₹1,200, ..." or "₹600 per day for 100 days"
const termsText = ({ customInstallments, expectedDailyMonthlyPayment, durationDays, paymentFrequency }) => {
  if (customInstallments?.length) return planSummary(customInstallments);
  const per = `${rupees(expectedDailyMonthlyPayment)} per ${PERIOD_NAMES[paymentFrequency] || 'installment'}`;
  return durationDays ? `${per} for ${durationDays} days` : `${per}, until repaid`;
};

// The details of a loan that can be corrected after it is created; its amounts can't
const EDITABLE_FIELDS = ['client', 'startDate', 'collectionStartDate', 'durationDays', 'installment', 'customInstallments'];

// A picked day, 'YYYY-MM-DD', stored as UTC midnight of that day like the dates of new loans
const parseDay = (value, label) => {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${label} must be a valid date`);
  }
  return date;
};

// @desc    Get all loans
// @route   GET /api/loans
// @access  Public
const getLoans = async (req, res) => {
  try {
    const loans = await Loan.find().populate('client').sort({ createdAt: -1 }).lean();
    const today = todayKey();
    const active = loans.filter((loan) => loan.status === 'ACTIVE');
    const paidToday = await repaidOnDayByLoan(today, active.map((loan) => loan._id));
    // Where each active loan stands against its installment schedule
    const data = loans.map((loan) => (loan.status === 'ACTIVE'
      ? { ...loan, schedule: loanSchedule(loan, { today, paidToday: paidToday.get(String(loan._id)) || 0 }) }
      : loan));
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Originate a new loan
// @route   POST /api/loans
// @access  Public
const addLoan = async (req, res) => {
  try {
    const { client, principalAmount, expectedReturnAmount, paymentFrequency, startDate } = req.body;
    const { collectionStartDate, ...terms } = loanTerms(req.body);

    // Calculate cash on hand
    const cashStats = await Transaction.aggregate([
      {
        $group: {
          _id: null,
          totalCapitalInjected: { $sum: { $cond: [{ $eq: ['$type', 'CAPITAL_INJECTION'] }, '$amount', 0] } },
          totalCapitalWithdrawn: { $sum: { $cond: [{ $eq: ['$type', 'CAPITAL_WITHDRAWAL'] }, '$amount', 0] } },
          totalDisbursed: { $sum: { $cond: [{ $eq: ['$type', 'DISBURSEMENT'] }, '$amount', 0] } },
          totalRepaid: { $sum: { $cond: [{ $eq: ['$type', 'REPAYMENT'] }, '$amount', 0] } },
          totalExpenses: { $sum: { $cond: [{ $eq: ['$type', 'BUSINESS_EXPENSE'] }, '$amount', 0] } },
        }
      }
    ]);

    let cashOnHand = 0;
    if (cashStats.length > 0) {
      const stats = cashStats[0];
      const totalCapital = stats.totalCapitalInjected - stats.totalCapitalWithdrawn;
      cashOnHand = totalCapital - stats.totalDisbursed + stats.totalRepaid - stats.totalExpenses;
    }

    if (principalAmount > cashOnHand) {
      return res.status(400).json({ success: false, error: ['Insufficient cash on hand to disburse this loan'] });
    }

    // Create the loan
    const loan = await Loan.create({
      client,
      principalAmount,
      expectedReturnAmount,
      paymentFrequency,
      ...terms,
      startDate: startDate ? new Date(startDate) : new Date(),
      collectionStartDate: collectionStartDate ? new Date(collectionStartDate) : undefined
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
    if (error instanceof HttpError) {
      return res.status(error.status).json({ success: false, error: [error.message] });
    }
    console.error('ADD LOAN ERROR:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((val) => val.message);
      return res.status(400).json({ success: false, error: messages });
    } else {
      return res.status(500).json({ success: false, error: 'Server Error', details: error.message });
    }
  }
};

// @desc    Correct a loan's client, disbursement date, collection start date, tenure, installment or custom installment
//          plan (customInstallments: a list to set or replace it, null to go back to a tenure and installment). The loan's own records
//          move with it (its disbursement entry, and the repayments and staff entries naming the old client),
//          all in one transaction, and the change is added to the loan's edit history.
//          With dryRun: true nothing is saved; the response shows the changes and the schedule before and after.
// @route   PATCH /api/loans/:id
// @access  Admin
const updateLoanDetails = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Loan not found');
    const body = req.body || {};
    const notEditable = Object.keys(body).filter((key) => !EDITABLE_FIELDS.includes(key) && key !== 'dryRun');
    if (notEditable.length) {
      throw new HttpError(400, `Only the client, disbursement date, collection start date, tenure, installment and installment plan can be changed (not ${notEditable.join(', ')})`);
    }

    const result = await withTransaction(async (session) => {
      const loan = await Loan.findById(req.params.id).populate('client', 'name').session(session);
      if (!loan) throw new HttpError(404, 'Loan not found');
      const changes = [];

      const oldClient = loan.client;
      let newClient = null;
      if (body.client !== undefined && String(body.client) !== String(oldClient?._id)) {
        if (!mongoose.isValidObjectId(body.client)) throw new HttpError(400, 'Choose a client');
        newClient = await Client.findById(body.client).select('name').session(session);
        if (!newClient) throw new HttpError(404, 'Client not found');
        changes.push({ field: 'client', from: oldClient?.name || '', to: newClient.name });
      }

      let newStart = null;
      if (body.startDate !== undefined) {
        const date = parseDay(body.startDate, 'Disbursement date');
        if (dayKey(date) !== dayKey(loan.startDate)) {
          newStart = date;
          changes.push({ field: 'startDate', from: dayKey(loan.startDate), to: dayKey(date) });
        }
      }

      // undefined: unchanged; null: no collection start date any more
      let newCollection;
      if (body.collectionStartDate !== undefined) {
        const date = body.collectionStartDate === null || body.collectionStartDate === ''
          ? null
          : parseDay(body.collectionStartDate, 'Collection start date');
        const from = loan.collectionStartDate ? dayKey(loan.collectionStartDate) : '';
        const to = date ? dayKey(date) : '';
        if (from !== to) {
          newCollection = date;
          changes.push({ field: 'collectionStartDate', from, to });
        }
      }

      const start = newStart || loan.startDate;
      const expected = loan.expectedReturnAmount;

      // The custom installment plan after the edit, or null for none. Its dates must stay on or after the disbursement date.
      const hadPlan = Boolean(loan.customInstallments?.length);
      let plan = hadPlan ? loan.customInstallments.map((row) => ({ date: row.date, amount: row.amount })) : null;
      if (body.customInstallments !== undefined) {
        plan = body.customInstallments === null ? null : parseCustomInstallments(body.customInstallments, { expected, startDate: start });
      } else if (plan && newStart) {
        const [problem] = planProblems(plan, { expected, startDate: start });
        if (problem) throw new HttpError(400, `${problem}. Move that installment, or change the plan along with the date`);
      }
      if (plan && (!isBlank(body.durationDays) || !isBlank(body.installment))) throw new HttpError(400, NOT_WITH_A_PLAN);
      if (plan && newCollection) throw new HttpError(400, NOT_WITH_A_PLAN);
      // Moving to a plan drops the collection start date: the plan's first installment is when collection starts
      if (plan && loan.collectionStartDate && newCollection === undefined) {
        newCollection = null;
        changes.push({ field: 'collectionStartDate', from: dayKey(loan.collectionStartDate), to: '' });
      }

      const collection = newCollection === undefined ? loan.collectionStartDate : newCollection;
      if (collection && dayKey(collection) < dayKey(start)) {
        throw new HttpError(400, 'Collection can\'t start before the loan is disbursed');
      }

      // Tenure and installment, worked out together. Tenure: a number of days, or blank for "until repaid".
      // Installment: an amount sets it by hand; blank works it out from the tenure. Without an installment in the
      // request, a worked-out one follows the new tenure and a hand-set one stays (it must still fit the tenure).
      // Leaving a plan, they come from the request alone: a hand-set installment, or one worked out from the tenure.
      let days = plan || hadPlan ? undefined : loan.durationDays || undefined;
      if (body.durationDays !== undefined) {
        if (isBlank(body.durationDays)) {
          days = undefined;
        } else {
          days = Number(body.durationDays);
          if (!(Number.isInteger(days) && days >= 1)) throw new HttpError(400, 'Duration must be a whole number of days, at least 1');
        }
      }
      let amount = loan.expectedDailyMonthlyPayment;
      let custom = Boolean(loan.installmentIsCustom);
      const fromTenure = () => {
        if (!days) throw new HttpError(400, hadPlan ? 'Without the installment plan, set a duration, an installment or both' : 'A loan without a duration needs an installment');
        return Math.round((expected / installmentCount(loan.paymentFrequency, days)) * 100) / 100;
      };
      if (plan) {
        // The plan sets the dates and amounts; the installment is its average (see the Loan model)
        amount = Math.round((expected / plan.length) * 100) / 100;
        custom = true;
      } else if (hadPlan && isBlank(body.installment)) {
        amount = fromTenure();
        custom = false;
      } else if (body.installment !== undefined && isBlank(body.installment)) {
        amount = fromTenure();
        custom = false;
      } else if (body.installment !== undefined) {
        amount = Number(body.installment);
        if (!(Number.isFinite(amount) && amount > 0)) throw new HttpError(400, 'Installment must be a number greater than zero');
        amount = Math.round(amount * 100) / 100;
        custom = true;
      } else if (!custom) {
        // A worked-out installment follows the tenure; with no tenure left it stays as it is, now set by hand
        if (days) amount = fromTenure(); else custom = true;
      }
      if (custom && !plan) checkInstallment(amount, { expected, days, frequency: loan.paymentFrequency });

      const tenureChanged = (days || null) !== (loan.durationDays || null);
      const installmentChanged = Math.abs(amount - loan.expectedDailyMonthlyPayment) >= 0.005;
      const planChanged = Boolean(plan) !== hadPlan || (plan && !samePlan(plan, loan.customInstallments));
      if (plan || hadPlan) {
        // Onto, off or within a plan: one entry for how the loan repays, before and after
        if (planChanged) {
          const after = { customInstallments: plan, expectedDailyMonthlyPayment: amount, durationDays: days, paymentFrequency: loan.paymentFrequency };
          const from = termsText(loan);
          let to = termsText(after);
          // Moved or reshuffled installments can read the same in summary
          if (from === to) to += ' (dates or amounts changed)';
          if (!plan) to += custom ? '' : ' (from the duration)';
          changes.push({ field: 'customInstallments', from, to });
        }
      } else {
        const tenureText = (value) => (value ? `${value} days` : 'until repaid');
        if (tenureChanged) changes.push({ field: 'durationDays', from: tenureText(loan.durationDays), to: tenureText(days) });
        if (installmentChanged) {
          changes.push({
            field: 'installment',
            from: rupees(loan.expectedDailyMonthlyPayment),
            to: custom ? rupees(amount) : `${rupees(amount)} (from the duration)`,
          });
        }
      }
      const termsChanged = planChanged || tenureChanged || installmentChanged || custom !== Boolean(loan.installmentIsCustom);
      const installmentFields = termsChanged
        ? { customInstallments: plan || undefined, durationDays: days, expectedDailyMonthlyPayment: amount, installmentIsCustom: custom }
        : {};

      // The schedule before and after, for the review step in the app
      const today = todayKey();
      const paidToday = (await repaidOnDayByLoan(today, [loan._id], session)).get(String(loan._id)) || 0;
      const current = loan.toObject();
      const preview = {
        changes,
        schedule: loan.status === 'ACTIVE'
          ? {
            before: loanSchedule(current, { today, paidToday }),
            after: loanSchedule({ ...current, startDate: start, collectionStartDate: collection || undefined, ...installmentFields }, { today, paidToday }),
          }
          : null,
      };
      if (body.dryRun || !changes.length) return { ...preview, saved: false };

      if (newClient) {
        loan.client = newClient._id;
        // Records that name the old client move to the new one; repayments entered without a client stay that way
        const named = oldClient ? { client: oldClient._id } : { client: { $ne: null } };
        await Transaction.updateMany({ loan: loan._id, ...named }, { $set: { client: newClient._id } }, { session });
        await CollectionEntry.updateMany({ loan: loan._id }, { $set: { client: newClient._id } }, { session });
      }
      if (newStart) {
        loan.startDate = newStart;
        await Transaction.updateMany({ loan: loan._id, type: 'DISBURSEMENT' }, { $set: { date: newStart } }, { session });
      }
      if (newCollection !== undefined) loan.collectionStartDate = newCollection || undefined;
      if (termsChanged) Object.assign(loan, installmentFields);
      loan.editHistory.push({ at: new Date(), by: req.user.id, byName: req.user.name, changes });
      await loan.save({ session });
      return { ...preview, saved: true };
    });

    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, error, 'Update Loan Error:');
  }
};

module.exports = {
  getLoans,
  addLoan,
  updateLoanDetails,
};
