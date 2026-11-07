// Database backups (backup.js): written atomically and verified, kept in
// BACKUP_DIR, rotated by kind, downloadable only from inside that directory, and
// on an interval that is validated rather than trusted.
//
// The failure this guards against first: a backup written straight to its final
// name, cut short by a full disk or a killed process, looks exactly like a good
// one until the day it is restored.
//
// No framework — plain node + assert, a real temporary database and a scratch
// BACKUP_DIR. Run: `node test/backup.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-backup-test-'));
const tmpDb = path.join(os.tmpdir(), `bindarr-backup-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* not there */ }
}
process.env.DB_PATH = tmpDb;
process.env.BACKUP_DIR = path.join(scratch, 'backups');
process.env.BACKUP_KEEP_LAST = '2';
delete process.env.BACKUP_INTERVAL_HOURS;

const db = require('../src/db');
const backup = require('../src/backup');

const dir = process.env.BACKUP_DIR;
const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const pause = (ms) => new Promise(r => setTimeout(r, ms));

function readOnly(file, sql) {
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      conn.all(sql, (e, rows) => conn.close(() => (e ? reject(e) : resolve(rows))));
    });
  });
}

async function writesVerifiedSnapshotsIntoBackupDir() {
  assert.strictEqual(backup.BACKUP_DIR, path.resolve(dir), 'BACKUP_DIR comes from the environment');
  await db.run(`INSERT INTO sets (id, name, game) VALUES ('kept-set', 'kept', 'pokemon')`);
  const meta = await backup.createBackup();
  assert.ok(meta.file.endsWith('.bak') && meta.size > 0);
  assert.strictEqual(meta.kind, 'regular');
  assert.deepStrictEqual(files(), [meta.file], 'one .bak and no leftover temporary file');
  const [set] = await readOnly(path.join(dir, meta.file), `SELECT name FROM sets WHERE id = 'kept-set'`);
  assert.strictEqual(set.name, 'kept', 'the snapshot is a readable copy of the database');
  assert.deepStrictEqual(backup.listBackups().map(b => [b.file, b.kind]), [[meta.file, 'regular']]);
  return meta;
}

async function failedVerificationKeepsWhatWasThere() {
  const before = files();
  await assert.rejects(
    backup.createBackup({ verify: async () => { throw new Error('simulated truncated snapshot'); } }),
    /simulated truncated snapshot/
  );
  assert.deepStrictEqual(files(), before, 'no new .bak, no .tmp left behind, earlier backups untouched');
}

async function verifyRejectsDamagedFiles(good) {
  const goodPath = path.join(dir, good.file);
  await backup.verifySnapshot(goodPath, { tables: 5 });   // a whole snapshot passes

  const bytes = fs.readFileSync(goodPath);
  const truncated = path.join(scratch, 'truncated.db');
  fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
  await assert.rejects(backup.verifySnapshot(truncated, { tables: 5 }), 'a truncated snapshot is refused');

  const garbage = path.join(scratch, 'garbage.db');
  fs.writeFileSync(garbage, Buffer.alloc(8192, 7));
  await assert.rejects(backup.verifySnapshot(garbage, { tables: 5 }), 'a file that is not a database is refused');

  // quick_check calls a 0-byte database "ok"; the table count is what catches it.
  const empty = path.join(scratch, 'empty.db');
  fs.writeFileSync(empty, '');
  await assert.rejects(backup.verifySnapshot(empty, { tables: 5 }), /holds 0 tables/);
}

async function staleTempFilesAreCleared() {
  fs.writeFileSync(path.join(dir, 'bindarr.2020-01-01T00-00-00-000Z.bak.tmp'), 'left by a killed process');
  await pause(15);
  await backup.createBackup();
  assert.ok(!files().some(f => f.endsWith('.tmp')), 'the next backup clears a temporary file a crash left behind');
}

async function rotationIsPerKind() {
  const pre = await backup.createPreMigrationBackup({ from: '1.0.0', to: '1.0.1' });
  assert.strictEqual(pre.kind, 'pre-migration');
  assert.ok(pre.file.startsWith('pre-migration-'), pre.file);
  for (let i = 0; i < 3; i++) { await pause(15); await backup.createBackup(); }
  const regular = backup.listBackups().filter(b => b.kind === 'regular');
  assert.strictEqual(regular.length, 2, 'regular backups rotate to BACKUP_KEEP_LAST');
  assert.ok(files().includes(pre.file), 'and never push out a pre-migration snapshot');

  const again = await backup.createPreMigrationBackup({ from: '1.0.0', to: '1.0.1' });
  assert.strictEqual(again.reused, true, 'a second attempt at the same upgrade reuses the first snapshot');
  assert.strictEqual(again.file, pre.file);

  for (const [from, to] of [['1.0.1', '1.0.2'], ['1.0.2', '1.0.3'], [null, '1.0.4']]) {
    await pause(15);
    await backup.createPreMigrationBackup({ from, to });
  }
  const kept = backup.listBackups().filter(b => b.kind === 'pre-migration').map(b => b.file);
  assert.strictEqual(kept.length, backup.KEEP_PRE_MIGRATION, 'pre-migration snapshots keep their own last three');
  assert.ok(!kept.includes(pre.file), 'the oldest one is the one that goes');
  assert.ok(kept.some(f => f.includes('-unversioned-to-1.0.4-')), 'a database no release has marked is named as such');
  assert.strictEqual(backup.listBackups().filter(b => b.kind === 'regular').length, 2, 'and they do not cost a regular backup');
}

function downloadsStayInsideBackupDir() {
  const [newest] = backup.listBackups();
  assert.strictEqual(backup.resolveBackupFile(newest.file), path.join(path.resolve(dir), newest.file));
  fs.writeFileSync(path.join(scratch, 'outside.bak'), 'not a backup');
  fs.mkdirSync(path.join(dir, 'folder.bak'));
  for (const name of [
    '../outside.bak', '..\\outside.bak', `sub/${newest.file}`, `C:${newest.file}`, `${newest.file}:stream`,
    '.hidden.bak', 'notes.txt', 'missing.bak', 'folder.bak', '', null, undefined, 42,
    path.join(scratch, 'outside.bak'),
  ]) {
    assert.strictEqual(backup.resolveBackupFile(name), null, `${JSON.stringify(name)} must not resolve`);
  }
  fs.rmdirSync(path.join(dir, 'folder.bak'));
}

function intervalIsValidated() {
  const p = backup.parseIntervalHours;
  assert.deepStrictEqual(p(undefined), { hours: 24 });
  assert.deepStrictEqual(p(''), { hours: 24 }, 'an empty value is unset, not "off"');
  assert.deepStrictEqual(p('0'), { hours: 0 });
  assert.deepStrictEqual(p('12'), { hours: 12 });
  assert.deepStrictEqual(p('24h'), { hours: 24 }, 'still read leniently, as before');
  // 597h and up used to overflow setInterval's 2^31-1 ms and fire every millisecond.
  assert.deepStrictEqual(p('600'), { hours: 600 });
  for (const bad of ['abc', '-1', 'NaN', 'Infinity']) {
    const r = p(bad);
    assert.strictEqual(r.hours, 24, `${bad} falls back to the default`);
    assert.ok(r.warning && r.warning.includes(bad), `and says so (${bad})`);
  }
  assert.strictEqual(p('0.1').hours, 0.25, 'below what the scheduler can honour is raised to its floor');
  assert.ok(p('0.1').warning);
  assert.strictEqual(p('100000').hours, 24 * 366, 'more than a year is capped');
  assert.ok(p('100000').warning);
  assert.strictEqual(backup.intervalMs(), 24 * 60 * 60 * 1000, 'unset means daily');
}

async function scheduleHooks() {
  const newestRegular = backup.listBackups().find(b => b.kind === 'regular');
  assert.strictEqual(backup.lastBackupAt().toISOString(), newestRegular.created_at,
    'the schedule counts from the newest regular backup, not a pre-migration snapshot');

  assert.strictEqual(backup.pending(), null, 'idle');
  const a = backup.createBackup();
  const b = backup.createBackup();
  assert.strictEqual(a, b, 'a second request while one is being written gets that one');
  assert.ok(backup.pending(), 'a snapshot in progress is visible to shutdown');
  await a;
  await backup.pending();
  assert.strictEqual(backup.pending(), null);
}

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

async function main() {
  await db.initDb();
  const first = await writesVerifiedSnapshotsIntoBackupDir();
  await failedVerificationKeepsWhatWasThere();
  await verifyRejectsDamagedFiles(first);
  await staleTempFilesAreCleared();
  await rotationIsPerKind();
  downloadsStayInsideBackupDir();
  intervalIsValidated();
  await scheduleHooks();
  console.log('backup.test.js: atomic verified snapshots, BACKUP_DIR, per-kind rotation, contained downloads, validated interval');
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async err => { console.error(err); await cleanup(); process.exit(1); });
