// Graceful shutdown (utils/shutdown.js), driven directly rather than by sending
// signals: Windows cannot deliver SIGTERM to a child in any useful way, so a
// spawn-and-signal test would pass or fail on the platform, not on the code.
//
// What the sequence promises, each asserted here: it stops accepting connections
// but lets a request in progress finish; stops the jobs; waits for running work,
// but only so long; closes the database after the work; exits with the code it
// was given; and a second signal exits at once.
//
// No framework — plain node + assert, real HTTP servers on ephemeral ports.
// Run: `node test/shutdown.test.js`
const assert = require('assert');
const http = require('http');
const { createShutdown, closeServer, whenTrue } = require('../src/utils/shutdown');

function quietLog() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
}
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const pause = (ms) => new Promise(r => setTimeout(r, ms));

function exitRecorder() {
  let resolveExit;
  const exited = new Promise(r => { resolveExit = r; });
  const codes = [];
  return { codes, exited, exit: (code) => { codes.push(code); resolveExit(code); } };
}

async function orderlyShutdown() {
  let requestArrived;
  const arrived = new Promise(r => { requestArrived = r; });
  const server = http.createServer((req, res) => {
    requestArrived();
    setTimeout(() => res.end('finished'), 150);
  });
  const port = await listen(server);
  const inFlight = fetch(`http://127.0.0.1:${port}/slow`).then(r => r.text());
  await arrived;

  const order = [];
  const ex = exitRecorder();
  const q = quietLog();
  let releaseWork;
  const work = new Promise(r => { releaseWork = r; });
  const shutdown = createShutdown({
    servers: () => [server, null],
    stopJobs: () => order.push('stopJobs'),
    pendingWork: () => [{ name: 'price-sweeps', promise: work.then(() => order.push('work done')) }, { name: 'idle', promise: null }],
    closeDb: async () => order.push('closeDb'),
    exit: (code) => { order.push(`exit ${code}`); ex.exit(code); },
    log: q,
    graceMs: 2000,
  });

  const done = shutdown('SIGTERM');
  assert.deepStrictEqual(order, ['stopJobs'], 'jobs are stopped straight away');
  await pause(20);
  assert.deepStrictEqual(order, ['stopJobs'], 'and the database is not closed under running work');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/new`), 'a new connection is refused once shutdown begins');
  assert.strictEqual(await inFlight, 'finished', 'the request in progress still gets its answer');
  releaseWork();
  assert.strictEqual(await ex.exited, 0, 'a signal exits 0');
  await done;
  assert.deepStrictEqual(order, ['stopJobs', 'work done', 'closeDb', 'exit 0'], 'the database closes after the work, and the exit comes last');
  assert.strictEqual(server.listening, false);
  assert.ok(q.lines.some(l => l.startsWith('SIGTERM: shutting down')), 'the reason is logged');
}

async function hungWorkIsAbandonedOnTime() {
  const ex = exitRecorder();
  const q = quietLog();
  let closed = false;
  const shutdown = createShutdown({
    pendingWork: () => [{ name: 'catalog build', promise: new Promise(() => {}) }, { name: 'backup', promise: Promise.resolve() }],
    closeDb: async () => { closed = true; },
    exit: ex.exit,
    log: q,
    graceMs: 100,
  });
  const started = Date.now();
  shutdown('SIGTERM');
  assert.strictEqual(await ex.exited, 0);
  const took = Date.now() - started;
  assert.ok(took >= 90 && took < 2000, `waits about graceMs for hung work, then goes on (took ${took}ms)`);
  assert.ok(closed, 'the database is still closed');
  const warning = q.lines.find(l => l.includes('still running'));
  assert.ok(warning && warning.includes('catalog build') && !warning.includes('backup'), `names only what did not finish: ${warning}`);
}

async function secondSignalForcesExit() {
  const ex = exitRecorder();
  const codes = [];
  const shutdown = createShutdown({
    pendingWork: () => [{ name: 'forever', promise: new Promise(() => {}) }],
    exit: (code) => { codes.push(code); ex.exit(code); },
    log: quietLog(),
    graceMs: 5000,
  });
  const first = shutdown('SIGTERM');
  await pause(10);
  const second = shutdown('SIGINT');
  assert.deepStrictEqual(codes, [1], 'a second signal exits at once, with 1');
  assert.strictEqual(second, first, 'and is the same shutdown, not a new one');
}

async function databaseTroubleDoesNotBlockTheExit() {
  let ex = exitRecorder();
  let q = quietLog();
  createShutdown({
    closeDb: async () => { throw new Error('SQLITE_BUSY: unable to close'); },
    exit: ex.exit, log: q, graceMs: 50,
  })('SIGTERM');
  assert.strictEqual(await ex.exited, 0);
  assert.ok(q.lines.some(l => l.includes('did not close cleanly') && l.includes('SQLITE_BUSY')), 'a failed close is logged');

  ex = exitRecorder();
  q = quietLog();
  const started = Date.now();
  createShutdown({
    closeDb: () => new Promise(() => {}),
    exit: ex.exit, log: q, graceMs: 50, dbCloseMs: 100,
  })('SIGTERM');
  await ex.exited;
  assert.ok(Date.now() - started < 2000, 'a close that never returns is bounded too');
  assert.ok(q.lines.some(l => l.includes('did not close within')));
}

async function fatalStartupExitsNonZero() {
  const ex = exitRecorder();
  const q = quietLog();
  const neverListened = http.createServer();
  createShutdown({
    servers: () => [neverListened],
    stopJobs: () => { throw new Error('scheduler not started'); },
    pendingWork: () => [{ name: 'database startup', promise: Promise.reject(new Error('SQLITE_CANTOPEN')) }],
    exit: ex.exit,
    log: q,
    graceMs: 1000,
  })('Database initialisation failed', 1);
  assert.strictEqual(await ex.exited, 1, 'the code it is given is the code it exits with');
  assert.ok(q.lines.some(l => l.includes('could not stop background jobs')), 'a step that throws is logged and skipped');
  assert.ok(!q.lines.some(l => l.includes('still running')), 'rejected work counts as finished');
}

async function helpers() {
  await closeServer(null);
  await closeServer(http.createServer());   // never listened
  let flag = false;
  setTimeout(() => { flag = true; }, 30);
  await whenTrue(() => flag, 5);
  assert.ok(flag, 'whenTrue resolves once its test passes');
}

async function main() {
  await orderlyShutdown();
  await hungWorkIsAbandonedOnTime();
  await secondSignalForcesExit();
  await databaseTroubleDoesNotBlockTheExit();
  await fatalStartupExitsNonZero();
  await helpers();
  console.log('shutdown.test.js: listeners close, jobs stop, work is waited for within bounds, database closes, exit codes hold');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
