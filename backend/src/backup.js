const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const db = require('./db');

// VACUUM INTO writes a consistent snapshot of the live DB (incl. WAL) to a new
// file with no locking issues, even while the server is serving requests.

// Beside the database unless BACKUP_DIR says otherwise, e.g. a second disk or a
// mount that is itself backed up off the box. Resolved once, here, and used by
// everything that reads or writes a backup — the admin list, create and download
// routes included — so they cannot disagree about where the files are.
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(db.dbPath), 'backups'));
const KEEP_LAST = parseInt(process.env.BACKUP_KEEP_LAST, 10) || 10;

// Snapshots taken before a different release migrates the schema (db.js). They
// rotate on their own, so ten days of daily backups cannot push out the copy from
// before an upgrade, and a restart loop cannot either (see createPreMigrationBackup).
const PRE_MIGRATION_PREFIX = 'pre-migration-';
const KEEP_PRE_MIGRATION = 3;

const kindOf = (file) => (file.startsWith(PRE_MIGRATION_PREFIX) ? 'pre-migration' : 'regular');
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');
// Derived from the live DB's name so it follows any rename instead of
// hardcoding one. Older pokemon_cards.*.bak files still list and restore.
const dbBase = () => path.basename(db.dbPath, '.db');

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.bak'))
    .map(f => {
      try {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return st.isFile() ? { file: f, size: st.size, created_at: st.mtime.toISOString(), kind: kindOf(f) } : null;
      } catch {
        return null;   // gone between readdir and stat
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// The one way a request turns a name into a backup file: a plain file directly
// inside BACKUP_DIR whose name ends in .bak, or null. basename() alone used to be
// the whole check, which still let a name reach the filesystem with a drive
// letter, an NTFS stream (":") or a backslash that is only a separator on
// Windows. lstat, not stat, so a symlink planted in the directory is refused
// rather than followed somewhere else.
function resolveBackupFile(name) {
  if (typeof name !== 'string' || !name.endsWith('.bak') || name.startsWith('.')) return null;
  if (/[\\/:\0]/.test(name) || name !== path.basename(name)) return null;
  const full = path.join(BACKUP_DIR, name);
  if (path.dirname(full) !== BACKUP_DIR) return null;
  try {
    return fs.lstatSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

function openReadOnly(file) {
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => (err ? reject(err) : resolve(conn)));
  });
}
const query = (conn, sql) => new Promise((resolve, reject) =>
  conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
const closeConn = (conn) => new Promise(resolve => conn.close(() => resolve()));

// Is this file a whole, readable database? PRAGMA quick_check, on a read-only
// connection of its own so it reads the file as written rather than anything the
// live connection has cached. VACUUM INTO writes a rollback-journal database, so
// a read-only open leaves no -wal or -shm beside it.
//
// quick_check alone passes an EMPTY file — a 0-byte database is a valid one — so
// the snapshot must also hold at least as many tables as the live database did.
async function verifySnapshot(file, { tables = 0 } = {}) {
  const conn = await openReadOnly(file);
  try {
    const rows = await query(conn, `PRAGMA quick_check`);
    const verdict = rows.map(r => Object.values(r)[0]).join('; ');
    if (verdict !== 'ok') throw new Error(`quick_check failed: ${verdict.slice(0, 300)}`);
    const [{ n }] = await query(conn, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`);
    if (n < tables) throw new Error(`snapshot holds ${n} tables, the database ${tables}`);
  } finally {
    await closeConn(conn);
  }
}

// A crash or a kill mid-snapshot leaves a .bak.tmp behind. Nothing lists them,
// and with snapshots serialised (below) none can belong to a write in progress.
function removeStaleTemps() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (f.endsWith('.bak.tmp')) {
      try { fs.rmSync(path.join(BACKUP_DIR, f), { force: true }); } catch { /* locked; next time */ }
    }
  }
}

// Write one snapshot atomically: VACUUM INTO a temporary name in the same
// directory, verify that, then rename it into place. Written straight to its
// final name, a backup cut short by a full disk or a killed process looked
// exactly like a good one until the day it was needed. Now a snapshot that is
// not whole never gets a .bak name: the temporary file is removed, the error is
// thrown, and every earlier backup is left alone (pruning only runs after a
// success). `verify` is replaceable for tests.
async function writeSnapshot(fileName, { verify = verifySnapshot } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  removeStaleTemps();
  const dest = path.join(BACKUP_DIR, fileName);
  const tmp = `${dest}.tmp`;
  try {
    const { n: tables } = await db.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`);
    // Exclusive: VACUUM fails outright while any other statement is in flight.
    await db.runExclusive(`VACUUM INTO ?`, [tmp]);
    await verify(tmp, { tables });
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    throw err;
  }
  const st = fs.statSync(dest);
  return { file: fileName, size: st.size, created_at: st.mtime.toISOString(), kind: kindOf(fileName) };
}

function prune(kind, keep) {
  for (const b of listBackups().filter(x => x.kind === kind).slice(keep)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.file)); } catch (err) {
      console.warn(`Could not prune old backup ${b.file}: ${err.message}`);
    }
  }
}

// One snapshot at a time, whoever asks: the scheduled backup, the admin's "Back
// up now", and the pre-migration snapshot all write into the same directory and
// share its temp-file cleanup.
let queue = Promise.resolve();
let active = 0;
function serially(fn) {
  active++;
  const run = queue.then(fn);
  queue = run.catch(() => {}).then(() => { active--; });
  return run;
}

// Resolves when no snapshot is being written or waiting; null when idle. What a
// shutdown waits on.
const pending = () => (active > 0 ? queue : null);

// Create a snapshot, prune to the newest KEEP_LAST. Returns the new file's meta.
// A second call while one is being written gets that one rather than a copy of
// it a second later.
let regularInFlight = null;
function createBackup(options = {}) {
  if (regularInFlight) return regularInFlight;
  const run = serially(async () => {
    const meta = await writeSnapshot(`${dbBase()}.${stampNow()}.bak`, options);
    prune('regular', KEEP_LAST);
    return meta;
  });
  regularInFlight = run;
  const clear = () => { regularInFlight = null; };
  run.then(clear, clear);
  return run;
}

// The snapshot db.js takes before a different release migrates the schema, named
// for the move it protects: pre-migration-<db>-<from>-to-<to>-<time>.bak.
//
// At most ONE per move. A migration that fails makes the server exit, and Docker
// restarts it straight into the same migration; taking a fresh snapshot on every
// attempt would rotate the real pre-upgrade copy out after three restarts and
// keep only snapshots of a half-migrated database. The existing one is returned
// with `reused: true` instead.
async function createPreMigrationBackup({ from, to }, options = {}) {
  const move = `${PRE_MIGRATION_PREFIX}${dbBase()}-${from || 'unversioned'}-to-${to}-`;
  const existing = listBackups().find(b => b.file.startsWith(move));
  if (existing) return { ...existing, reused: true };
  return serially(async () => {
    const meta = await writeSnapshot(`${move}${stampNow()}.bak`, options);
    prune('pre-migration', KEEP_PRE_MIGRATION);
    return meta;
  });
}

// BACKUP_INTERVAL_HOURS, validated. Hours, 0 = off, default 24. It used to be
// handed straight to setInterval, where anything from 597 hours up overflows the
// 2^31-1 ms timer limit and fires every millisecond, and anything unparseable
// silently switched backups off. There is no long timer any more — the schedule
// is a scheduler.js job — but a value that cannot mean what was intended still
// falls back to the default, and says so.
const DEFAULT_INTERVAL_HOURS = 24;
const MIN_INTERVAL_HOURS = 0.25;      // the scheduler checks every 15 minutes
const MAX_INTERVAL_HOURS = 24 * 366;  // a year

function parseIntervalHours(raw) {
  if (raw === undefined || String(raw).trim() === '') return { hours: DEFAULT_INTERVAL_HOURS };
  const hours = parseFloat(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    return {
      hours: DEFAULT_INTERVAL_HOURS,
      warning: `BACKUP_INTERVAL_HOURS="${raw}" is not a number of hours (0 disables); backing up every ${DEFAULT_INTERVAL_HOURS}h instead.`,
    };
  }
  if (hours === 0) return { hours: 0 };
  if (hours < MIN_INTERVAL_HOURS) {
    return { hours: MIN_INTERVAL_HOURS, warning: `BACKUP_INTERVAL_HOURS=${raw} is shorter than the ${MIN_INTERVAL_HOURS}h the scheduler can honour; using ${MIN_INTERVAL_HOURS}h.` };
  }
  if (hours > MAX_INTERVAL_HOURS) {
    return { hours: MAX_INTERVAL_HOURS, warning: `BACKUP_INTERVAL_HOURS=${raw} is longer than a year; using ${MAX_INTERVAL_HOURS}h.` };
  }
  return { hours };
}

const interval = parseIntervalHours(process.env.BACKUP_INTERVAL_HOURS);

// The automatic backup is a scheduler.js job, and this is its period: counted
// from the last run recorded in job_runs, so a restart no longer pushes the next
// backup a whole interval away.
const intervalMs = () => interval.hours * 60 * 60 * 1000;

// Where the schedule's clock starts the first time it sees this install: the
// newest backup already on disk, or (null) now. An upgraded install that has
// been restarting too often to ever reach its first backup has none, and is
// backed up one interval after this boot instead of never; a database created
// a moment ago is not backed up while it is still empty.
function lastBackupAt() {
  const newest = listBackups().find(b => b.kind === 'regular');
  return newest ? new Date(newest.created_at) : null;
}

async function runScheduledBackup() {
  const b = await createBackup();
  console.log(`Auto-backup created: ${b.file} (${b.size} bytes).`);
  return b;
}

// Said once at boot.
function logPolicy() {
  if (interval.warning) console.warn(interval.warning);
  if (!interval.hours) {
    console.log(`Auto-backup disabled (BACKUP_INTERVAL_HOURS=0). Pre-migration snapshots still go to ${BACKUP_DIR}.`);
  } else {
    console.log(`Auto-backup enabled: every ${interval.hours}h into ${BACKUP_DIR}, keeping newest ${KEEP_LAST}.`);
  }
}

module.exports = {
  BACKUP_DIR,
  KEEP_LAST,
  KEEP_PRE_MIGRATION,
  listBackups,
  resolveBackupFile,
  createBackup,
  createPreMigrationBackup,
  verifySnapshot,
  writeSnapshot,
  pending,
  parseIntervalHours,
  intervalMs,
  lastBackupAt,
  runScheduledBackup,
  logPolicy,
};
