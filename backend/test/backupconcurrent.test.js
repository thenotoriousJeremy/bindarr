// A backup taken while other requests are reading and writing. VACUUM INTO is
// refused by SQLite ("cannot VACUUM - SQL statements in progress") while any
// other statement on the connection is still running, and the connection lock
// used to dispatch it as soon as no transaction held the connection, in-flight
// reads and writes or not. At boot the scheduler runs the overdue backup next to
// the set sync, so the first backup failed. It now waits for a quiet connection.
//
// Whether SQLite actually trips depends on thread-pool timing, so the test also
// checks the rule itself: the connection is watched, and at the moment VACUUM is
// handed to sqlite3 no other statement may still be unanswered.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-backupconcurrent-test-'));
const tmpDb = path.join(os.tmpdir(), `bindarr-backupconcurrent-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* not there */ }
}
process.env.DB_PATH = tmpDb;
process.env.BACKUP_DIR = path.join(scratch, 'backups');
delete process.env.BACKUP_INTERVAL_HOURS;

const db = require('../src/db');
const backup = require('../src/backup');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* locked */ }
}

// Count the statements sqlite3 has been handed and not yet answered, and note
// that count whenever a VACUUM is handed over.
let outstanding = 0;
const atVacuum = [];
for (const method of ['run', 'get', 'all']) {
  const original = db.dbConnection[method].bind(db.dbConnection);
  db.dbConnection[method] = (sql, params, callback) => {
    if (typeof params === 'function') { callback = params; params = []; }
    if (/^\s*VACUUM/i.test(sql)) atVacuum.push(outstanding);
    outstanding++;
    return original(sql, params, function (...args) {
      outstanding--;
      return callback.apply(this, args);
    });
  };
}

async function main() {
  await db.initDb();
  await db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
  await db.withTransaction(async () => {
    for (let i = 0; i < 2000; i++) await db.run(`INSERT INTO t (v) VALUES (?)`, [`row ${i}`]);
  });

  // Workers that keep reads and writes in flight for as long as the backups run.
  let stop = false;
  const worker = async (i) => {
    let n = 0;
    while (!stop) {
      await Promise.all([
        db.all(`SELECT * FROM t WHERE v LIKE ?`, [`%${i}%`]),
        db.run(`INSERT INTO t (v) VALUES (?)`, [`worker ${i} ${n++}`]),
      ]);
    }
  };
  const workers = Array.from({ length: 8 }, (_, i) => worker(i));
  try {
    for (let round = 0; round < 5; round++) {
      const b = await backup.createBackup();
      assert.ok(b && b.size > 0, 'the backup was written');
    }
  } finally {
    stop = true;
    await Promise.all(workers);
  }
  assert.strictEqual(atVacuum.length, 5);
  assert.deepStrictEqual(atVacuum, [0, 0, 0, 0, 0], 'VACUUM was only ever issued on a quiet connection');
  assert.ok(fs.readdirSync(process.env.BACKUP_DIR).some(f => f.endsWith('.bak')), 'a .bak file exists');
  console.log('backupconcurrent ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
