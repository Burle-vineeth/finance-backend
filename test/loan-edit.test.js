const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  app, request, startDb, stopDb, clearDb, auth, seedTeam, seedLoan, today, models,
} = require('./helpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const { dayKey } = require('../src/services/schedule');
// India days relative to now, as the server counts them
const day = (offset) => dayKey(new Date(Date.now() + offset * 86400000));
const patch = (token, id, body) => request(app).patch(`/api/loans/${id}`).set(auth(token)).send(body);

// A loan with a disbursement, an admin-entered repayment (no client) and an approved staff repayment (names the client)
const seedWithHistory = async () => {
  const team = await seedTeam();
  const { client, loan } = await seedLoan();
  await request(app).post('/api/transactions').set(auth(team.admin)).send({ type: 'REPAYMENT', loan: loan._id, amount: 120, date: today() });
  const entry = (await request(app).post('/api/collections').set(auth(team.staff)).send({ loan: loan._id, amount: 120, date: today() })).body.data;
  await request(app).post(`/api/collections/${entry._id}/approve`).set(auth(team.admin)).send({});
  const other = await models.Client.create({ name: 'Suresh Reddy', phone: '9000045678' });
  return { ...team, client, loan, other, entry };
};

describe('correcting a loan\'s details', () => {
  it('moves the loan and its records to the right client', async () => {
    const { admin, loan, client, other, entry } = await seedWithHistory();
    const res = await patch(admin, loan._id, { client: String(other._id) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.saved, true);
    assert.deepEqual(res.body.data.changes, [{ field: 'client', from: 'Ramesh Kumar', to: 'Suresh Reddy' }]);

    const updated = await models.Loan.findById(loan._id).lean();
    assert.equal(String(updated.client), String(other._id));
    const disbursement = await models.Transaction.findOne({ loan: loan._id, type: 'DISBURSEMENT' }).lean();
    assert.equal(String(disbursement.client), String(other._id));
    const approved = await models.Transaction.findOne({ loan: loan._id, collectionEntry: entry._id }).lean();
    assert.equal(String(approved.client), String(other._id));
    // The admin's own repayment had no client and still has none
    const adminRepayment = await models.Transaction.findOne({ loan: loan._id, type: 'REPAYMENT', collectionEntry: null }).lean();
    assert.equal(adminRepayment.client, null);
    assert.equal(String((await models.CollectionEntry.findById(entry._id).lean()).client), String(other._id));
    // Nothing still points at the old client
    assert.equal(await models.Transaction.countDocuments({ client: client._id }), 0);
  });

  it('moves the disbursement entry with the disbursement date, and the schedule with it', async () => {
    const { admin, loan } = await seedWithHistory();
    const res = await patch(admin, loan._id, { startDate: day(-8) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.schedule.after.firstDueDate, day(-7));
    const disbursement = await models.Transaction.findOne({ loan: loan._id, type: 'DISBURSEMENT' }).lean();
    assert.equal(disbursement.date.toISOString().substring(0, 10), day(-8));
    const listed = (await request(app).get('/api/loans').set(auth(admin))).body.data.find((l) => l._id === String(loan._id));
    assert.equal(listed.schedule.firstDueDate, day(-7));
  });

  it('sets and clears the collection start date', async () => {
    const { admin, loan } = await seedWithHistory();
    let res = await patch(admin, loan._id, { collectionStartDate: day(2) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.schedule.after.firstDueDate, day(2));
    assert.equal(res.body.data.schedule.after.status, 'PAID_AHEAD');
    res = await patch(admin, loan._id, { collectionStartDate: null });
    assert.equal(res.status, 200);
    assert.equal((await models.Loan.findById(loan._id).lean()).collectionStartDate, undefined);
  });

  it('refuses a collection start before the disbursement date', async () => {
    const { admin, loan } = await seedWithHistory();
    const res = await patch(admin, loan._id, { collectionStartDate: day(-30) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /before the loan is disbursed/);
  });

  it('previews without saving', async () => {
    const { admin, loan, other } = await seedWithHistory();
    const res = await patch(admin, loan._id, { client: String(other._id), startDate: day(-8), dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.saved, false);
    assert.equal(res.body.data.changes.length, 2);
    assert.ok(res.body.data.schedule.before && res.body.data.schedule.after);
    const unchanged = await models.Loan.findById(loan._id).lean();
    assert.notEqual(String(unchanged.client), String(other._id));
    assert.equal((unchanged.editHistory || []).length, 0);
  });

  it('records who changed what', async () => {
    const { admin, loan } = await seedWithHistory();
    await patch(admin, loan._id, { startDate: day(-8) });
    await patch(admin, loan._id, { collectionStartDate: day(-6) });
    const { editHistory } = await models.Loan.findById(loan._id).lean();
    assert.equal(editHistory.length, 2);
    assert.equal(editHistory[0].byName, 'Admin');
    assert.deepEqual(editHistory[0].changes, [{ field: 'startDate', from: day(-5), to: day(-8) }]);
    assert.deepEqual(editHistory[1].changes, [{ field: 'collectionStartDate', from: '', to: day(-6) }]);
  });

  it('saves nothing when nothing changed', async () => {
    const { admin, loan } = await seedWithHistory();
    const res = await patch(admin, loan._id, { startDate: day(-5) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.saved, false);
    assert.equal(res.body.data.changes.length, 0);
    assert.equal(((await models.Loan.findById(loan._id).lean()).editHistory || []).length, 0);
  });

  it('refuses changes to amounts and terms, and bad input', async () => {
    const { admin, loan } = await seedWithHistory();
    for (const body of [{ principalAmount: 5000 }, { expectedReturnAmount: 9000 }, { durationDays: 20 }, { paymentFrequency: 'WEEKLY' }, { status: 'CLOSED' }]) {
      const res = await patch(admin, loan._id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await patch(admin, loan._id, { startDate: '2026-02-31' })).status, 400);
    assert.equal((await patch(admin, loan._id, { client: 'nobody' })).status, 400);
    assert.equal((await patch(admin, loan._id, { client: '000000000000000000000000' })).status, 404);
    assert.equal((await patch(admin, '000000000000000000000000', { startDate: day(-8) })).status, 404);
    const unchanged = await models.Loan.findById(loan._id).lean();
    assert.equal(unchanged.principalAmount, 1000);
    assert.equal(unchanged.paymentFrequency, 'DAILY');
  });

  it('is for the admin only', async () => {
    const { staff, loan } = await seedWithHistory();
    assert.equal((await patch(staff, loan._id, { startDate: day(-8) })).status, 403);
  });
});
