// A custom installment plan: a loan's installments listed one by one, each with its own date and amount
// ("10 installments, the first ₹5,000 on 5 Nov..."), in place of a duration and a fixed installment.
//
// A plan is good when it has
//   - 1 to 1,000 installments
//   - each on a real date, no earlier than the disbursement date and at most 10 years after it
//   - no two installments on the same day
//   - each amount more than zero, in rupees and paise (at most 2 decimal places)
//   - amounts adding up to exactly the expected return
// It is checked when it is set, for clear messages, and again by the Loan model before every save.
// Plans are kept in date order, with each date stored as UTC midnight of its day like other picked dates.
const { HttpError } = require('../utils/httpError');
const { dayKey, keyToDate } = require('./schedule');

const MAX_INSTALLMENTS = 1000;
const MAX_YEARS = 10;

const rupees = (amount) => `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const dateFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const longDate = (key) => dateFormatter.format(keyToDate(key));
// Amounts compared in whole paise, so 0.1 + 0.2 adds up to 0.3
const paise = (amount) => Math.round(amount * 100);

// A row's date as a day key: a 'YYYY-MM-DD' string from the app, or a stored Date; null when it isn't a real date
const dateKeyOf = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : dayKey(value);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = keyToDate(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
};

const amountOf = (value) => {
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return typeof value === 'number' ? value : NaN;
};

// What is wrong with a plan, as messages that name installments by their place in the list ("Installment 3"),
// or [] when it is good.
//   rows       [{ date: 'YYYY-MM-DD' | Date, amount }]
//   expected   the loan's expected return
//   startDate  the disbursement date
const planProblems = (rows, { expected, startDate }) => {
  if (!Array.isArray(rows)) return ['The installments must be a list'];
  if (!rows.length) return ['Add at least one installment'];
  if (rows.length > MAX_INSTALLMENTS) return [`A plan can have at most ${MAX_INSTALLMENTS.toLocaleString('en-IN')} installments`];

  const problems = [];
  const startKey = dayKey(startDate);
  const [y, m, d] = startKey.split('-').map(Number);
  const latestKey = new Date(Date.UTC(y + MAX_YEARS, m - 1, d)).toISOString().slice(0, 10);
  const firstOnDay = new Map();
  let amountsGood = true;
  let total = 0;

  rows.forEach((row, index) => {
    const label = `Installment ${index + 1}`;
    const key = dateKeyOf(row?.date);
    if (!row?.date) problems.push(`${label} needs a date`);
    else if (!key) problems.push(`${label}: pick a valid date`);
    else if (key < startKey) problems.push(`${label} (${longDate(key)}) is before the disbursement date, ${longDate(startKey)}`);
    else if (key > latestKey) problems.push(`${label} (${longDate(key)}) is more than ${MAX_YEARS} years after the disbursement`);
    else if (firstOnDay.has(key)) problems.push(`Installments ${firstOnDay.get(key) + 1} and ${index + 1} are both on ${longDate(key)}`);
    else firstOnDay.set(key, index);

    const amount = amountOf(row?.amount);
    if (!Number.isFinite(amount)) problems.push(`${label} needs an amount`);
    else if (amount <= 0) problems.push(`${label}: the amount must be more than zero`);
    else if (Math.abs(amount * 100 - paise(amount)) > 1e-6) problems.push(`${label}: the amount can't go below a paisa (2 decimal places)`);
    if (Number.isFinite(amount) && amount > 0) total += paise(amount); else amountsGood = false;
  });

  if (amountsGood && Number.isFinite(expected) && total !== paise(expected)) {
    const gap = Math.abs(total - paise(expected)) / 100;
    problems.push(`The installments add up to ${rupees(total / 100)}, but the expected return is ${rupees(expected)} `
      + `(${rupees(gap)} ${total < paise(expected) ? 'short' : 'over'})`);
  }
  return problems;
};

// A plan from the app, checked and in date order, ready to store as [{ date: Date, amount }].
// Throws an HttpError naming the first problem.
const parseCustomInstallments = (rows, context) => {
  const problems = planProblems(rows, context);
  if (problems.length) {
    const more = problems.length - 1;
    throw new HttpError(400, more ? `${problems[0]} (and ${more} more ${more === 1 ? 'problem' : 'problems'})` : problems[0]);
  }
  return rows
    .map((row) => ({ date: keyToDate(dateKeyOf(row.date)), amount: paise(amountOf(row.amount)) / 100 }))
    .sort((a, b) => a.date - b.date);
};

// The same installments on the same days?
const samePlan = (a, b) => {
  const rowsOf = (rows) => (rows || []).map((row) => `${dateKeyOf(row.date)}=${paise(amountOf(row.amount))}`).sort().join(',');
  return rowsOf(a) === rowsOf(b);
};

// "10 installments of ₹1,200, 5 Nov 2026 to 5 Aug 2027" (or "₹500 to ₹2,000" when the amounts differ)
const planSummary = (rows) => {
  const keys = rows.map((row) => dateKeyOf(row.date)).sort();
  const amounts = rows.map((row) => amountOf(row.amount));
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  const count = rows.length === 1 ? '1 installment' : `${rows.length} installments`;
  const each = low === high ? `of ${rupees(low)}` : `of ${rupees(low)} to ${rupees(high)}`;
  const when = keys.length === 1 ? `on ${longDate(keys[0])}` : `${longDate(keys[0])} to ${longDate(keys[keys.length - 1])}`;
  return `${count} ${each}, ${when}`;
};

module.exports = {
  MAX_INSTALLMENTS,
  planProblems,
  parseCustomInstallments,
  samePlan,
  planSummary,
};
