// Clears what earlier test runs left in the OS temp directory. Both runners
// (test/run.js and test/e2e/run.js) call it before their first suite.
//
// Every test makes its throwaway files there under a name starting `bindarr-`
// (staticcache uses `.bindarr-`), and deletes them on the way out — unless it was
// killed, crashed, or deleted a database a server still held open, which on
// Windows fails. Left alone those pile up (932 entries, about 1 GB, on one
// machine), and a stale database a later test happens to reopen fails that test
// for reasons that have nothing to do with the code.
//
// Most names carry the id of the process that made them, and those are removed
// only once that process has exited: several runs can share one temp directory
// (a second checkout, a CI host, parallel agents), and a live run's database must
// not disappear under it. A name without one is removed once it is old enough
// that no run can still be using it. Not a *.test.js file, so neither runner
// runs it as a suite.
const fs = require('fs');
const os = require('os');
const path = require('path');

const NO_PID_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// [pattern, index of the pid group, or 0 for none]
const SHAPES = [
  [/^bindarr-.+-(\d+)\.db(?:-wal|-shm|-journal)?$/, 1],   // bindarr-notify-1234.db and its sidecars
  [/^bindarr-.+-(\d+)-[A-Za-z0-9]{6}$/, 1],                // mkdtemp: bindarr-isolation-1234-Ab3dE9
  [/^\.?bindarr-[a-z-]+-[A-Za-z0-9]{6}$/, 0],              // mkdtemp without a pid: bindarr-tls-Ab3dE9
];
// Unit tests that keep their database at the temp root get their pre-migration
// snapshots written to <tmp>/backups.
const SNAPSHOT = /^pre-migration-bindarr-[a-z-]+?-(\d+)-.+\.bak(?:\.tmp)?$/;

function running(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';   // exists, belongs to someone else
  }
}

function stale(dir, name, pidGroup, match) {
  if (pidGroup) return !running(Number(match[pidGroup]));
  try {
    return Date.now() - fs.statSync(path.join(dir, name)).mtimeMs > NO_PID_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function remove(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    return true;
  } catch {
    return false;   // still held open by something: next run
  }
}

function clearStaleTestFiles({ dir = os.tmpdir(), log = console.log } = {}) {
  let cleared = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    for (const [shape, pidGroup] of SHAPES) {
      const match = shape.exec(name);
      if (!match) continue;
      if (stale(dir, name, pidGroup, match) && remove(path.join(dir, name))) cleared++;
      break;
    }
  }

  const backups = path.join(dir, 'backups');
  try {
    for (const name of fs.readdirSync(backups)) {
      const match = SNAPSHOT.exec(name);
      if (match && !running(Number(match[1])) && remove(path.join(backups, name))) cleared++;
    }
    // Only if that emptied it: the name is generic, and anything else in it is
    // not ours.
    if (!fs.readdirSync(backups).length) fs.rmdirSync(backups);
  } catch { /* no backups folder */ }

  if (cleared) log(`Cleared ${cleared} stale test file(s) and folder(s) from ${dir}.`);
  return cleared;
}

module.exports = { clearStaleTestFiles };
