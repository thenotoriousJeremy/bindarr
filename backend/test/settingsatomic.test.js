// A settings save is all or nothing (SEC-18).
//
// PUT /api/settings validated some fields only after earlier ones had been
// written, so a save refused for one bad value still changed the others. And an
// admin's edit of a user wrote the new password, and signed the user out
// everywhere, before checking the role in the same request. Now every field is
// validated first and the writes happen together.
//
// The real routers and auth gate in this process. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-settingsatomic-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const { generateSession, verifyPassword } = require('../src/utils/authHelpers');
const { authenticateToken } = require('../src/middleware/auth');

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

async function main() {
  await db.initDb();
  const addUser = async (name, role, password) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    [name, db.hashPassword(password), role, crypto.randomBytes(16).toString('hex')]
  )).lastID;
  const adminId = await addUser('boss', 'admin', 'boss-password-1');
  const memberId = await addUser('worker', 'member', 'worker-password-1');
  const adminToken = await generateSession(adminId);
  await generateSession(memberId);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../src/routes/admin'));
  app.use('/api', authenticateToken);
  app.use('/api/settings', require('../src/routes/settings'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const put = async (p, body) => {
    const res = await fetch(base + p, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const settingsRow = () => db.get(
    `SELECT scan_exclude_tokens, setup_complete, price_refresh_days, public_base_url FROM app_settings WHERE id = 1`
  );

  // --- PUT /api/settings ------------------------------------------------------------
  const before = { ...(await settingsRow()) };
  for (const body of [
    { scan_exclude_tokens: true, public_base_url: 'ftp://cards.example.com' },
    { setup_complete: true, public_base_url: 123 },
    { price_refresh_days: 3, scan_exclude_tokens: true, public_base_url: 'cards.example.com' },
    { scan_exclude_tokens: true, setup_complete: true, sealed_tcg_extra_enabled: 'yes' },
  ]) {
    const r = await put('/api/settings', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.deepStrictEqual({ ...(await settingsRow()) }, before, `a refused save changes nothing: ${JSON.stringify(body)}`);
  }
  const ok = await put('/api/settings', { scan_exclude_tokens: true, setup_complete: true, price_refresh_days: 3, public_base_url: 'https://cards.example.com/' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.deepStrictEqual({ ...(await settingsRow()) },
    { scan_exclude_tokens: 1, setup_complete: 1, price_refresh_days: 3, public_base_url: 'https://cards.example.com' });
  assert.strictEqual(ok.json.public_base_url, 'https://cards.example.com', 'the answer is the saved settings');
  console.log('PASS: a settings save is validated whole before anything is written');

  // --- PUT /api/admin/users/:id -----------------------------------------------------
  const hashOf = async (id) => (await db.get(`SELECT password_hash FROM users WHERE id = ?`, [id])).password_hash;
  const sessionsOf = async (id) => (await db.get(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [id])).n;
  let r = await put(`/api/admin/users/${memberId}`, { password: 'reset-password-1', role: 'superuser' });
  assert.strictEqual(r.status, 400);
  assert.ok(verifyPassword('worker-password-1', await hashOf(memberId)), 'a refused edit does not change the password');
  assert.strictEqual(await sessionsOf(memberId), 1, 'nor sign the user out');

  r = await put(`/api/admin/users/${adminId}`, { password: 'boss-password-2', role: 'member' });
  assert.strictEqual(r.status, 400, 'an admin cannot demote themselves');
  assert.ok(verifyPassword('boss-password-1', await hashOf(adminId)), 'and the password in the same request is not saved');

  r = await put(`/api/admin/users/${memberId}`, { password: 'reset-password-1', role: 'admin' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.ok(verifyPassword('reset-password-1', await hashOf(memberId)), 'a valid edit saves the password');
  assert.strictEqual(await sessionsOf(memberId), 0, 'signs the user out');
  assert.strictEqual((await db.get(`SELECT role FROM users WHERE id = ?`, [memberId])).role, 'admin', 'and saves the role');
  console.log('PASS: an admin\'s user edit is validated whole before anything is written');

  console.log('PASS: settingsatomic.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
