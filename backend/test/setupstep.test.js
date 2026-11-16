// The setup wizard reopens at the step it was closed on.
//
// Its first screen promised "close the wizard at any point and it resumes here",
// but only setup_complete was stored, so a wizard closed on the keys step came
// back on the language step. app_settings.setup_step now holds the step's name,
// written by an admin's PUT /api/settings and read back by GET.
//
// The real router and auth gate in this process. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-setupstep-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const { generateSession } = require('../src/utils/authHelpers');
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
  const addUser = async (name, role) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    [name, '!', role, crypto.randomBytes(16).toString('hex')]
  )).lastID;
  const adminToken = await generateSession(await addUser('boss', 'admin'));
  const memberToken = await generateSession(await addUser('worker', 'member'));

  const app = express();
  app.use(express.json());
  app.use('/api', authenticateToken);
  app.use('/api/settings', require('../src/routes/settings'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const call = async (method, body, token = adminToken) => {
    const res = await fetch(`${base}/api/settings`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const stored = async () => (await db.get(`SELECT setup_step FROM app_settings WHERE id = 1`)).setup_step;

  let r = await call('GET');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.setup_complete, false, 'a new install has not finished the wizard');
  assert.strictEqual(r.json.setup_step, '', 'and starts it at the first step');

  r = await call('PUT', { setup_step: 'keys' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.setup_step, 'keys', 'the answer is the saved step');
  assert.strictEqual((await call('GET', undefined, memberToken)).json.setup_step, 'keys', 'read back by GET');
  console.log('PASS: the step the wizard is on is saved and read back');

  // Anything but a short lower-case name is refused, and changes nothing.
  for (const bad of [3, true, null, {}, ['keys'], 'Keys', 'keys; DROP TABLE users', 'x'.repeat(33)]) {
    r = await call('PUT', { setup_step: bad });
    assert.strictEqual(r.status, 400, `refused: ${JSON.stringify(bad)}`);
    assert.strictEqual(await stored(), 'keys', `a refused step changes nothing: ${JSON.stringify(bad)}`);
  }
  r = await call('PUT', { setup_step: 'storage' }, memberToken);
  assert.strictEqual(r.status, 403, 'only an admin moves the wizard');
  assert.strictEqual(await stored(), 'keys');
  console.log('PASS: a malformed step, or a member\'s, is refused');

  // Finishing (or skipping) marks it done and clears the step in one save.
  r = await call('PUT', { setup_complete: true, setup_step: '' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.setup_complete, true);
  assert.strictEqual(r.json.setup_step, '');
  console.log('PASS: finishing clears the step');

  console.log('PASS: setupstep.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
