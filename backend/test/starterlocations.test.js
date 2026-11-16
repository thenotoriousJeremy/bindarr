// Every new account gets the starter binder and box (SEC-20).
//
// seedStarterLocations counted the locations of the whole install, so once the
// first account had them nobody else ever did: SSO users were seeded into
// nothing, and self-registration and the admin's Add User never called it at all.
// It now counts only the given account's own locations, whoever calls it, and
// every route that creates an account calls it. initDb seeds only an owner it has
// just created, so an existing owner who deleted theirs does not get them back on
// a restart, even when nobody else on the install has any storage either.
//
// The real routers in this process. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-starterlocations-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'owner-password-1';
process.env.ALLOW_REGISTRATION = 'true';

const express = require('express');
const db = require('../src/db');
const { generateSession } = require('../src/utils/authHelpers');

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

const locationsOf = async (userId) =>
  (await db.all(`SELECT name FROM locations WHERE user_id = ? ORDER BY name`, [userId])).map(l => l.name);
const STARTER = ['Bulk Storage Box 1', 'Main Binder'];

async function main() {
  await db.initDb();
  const owner = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  assert.deepStrictEqual(await locationsOf(owner.id), STARTER, 'the owner gets them, as before');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/admin', require('../src/routes/admin'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const post = async (p, body, token) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  // Self-registration.
  let r = await post('/api/auth/register', { username: 'newcomer', password: 'newcomer-password-1' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const newcomer = await db.get(`SELECT id FROM users WHERE username = 'newcomer'`);
  assert.deepStrictEqual(await locationsOf(newcomer.id), STARTER, 'a registered member gets the pair too');

  // The admin's Add User.
  r = await post('/api/admin/users', { username: 'invited', password: 'invited-password-1' }, await generateSession(owner.id));
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const invited = await db.get(`SELECT id FROM users WHERE username = 'invited'`);
  assert.deepStrictEqual(await locationsOf(invited.id), STARTER, 'so does an account an admin creates');
  const compartments = await db.get(
    `SELECT COUNT(*) AS n FROM compartments c JOIN locations l ON l.id = c.location_id WHERE l.user_id = ?`, [invited.id]
  );
  assert.strictEqual(compartments.n, 12, 'with their pages and rows');
  console.log('PASS: registration and Add User seed the starter binder and box');

  // Counted per account: one that already has a location is left alone.
  await db.seedStarterLocations(invited.id);
  assert.deepStrictEqual(await locationsOf(invited.id), STARTER, 'seeding twice adds nothing');

  // A member is seeded however much storage the rest of the install has: only
  // their own locations count, with no option needed to say so.
  const member = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, share_enabled) VALUES (?, ?, ?, ?, ?)`,
    ['plainmember', '!', 'member', 'plainmember-token', 0]
  );
  assert.ok((await db.get(`SELECT COUNT(*) AS n FROM locations`)).n > 0, 'other accounts already have storage');
  await db.seedStarterLocations(member.lastID);
  assert.deepStrictEqual(await locationsOf(member.lastID), STARTER, 'the member gets their own pair');
  assert.deepStrictEqual(await locationsOf(owner.id), STARTER, 'and nobody else gains any');

  // The boot-time call: an owner who deleted theirs does not get them back.
  await db.run(`DELETE FROM locations WHERE user_id = ?`, [owner.id]);
  await db.initDb();   // a restart
  assert.deepStrictEqual(await locationsOf(owner.id), [], 'a restart does not re-seed an owner who removed them');

  // Not even when nobody on the install has any storage left, which the old
  // install-wide count read as "a new install" and seeded again.
  await db.run(`DELETE FROM locations`);
  await db.initDb();
  assert.deepStrictEqual(await locationsOf(owner.id), [], 'an empty install does not re-seed its owner on restart');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM locations`)).n, 0, 'nor anyone else');
  console.log('PASS: seeding counts the account\'s own locations, and a restart re-seeds nobody');

  console.log('PASS: starterlocations.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
