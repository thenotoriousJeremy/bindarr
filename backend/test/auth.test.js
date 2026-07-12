// Smoke tests for the security-critical auth + per-user isolation paths.
// Framework-free (node + assert), throwaway SQLite. Run via `npm test`.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-auth-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { verifyPassword } = require('../src/utils/authHelpers');

function cleanup() {
  try { db.dbConnection.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
}

function testPasswordHashing() {
  const hash = db.hashPassword('correct horse battery');
  assert(verifyPassword('correct horse battery', hash), 'correct password must verify');
  assert(!verifyPassword('wrong password', hash), 'wrong password must not verify');

  // Legacy 2-part (salt:hash, implied 10000 iterations) hashes must still verify.
  const salt = 'deadbeef';
  const legacyHex = crypto.pbkdf2Sync('legacy-pw', salt, 10000, 64, 'sha512').toString('hex');
  assert(verifyPassword('legacy-pw', `${salt}:${legacyHex}`), 'legacy 2-part hash must verify');
  assert(!verifyPassword('nope', `${salt}:${legacyHex}`), 'legacy hash must reject wrong password');

  // Malformed / empty stored hashes must return false, never throw.
  assert(!verifyPassword('x', ''), 'empty hash => false');
  assert(!verifyPassword('x', 'garbage'), 'unparseable hash => false');
  assert(!verifyPassword('x', 'a:b:c:d'), '4-part hash => false');

  console.log('PASS: password hashing round-trip, legacy format, and malformed input');
}

async function testCollectionIsolation() {
  const alice = 1; // default admin created by initDb
  const bob = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, share_enabled) VALUES (?, ?, ?, ?, ?)`,
    ['bob', db.hashPassword('bobpassword'), 'member', crypto.randomBytes(8).toString('hex'), 0]
  )).lastID;

  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['card-x', 'Pikachu', 'Pokémon', '[]', '[]', 'Common', 's1', 'Set One', '1', '', 5]
  );

  // Alice owns 3 copies, Bob owns 1.
  for (let i = 0; i < 3; i++) {
    await db.run(`INSERT INTO collection (card_id, quantity, user_id) VALUES (?, ?, ?)`, ['card-x', 1, alice]);
  }
  await db.run(`INSERT INTO collection (card_id, quantity, user_id) VALUES (?, ?, ?)`, ['card-x', 1, bob]);

  // The user-scoped read (same shape every collection route uses) must never
  // leak another user's rows.
  const aliceRows = await db.all(`SELECT id FROM collection WHERE user_id = ?`, [alice]);
  const bobRows = await db.all(`SELECT id FROM collection WHERE user_id = ?`, [bob]);
  assert.strictEqual(aliceRows.length, 3, `alice must see only her 3 rows, saw ${aliceRows.length}`);
  assert.strictEqual(bobRows.length, 1, `bob must see only his 1 row, saw ${bobRows.length}`);

  // A scoped delete keyed on the owner must not touch another user's rows —
  // this is the guard every DELETE /collection/:id relies on.
  const del = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [aliceRows[0].id, bob]);
  assert.strictEqual(del.changes, 0, 'bob must not be able to delete alice\'s row via id');
  const stillThere = await db.get(`SELECT id FROM collection WHERE id = ?`, [aliceRows[0].id]);
  assert(stillThere, "alice's row must survive bob's scoped delete");

  console.log('PASS: per-user collection isolation on read and scoped delete');
}

async function main() {
  await db.initDb();
  testPasswordHashing();
  await testCollectionIsolation();
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch(err => { console.error('FAIL:', err.stack || err.message); cleanup(); process.exit(1); });
