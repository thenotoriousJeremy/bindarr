// Provider keys and the API key never reach the client as values.
//
// The SPA stores the user object it is handed in localStorage, and it used to be
// handed the account's pokemontcg.io key, PSA token, graded-price key and the
// read-only API key in plain text -- by login, the SSO exchange, GET /me and every
// settings save. Now each of those says only whether a key is set (has_*), the
// provider keys are write-only, and the API key is read on demand from its own
// endpoint, which is not part of that object.
//
// The real auth router and middleware in this process, over a throwaway database.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-userkeys-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');

let server;
let base;

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

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
}

const SECRETS = {
  tcg_api_key: 'tcg-key-0123456789',
  psa_api_token: 'psa-token-0123456789',
  graded_price_api_key: 'ppt-key-0123456789',
  api_key: `bnd_${crypto.randomBytes(24).toString('hex')}`
};

function assertNoSecrets(res, what) {
  for (const [field, value] of Object.entries(SECRETS)) {
    assert.ok(!res.text.includes(value), `${what} must not contain the ${field} value`);
  }
  for (const field of Object.keys(SECRETS)) {
    assert.ok(!(field in res.body.user), `${what} must not carry a ${field} field`);
  }
}

const keysOf = (id) => db.get(`SELECT tcg_api_key, psa_api_token, graded_price_api_key FROM users WHERE id = ?`, [id]);

async function main() {
  await db.initDb();
  const userId = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, tcg_api_key, psa_api_token, graded_price_api_key, api_key)
     VALUES (?, ?, 'member', ?, ?, ?, ?, ?)`,
    ['keeper', db.hashPassword('keeper-password-1'), crypto.randomBytes(16).toString('hex'),
      SECRETS.tcg_api_key, SECRETS.psa_api_token, SECRETS.graded_price_api_key, SECRETS.api_key]
  )).lastID;

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  // --- Every user object says whether, never what ------------------------------
  const login = await api('POST', '/api/auth/login', { body: { username: 'keeper', password: 'keeper-password-1' } });
  assert.strictEqual(login.status, 200);
  assertNoSecrets(login, 'the login response');
  assert.deepStrictEqual(
    [login.body.user.has_tcg_api_key, login.body.user.has_psa_api_token, login.body.user.has_graded_price_api_key, login.body.user.has_api_key],
    [true, true, true, true]
  );
  assert.strictEqual(login.body.user.role, 'member', 'the rest of the profile is still there');
  const token = login.body.token;

  const me = await api('GET', '/api/auth/me', { token });
  assert.strictEqual(me.status, 200);
  assertNoSecrets(me, 'GET /me');
  assert.strictEqual(me.body.user.id, userId);
  assert.strictEqual(me.body.user.has_psa_api_token, true);

  // Through the API key, too: it is a read-only credential that lives in some
  // other machine's config, and must not read the account's other keys.
  const meByKey = await api('GET', '/api/auth/me', { token: SECRETS.api_key });
  assert.strictEqual(meByKey.status, 200);
  assertNoSecrets(meByKey, 'GET /me with the API key');
  console.log('PASS: sign-in and /me report keys as has_* flags only');

  // --- The API key is shown on request, to a login session ---------------------
  const shown = await api('GET', '/api/auth/api-key', { token });
  assert.strictEqual(shown.status, 200);
  assert.strictEqual(shown.body.api_key, SECRETS.api_key);
  assert.strictEqual(shown.headers.get('cache-control'), 'no-store', 'a secret must not be cached');
  assert.strictEqual((await api('GET', '/api/auth/api-key', { token: SECRETS.api_key })).status, 403,
    'the API key cannot be used to read itself back');
  console.log('PASS: the API key is readable on demand, from a login session only');

  // --- Provider keys are write-only ---------------------------------------------
  // A save that does not mention a key leaves it alone...
  const toggle = await api('PUT', '/api/auth/settings', { token, body: { share_enabled: true } });
  assert.strictEqual(toggle.status, 200);
  assertNoSecrets(toggle, 'a settings save');
  assert.deepStrictEqual({ ...(await keysOf(userId)) }, {
    tcg_api_key: SECRETS.tcg_api_key, psa_api_token: SECRETS.psa_api_token, graded_price_api_key: SECRETS.graded_price_api_key
  });

  // ...a string replaces it, trimmed...
  const replaced = await api('PUT', '/api/auth/settings', { token, body: { psa_api_token: '  new-psa-token  ' } });
  assert.strictEqual(replaced.status, 200);
  assert.ok(!replaced.text.includes('new-psa-token'), 'not even the key just sent comes back');
  assert.strictEqual((await keysOf(userId)).psa_api_token, 'new-psa-token');

  // ...and '' or null clears it, which the flags then say.
  const cleared = await api('PUT', '/api/auth/settings', { token, body: { tcg_api_key: '', graded_price_api_key: null } });
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual(cleared.body.user.has_tcg_api_key, false);
  assert.strictEqual(cleared.body.user.has_graded_price_api_key, false);
  assert.strictEqual(cleared.body.user.has_psa_api_token, true);
  assert.deepStrictEqual({ ...(await keysOf(userId)) }, { tcg_api_key: '', psa_api_token: 'new-psa-token', graded_price_api_key: '' });

  // Not text: refused before anything is written, so no half-applied save.
  const bad = await api('PUT', '/api/auth/settings', { token, body: { share_enabled: false, psa_api_token: { $ne: '' } } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await db.get(`SELECT share_enabled FROM users WHERE id = ?`, [userId])).share_enabled, 1,
    'the share toggle in the same request must not have been applied');
  assert.strictEqual((await keysOf(userId)).psa_api_token, 'new-psa-token');
  console.log('PASS: provider keys are write-only: omitted keeps, text replaces, empty clears');

  console.log('PASS: userkeys.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
