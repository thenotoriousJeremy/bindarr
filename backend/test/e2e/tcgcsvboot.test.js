// A fresh install must not contact TCGCSV at boot.
//
// Since #118 a fresh database made a full TCGCSV sync (~800 requests) the moment
// the server came up: the scheduler's tcgcsv-sync job is overdue on an empty
// job_runs table, so it runs at the first check. Every new install and every dev
// or test boot did that, and it got a developer's IP flagged for overuse.
//
// This boots the REAL server.js with the sync ENABLED, unlike every other suite,
// but with TCGCSV_BASE_URL pointed at a local fake that counts requests, so
// nothing can reach tcgcsv.com whatever the code does. It waits for the scheduler
// to record its tcgcsv-sync run, then asserts the fake was never asked anything.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const { freePort } = require('../freePort');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-tcgcsvboot-'));
const tmpDb = path.join(tmpDir, 'bindarr.db');
const projectRoot = path.join(__dirname, '../../../');

async function waitFor(cond, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await cond()) return true; } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function jobRun(name) {
  const sqlite3 = require(path.join(projectRoot, 'backend/node_modules/sqlite3'));
  return new Promise((resolve) => {
    const conn = new sqlite3.Database(tmpDb, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return resolve(null);
      conn.get(`SELECT last_status FROM job_runs WHERE name = ?`, [name], (err, row) => {
        conn.close(() => resolve(err ? null : row || null));
      });
    });
  });
}

async function runTests() {
  const fakeRequests = [];
  const fake = http.createServer((req, res) => {
    fakeRequests.push(req.url);
    res.writeHead(500);
    res.end();
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

  const port = String(await freePort());
  const env = { ...process.env, PORT: port, DB_PATH: tmpDb, HTTPS_PORT: '', TCGCSV_BASE_URL: fakeUrl, BINDARR_DISABLE_FX_SYNC: '1' };
  delete env.BINDARR_DISABLE_TCGCSV_SYNC;   // the point: the real boot path, sync on
  // The Scryfall fixtures, as the other suites use: the scheduler only starts after
  // startup's set refresh, which would otherwise page live through Scryfall.
  const mockScript = path.join(__dirname, 'scryfall-mock.js');
  const server = spawn('node', ['-r', mockScript, path.join(projectRoot, 'backend/src/server.js')], { env });
  let output = '';
  server.stdout.on('data', d => { output += d; });
  server.stderr.on('data', d => { output += d; });

  try {
    const up = await waitFor(async () => (await fetch(`http://localhost:${port}/api/health`)).ok);
    assert.ok(up, 'server came up');

    // F9-TC1: the scheduler runs tcgcsv-sync at boot on a fresh database, and it
    // makes no request because nothing on the instance needs TCGCSV prices.
    // 'error' counts as having run too: the fake answers 500, so a sync that did
    // reach for TCGCSV fails, and the request assertion below says why.
    const ran = await waitFor(async () => ['ok', 'error'].includes((await jobRun('tcgcsv-sync'))?.last_status), 90000);
    assert.ok(ran, `the scheduler ran tcgcsv-sync at boot (job_runs: ${JSON.stringify(await jobRun('tcgcsv-sync'))}); server said:\n${output.slice(-2000)}`);
    // The hourly price sweep also starts at boot and calls the sync; give it a moment.
    await new Promise(r => setTimeout(r, 1500));
    assert.deepStrictEqual(fakeRequests, [], `a fresh install must make zero TCGCSV requests at boot (saw ${fakeRequests.join(', ')})`);
    assert.match(output, /TCGCSV sync skipped/, 'the skip is logged');
    assert.strictEqual(output.match(/TCGCSV sync skipped/g).length, 1, 'and logged once, not per caller');
    console.log('PASS: F9-TC1');
  } finally {
    // SIGKILL immediately to avoid sqlite3 teardown crashes on Windows
    server.kill('SIGKILL');
    fake.close();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* still locked */ }
  }
}

runTests()
  .then(() => setTimeout(() => process.exit(0), 500))
  .catch(err => { console.error('FAIL: tcgcsvboot.test.js -', err.message); setTimeout(() => process.exit(1), 500); });
