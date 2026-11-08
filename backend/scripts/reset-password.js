// Reset a user's password from the command line: the way back in for an admin who
// is locked out, where the only advice used to be deleting the database.
//
//   docker exec -it bindarr node scripts/reset-password.js <username>
//   docker exec -it -e NEW_PASSWORD='...' bindarr node scripts/reset-password.js <username>
//   node scripts/reset-password.js <username>        (from backend/, without Docker)
//
// Sets a new password -- random, or NEW_PASSWORD when it is set -- hashed exactly
// as the app hashes it (db.hashPassword, which login verifies), signs that user
// out of every session, and prints the new password once. Exits 1 when there is
// no such user and 2 on bad usage, so a script can tell the two apart.
//
// Safe beside a running server: one short transaction through SQLite's own
// locking. No initDb(), for the reason repairThinPokemonCache.js gives: the server
// made the schema, and migrations do not belong in a side process.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// The server's own .env lookup (see the top of src/server.js), so DB_PATH means
// the same file here as it does to the server started from the same directory.
const DOTENV = { override: false, quiet: true };
require('dotenv').config(DOTENV);
require('dotenv').config({ ...DOTENV, path: path.join(__dirname, '..', '.env') });

const MIN_LENGTH = 8; // the app's own minimum (routes/auth.js, routes/admin.js)

// 20 characters from a URL-safe alphabet: 120 bits, nothing to escape in a shell.
function generatePassword() {
  return crypto.randomBytes(15).toString('base64url');
}

// The reset itself. Returns { username, password, generated, signedOut }, or null
// when no user has that name. Names are matched the way login matches them:
// trimmed and lower-cased.
async function resetPassword(username, { password } = {}) {
  // Required here, not at the top: the CLI below must switch users before the
  // database is opened, and db.js opens it as soon as it is loaded.
  const db = require('../src/db');
  const { revokeSessions } = require('../src/utils/authHelpers');

  if (password !== undefined && (typeof password !== 'string' || password.length < MIN_LENGTH)) {
    throw new Error(`NEW_PASSWORD must be at least ${MIN_LENGTH} characters.`);
  }
  // The server may be mid-write; wait for its lock rather than failing on it.
  await db.run('PRAGMA busy_timeout = 5000');
  const name = String(username || '').trim().toLowerCase();
  const user = await db.get(`SELECT id, username FROM users WHERE username = ?`, [name]);
  if (!user) return null;

  const generated = password === undefined;
  const next = generated ? generatePassword() : password;
  let signedOut = 0;
  await db.withTransaction(async () => {
    await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [db.hashPassword(next), user.id]);
    // Whoever had the old password may still hold a session made with it.
    signedOut = (await revokeSessions(user.id)).changes;
  });
  return { username: user.username, password: next, generated, signedOut };
}

// docker exec runs as root unless told otherwise, while the server runs as the
// unprivileged `node` user (entrypoint.sh drops to it with gosu). A root process
// writing the database can leave root-owned -wal/-shm files beside it, which the
// server then cannot open. So a root run becomes whoever owns the database's
// directory -- `node`, in the image -- before anything is opened.
function becomeDatabaseOwner(dir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const owner = fs.statSync(dir);
  if (owner.uid === 0) return;
  process.setgroups([owner.gid]);
  process.setgid(owner.gid);
  process.setuid(owner.uid);
}

async function main() {
  const username = process.argv[2];
  if (!username || process.argv.length > 3) {
    console.error('Usage: node scripts/reset-password.js <username>');
    console.error('Set NEW_PASSWORD to choose the password; otherwise a random one is printed.');
    return 2;
  }
  const newPassword = process.env.NEW_PASSWORD || undefined;
  if (newPassword !== undefined && newPassword.length < MIN_LENGTH) {
    console.error(`NEW_PASSWORD must be at least ${MIN_LENGTH} characters.`);
    return 2;
  }

  // Never create a database: a wrong DB_PATH would otherwise make an empty one,
  // and the "no such table" that followed would say nothing useful.
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'database', 'bindarr.db');
  const legacyPath = path.join(path.dirname(dbPath), 'pokemon_cards.db');
  if (!fs.existsSync(dbPath) && !(path.basename(dbPath) === 'bindarr.db' && fs.existsSync(legacyPath))) {
    console.error(`No database at ${path.resolve(dbPath)}. Set DB_PATH to the file the server uses.`);
    return 2;
  }

  try {
    becomeDatabaseOwner(path.dirname(path.resolve(dbPath)));
  } catch (err) {
    console.error(`Could not switch to the database owner (${err.message}). Run it as that user instead:`);
    console.error('  docker exec -it -u node bindarr node scripts/reset-password.js <username>');
    return 2;
  }

  const db = require('../src/db');
  try {
    const result = await resetPassword(username, { password: newPassword });
    if (!result) {
      const users = (await db.all(`SELECT username FROM users ORDER BY username`)).map(u => u.username);
      console.error(`No user named "${username}".${users.length ? ` Users: ${users.join(', ')}` : ' There are no accounts yet.'}`);
      return 1;
    }
    console.log(`Password for "${result.username}" reset; ${result.signedOut} session(s) signed out.`);
    console.log(result.generated ? `New password: ${result.password}` : 'New password: the one given in NEW_PASSWORD.');
    console.log('Sign in with it, then change it under Settings.');
    return 0;
  } catch (err) {
    console.error(`Reset failed: ${err.message}`);
    return 2;
  } finally {
    await new Promise(resolve => db.dbConnection.close(() => resolve()));
  }
}

if (require.main === module) {
  // exitCode rather than process.exit: let the connection close and the loop drain.
  main().then(code => { process.exitCode = code; });
}

module.exports = { resetPassword, generatePassword, MIN_LENGTH };
