const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const {
  app, request, startDb, stopDb, clearDb, auth, seedLegacyPin, login, seedTeam, models,
} = require('./helpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

describe('upgrade from the single app PIN', () => {
  it('turns the old PIN into the admin account on first sign-in', async () => {
    await seedLegacyPin('1234');
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', pin: '1234' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'ADMIN');
    assert.equal(res.body.user.username, 'admin');
    assert.equal(await models.User.countDocuments(), 1);
  });

  it('still signs in with only a PIN, as app versions from before this update do', async () => {
    await seedLegacyPin('1234');
    const res = await request(app).post('/api/auth/verify-pin').send({ pin: '1234' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.user.role, 'ADMIN');
    const dashboard = await request(app).get('/api/dashboard').set(auth(res.body.token));
    assert.equal(dashboard.status, 200);
  });

  it('creates the admin only once when two first sign-ins race', async () => {
    await seedLegacyPin('1234');
    const results = await Promise.all([1, 2, 3].map(() => request(app).post('/api/auth/login').send({ username: 'admin', pin: '1234' })));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.equal(await models.User.countDocuments(), 1);
  });

  it('rejects tokens issued before user accounts existed', async () => {
    const config = await seedLegacyPin('1234');
    const oldToken = jwt.sign({ configId: config._id, role: 'admin', tv: 0 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    const res = await request(app).get('/api/dashboard').set(auth(oldToken));
    assert.equal(res.status, 401);
  });

  it('answers 503 when no PIN has been set up at all', async () => {
    const res = await request(app).post('/api/auth/verify-pin').send({ pin: '1234' });
    assert.equal(res.status, 503);
  });
});

describe('sign-in', () => {
  it('gives the same answer for an unknown username as for a wrong PIN', async () => {
    await seedTeam();
    const unknown = await request(app).post('/api/auth/login').send({ username: 'nobody', pin: '1234' });
    assert.equal(unknown.status, 401);
    assert.match(unknown.body.message, /Wrong username or PIN/);
  });

  it('matches usernames however they are typed', async () => {
    await seedTeam();
    const res = await request(app).post('/api/auth/login').send({ username: '  RAVI ', pin: '5678' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'STAFF');
  });

  it('locks out only the user who keeps guessing', async () => {
    await seedTeam();
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({ username: 'ravi', pin: '0000' });
    }
    const locked = await request(app).post('/api/auth/login').send({ username: 'ravi', pin: '5678' });
    assert.equal(locked.status, 429);
    const admin = await request(app).post('/api/auth/login').send({ username: 'admin', pin: '1234' });
    assert.equal(admin.status, 200);
  });

  it('returns who is signed in', async () => {
    const { staff } = await seedTeam();
    const res = await request(app).get('/api/auth/me').set(auth(staff));
    assert.equal(res.status, 200);
    assert.equal(res.body.user.name, 'Ravi');
    assert.equal(res.body.user.role, 'STAFF');
  });

  it('changing your PIN signs out your other devices but not other users', async () => {
    const { admin, staff } = await seedTeam();
    const otherDevice = await login('ravi', '5678');
    const res = await request(app).post('/api/auth/change-pin').set(auth(staff)).send({ oldPin: '5678', newPin: '4321' });
    assert.equal(res.status, 200);
    assert.equal((await request(app).get('/api/auth/me').set(auth(otherDevice))).status, 401);
    assert.equal((await request(app).get('/api/auth/me').set(auth(res.body.token))).status, 200);
    assert.equal((await request(app).get('/api/auth/me').set(auth(admin))).status, 200);
    await login('ravi', '4321');
  });
});

describe('what each role can reach', () => {
  it('blocks staff from everything except collections', async () => {
    const { staff } = await seedTeam();
    for (const path of ['/api/dashboard', '/api/clients', '/api/loans', '/api/transactions', '/api/users', '/api/collections/summary']) {
      const res = await request(app).get(path).set(auth(staff));
      assert.equal(res.status, 403, `${path} should be admin only`);
    }
    for (const [method, path] of [['post', '/api/transactions'], ['post', '/api/loans'], ['post', '/api/clients'], ['delete', '/api/transactions/000000000000000000000000']]) {
      const res = await request(app)[method](path).set(auth(staff)).send({});
      assert.equal(res.status, 403, `${method} ${path} should be admin only`);
    }
    assert.equal((await request(app).get('/api/collections/loans').set(auth(staff))).status, 200);
    assert.equal((await request(app).get('/api/collections').set(auth(staff))).status, 200);
  });

  it('lets the admin reach everything', async () => {
    const { admin } = await seedTeam();
    for (const path of ['/api/dashboard', '/api/clients', '/api/loans', '/api/transactions', '/api/users', '/api/collections/summary', '/api/collections']) {
      assert.equal((await request(app).get(path).set(auth(admin))).status, 200, path);
    }
  });

  it('keeps staff from submitting as the admin', async () => {
    const { admin } = await seedTeam();
    const res = await request(app).post('/api/collections').set(auth(admin)).send({});
    assert.equal(res.status, 403);
  });

  it('requires a token everywhere except sign-in', async () => {
    for (const path of ['/api/dashboard', '/api/collections', '/api/collections/loans', '/api/users', '/api/auth/me']) {
      assert.equal((await request(app).get(path)).status, 401, path);
    }
  });
});

describe('managing staff', () => {
  it('disabling a staff member signs them out and blocks sign-in', async () => {
    const { admin, staff, staffId } = await seedTeam();
    const res = await request(app).patch(`/api/users/${staffId}`).set(auth(admin)).send({ active: false });
    assert.equal(res.status, 200);
    assert.equal((await request(app).get('/api/collections').set(auth(staff))).status, 401);
    const again = await request(app).post('/api/auth/login').send({ username: 'ravi', pin: '5678' });
    assert.equal(again.status, 401);

    await request(app).patch(`/api/users/${staffId}`).set(auth(admin)).send({ active: true });
    await login('ravi', '5678');
  });

  it('resetting a PIN signs the staff member out and clears a lockout', async () => {
    const { admin, staff, staffId } = await seedTeam();
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ username: 'ravi', pin: '0000' });
    const res = await request(app).post(`/api/users/${staffId}/reset-pin`).set(auth(admin)).send({ pin: '2468' });
    assert.equal(res.status, 200);
    assert.equal((await request(app).get('/api/collections').set(auth(staff))).status, 401);
    await login('ravi', '2468');
  });

  it('refuses duplicate usernames and changes to the admin account', async () => {
    const { admin } = await seedTeam();
    const duplicate = await request(app).post('/api/users').set(auth(admin)).send({ name: 'Ravi 2', username: 'Ravi', pin: '1111' });
    assert.equal(duplicate.status, 409);
    const adminUser = await models.User.findOne({ role: 'ADMIN' });
    const disableAdmin = await request(app).patch(`/api/users/${adminUser._id}`).set(auth(admin)).send({ active: false });
    assert.equal(disableAdmin.status, 403);
  });

  it('never sends PIN hashes to the app', async () => {
    const { admin } = await seedTeam();
    const res = await request(app).get('/api/users').set(auth(admin));
    assert.equal(res.body.data.length, 2);
    for (const user of res.body.data) {
      assert.equal(user.pinHash, undefined);
      assert.equal(user.failedAttempts, undefined);
    }
  });
});
