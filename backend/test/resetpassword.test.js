// scripts/reset-password.js: the recovery path for a locked-out admin.
//
// What has to hold: the new password is hashed the way login checks it (and the
// old one stops working); every session the user had is signed out; a random
// password is generated when none is given; and the CLI exits non-zero, without
// touching anything, for an unknown user or a database that is not there.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-resetpassword-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { verifyPassword, generateSession } = require('../src/utils/authHelpers');
const { resetPassword, MIN_LENGTH } = require('../scripts/reset-password');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'reset-password.js');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const hashOf = async (id) => (await db.get(`SELECT password_hash FROM users WHERE id = ?`, [id])).password_hash;
const sessionsOf = async (id) => (await db.get(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [id])).n;

// The CLI as an operator runs it, against the same database file.
const cli = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
  env: { ...process.env, DB_PATH: tmpDb, NEW_PASSWORD: '', ...env },
  encoding: 'utf8'
});

async function main() {
  await db.initDb();
  const mkUser = async (name, password) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'admin', ?)`,
    [name, db.hashPassword(password), crypto.randomBytes(16).toString('hex')]
  )).lastID;
  const trainerId = await mkUser('trainer', 'old-password-1');
  const bystanderId = await mkUser('bystander', 'their-password-1');
  await generateSession(trainerId);
  await generateSession(trainerId);
  await generateSession(bystanderId);

  // --- A chosen password: hashed like the app, sessions gone ---------------------
  const chosen = await resetPassword('  Trainer ', { password: 'brand-new-pass' });
  assert.deepStrictEqual(
    { username: chosen.username, generated: chosen.generated, signedOut: chosen.signedOut },
    { username: 'trainer', generated: false, signedOut: 2 },
    'matched the way login matches names, and both sessions were signed out'
  );
  assert.ok(verifyPassword('brand-new-pass', await hashOf(trainerId)), 'login verifies the new password');
  assert.ok(!verifyPassword('old-password-1', await hashOf(trainerId)), 'and no longer the old one');
  assert.strictEqual(await sessionsOf(trainerId), 0);
  assert.strictEqual(await sessionsOf(bystanderId), 1, "another user's sessions are untouched");
  assert.ok(verifyPassword('their-password-1', await hashOf(bystanderId)));
  console.log('PASS: a chosen password is hashed as login expects and every session is signed out');

  // --- No password given: a random one, strong enough --------------------------
  const random = await resetPassword('trainer');
  assert.strictEqual(random.generated, true);
  assert.ok(random.password.length >= 16, 'a generated password is long');
  assert.match(random.password, /^[A-Za-z0-9_-]+$/, 'and needs no quoting in a shell');
  assert.ok(verifyPassword(random.password, await hashOf(trainerId)));
  assert.notStrictEqual((await resetPassword('trainer')).password, random.password, 'and differs every time');
  console.log('PASS: with no password given, a random one is set');

  // --- Refusals -----------------------------------------------------------------
  assert.strictEqual(await resetPassword('nobody'), null, 'an unknown user is reported, not created');
  const before = await hashOf(trainerId);
  await assert.rejects(() => resetPassword('trainer', { password: 'x'.repeat(MIN_LENGTH - 1) }), /at least/);
  assert.strictEqual(await hashOf(trainerId), before, 'a refused password changes nothing');
  console.log('PASS: unknown users and short passwords are refused');

  // --- The CLI -------------------------------------------------------------------
  const ok = cli(['trainer'], { NEW_PASSWORD: 'cli-password-1' });
  assert.strictEqual(ok.status, 0, `CLI reset should succeed: ${ok.stderr}`);
  assert.match(ok.stdout, /reset/);
  assert.ok(!ok.stdout.includes('cli-password-1'), 'a password the operator supplied is not echoed back');
  assert.ok(verifyPassword('cli-password-1', await hashOf(trainerId)));

  const generated = cli(['trainer']);
  assert.strictEqual(generated.status, 0, generated.stderr);
  const printed = (generated.stdout.match(/New password: (\S+)/) || [])[1];
  assert.ok(printed && verifyPassword(printed, await hashOf(trainerId)), 'the printed password is the one that was set');

  const unknown = cli(['nobody']);
  assert.strictEqual(unknown.status, 1, 'an unknown user exits 1');
  assert.match(unknown.stderr, /No user named "nobody"/);
  assert.strictEqual(cli([]).status, 2, 'no username is a usage error');

  const missing = path.join(os.tmpdir(), `bindarr-resetpassword-missing-${process.pid}.db`);
  const nowhere = cli(['trainer'], { DB_PATH: missing });
  assert.strictEqual(nowhere.status, 2, 'no database is an error');
  assert.ok(!fs.existsSync(missing), 'and the script must not have created one');
  console.log('PASS: the CLI exits 0 on success, 1 for an unknown user, 2 for bad usage');

  console.log('PASS: resetpassword.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
