// Background jobs on schedules that survive a restart.
//
// Each job used to own a setInterval: a week for the set refresh, a day for the
// backup and the session purge. An interval starts counting when the process
// does, so every restart reset them all, and an install that restarts more often
// than a job's period never ran that job — weekly auto-updates meant the set list
// never refreshed, a daily restart meant no backup was ever taken.
//
// Now the clock lives in SQLite (the job_runs table, one row per job) and one
// modest timer asks every CHECK_EVERY_MS whether anything has fallen due. A job
// that is overdue at boot runs at the first check. The per-card price gates
// (priceHelpers.shouldSweepPrices) have always worked this way; this does the
// same for everything else.
//
// A job is { name, every, run, since? }:
//   every()  its period in ms, read at every check; 0 switches the job off
//            (and writes nothing for it)
//   run()    the work; a throw is recorded and logged, never propagated
//   since()  optional. For a job with no row yet, the time to count its first
//            period from (a Date, a timestamp, or null for "now"), stored as a
//            'baseline' row. Without it a job that has never run is due at once.
//            The backup uses it so a brand-new database is not backed up the
//            second it is created, while an upgraded install counts from its
//            newest existing backup file.
//
// Jobs are single-flight each (a check that finds one running leaves it alone)
// but run independently of one another, so an hour-long price sweep cannot hold
// up the backup. A failed run is retried after RETRY_AFTER_MS rather than a
// whole period: a week is too long to wait out a provider's bad afternoon.
const db = require('./db');
const { parseSqliteUtc } = require('./utils/priceHelpers');

const CHECK_EVERY_MS = 15 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 500;

function createScheduler({
  jobs,
  now = () => Date.now(),
  log = console,
  checkEveryMs = CHECK_EVERY_MS,
  retryAfterMs = RETRY_AFTER_MS,
} = {}) {
  const byName = new Map(jobs.map(job => [job.name, job]));
  const running = new Map();   // name -> promise of the run in progress
  let timer = null;
  let stopped = false;

  const readRun = (name) =>
    db.get(`SELECT last_run_at, last_status, last_error FROM job_runs WHERE name = ?`, [name]);
  const writeRun = (name, at, status, error = null) =>
    db.run(
      `INSERT OR REPLACE INTO job_runs (name, last_run_at, last_status, last_error) VALUES (?, ?, ?, ?)`,
      [name, new Date(at).toISOString(), status, error]
    );

  // When the job next falls due (epoch ms), or null when it is switched off.
  async function nextDueAt(job) {
    const every = Number(job.every());
    if (!(every > 0)) return null;
    let row = await readRun(job.name);
    if (!row && job.since) {
      const since = await job.since();
      const at = since == null ? now() : Math.min(+since, now());
      await writeRun(job.name, at, 'baseline');
      row = { last_run_at: new Date(at).toISOString(), last_status: 'baseline' };
    }
    const last = row && row.last_run_at ? parseSqliteUtc(row.last_run_at).getTime() : NaN;
    if (!Number.isFinite(last)) return now();
    return last + (row.last_status === 'error' ? Math.min(every, retryAfterMs) : every);
  }

  async function isDue(job) {
    const at = await nextDueAt(job);
    return at !== null && at <= now();
  }

  // Run a job now, unless it is already running, in which case the run in
  // progress is returned. Resolves (never rejects) once its outcome is recorded.
  function runJob(job) {
    if (running.has(job.name)) return running.get(job.name);
    const startedAt = now();
    const run = (async () => {
      await null;   // `running` is set before the job's first line executes
      let status = 'ok';
      let error = null;
      try {
        await job.run();
      } catch (err) {
        status = 'error';
        error = String((err && err.message) || err).slice(0, MAX_ERROR_LENGTH);
        log.error(`Scheduled job ${job.name} failed: ${error}`);
      }
      try {
        await writeRun(job.name, startedAt, status, error);
      } catch (err) {
        log.error(`Scheduled job ${job.name}: could not record its run: ${err.message}`);
      }
    })();
    running.set(job.name, run);
    const clear = () => { if (running.get(job.name) === run) running.delete(job.name); };
    run.then(clear, clear);
    return run;
  }

  // Start every job that is due. Resolves to the names started, without waiting
  // for them to finish.
  async function check() {
    const started = [];
    for (const job of jobs) {
      if (stopped) break;
      if (running.has(job.name)) continue;
      try {
        // stopped is asked again after the read: a check already under way when
        // stop() is called must not start anything.
        if (await isDue(job) && !stopped) {
          runJob(job);
          started.push(job.name);
        }
      } catch (err) {
        log.error(`Scheduler: could not check ${job.name}: ${err.message}`);
      }
    }
    return started;
  }

  // Run one job right now if it is due, and wait for it. True when it ran (or was
  // already running and has now finished), false when it was not due.
  async function runIfDue(name) {
    const job = byName.get(name);
    if (!job || stopped) return false;
    if (running.has(name)) {
      await running.get(name);
      return true;
    }
    if (!(await isDue(job))) return false;
    await runJob(job);
    return true;
  }

  // The first check runs immediately, so whatever fell due while the server was
  // down runs now rather than a period from now. unref'd: the HTTP listener is
  // what keeps the process alive, not this.
  function start() {
    if (timer || stopped) return Promise.resolve([]);
    timer = setInterval(() => {
      check().catch(err => log.error('Scheduler check failed:', err.message));
    }, checkEveryMs);
    if (timer.unref) timer.unref();
    return check();
  }

  // No further checks. Runs already going are left to finish; inFlight() is what
  // a shutdown waits on.
  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  const inFlight = () => [...running].map(([name, promise]) => ({ name, promise }));

  return { start, stop, check, runIfDue, runJob, isDue, nextDueAt, inFlight };
}

module.exports = { createScheduler, CHECK_EVERY_MS, RETRY_AFTER_MS };
