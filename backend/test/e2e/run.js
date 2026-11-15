// Runs every e2e suite in test/e2e, one process each, one after another.
//
//   node test/e2e/run.js                 every suite
//   node test/e2e/run.js isolation lists only suites whose file names contain one of these
//
// No e2e process may reach the network. The suites start their servers through
// harness.js, which preloads offline.js; on top of that, every process this run
// starts loads netguard.js through NODE_OPTIONS, so a connection or DNS lookup to
// anything but this machine is refused whoever makes it. Both write to one log:
// the summary counts the provider requests offline.js answered, lists every
// connection netguard refused, and fails the run on any refusal. Before the first
// suite, a probe checks that netguard really does stop a connection on this Node.
//
// A suite gets FILE_TIMEOUT_MS, then it is killed and counted as failed (its server
// notices and exits: see offline.js). PASS and FAIL lines are read whole, from both
// streams, and reported with the suite's file name, because case ids repeat across
// suites (F9-TC1 is in seven of them).
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { clearStaleTestFiles } = require('../tempFiles');

process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
process.env.BINDARR_DISABLE_FX_SYNC = '1';

const TEST_DIR = __dirname;
const NETGUARD = path.join(TEST_DIR, 'netguard.js');
// The slowest suite (malformed, about 3,700 requests) takes a minute on a laptop.
const FILE_TIMEOUT_MS = Number(process.env.E2E_FILE_TIMEOUT_MS) || 5 * 60 * 1000;

const filters = process.argv.slice(2);
const files = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !filters.length || filters.some(x => f.includes(x)))
  .sort();

clearStaleTestFiles();
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-e2e-run-${process.pid}-`));
const NET_LOG = path.join(runDir, 'network.log');

// Every child, and every process it starts, preloads the guard and writes to the
// log. JSON quoting is what NODE_OPTIONS expects for a path with spaces or
// backslashes in it.
const guardOption = `--require ${JSON.stringify(NETGUARD)}`;
const childEnv = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, guardOption].filter(Boolean).join(' '),
  BINDARR_E2E_NET_LOG: NET_LOG,
  // Every suite drives the API as the 'admin' account. initDb only seeds that
  // account when a password is pinned — a real fresh install gets its owner
  // from the setup wizard instead, and a headless test has no browser.
  DEFAULT_ADMIN_PASSWORD: 'test-admin-password',
};

// A connection to TEST-NET-1 (192.0.2.0/24, which routes nowhere) from a process
// started the way the suites are. Refused at once means the guard works on this
// Node; anything else means the zero below would prove nothing.
function guardWorks() {
  const log = path.join(runDir, 'self-check.log');
  const probe = `fetch('http://192.0.2.1/', { signal: AbortSignal.timeout(5000) })
    .then(() => process.exit(2), (e) => process.exit(e.cause && e.cause.code === 'ECONNREFUSED' ? 0 : 3));`;
  const { status } = spawnSync(process.execPath, ['-e', probe], {
    env: { ...childEnv, BINDARR_E2E_NET_LOG: log },
    stdio: 'ignore',
    timeout: 20000,
  });
  const logged = fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('refused connection to 192.0.2.1:80');
  return status === 0 && logged;
}

function runSuite(file) {
  return new Promise((resolve) => {
    console.log(`\n=========================================`);
    console.log(`RUNNING TEST SUITE: ${file}`);
    console.log(`=========================================`);

    const started = Date.now();
    const result = { file, passed: [], failed: [], code: null, signal: null, timedOut: false };
    const child = spawn(process.execPath, [path.join(TEST_DIR, file)], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });

    const scan = (line) => {
      const m = /^(PASS|FAIL): (F\d+-TC\d+)\b/.exec(line);
      if (m) (m[1] === 'PASS' ? result.passed : result.failed).push(m[2]);
    };
    for (const [stream, echo] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on('data', (chunk) => echo.write(chunk));
      readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', scan);
    }

    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill('SIGKILL');
    }, FILE_TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      Object.assign(result, { code, signal, seconds: (Date.now() - started) / 1000 });
      // A FAIL line fails the suite even if it then exited 0.
      const ok = code === 0 && !result.timedOut && !result.failed.length;
      if (ok) console.log(`PASS: ${file} executed successfully (${result.seconds.toFixed(1)} s).`);
      else if (result.timedOut) console.error(`FAIL: ${file} was killed after ${FILE_TIMEOUT_MS / 1000} s.`);
      else console.error(`FAIL: ${file} exited with code ${code}${signal ? ` (${signal})` : ''}.`);
      result.ok = ok;
      resolve(result);
    });
  });
}

// "offline GET https://api.tcgdex.net/v2/en/sets from server.js (pid 123)" -> api.tcgdex.net
function hostOf(line) {
  const m = /\bhttps?:\/\/([^/\s:]+)/.exec(line);
  return m ? m[1] : line.split(' ').slice(1, 3).join(' ');
}

function countBy(lines, key) {
  const counts = new Map();
  for (const l of lines) counts.set(key(l), (counts.get(key(l)) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

async function main() {
  if (!files.length) {
    console.error(filters.length ? `No e2e suite matches ${filters.join(', ')}.` : `No e2e suites found under ${TEST_DIR}.`);
    process.exit(1);
  }
  const guarded = guardWorks();
  if (!guarded) console.error('FAIL: netguard did not refuse a test connection on this Node; this run cannot show it stayed offline.');

  console.log(`Discovered ${files.length} E2E test files under ${TEST_DIR}.`);
  const results = [];
  for (const file of files) results.push(await runSuite(file));

  const lines = fs.existsSync(NET_LOG) ? fs.readFileSync(NET_LOG, 'utf8').split('\n').filter(Boolean) : [];
  const refused = lines.filter(l => l.startsWith('refused '));
  const offline = lines.filter(l => l.startsWith('offline '));

  const failedSuites = results.filter(r => !r.ok);
  const passedCases = results.reduce((n, r) => n + r.passed.length, 0);
  // A suite that failed without naming a case still counts as one failed case.
  const failedCases = results.reduce((n, r) => n + (r.failed.length || (r.ok ? 0 : 1)), 0);

  console.log(`\n=========================================`);
  console.log(`E2E TEST RUNNER RESULT SUMMARY:`);
  console.log(`  Passed suites: ${results.length - failedSuites.length} / ${results.length}`);
  console.log(`  Failed suites: ${failedSuites.length} / ${results.length}`);
  console.log(`  Passed test cases: ${passedCases}`);
  console.log(`  Failed test cases: ${failedCases}`);
  console.log(`  Total test cases:  ${passedCases + failedCases}`);
  console.log(`  Network: ${refused.length} outbound connection(s) refused; ${offline.length} provider request(s) answered offline` +
    (offline.length ? ` (${countBy(offline, hostOf).map(([h, n]) => `${h} ${n}`).join(', ')})` : '') + '.');
  console.log(`=========================================`);

  for (const r of failedSuites) {
    const cases = r.failed.length ? r.failed.map(id => `${r.file} ${id}`).join(', ') : `${r.file} (no case reported)`;
    console.error(`Failed: ${cases}`);
  }
  if (refused.length) {
    console.error('\nOutbound connections the e2e run attempted (refused by netguard.js; answer them in offline.js):');
    for (const [line, n] of countBy(refused, l => l.replace(/ \(pid \d+\)$/, ''))) console.error(`  ${n > 1 ? `${n} x ` : ''}${line}`);
  }

  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* the next run clears it */ }
  process.exit(failedSuites.length || refused.length || !guarded ? 1 : 0);
}

main().catch(err => {
  console.error('Unhandled runner error:', err);
  process.exit(1);
});
