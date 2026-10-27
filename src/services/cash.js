// Where the business's cash is: with staff (collected by them, not yet handed over) or in the admin's hand.
//
// All cash comes in to and goes out of the admin's hand, except repayments paid to staff, which sit with staff
// until a cash transfer moves them. So the staff's share is their repayments, plus what was moved to them, less
// what they handed over; the admin's hand holds the rest of the cash.
const CASH_IN = ['CAPITAL_INJECTION', 'REPAYMENT'];
const CASH_OUT = ['CAPITAL_WITHDRAWAL', 'DISBURSEMENT', 'BUSINESS_EXPENSE'];

const round2 = (value) => Math.round(value * 100) / 100;

const cashSplit = (transactions) => {
  let total = 0;
  let withStaff = 0;
  for (const t of transactions) {
    if (CASH_IN.includes(t.type)) total += t.amount;
    else if (CASH_OUT.includes(t.type)) total -= t.amount;
    if (t.type === 'REPAYMENT' && t.cashWith === 'STAFF') withStaff += t.amount;
    else if (t.type === 'CASH_TRANSFER') withStaff += t.cashWith === 'STAFF' ? t.amount : -t.amount;
  }
  return { total: round2(total), withStaff: round2(withStaff), inHand: round2(total - withStaff) };
};

module.exports = { cashSplit };
