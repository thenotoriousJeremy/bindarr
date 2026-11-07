// Sessions: what the database holds, and when a session stops working.
//
//   1. The sessions table stores a SHA-256 of each token, never the token. A copy
//      of the database -- a backup, a borrowed volume -- must not be a way in, so
//      the stored value presented as a bearer token has to fail.
//   2. Rows written before that are hashed in place at startup, so an upgrade
//      signs nobody out, and a second start does not hash them again.
//   3. Changing your password signs out every other session and keeps the one
//      that made the change.
//   4. An admin resetting someone's password signs out all of that user's
//      sessions (and only theirs).
//   5. Only the auth gate answers 401 with the "session expired" marker the app
//      signs out on; a wrong current password is a 400.
//   6. Logging out ends this session, not the others.
//
// The real auth and admin routers and the real auth middleware, mounted in this
// process over a throwaway database. The two card APIs the admin router pulls in
// are stubbed, as in adminseed.test.js, so nothing reaches the network.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-sessions-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');

const stubModule = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stubModule('../src/tcgApi', { getCardsBySet: async () => [] });
stubModule('../src/scryfallApi', { getCardsBySet: async () => [] });

const { authenticateToken } = require('../src/middleware/auth');
const { generateSession, hashSessionToken } = require('../src/utils/authHelpers');

let server;
let base;
let trainerId;
let bossId;

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

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/admin', require('../src/routes/admin'));
  // Stands in for every route behind the /api gate in server.js.
  app.get('/api/probe', authenticateToken, (req, res) => res.json({ id: req.user.id }));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

const probe = (token) => api('GET', '/api/probe', { token });

async function login(username, password) {
  const res = await api('POST', '/api/auth/login', { body: { username, password } });
  assert.strictEqual(res.status, 200, `login as ${username} should succeed, got ${res.status}`);
  return res.body.token;
}

const sessionRows = async (userId) =>
  (await db.all(`SELECT token FROM sessions WHERE user_id = ? ORDER BY rowid`, [userId])).map(r => r.token);

async function testStoredHashed() {
  const token = await login('trainer', 'old-password-1');
  const rows = await sessionRows(trainerId);
  assert.deepStrictEqual(rows, [hashSessionToken(token)], 'the table holds the hash of the token');
  assert.ok(!rows.some(r => r.includes(token)), 'the token itself must appear nowhere in the table');
  assert.match(rows[0], /^sha256:[0-9a-f]{64}$/);

  assert.strictEqual((await probe(token)).status, 200, 'the token still signs in');
  assert.strictEqual((await probe(rows[0])).status, 401, 'what the database holds must not be a credential');
  console.log('PASS: sessions are stored as a hash of the token, and the hash is not a credential');
}

async function testLegacyRowsMigrate() {
  // A row exactly as every build before this one wrote it.
  const legacy = crypto.randomBytes(32).toString('hex');
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATETIME('now', '+1 day'))`, [legacy, trainerId]);
  assert.strictEqual((await probe(legacy)).status, 401, 'unmigrated, a plaintext row cannot match a hashed lookup');

  await db.initDb(); // the next start
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM sessions WHERE token = ?`, [legacy])).n, 0,
    'the plaintext token must be gone from the table');
  assert.ok(await db.get(`SELECT 1 FROM sessions WHERE token = ?`, [hashSessionToken(legacy)]),
    'the row is hashed in place, with the same digest the middleware uses');
  assert.strictEqual((await probe(legacy)).status, 200, 'a session from before the upgrade keeps working');

  await db.initDb(); // and the one after
  assert.ok(await db.get(`SELECT 1 FROM sessions WHERE token = ?`, [hashSessionToken(legacy)]),
    'a second start must not hash the hash');
  assert.strictEqual((await probe(legacy)).status, 200);
  console.log('PASS: plaintext session rows are hashed once at startup and stay signed in');
}

async function testPasswordChangeRevokesOtherSessions() {
  const here = await login('trainer', 'old-password-1');
  const there = await login('trainer', 'old-password-1');

  const res = await api('PUT', '/api/auth/settings', {
    token: here,
    body: { current_password: 'old-password-1', password: 'new-password-2' }
  });
  assert.strictEqual(res.status, 200, `password change should succeed, got ${res.status}`);
  assert.strictEqual((await probe(here)).status, 200, 'the session that changed the password stays signed in');
  assert.strictEqual((await probe(there)).status, 401, 'every other session is signed out');
  // The earlier sessions (including the migrated one) went the same way.
  assert.deepStrictEqual(await sessionRows(trainerId), [hashSessionToken(here)]);
  console.log('PASS: changing your password signs out your other sessions and keeps this one');
}

async function testAdminResetRevokesUserSessions() {
  const bossToken = await login('boss', 'boss-password-1');
  const first = await generateSession(trainerId);
  const second = await generateSession(trainerId);

  const res = await api('PUT', `/api/admin/users/${trainerId}`, { token: bossToken, body: { password: 'reset-password-3' } });
  assert.strictEqual(res.status, 200, `admin reset should succeed, got ${res.status}`);
  for (const t of [first, second]) {
    assert.strictEqual((await probe(t)).status, 401, 'a reset must sign the user out everywhere');
  }
  assert.deepStrictEqual(await sessionRows(trainerId), []);
  assert.strictEqual((await probe(bossToken)).status, 200, "the admin's own session is not touched");

  // A role change alone is not a credential change and signs nobody out.
  const kept = await generateSession(trainerId);
  assert.strictEqual((await api('PUT', `/api/admin/users/${trainerId}`, { token: bossToken, body: { role: 'member' } })).status, 200);
  assert.strictEqual((await probe(kept)).status, 200);

  // An admin resetting their OWN password here keeps the session doing it.
  const elsewhere = await generateSession(bossId);
  const self = await api('PUT', `/api/admin/users/${bossId}`, { token: bossToken, body: { password: 'boss-password-2' } });
  assert.strictEqual(self.status, 200);
  assert.strictEqual((await probe(bossToken)).status, 200, 'the resetting session survives a self-reset');
  assert.strictEqual((await probe(elsewhere)).status, 401, "the admin's other sessions do not");
  console.log("PASS: an admin password reset signs out all of that user's sessions");
}

// The app signs out on a 401 only when the gate marks it as the session ending
// (frontend/src/utils/sessionExpiry.js). Every other refusal has to be something
// else, or it logs the user out -- a mistyped current password used to.
async function testStatusCodesNeverFakeAnExpiredSession() {
  const token = await generateSession(trainerId);
  const before = (await db.get(`SELECT password_hash FROM users WHERE id = ?`, [trainerId])).password_hash;

  const wrong = await api('PUT', '/api/auth/settings', {
    token,
    body: { current_password: 'not-my-password', password: 'whatever-new-1' }
  });
  assert.strictEqual(wrong.status, 400, `a wrong current password is a bad request, not a lost session (got ${wrong.status})`);
  assert.match(wrong.body.error, /current password/i);
  assert.strictEqual(wrong.body.code, undefined, 'and it must not carry the session marker');
  assert.strictEqual((await probe(token)).status, 200, 'the session survives the typo');
  assert.strictEqual((await db.get(`SELECT password_hash FROM users WHERE id = ?`, [trainerId])).password_hash, before,
    'and the password is unchanged');

  // Not strings: refused as bad input, where they used to throw into a 500.
  for (const body of [{ current_password: 12345678, password: 'whatever-new-1' }, { current_password: 'x', password: 12345678 }]) {
    assert.strictEqual((await api('PUT', '/api/auth/settings', { token, body })).status, 400);
  }

  // The gate's own answers carry the marker...
  const none = await api('GET', '/api/probe');
  assert.strictEqual(none.status, 401);
  assert.strictEqual(none.body.code, 'session_expired');
  const stale = await probe('not-a-session');
  assert.strictEqual(stale.status, 401);
  assert.strictEqual(stale.body.code, 'session_expired');

  // ...and a failed sign-in, which is a 401 too, does not: nobody was signed in.
  const badLogin = await api('POST', '/api/auth/login', { body: { username: 'trainer', password: 'nope-nope-1' } });
  assert.strictEqual(badLogin.status, 401);
  assert.strictEqual(badLogin.body.code, undefined);
  console.log('PASS: only the auth gate answers 401 with the session-expired marker');
}

async function testLogoutEndsOnlyThisSession() {
  const a = await generateSession(trainerId);
  const b = await generateSession(trainerId);
  assert.strictEqual((await api('POST', '/api/auth/logout', { token: a })).status, 200);
  assert.strictEqual((await probe(a)).status, 401, 'the logged-out session is gone');
  assert.strictEqual((await probe(b)).status, 200, 'logging out one device leaves the others alone');
  console.log('PASS: logout ends the current session only');
}

async function main() {
  await db.initDb();
  const mkUser = async (name, password, role) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    [name, db.hashPassword(password), role, crypto.randomBytes(16).toString('hex')]
  )).lastID;
  trainerId = await mkUser('trainer', 'old-password-1', 'member');
  bossId = await mkUser('boss', 'boss-password-1', 'admin');
  base = await startApp();

  await testStoredHashed();
  await testLegacyRowsMigrate();
  await testPasswordChangeRevokesOtherSessions();
  await testAdminResetRevokesUserSessions();
  await testStatusCodesNeverFakeAnExpiredSession();
  await testLogoutEndsOnlyThisSession();
  console.log('PASS: sessions.test.js');
}

// No process.exit: close the handles and let the loop drain (the Windows libuv
// abort described in storagesettings.test.js).
main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
