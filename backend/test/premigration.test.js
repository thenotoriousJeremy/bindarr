// The snapshot initDb takes before a different release migrates a database that
// holds data (db.js snapshotBeforeMigrating, backup.createPreMigrationBackup).
//
// PRAGMA user_version records the release that last completed initDb on the
// file; until this code it was always 0. Asserted here: a fresh database is not
// snapshotted, a changed release is, the same release is not again, a restart
// loop on one failing upgrade does not rotate the real pre-upgrade copy out, and
// a snapshot that cannot be written is reported loudly without stopping startup.
//
// No framework — plain node + assert, a real temporary database and a scratch
// BACKUP_DIR. Run: `node test/premigration.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-premigration-test-'));
const tmpDb = path.join(os.tmpdir(), `bindarr-premigration-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* not there */ }
}
process.env.DB_PATH = tmpDb;
process.env.BACKUP_DIR = path.join(scratch, 'backups');

const db = require('../src/db');
const backup = require('../src/backup');

const VERSION = require('../package.json').version;
const [maj, min, pat] = VERSION.split('.').map(n => parseInt(n, 10));
const MARKER = maj * 1e6 + min * 1e3 + pat;

const snapshots = () => backup.listBackups().filter(b => b.kind === 'pre-migration').map(b => b.file).sort();
const userVersion = async () => (await db.get(`PRAGMA user_version`)).user_version;

function snapshotUserVersion(file) {
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(path.join(backup.BACKUP_DIR, file), sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      conn.get(`PRAGMA user_version`, (e, row) => conn.close(() => (e ? reject(e) : resolve(row.user_version))));
    });
  });
}

// Capture console.error for the duration of fn.
async function capturingErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.error = original; }
  return lines;
}

async function main() {
  // A brand-new file: nothing to protect, so no snapshot — but the release is
  // recorded, and a second boot of the same release does nothing at all.
  await db.initDb();
  assert.deepStrictEqual(snapshots(), [], 'a fresh database is not snapshotted');
  assert.strictEqual(await userVersion(), MARKER, 'initDb records the release that brought the schema up to date');
  await db.initDb();
  assert.deepStrictEqual(snapshots(), [], 'the same release booting again takes no snapshot');

  // The same file as an older release left it, now holding data.
  await db.run(`INSERT INTO sets (id, name, game) VALUES ('sv1', 'Scarlet & Violet', 'pokemon')`);
  await db.run(`PRAGMA user_version = 1007000`);
  await db.initDb();
  let snaps = snapshots();
  assert.strictEqual(snaps.length, 1, 'a different release snapshots before it migrates');
  assert.ok(snaps[0].startsWith(`pre-migration-${path.basename(tmpDb, '.db')}-1.7.0-to-${VERSION}-`), snaps[0]);
  assert.strictEqual(await snapshotUserVersion(snaps[0]), 1007000, 'the snapshot is the database as the old release left it');
  assert.strictEqual(await userVersion(), MARKER);
  await db.initDb();
  assert.strictEqual(snapshots().length, 1, 'and only once');

  // A migration that keeps failing restarts the server into the same upgrade
  // again and again. Each attempt must not take a new snapshot: three restarts
  // would rotate the real pre-upgrade copy out.
  await db.run(`PRAGMA user_version = 1007000`);
  await db.initDb();
  assert.deepStrictEqual(snapshots(), snaps, 'a repeated attempt at the same upgrade reuses its snapshot');

  // A database no marked release has opened (every install before this code).
  await db.run(`PRAGMA user_version = 0`);
  await db.initDb();
  snaps = snapshots();
  assert.strictEqual(snaps.length, 2);
  assert.ok(snaps.some(f => f.includes(`-unversioned-to-${VERSION}-`)), snaps.join(', '));

  // The snapshot cannot be written: BACKUP_DIR is a file. Startup carries on —
  // loudly — and the migration is still recorded as done.
  fs.rmSync(backup.BACKUP_DIR, { recursive: true, force: true });
  fs.writeFileSync(backup.BACKUP_DIR, 'not a directory');
  await db.run(`PRAGMA user_version = 1006000`);
  const errors = await capturingErrors(() => db.initDb());
  assert.ok(errors.some(l => l.includes('PRE-MIGRATION SNAPSHOT FAILED')), 'a failed snapshot is reported, not swallowed');
  assert.ok(errors.some(l => l.includes(`1.6.0 -> ${VERSION}`)), 'naming the upgrade it could not protect');
  assert.strictEqual(await userVersion(), MARKER, 'and the boot completes');
  fs.rmSync(backup.BACKUP_DIR, { force: true });

  console.log('premigration.test.js: snapshots once per upgrade of a database with data, never blocks startup');
}

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async err => { console.error(err); await cleanup(); process.exit(1); });
