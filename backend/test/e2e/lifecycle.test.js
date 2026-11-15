const path = require('path');
const fs = require('fs');
const assert = require('assert');
const sqlite3 = require('sqlite3');
const harness = require('./harness');

// Server lifecycle against the real server.js: a database that cannot be
// initialised ends the process instead of leaving it listening; the backup
// routes all work in BACKUP_DIR and nowhere else; and the boot records the job
// schedules without backing up a database it has only just created.
//
// Shutdown on SIGTERM is tested directly in test/shutdown.test.js: Windows cannot
// signal a child process in any way that exercises a handler.
const tmp = harness.tempDatabase('lifecycle-test');
const scratch = tmp.dir;
const ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD;

function exitOf(srv, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still running after ${ms / 1000}s`)), ms);
  });
  return Promise.race([srv.exited, timeout]).finally(() => clearTimeout(timer));
}

function readJobRuns(dbFile) {
  return new Promise((resolve) => {
    const conn = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve([]);
      conn.all(`SELECT name, last_status FROM job_runs`, (e, rows) => conn.close(() => resolve(e ? [] : rows)));
    });
  });
}

// F9-TC1: DB_PATH under a regular file cannot be opened. The server used to log
// that and keep listening, its health check answering 503 forever.
async function initFailureExits() {
  const notADirectory = path.join(scratch, 'not-a-directory');
  fs.writeFileSync(notADirectory, 'a file, so nothing can be created under it');
  const child = await harness.startServer({ dir: scratch, file: path.join(notADirectory, 'bindarr.db') }, { wait: false });
  let result;
  try {
    result = await exitOf(child, 30000);
  } catch (err) {
    await child.stop();
    throw new Error(`server with an unusable database ${err.message} instead of exiting`);
  }
  assert.strictEqual(result.code, 1, `exit code should be 1, got ${result.code} (${result.signal || 'no signal'})\n${child.stderr()}`);
  assert.ok(child.stderr().includes('Failed to initialize database'), `the reason is logged:\n${child.stderr()}`);
  console.log('PASS: F9-TC1');
}

async function backupsAndSchedules() {
  const dbFile = tmp.file;
  const backupDir = path.join(scratch, 'elsewhere', 'backups');
  // BACKUP_INTERVAL_HOURS back to its default (the harness switches backups off):
  // F9-TC4 is about the backup clock.
  const server = await harness.startServer(tmp, { env: { BACKUP_DIR: backupDir, BACKUP_INTERVAL_HOURS: undefined } });
  const base = server.base;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    });
    assert.strictEqual(login.status, 200, `admin login should succeed, got ${login.status}`);
    const auth = { Authorization: `Bearer ${(await login.json()).token}` };

    // F9-TC2: create, list and download all use BACKUP_DIR.
    const created = await fetch(`${base}/api/admin/backups`, { method: 'POST', headers: auth });
    assert.strictEqual(created.status, 201, `backup should be created, got ${created.status}`);
    const meta = await created.json();
    assert.deepStrictEqual(fs.readdirSync(backupDir), [meta.file], 'the backup is written into BACKUP_DIR, with no temp file left');
    const list = await (await fetch(`${base}/api/admin/backups`, { headers: auth })).json();
    assert.strictEqual(list.dir, path.resolve(backupDir), 'the list reports BACKUP_DIR');
    assert.ok(list.backups.some(b => b.file === meta.file), 'and lists the new backup');
    const download = await fetch(`${base}/api/admin/backups/${encodeURIComponent(meta.file)}/download`, { headers: auth });
    assert.strictEqual(download.status, 200);
    assert.strictEqual((await download.arrayBuffer()).byteLength, fs.statSync(path.join(backupDir, meta.file)).size, 'the download is the file');
    console.log('PASS: F9-TC2');

    // F9-TC3: a download cannot leave BACKUP_DIR.
    fs.copyFileSync(path.join(backupDir, meta.file), path.join(scratch, 'elsewhere', 'outside.bak'));
    for (const name of ['../outside.bak', '..\\outside.bak', `./${meta.file}`, `${meta.file}:x`]) {
      const res = await fetch(`${base}/api/admin/backups/${encodeURIComponent(name)}/download`, { headers: auth });
      assert.strictEqual(res.status, 404, `${name} should be refused, got ${res.status}`);
    }
    console.log('PASS: F9-TC3');

    // F9-TC4: the boot recorded the schedules — and did not back up a database it
    // had just created. The first check runs once the boot's set sync is done. On
    // a fresh database that asks every game's provider for its set list, which
    // offline.js refuses at once, but the wait stays long enough for a slow runner.
    let runs = [];
    for (let i = 0; i < 1200 && !runs.some(r => r.name === 'backup'); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      runs = await readJobRuns(dbFile);
    }
    const status = Object.fromEntries(runs.map(r => [r.name, r.last_status]));
    assert.strictEqual(status['sets-refresh'], 'ok', `the first boot runs the never-run weekly refresh (${JSON.stringify(status)})`);
    assert.strictEqual(status.backup, 'baseline', 'the backup clock starts instead of backing up a fresh database');
    assert.ok(status['session-purge'], 'the purge has run');
    assert.ok(!('tcgcsv-sync' in status), 'a disabled job records nothing');
    assert.ok(!('fx-rates' in status), 'no e2e run talks to the ECB');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepStrictEqual(fs.readdirSync(backupDir), [meta.file], 'no automatic backup at boot');
    console.log('PASS: F9-TC4');
  } catch (err) {
    console.error(server.stdout().slice(-4000));
    console.error(server.stderr().slice(-4000));
    throw err;
  } finally {
    await server.stop();
  }
}

async function runTests() {
  try {
    await initFailureExits();
    await backupsAndSchedules();
  } finally {
    // This process never opened the database, so there is no connection to close.
    await harness.cleanup(null, tmp);
  }
}

runTests()
  .then(() => process.exit(0))
  .catch(err => { console.error('FAIL: lifecycle.test.js -', err.message); process.exit(1); });
