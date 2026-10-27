// The business score: how the business did over a range of days, out of 100, and why.
//
// Five parts, each scored 0-100 and weighted. Each gives partial points: they fall evenly from full marks at the
// part's best to none at its worst, so a part is only zero when things are as bad as they can be.
//   collections    30  payments due in the range (installments and late fees) made within a week of falling due:
//                      100% full marks, 0% none
//   overdue risk   25  money overdue on the last day, as a share of the money lent out then: none overdue full
//                      marks, 50% or more none
//   earnings       20  the yearly rate the lent money earned in the range, after expenses: 45% or more full marks,
//                      0% or less none
//   money at work  15  how much of the money in the business was lent out rather than sitting as cash: 90% or more
//                      full marks, nothing lent none
//   spread of risk 10  how much of the money lent sits with the biggest borrower on the last day: 25% or less full
//                      marks, everything with one borrower none
// A part with nothing to measure (nothing fell due, nothing lent) is left out and the rest scaled to 100.
//
// A range running past today is measured up to today. Past days are worked out from the loans' current
// terms and the ledger's dates, so a loan edited later counts with its new schedule.
const { dueTimelineOf, feesTotal, interestRates, dayKey, addDays, daysBetween } = require('./schedule');

const TARGET_YEARLY_RATE = 45;
const GRACE_DAYS = 7;
const EPSILON = 0.005;

const PARTS = [
  { key: 'collections', name: 'Collections', weight: 30 },
  { key: 'overdue', name: 'Overdue risk', weight: 25 },
  { key: 'earnings', name: 'Earnings', weight: 20 },
  { key: 'moneyAtWork', name: 'Money at work', weight: 15 },
  { key: 'spread', name: 'Spread of risk', weight: 10 },
];

// A part scoring this or more is listed under what's helping; below it, under what's hurting. 80 is 80% paid within
// a week, 10% overdue, 36% a year earned, 72% lent out, or 40% with one borrower. Each reason is a sentence, with
// the loans behind it as details.
const HELPING_FROM = 80;
const reason = (text, details = []) => ({ text, details: details.filter(Boolean) });

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const round1 = (value) => Math.round(value * 10) / 10;
const rupees = (amount) => `₹${Math.round(amount).toLocaleString('en-IN')}`;
const percent = (share) => `${Math.round(share * 100)}%`;
const dateFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const shortDay = (key) => dateFormatter.format(new Date(`${key}T00:00:00Z`));

const labelFor = (total) => (total >= 80 ? 'Strong' : total >= 60 ? 'Good' : total >= 40 ? 'Needs attention' : 'At risk');

// The ledger arranged per loan and per day, for "how much by this day" questions
const ledgerOf = (loans, transactions) => {
  const repaymentsByLoan = new Map(loans.map((loan) => [String(loan._id), []]));
  // Money in (+) and out (-) of the business's cash, and principal lent (+) and recovered (-), by day
  const cashByDay = new Map();
  const lentByDay = new Map();
  const add = (map, day, amount) => map.set(day, (map.get(day) || 0) + amount);

  for (const t of transactions) {
    const day = dayKey(t.date);
    if (t.type === 'CAPITAL_INJECTION') add(cashByDay, day, t.amount);
    else if (t.type === 'CAPITAL_WITHDRAWAL' || t.type === 'BUSINESS_EXPENSE') add(cashByDay, day, -t.amount);
    else if (t.type === 'DISBURSEMENT') add(cashByDay, day, -t.amount);
    else if (t.type === 'REPAYMENT') {
      add(cashByDay, day, t.amount);
      add(lentByDay, day, -(t.principalPortion || 0));
      repaymentsByLoan.get(String(t.loan))?.push({ day, amount: t.amount, principal: t.principalPortion || 0 });
    }
  }
  for (const loan of loans) add(lentByDay, dayKey(loan.startDate), loan.principalAmount);
  for (const list of repaymentsByLoan.values()) list.sort((a, b) => a.day.localeCompare(b.day));

  const paidBy = (loan, day) => repaymentsByLoan.get(String(loan._id))
    .reduce((sum, r) => (r.day <= day ? sum + r.amount : sum), 0);
  const principalOutBy = (loan, day) => (dayKey(loan.startDate) > day ? 0 : Math.max(0, loan.principalAmount
    - repaymentsByLoan.get(String(loan._id)).reduce((sum, r) => (r.day <= day ? sum + r.principal : sum), 0)));
  const lastRepaymentDay = (loan) => repaymentsByLoan.get(String(loan._id)).at(-1)?.day;
  // Running totals from the first day anything happened, for day-by-day averages
  const runningFrom = (map) => {
    const days = [...map.keys()].sort();
    return (from, to, visit) => {
      let total = 0;
      let i = 0;
      while (i < days.length && days[i] < from) total += map.get(days[i++]);
      for (let day = from; day <= to; day = addDays(day, 1)) {
        while (i < days.length && days[i] <= day) total += map.get(days[i++]);
        visit(total);
      }
    };
  };

  return { paidBy, principalOutBy, lastRepaymentDay, eachDayCash: runningFrom(cashByDay), eachDayLent: runningFrom(lentByDay), repaymentsByLoan };
};

// Payments due in the range, made within the grace period. A payment covers whatever fell due first.
const collectionsPart = ({ loans, ledger, from, to, today, nameOf }) => {
  let onTime = 0;
  let late = 0;
  let waiting = 0;
  const lateByLoan = new Map();
  for (const loan of loans) {
    const timeline = dueTimelineOf(loan);
    const first = timeline.installmentsDueBy(addDays(from, -1));
    const last = timeline.installmentsDueBy(to);
    for (let i = first; i < last; i++) {
      const before = timeline.dueAmount(i);
      const amount = timeline.dueAmount(i + 1) - before;
      const deadline = addDays(timeline.dueOn(i), GRACE_DAYS);
      const graceOver = today > deadline;
      const covered = Math.min(amount, Math.max(0, ledger.paidBy(loan, graceOver ? deadline : today) - before));
      onTime += covered;
      // Still within its week and not yet paid: too early to call late
      if (amount - covered <= EPSILON) continue;
      if (graceOver) {
        late += amount - covered;
        lateByLoan.set(loan, (lateByLoan.get(loan) || 0) + amount - covered);
      } else {
        waiting += amount - covered;
      }
    }
  }
  const decided = onTime + late;
  if (decided < EPSILON) {
    const summary = waiting > EPSILON ? 'What fell due still has its week to be paid' : 'Nothing fell due in this period';
    return { score: null, summary, helping: [], hurting: [] };
  }

  const rate = onTime / decided;
  const score = clamp01(rate) * 100;
  const summary = `${percent(rate)} paid within a week`;
  const worst = [...lateByLoan.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([loan, amount]) => `${nameOf(loan)}: ${rupees(amount)} paid more than a week late, or not yet`);
  return score >= HELPING_FROM
    ? { score, summary, helping: [reason(`${percent(rate)} of the payments due were made within a week (${rupees(onTime)} of ${rupees(decided)}).`)], hurting: [] }
    : { score, summary, helping: [], hurting: [reason(`Only ${percent(rate)} of the payments due were made within a week: ${rupees(late)} came in later or not at all.`, worst)] };
};

// Loans still running on a day: given by then, and not yet closed
const runningOn = (loans, ledger, day) => loans.filter((loan) => {
  if (dayKey(loan.startDate) > day) return false;
  if (loan.status !== 'CLOSED') return true;
  const closedOn = loan.resolvedAt ? dayKey(loan.resolvedAt) : ledger.lastRepaymentDay(loan);
  return !closedOn || closedOn > day;
});

// Money overdue on the last day (falling due before it, unpaid by it), against the money lent out then
const overduePart = ({ loans, ledger, to, nameOf }) => {
  let overdue = 0;
  let lent = 0;
  const rows = [];
  for (const loan of runningOn(loans, ledger, to)) {
    const timeline = dueTimelineOf(loan);
    const paid = ledger.paidBy(loan, to);
    const owed = Math.max(0, timeline.dueAmount(timeline.installmentsDueBy(addDays(to, -1))) - paid);
    lent += ledger.principalOutBy(loan, to);
    if (owed > EPSILON) {
      overdue += owed;
      const unpaid = timeline.installmentsPaidBy(paid);
      rows.push({ loan, owed, since: unpaid < timeline.total ? timeline.dueOn(unpaid) : null });
    }
  }
  if (lent < EPSILON && overdue < EPSILON) return { score: null, summary: 'Nothing was lent out', helping: [], hurting: [] };

  const share = lent > EPSILON ? overdue / lent : 1;
  const score = clamp01(1 - share / 0.5) * 100;
  const summary = overdue < EPSILON ? 'Nothing overdue' : `${rupees(overdue)} overdue, ${percent(share)} of money lent`;
  if (score >= HELPING_FROM) {
    return { score, summary, helping: [reason(overdue < EPSILON ? 'Nothing was overdue at the end of the period.' : `Only ${rupees(overdue)} was overdue at the end of the period (${percent(share)} of money lent).`)], hurting: [] };
  }
  const worst = rows.sort((a, b) => b.owed - a.owed).slice(0, 2)
    .map((r) => `${nameOf(r.loan)}: ${rupees(r.owed)} overdue${r.since ? ` since ${shortDay(r.since)}` : ''}`);
  return { score, summary, helping: [], hurting: [reason(`${rupees(overdue)} was overdue at the end of the period, ${percent(share)} of the money lent out.`, worst)] };
};

// Interest earned in the range, after expenses, as a yearly rate on the average money lent out. Each
// repayment carries its loan's share of interest (₹1,200 back on ₹1,000 lent: a sixth of every payment),
// so earnings show in the period they came in, not only once a loan's principal is back.
const earningsPart = ({ loans, transactions, ledger, from, to, nameOf }) => {
  const shareOf = new Map(loans.map((loan) => {
    const total = loan.expectedReturnAmount + feesTotal(loan);
    return [String(loan._id), total > 0 ? Math.max(0, total - loan.principalAmount) / total : 0];
  }));
  let interest = 0;
  let expenses = 0;
  for (const t of transactions) {
    const day = dayKey(t.date);
    if (day < from || day > to) continue;
    if (t.type === 'REPAYMENT') interest += t.amount * (shareOf.get(String(t.loan)) || 0);
    if (t.type === 'BUSINESS_EXPENSE') expenses += t.amount;
  }
  const days = daysBetween(from, to) + 1;
  let lentDays = 0;
  ledger.eachDayLent(from, to, (lent) => { lentDays += Math.max(0, lent); });
  const averageLent = lentDays / days;
  if (averageLent < 1) return { score: null, summary: 'Nothing was lent out', helping: [], hurting: [] };

  const rate = ((interest - expenses) / averageLent) * (365 / days) * 100;
  const score = clamp01(rate / TARGET_YEARLY_RATE) * 100;
  const summary = `${Math.round(rate)}% a year, target ${TARGET_YEARLY_RATE}%`;
  if (score >= HELPING_FROM) {
    return { score, summary, helping: [reason(`Your lent money earned about ${Math.round(rate)}% a year (target ${TARGET_YEARLY_RATE}%).`)], hurting: [] };
  }
  // The loan dragging the average down most: a big balance at a low agreed rate
  const drag = runningOn(loans, ledger, to)
    .map((loan) => ({ loan, out: ledger.principalOutBy(loan, to), rate: interestRates(loan).agreed }))
    .filter((r) => r.rate !== null && r.rate < TARGET_YEARLY_RATE && r.out > 0)
    .sort((a, b) => b.out * (TARGET_YEARLY_RATE - b.rate) - a.out * (TARGET_YEARLY_RATE - a.rate))[0];
  return {
    score,
    summary,
    helping: [],
    hurting: [reason(`Your lent money earned about ${Math.round(rate)}% a year, below the ${TARGET_YEARLY_RATE}% target.`, [
      drag && `${nameOf(drag.loan)}: ${rupees(drag.out)} lent at ${round1(drag.rate)}% a year pulls the average down`,
      expenses > EPSILON && `Business expenses of ${rupees(expenses)} came off the earnings`,
    ])],
  };
};

// The share of the money in the business that was lent out, on average over the range
const moneyAtWorkPart = ({ ledger, from, to }) => {
  let lentSum = 0;
  let cashSum = 0;
  ledger.eachDayLent(from, to, (lent) => { lentSum += Math.max(0, lent); });
  ledger.eachDayCash(from, to, (cash) => { cashSum += Math.max(0, cash); });
  if (lentSum + cashSum < 1) return { score: null, summary: 'No money in the business yet', helping: [], hurting: [] };

  const days = daysBetween(from, to) + 1;
  const share = lentSum / (lentSum + cashSum);
  const idle = cashSum / days;
  const score = clamp01(share / 0.9) * 100;
  const summary = `${percent(share)} lent out on average`;
  return score >= HELPING_FROM
    ? { score, summary, helping: [reason(`On average ${percent(share)} of your money was lent out; about ${rupees(idle)} sat as cash.`)], hurting: [] }
    : { score, summary, helping: [], hurting: [reason(`On average ${rupees(idle)} (${percent(1 - share)} of your money) sat as cash, earning nothing.`)] };
};

// How much of the money lent out on the last day sits with the biggest borrower (all their loans together)
const spreadPart = ({ loans, ledger, to, nameOf }) => {
  const byClient = new Map();
  let total = 0;
  for (const loan of runningOn(loans, ledger, to)) {
    const out = ledger.principalOutBy(loan, to);
    const client = String(loan.client?._id || loan.client);
    const row = byClient.get(client) || { loan, out: 0 };
    row.out += out;
    byClient.set(client, row);
    total += out;
  }
  if (total < 1) return { score: null, summary: 'Nothing was lent out', helping: [], hurting: [] };

  const biggest = [...byClient.values()].sort((a, b) => b.out - a.out)[0];
  const share = biggest.out / total;
  const score = clamp01((1 - share) / 0.75) * 100;
  const summary = `Biggest borrower holds ${percent(share)}`;
  if (score >= HELPING_FROM) {
    return { score, summary, helping: [reason(`Risk is spread out: no borrower holds more than ${percent(share)} of the money lent.`)], hurting: [] };
  }
  const warning = share > 0.5 ? ' If that loan goes bad, most of the business goes with it.' : '';
  return { score, summary, helping: [], hurting: [reason(`${percent(share)} of the money lent is with one borrower: ${nameOf(biggest.loan)} (${rupees(biggest.out)}).${warning}`)] };
};

// The score for one range of days. loans carry their client's name (populated) for the reasons.
const scoreFor = ({ loans, transactions, from, to, today }) => {
  const measuredTo = to < today ? to : today;
  const ledger = ledgerOf(loans, transactions);
  const nameOf = (loan) => loan.client?.name || 'A client';
  const context = { loans, transactions, ledger, from, to: measuredTo, today, nameOf };
  const results = {
    collections: collectionsPart(context),
    overdue: overduePart(context),
    earnings: earningsPart(context),
    moneyAtWork: moneyAtWorkPart(context),
    spread: spreadPart(context),
  };

  const parts = PARTS.map((part) => {
    const result = results[part.key];
    return {
      ...part,
      score: result.score === null ? null : Math.round(result.score),
      points: result.score === null ? null : round1((part.weight * result.score) / 100),
      summary: result.summary,
    };
  });
  // From the rounded part scores, so the parts shown add up to the total
  const scored = parts.filter((p) => p.score !== null);
  const available = scored.reduce((sum, p) => sum + p.weight, 0);
  const total = available ? Math.round((scored.reduce((sum, p) => sum + p.weight * p.score, 0) / available)) : null;

  return {
    from,
    to,
    measuredTo,
    total,
    label: total === null ? null : labelFor(total),
    parts,
    helping: PARTS.flatMap((p) => results[p.key].helping),
    hurting: PARTS.flatMap((p) => results[p.key].hurting),
  };
};

module.exports = { scoreFor, labelFor, TARGET_YEARLY_RATE, GRACE_DAYS, PARTS };
