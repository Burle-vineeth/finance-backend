// Where the cash is: repayments go to the staff's hand or the admin's, and cash transfers move it between them
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, startDb, stopDb, clearDb, auth, seedTeam, seedLoan, today } = require('./helpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

// ₹1,00,000 of capital, ₹1,000 of it lent out: ₹99,000 in the admin's hand
const setup = async () => {
  const team = await seedTeam();
  const { loan } = await seedLoan();
  const post = (body) => request(app).post('/api/transactions').set(auth(team.admin)).send({ date: today(), ...body });
  const repay = (amount, cashWith) => post({ type: 'REPAYMENT', loan: String(loan._id), amount, ...(cashWith ? { cashWith } : {}) });
  const transfer = (amount, cashWith, notes) => post({ type: 'CASH_TRANSFER', amount, cashWith, notes });
  const split = async () => (await request(app).get('/api/transactions/cash').set(auth(team.admin))).body.data;
  const finances = async () => (await request(app).get('/api/dashboard').set(auth(team.admin))).body.data.finances;
  return { ...team, loan, repay, transfer, split, finances };
};

describe('cash with staff', () => {
  it('keeps a repayment paid to staff with staff until they hand it over', async () => {
    const { repay, transfer, split, finances } = await setup();
    assert.deepEqual(await split(), { total: 99000, withStaff: 0, inHand: 99000 });

    assert.equal((await repay(300, 'STAFF')).status, 201);
    assert.deepEqual(await split(), { total: 99300, withStaff: 300, inHand: 99000 });

    const received = await transfer(200, 'ADMIN', 'Evening handover');
    assert.equal(received.status, 201);
    assert.equal(received.body.data.type, 'CASH_TRANSFER');
    assert.deepEqual(await split(), { total: 99300, withStaff: 100, inHand: 99200 });

    // The dashboard's cash on hand is the same total, now split
    const f = await finances();
    assert.equal(f.cashOnHand, 99300);
    assert.equal(f.cashWithStaff, 100);
    assert.equal(f.cashInHand, 99200);
  });

  it('puts a repayment in the admin\'s hand when it says so, or doesn\'t say (older app versions)', async () => {
    const { repay, split } = await setup();
    await repay(100, 'ADMIN');
    await repay(50);
    assert.deepEqual(await split(), { total: 99150, withStaff: 0, inHand: 99150 });
  });

  it('puts an approved staff collection with staff', async () => {
    const { admin, staff, loan, split } = await setup();
    const sent = await request(app).post('/api/collections').set(auth(staff))
      .send({ loan: String(loan._id), amount: 250, date: today(), requestId: 'c-1' });
    await request(app).post(`/api/collections/${sent.body.data._id}/approve`).set(auth(admin)).send({});
    assert.equal((await split()).withStaff, 250);
  });

  it('moves cash to staff, as when staff hold what the app counted as yours', async () => {
    const { transfer, split } = await setup();
    const moved = await transfer(99000, 'STAFF', 'Starting balance');
    assert.equal(moved.status, 201);
    assert.deepEqual(await split(), { total: 99000, withStaff: 99000, inHand: 0 });
  });

  it('won\'t move more than the hand it leaves holds, or a bad transfer', async () => {
    const { repay, transfer, split } = await setup();
    await repay(300, 'STAFF');
    const tooMuch = await transfer(301, 'ADMIN');
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.error, /Staff have only ₹300/);
    assert.equal((await transfer(99001, 'STAFF')).status, 400);
    assert.equal((await transfer(100)).status, 400);
    assert.equal((await transfer(0, 'ADMIN')).status, 400);
    assert.equal((await repay(100, 'SOMEONE')).status, 400);
    assert.equal((await split()).withStaff, 300);
  });

  it('undoes a handover, but not money staff have since handed over', async () => {
    const { admin, repay, transfer, split } = await setup();
    const paid = (await repay(300, 'STAFF')).body.data;
    const handover = (await transfer(300, 'ADMIN')).body.data;

    const blocked = await request(app).delete(`/api/transactions/${paid._id}`).set(auth(admin));
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Staff gave me/);

    assert.equal((await request(app).delete(`/api/transactions/${handover._id}`).set(auth(admin))).status, 200);
    assert.equal((await split()).withStaff, 300);
    assert.equal((await request(app).delete(`/api/transactions/${paid._id}`).set(auth(admin))).status, 200);
    assert.deepEqual(await split(), { total: 99000, withStaff: 0, inHand: 99000 });
  });

  it('is the admin\'s only', async () => {
    const { staff } = await setup();
    assert.equal((await request(app).get('/api/transactions/cash').set(auth(staff))).status, 403);
  });
});
