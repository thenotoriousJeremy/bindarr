const path = require('path');
const fs = require('fs');

// Snapshot the SQLite database into backupDir using VACUUM INTO, which produces
// a consistent copy while the app is live (safe under WAL — no torn reads),
// then prune to the newest `keep` snapshots. Returns the snapshot path.
async function backupDatabase(db, backupDir, keep = 7) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `pokemon_cards-${stamp}.db`);
  // VACUUM INTO takes a string-literal target (not a bound parameter). The path
  // is server-controlled (env + timestamp), but escape single quotes anyway.
  await db.run(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);

  const snapshots = fs.readdirSync(backupDir)
    .filter(f => /^pokemon_cards-.*\.db$/.test(f))
    .sort(); // ISO timestamps sort chronologically
  for (const f of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    try { fs.unlinkSync(path.join(backupDir, f)); } catch { /* already gone */ }
  }
  return dest;
}

module.exports = { backupDatabase };
