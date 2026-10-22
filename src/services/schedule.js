// When a loan's next payment is due: one period (day, week or month) after the latest repayment, or
// after the collection start date (else the disbursement date) when nothing has been repaid yet.
// today is local midnight. isCollectedToday says whether the latest repayment was made today.
const paymentSchedule = (loan, latestRepaymentDate, today) => {
  let lastPaymentDate = loan.collectionStartDate || loan.startDate;
  let isCollectedToday = false;

  if (latestRepaymentDate) {
    lastPaymentDate = latestRepaymentDate;
    isCollectedToday = new Date(lastPaymentDate).toDateString() === today.toDateString();
  }

  const nextPaymentDate = new Date(lastPaymentDate);
  if (loan.paymentFrequency === 'DAILY') {
    nextPaymentDate.setDate(nextPaymentDate.getDate() + 1);
  } else if (loan.paymentFrequency === 'WEEKLY') {
    nextPaymentDate.setDate(nextPaymentDate.getDate() + 7);
  } else if (loan.paymentFrequency === 'MONTHLY') {
    nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
  }

  return { nextPaymentDate, isCollectedToday };
};

module.exports = { paymentSchedule };
