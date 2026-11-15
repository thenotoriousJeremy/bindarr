// Bindarr API keys are stored as a hash, like sessions (SEC-13).
//
// A key used to be stored as-is so Settings could show it again, which meant a
// copy of the database, or an admin backup, held a working key to every
// collection that had one. Keys are now stored as their SHA-256 and shown once,
// when made (userkeys.test.js covers the routes). Here: a key stored by an older
// build is hashed in place at the next start and keeps working, only once; the
// stored value is not itself a credential; and an account backup carries no key
// in any form. Plain node + assert, real middleware and routes in this process.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-apikeyhash-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const { hashApiKey, hashSessionToken, generateSession } = require('../src/utils/authHelpers');
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
  const key = `bnd_${crypto.randomBytes(24).toString('hex')}`;
  // A row exactly as builds before this one wrote it.
  const userId = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, api_key) VALUES ('scripted', 'x', 'member', ?, ?)`,
    [crypto.randomBytes(16).toString('hex'), key]
  )).lastID;
  await db.run(`INSERT INTO users (username, password_hash, role, share_token, api_key) VALUES ('blank', 'x', 'member', ?, '')`,
    [crypto.randomBytes(16).toString('hex')]);

  const app = express();
  app.use(express.json());
  app.use('/api', authenticateToken);
  app.get('/api/probe', (req, res) => res.json({ id: req.user.id, viaKey: req.user.via_api_key }));
  app.post('/api/probe', (req, res) => res.json({ ok: true }));
  app.use('/api', require('../src/routes/backup'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const call = async (method, p, token) => {
    const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };

  assert.strictEqual((await call('GET', '/api/probe', key)).status, 401, 'unmigrated, a plaintext key cannot match a hashed lookup');

  await db.initDb();   // the next start
  const stored = (await db.get(`SELECT api_key FROM users WHERE id = ?`, [userId])).api_key;
  assert.strictEqual(stored, hashApiKey(key), 'the key is hashed in place, with the digest the auth gate uses');
  assert.strictEqual(hashApiKey(key), hashSessionToken(key), 'one digest for sessions and keys: one hash per request');
  assert.strictEqual((await db.get(`SELECT api_key FROM users WHERE username = 'blank'`)).api_key, '', 'an empty value is no key, and is left alone');
  const read = await call('GET', '/api/probe', key);
  assert.strictEqual(read.status, 200, 'a key from before the upgrade keeps working');
  assert.deepStrictEqual(read.json, { id: userId, viaKey: true });
  assert.strictEqual((await call('POST', '/api/probe', key)).status, 403, 'and is still read-only');
  assert.strictEqual((await call('GET', '/api/probe', stored)).status, 401, 'what the database holds is not a credential');

  await db.initDb();   // and the one after
  assert.strictEqual((await db.get(`SELECT api_key FROM users WHERE id = ?`, [userId])).api_key, hashApiKey(key),
    'a second start must not hash the hash');
  console.log('PASS: plaintext API keys are hashed once at startup and keep working');

  // An account backup is that account's rows; its key, in any form, is not one.
  const session = await generateSession(userId);
  const backup = await call('GET', '/api/backup', session);
  assert.strictEqual(backup.status, 200);
  assert.ok(!backup.text.includes(key) && !backup.text.includes(stored) && !backup.text.includes('api_key'),
    'a backup never carries an API key to another account or install');
  console.log('PASS: an account backup carries no API key');

  console.log('PASS: apikeyhash.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
