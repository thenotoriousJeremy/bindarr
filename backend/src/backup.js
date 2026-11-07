const fs = require('fs');
const path = require('path');
const db = require('./db');

// VACUUM INTO writes a consistent snapshot of the live DB (incl. WAL) to a new
// file with no locking issues, even while the server is serving requests.

const BACKUP_DIR = path.join(path.dirname(db.dbPath), 'backups');
const KEEP_LAST = parseInt(process.env.BACKUP_KEEP_LAST, 10) || 10;

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.bak'))
    .map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Create a snapshot, prune to the newest KEEP_LAST. Returns the new file's meta.
async function createBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Derived from the live DB's name so it follows any rename instead of
  // hardcoding one. Older pokemon_cards.*.bak files still list and restore.
  const dest = path.join(BACKUP_DIR, `${path.basename(db.dbPath, '.db')}.${stamp}.bak`);
  await db.run(`VACUUM INTO ?`, [dest]);

  for (const b of listBackups().slice(KEEP_LAST)) {
    fs.unlinkSync(path.join(BACKUP_DIR, b.file));
  }

  const st = fs.statSync(dest);
  return { file: path.basename(dest), size: st.size, created_at: st.mtime.toISOString() };
}

// The automatic backup is a scheduler.js job: BACKUP_INTERVAL_HOURS (default 24;
// 0 disables) is its period, counted from the last run recorded in job_runs, so
// a restart no longer pushes the next backup a whole interval away.
function intervalHours() {
  return process.env.BACKUP_INTERVAL_HOURS === undefined
    ? 24
    : parseFloat(process.env.BACKUP_INTERVAL_HOURS) || 0;
}
const intervalMs = () => Math.max(0, intervalHours()) * 60 * 60 * 1000;

// Where the schedule's clock starts the first time it sees this install: the
// newest backup already on disk, or (null) now. An upgraded install that has
// been restarting too often to ever reach its first backup has none, and is
// backed up one interval after this boot instead of never; a database created
// a moment ago is not backed up while it is still empty.
function lastBackupAt() {
  const newest = listBackups()[0];
  return newest ? new Date(newest.created_at) : null;
}

async function runScheduledBackup() {
  const b = await createBackup();
  console.log(`Auto-backup created: ${b.file} (${b.size} bytes).`);
  return b;
}

// Said once at boot, as startAutoBackup did when it owned the timer.
function logPolicy() {
  const hours = intervalHours();
  if (!(hours > 0)) console.log('Auto-backup disabled (BACKUP_INTERVAL_HOURS=0).');
  else console.log(`Auto-backup enabled: every ${hours}h, keeping newest ${KEEP_LAST}.`);
}

module.exports = { BACKUP_DIR, listBackups, createBackup, intervalMs, lastBackupAt, runScheduledBackup, logPolicy };
