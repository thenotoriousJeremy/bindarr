// Graceful shutdown: what SIGTERM and SIGINT do.
//
// There was no handler at all. Under Docker node is PID 1 (entrypoint.sh execs
// gosu, which execs node), and the kernel gives PID 1 no default action for
// SIGTERM, so `docker stop` was ignored for ten seconds and then became a
// SIGKILL — mid-write, whatever was running: a backup half-copied, a catalog half
// built, and the WAL never checkpointed, so a copy of the volume taken after a
// "clean" stop still needed its -wal file to be complete.
//
// In order:
//   1. Stop accepting connections (HTTP and the optional HTTPS listener); idle
//      keep-alive sockets close at once, requests in progress finish.
//   2. Stop the job timers, and ask the work that can stop early to stop at its
//      next safe point — the price sweeps between two sweeps, a catalog build
//      after its in-flight images (it writes what it has, atomically).
//   3. Wait for that work, for at most `graceMs`. A sweep or a backup that is
//      still going then is abandoned: every write is its own SQLite statement,
//      so stopping between them loses no more than the unfinished remainder.
//   4. Close the database, which checkpoints the WAL into the main file.
//   5. Exit with `code` (0 for a signal).
//
// The default budget, 8 s of waiting plus 1.5 s for the close, fits inside
// Docker's default 10 s stop timeout. A second signal while this runs exits at
// once, with 1.
//
// Everything it touches is passed in, so the sequence is testable without
// sending real signals (which Windows cannot do to a child in any useful way).
const GRACE_MS = 8000;
const DB_CLOSE_MS = 1500;

// Resolves true if `promise` settles within `ms`, false if the time runs out
// first. Rejections propagate.
function within(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([Promise.resolve(promise).then(() => true), timeout])
    .finally(() => clearTimeout(timer));
}

// server.close() resolves once every connection has ended. A server that never
// got as far as listening (startup failed first) counts as closed.
function closeServer(server) {
  return new Promise(resolve => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

function createShutdown({
  servers = () => [],
  stopJobs = () => {},
  pendingWork = () => [],
  closeDb = async () => {},
  exit = (code) => process.exit(code),
  log = console,
  graceMs = GRACE_MS,
  dbCloseMs = DB_CLOSE_MS,
} = {}) {
  let underway = null;

  return function shutdown(reason, code = 0) {
    if (underway) {
      log.warn(`${reason} during shutdown: exiting now.`);
      exit(1);
      return underway;
    }
    underway = (async () => {
      log.log(`${reason}: shutting down (up to ${graceMs / 1000}s for running work)...`);
      const listeners = (servers() || []).filter(Boolean);
      const closed = Promise.all(listeners.map(closeServer));

      try { stopJobs(); } catch (err) { log.error(`Shutdown: could not stop background jobs: ${err.message}`); }

      let work = [];
      try {
        work = (pendingWork() || []).filter(w => w && w.promise);
      } catch (err) {
        log.error(`Shutdown: could not list running work: ${err.message}`);
      }
      const settled = new Set();
      for (const w of work) Promise.resolve(w.promise).then(() => settled.add(w), () => settled.add(w));

      const finished = await within(Promise.allSettled([closed, ...work.map(w => w.promise)]), graceMs);
      if (!finished) {
        const left = work.filter(w => !settled.has(w)).map(w => w.name);
        log.warn(`Shutdown: still running after ${graceMs / 1000}s: ${left.length ? left.join(', ') : 'open connections'}. Closing anyway.`);
        for (const s of listeners) {
          if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
        }
      }

      try {
        if (!(await within(Promise.resolve().then(closeDb), dbCloseMs))) {
          log.warn(`Shutdown: the database did not close within ${dbCloseMs}ms.`);
        }
      } catch (err) {
        log.error(`Shutdown: the database did not close cleanly: ${err.message}`);
      }
      log.log('Shutdown complete.');
      exit(code);
    })();
    return underway;
  };
}

// Resolves once `test()` is true, polling every `everyMs`. For work that exposes
// a state to look at rather than a promise to wait on (catalog.state()).
function whenTrue(test, everyMs = 100) {
  return new Promise(resolve => {
    const poll = () => {
      if (test()) return resolve();
      const t = setTimeout(poll, everyMs);
      if (t.unref) t.unref();   // the shutdown's own deadline is what keeps the process up
    };
    poll();
  });
}

module.exports = { createShutdown, closeServer, whenTrue, GRACE_MS, DB_CLOSE_MS };
