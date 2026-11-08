// Persisted job schedules (scheduler.js).
//
// The weekly set refresh and the daily backup used to be in-memory intervals, so
// every restart reset their clocks: an install that auto-updates weekly never
// refreshed its sets, and one that restarts daily never backed up. The point of
// these assertions is that the clock now outlives the process — a second
// scheduler over the same database (a restart) sees what the first one ran.
//
// No framework — plain node + assert, a real temporary SQLite file and an
// injected clock. Run: `node test/scheduler.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-scheduler-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* not there */ }
}
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { createScheduler } = require('../src/scheduler');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let clock = Date.parse('2026-01-01T00:00:00Z');
const now = () => clock;

function quietLog() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
}

const rowFor = (name) => db.get(`SELECT * FROM job_runs WHERE name = ?`, [name]);
const make = (jobs, extra = {}) => createScheduler({ jobs, now, log: quietLog(), ...extra });

async function survivesARestart() {
  let runs = 0;
  const job = { name: 'weekly', every: () => 7 * DAY, run: async () => { runs++; } };

  const first = make([job]);
  assert.strictEqual(await first.isDue(job), true, 'a job that has never run is due at once');
  await first.runJob(job);
  assert.strictEqual(runs, 1);
  const row = await rowFor('weekly');
  assert.strictEqual(row.last_status, 'ok');
  assert.strictEqual(Date.parse(row.last_run_at), clock, 'the run is recorded at the time it started');
  assert.strictEqual(await first.isDue(job), false, 'and is not due again straight away');

  // A restart: a new scheduler, the same database. The old setInterval started
  // counting a full week again here; the stored run says only six days remain.
  clock += DAY;
  const second = make([job]);
  assert.strictEqual(await second.isDue(job), false, 'a restart a day later does not reset the clock');
  assert.deepStrictEqual(await second.check(), [], 'nor run the job early');
  clock += 6 * DAY - 1;
  assert.strictEqual(await second.isDue(job), false, 'one millisecond short of the period it is still not due');
  clock += 1;
  assert.strictEqual(await second.isDue(job), true, 'a week after the last run it is due, however many restarts');
  assert.deepStrictEqual(await second.check(), ['weekly'], 'and the next check runs it');
  await Promise.all(second.inFlight().map(w => w.promise));
  assert.strictEqual(runs, 2);
}

async function baselineFromSince() {
  let runs = 0;
  const fresh = { name: 'fresh-backup', every: () => DAY, since: () => null, run: async () => { runs++; } };
  const s = make([fresh]);
  assert.strictEqual(await s.isDue(fresh), false, 'with since(), a never-run job starts its clock instead of running');
  const row = await rowFor('fresh-backup');
  assert.strictEqual(row.last_status, 'baseline');
  assert.strictEqual(Date.parse(row.last_run_at), clock, 'counted from now when since() has nothing');
  clock += DAY;
  assert.strictEqual(await make([fresh]).isDue(fresh), true, 'one period after the baseline it is due, across restarts');

  const old = { name: 'old-backup', every: () => DAY, since: () => new Date(clock - 30 * HOUR), run: async () => { runs++; } };
  assert.strictEqual(await s.isDue(old), true, 'counted from since() when it has a time: 30h ago is overdue for a daily job');
  const future = { name: 'future-backup', every: () => DAY, since: () => clock + 5 * DAY, run: async () => { runs++; } };
  await s.isDue(future);
  assert.strictEqual(Date.parse((await rowFor('future-backup')).last_run_at), clock, 'a since() in the future is clamped to now');
  assert.strictEqual(runs, 0);
}

async function failureIsRecordedAndRetriedSooner() {
  const q = quietLog();
  const job = { name: 'flaky', every: () => 7 * DAY, run: async () => { throw new Error('provider down'); } };
  const s = createScheduler({ jobs: [job], now, log: q });
  await s.runJob(job);
  const row = await rowFor('flaky');
  assert.strictEqual(row.last_status, 'error');
  assert.strictEqual(row.last_error, 'provider down');
  assert.ok(q.lines.some(l => l.includes('flaky') && l.includes('provider down')), 'a failure is logged with its job');
  clock += HOUR - 1;
  assert.strictEqual(await s.isDue(job), false);
  clock += 1;
  assert.strictEqual(await s.isDue(job), true, 'a failed weekly job is retried after an hour, not a week');

  job.run = async () => {};
  await s.runJob(job);
  assert.strictEqual((await rowFor('flaky')).last_status, 'ok');
  assert.strictEqual((await rowFor('flaky')).last_error, null, 'a later success clears the error');
}

async function singleFlightAndConcurrentJobs() {
  let release;
  const hold = new Promise(r => { release = r; });
  let slowRuns = 0;
  let quickRuns = 0;
  const slow = { name: 'slow', every: () => HOUR, run: async () => { slowRuns++; await hold; } };
  const quick = { name: 'quick', every: () => HOUR, run: async () => { quickRuns++; } };
  const s = make([slow, quick]);
  assert.deepStrictEqual(await s.check(), ['slow', 'quick'], 'every due job starts');
  await s.inFlight().find(w => w.name === 'quick').promise;
  assert.strictEqual(quickRuns, 1, 'a job does not wait behind another one that is still running');
  assert.strictEqual(s.runJob(slow), s.inFlight().find(w => w.name === 'slow').promise, 'runJob on a running job hands back the run in progress');
  clock += 2 * HOUR;
  assert.deepStrictEqual(await s.check(), ['quick'], 'a check leaves a job that is still running alone');
  release();
  await Promise.all(s.inFlight().map(w => w.promise));
  assert.strictEqual(slowRuns, 1, 'the slow job ran once');
  assert.deepStrictEqual(s.inFlight(), [], 'nothing is left in flight');
}

async function disabledJobsAreInert() {
  let runs = 0;
  const off = { name: 'switched-off', every: () => 0, since: () => null, run: async () => { runs++; } };
  const s = make([off]);
  assert.strictEqual(await s.isDue(off), false);
  assert.strictEqual(await s.nextDueAt(off), null);
  assert.deepStrictEqual(await s.check(), []);
  assert.strictEqual(await s.runIfDue('switched-off'), false);
  assert.strictEqual(await rowFor('switched-off'), undefined, 'a switched-off job writes nothing');
  assert.strictEqual(runs, 0);
}

async function runIfDue() {
  let runs = 0;
  const job = { name: 'boot-job', every: () => DAY, run: async () => { runs++; } };
  const s = make([job]);
  assert.strictEqual(await s.runIfDue('boot-job'), true, 'a due job runs and is waited for');
  assert.strictEqual(runs, 1);
  assert.strictEqual(await s.runIfDue('boot-job'), false, 'then it is not due');
  assert.strictEqual(await s.runIfDue('no-such-job'), false);
  assert.strictEqual(runs, 1);
}

async function startAndStop() {
  let runs = 0;
  const job = { name: 'ticking', every: () => HOUR, run: async () => { runs++; } };
  const s = make([job], { checkEveryMs: 20 });
  assert.deepStrictEqual(await s.start(), ['ticking'], 'start runs the first check immediately');
  await Promise.all(s.inFlight().map(w => w.promise));
  assert.strictEqual(runs, 1);
  clock += HOUR;
  await new Promise(r => setTimeout(r, 120));
  await Promise.all(s.inFlight().map(w => w.promise));
  assert.strictEqual(runs, 2, 'the periodic check picks the job up again once it is due');
  s.stop();
  clock += HOUR;
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(runs, 2, 'no checks after stop()');
  assert.deepStrictEqual(await s.check(), [], 'a check after stop() starts nothing');
  assert.strictEqual(await s.runIfDue('ticking'), false);
  assert.deepStrictEqual(await s.start(), [], 'and start() does not re-arm a stopped scheduler');
}

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function main() {
  await db.initDb();
  await survivesARestart();
  await baselineFromSince();
  await failureIsRecordedAndRetriedSooner();
  await singleFlightAndConcurrentJobs();
  await disabledJobsAreInert();
  await runIfDue();
  await startAndStop();
  console.log('scheduler.test.js: job clocks persist across restarts; due, baseline, retry, single-flight, stop');
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async err => { console.error(err); await cleanup(); process.exit(1); });
