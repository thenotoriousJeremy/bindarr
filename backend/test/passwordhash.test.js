// Password checks no longer block the server or say which usernames exist (SEC-05).
//
//   - Hashing and checking run PBKDF2 asynchronously, on libuv's thread pool:
//     pbkdf2Sync spent its 210k rounds on the event loop, stalling every request.
//   - Sign-in with an unknown username, or with an account that has no password
//     (SSO-only, a phone's owner), does the same PBKDF2 work a real check does, so
//     the response time no longer tells them apart.
//   - The current-password check a password change makes is rate-limited per
//     account, counting only wrong current passwords.
//   - Sign-in's limit is spent by failures only, so a household behind one
//     address does not lock itself out by signing in (SEC-19).
//
// Existing hashes, both formats, still verify. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-passwordhash-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const authHelpers = require('../src/utils/authHelpers');

let server;
async function cleanup() {
  if (server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

// Every PBKDF2 call made through crypto.pbkdf2, with its iteration count.
const pbkdf2Calls = [];
const realPbkdf2 = crypto.pbkdf2;
crypto.pbkdf2 = function countedPbkdf2(password, salt, iterations, ...rest) {
  pbkdf2Calls.push(iterations);
  return realPbkdf2.call(this, password, salt, iterations, ...rest);
};

async function main() {
  await db.initDb();
  const { hashPassword, checkPassword, PBKDF2_ITERATIONS } = authHelpers;

  // --- Off the event loop ------------------------------------------------------
  let ticked = false;
  setImmediate(() => { ticked = true; });
  const hash = await hashPassword('correct horse battery');
  assert.ok(ticked, 'the event loop turned while the password was hashed');
  assert.match(hash, new RegExp(`^${PBKDF2_ITERATIONS}:[0-9a-f]{32}:[0-9a-f]{128}$`), 'the stored format is unchanged');
  ticked = false;
  setImmediate(() => { ticked = true; });
  assert.strictEqual(await checkPassword('correct horse battery', hash), true);
  assert.ok(ticked, 'and while it was checked');
  assert.strictEqual(await checkPassword('wrong horse', hash), false);
  console.log('PASS: hashing and checking leave the event loop free');

  // --- Every stored format still verifies -----------------------------------------
  assert.strictEqual(authHelpers.verifyPassword('correct horse battery', hash), true, 'the sync check agrees');
  assert.strictEqual(await checkPassword('correct horse battery', db.hashPassword('correct horse battery')), true,
    'db.hashPassword (sync, for initDb and scripts) makes the same format');
  const legacy = `deadbeef:${crypto.pbkdf2Sync('legacy-pw', 'deadbeef', 10000, 64, 'sha512').toString('hex')}`;
  assert.strictEqual(await checkPassword('legacy-pw', legacy), true, 'a legacy salt:hash still verifies');
  assert.strictEqual(await checkPassword('nope', legacy), false);
  for (const bad of ['', 'garbage', 'a:b:c:d', 'x:y:z', null, undefined]) {
    assert.strictEqual(await checkPassword('x', bad), false, `${JSON.stringify(bad)} never matches`);
  }
  console.log('PASS: current and legacy hashes verify; malformed ones never do');

  // --- The same work whether or not there is a password -----------------------------
  for (const stored of [null, `oidc_locked:${crypto.randomBytes(16).toString('hex')}`, '!']) {
    pbkdf2Calls.length = 0;
    assert.strictEqual(await checkPassword('anything', stored), false);
    assert.deepStrictEqual(pbkdf2Calls, [PBKDF2_ITERATIONS], `${stored} still costs one full check`);
  }

  const owner = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES ('owner', ?, 'admin', ?)`,
    [hash, crypto.randomBytes(16).toString('hex')]
  )).lastID;
  await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, oidc_sub) VALUES ('ssoonly', ?, 'member', ?, 'sub-1')`,
    [`oidc_locked:${crypto.randomBytes(16).toString('hex')}`, crypto.randomBytes(16).toString('hex')]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const call = async (method, p, { body, token } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  for (const username of ['nobody-by-this-name', 'ssoonly', 'owner']) {
    pbkdf2Calls.length = 0;
    const r = await call('POST', '/api/auth/login', { body: { username, password: 'not-the-password' } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.code, 'invalid_credentials', 'one answer for every kind of miss');
    assert.deepStrictEqual(pbkdf2Calls, [PBKDF2_ITERATIONS], `a failed sign-in as ${username} does one full check`);
  }
  console.log('PASS: unknown and SSO-only usernames cost the same check as a real one');

  // --- Sign-in's limit counts failures only ---------------------------------------------
  // Three failures above; twenty successes now must all go through.
  let token;
  for (let i = 0; i < 20; i++) {
    const r = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'correct horse battery' } });
    assert.strictEqual(r.status, 200, `successful sign-in ${i + 1} is not limited`);
    token = r.json.token;
  }
  for (let i = 0; i < 17; i++) {
    assert.strictEqual((await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'bad' } })).status, 401);
  }
  assert.strictEqual((await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'bad' } })).status, 429,
    'the twenty-first failure in the window is refused');
  console.log('PASS: the sign-in limit is spent by failures, not by signing in');

  // --- Password changes: wrong current passwords are counted, per account --------------
  // Not counted: saves that change no password, and a malformed one.
  for (let i = 0; i < 12; i++) {
    assert.strictEqual((await call('PUT', '/api/auth/settings', { token, body: { share_enabled: i % 2 === 0 } })).status, 200);
  }
  assert.strictEqual((await call('PUT', '/api/auth/settings', { token, body: { password: 123 } })).status, 400);
  for (let i = 0; i < 10; i++) {
    const r = await call('PUT', '/api/auth/settings', { token, body: { current_password: `guess-${i}`, password: 'new-password-1' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'wrong_password');
  }
  const limited = await call('PUT', '/api/auth/settings', { token, body: { current_password: 'correct horse battery', password: 'new-password-1' } });
  assert.strictEqual(limited.status, 429, 'the eleventh current-password check in the window is refused, even a right one');
  assert.strictEqual(await checkPassword('correct horse battery', (await db.get(`SELECT password_hash FROM users WHERE id = ?`, [owner])).password_hash), true,
    'and the password is unchanged');
  assert.strictEqual((await call('PUT', '/api/auth/settings', { token, body: { share_enabled: true } })).status, 200,
    'a save that changes no password still works');
  console.log('PASS: wrong current passwords are rate-limited per account');

  console.log('PASS: passwordhash.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
