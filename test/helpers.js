// Test setup: a throwaway in-memory MongoDB replica set (so transactions work like on Atlas)
// and the real Express app. No test touches a real database.
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const request = require('supertest');

process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-the-server-check';
delete process.env.INITIAL_PIN;

const { createApp } = require('../src/app');
const AppConfig = require('../src/models/AppConfig');
const Client = require('../src/models/Client');
const Loan = require('../src/models/Loan');
const Transaction = require('../src/models/Transaction');
const User = require('../src/models/User');
const CollectionEntry = require('../src/models/CollectionEntry');

let replSet;
const app = createApp();

const startDb = async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  // Collections and unique indexes exist up front, as they do on a running server
  await mongoose.connection.syncIndexes();
};

const stopDb = async () => {
  await mongoose.disconnect();
  await replSet.stop();
};

const clearDb = async () => {
  await Promise.all([AppConfig, Client, Loan, Transaction, User, CollectionEntry].map((m) => m.deleteMany({})));
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });

// The database as it is before this update: one app PIN and no user accounts
const seedLegacyPin = async (pin = '1234') => AppConfig.create({ systemPinHash: await bcrypt.hash(pin, 4) });

const login = async (username, pin) => {
  const res = await request(app).post('/api/auth/login').send({ username, pin });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
};

// Admin (from the legacy PIN) plus one staff member, both signed in
const seedTeam = async () => {
  await seedLegacyPin('1234');
  const admin = await login('admin', '1234');
  const created = await request(app).post('/api/users').set(auth(admin)).send({ name: 'Ravi', username: 'ravi', pin: '5678' });
  if (created.status !== 201) throw new Error(`create staff failed: ${created.status}`);
  const staff = await login('ravi', '5678');
  return { admin, staff, staffId: created.body.data.id };
};

// A disbursed loan with enough capital behind it
const seedLoan = async ({ principal = 1000, expected = 1200, frequency = 'DAILY', days = 10, startDate } = {}) => {
  const client = await Client.create({ name: 'Ramesh Kumar', phone: '9848012345' });
  await Transaction.create({ type: 'CAPITAL_INJECTION', amount: 100000 });
  const loan = await Loan.create({
    client: client._id,
    principalAmount: principal,
    expectedReturnAmount: expected,
    paymentFrequency: frequency,
    durationDays: days,
    startDate: startDate || new Date(Date.now() - 5 * 86400000),
  });
  await Transaction.create({ type: 'DISBURSEMENT', amount: principal, client: client._id, loan: loan._id, date: loan.startDate });
  return { client, loan };
};

// Today in India, the day the server counts as today (see services/schedule)
const { todayKey } = require('../src/services/schedule');
const today = () => todayKey();

module.exports = {
  app, request, startDb, stopDb, clearDb, auth, seedLegacyPin, login, seedTeam, seedLoan, today,
  models: { AppConfig, Client, Loan, Transaction, User, CollectionEntry },
};
