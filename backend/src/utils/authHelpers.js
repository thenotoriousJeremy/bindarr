const crypto = require('crypto');
const db = require('../db');

// Passwords: PBKDF2-SHA512, stored as `iterations:salt:hash` (hex). Hashes from
// before the count was stored per hash are `salt:hash` at 10000 iterations, and
// still verify.
const PBKDF2_ITERATIONS = 210000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';
// The password_hash of an account that signs in only through SSO (routes/auth.js).
// It is not a hash of anything, so no password can match it.
const SSO_ONLY_PREFIX = 'oidc_locked:';
// Salt for the stand-in check below. Any value does; random per process so it is
// never mistaken for a real hash's.
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

function pbkdf2(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, KEY_LENGTH, DIGEST, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// The hash a request path stores. Asynchronous: the 210k rounds take tens of
// milliseconds (more on a Pi), and pbkdf2Sync spent them on the event loop,
// stalling every other request while one person signed up.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_ITERATIONS}:${salt}:${hash.toString('hex')}`;
}

// The same hash, synchronously, for the places nothing else is waiting on:
// initDb's DEFAULT_ADMIN_PASSWORD seed, the reset-password script and tests.
// db.hashPassword is this.
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return `${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

// { iterations, salt, hash } for a stored password hash, or null for anything
// that is not one: no account, an SSO-only account, a phone's owner ('!').
function parseStoredHash(storedHash) {
  if (typeof storedHash !== 'string' || !storedHash || storedHash.startsWith(SSO_ONLY_PREFIX)) return null;
  const parts = storedHash.split(':');
  if (parts.length === 2) return { iterations: 10000, salt: parts[0], hash: parts[1] };
  if (parts.length !== 3) return null;
  const iterations = Number(parts[0]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10000000) return null;
  return { iterations, salt: parts[1], hash: parts[2] };
}

// The check sign-in and a password change make. Asynchronous, like hashPassword.
// Whatever it is handed -- a real hash, nothing (no such user), or an account
// with no password -- it does the work of one full check, so how long the answer
// takes does not say which usernames exist or which accounts are SSO-only.
async function checkPassword(password, storedHash) {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) {
    await pbkdf2(String(password), DUMMY_SALT, PBKDF2_ITERATIONS);
    return false;
  }
  const storedBuf = Buffer.from(parsed.hash, 'hex');
  const verifyBuf = await pbkdf2(String(password), parsed.salt, parsed.iterations);
  if (storedBuf.length !== verifyBuf.length) return false;
  return crypto.timingSafeEqual(storedBuf, verifyBuf);
}

// The synchronous check, for scripts and tests. Request paths use checkPassword.
function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const parts = storedHash.split(':');

  let iterations, salt, hash;
  if (parts.length === 3) {
    [iterations, salt, hash] = parts;
    iterations = parseInt(iterations, 10);
  } else if (parts.length === 2) {
    // Legacy hashes created before the iteration count was stored per-hash.
    iterations = 10000;
    [salt, hash] = parts;
  } else {
    return false;
  }

  const storedBuf = Buffer.from(hash, 'hex');
  const verifyBuf = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512');
  if (storedBuf.length !== verifyBuf.length) return false;
  return crypto.timingSafeEqual(storedBuf, verifyBuf);
}

// What the sessions table stores in place of a token: its SHA-256. A copy of the
// database -- a backup, a borrowed volume -- then holds nothing that signs anyone
// in. Unsalted and fast on purpose: a token is 256 random bits, so unlike a
// password there is nothing to guess, and every request has to hash it once.
// The prefix marks a row as hashed; initDb hashes any row stored before this.
function hashSessionToken(token) {
  return `sha256:${crypto.createHash('sha256').update(String(token)).digest('hex')}`;
}

// A Bindarr API key is stored the same way, for the same reason, and the auth
// gate looks both up with the one hash it computes per request. Which is why a
// key can be shown only when it is made (routes/auth.js). initDb hashes keys
// stored before this.
const hashApiKey = hashSessionToken;

async function generateSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiration
  const expiresAtStr = expiresAt.toISOString().slice(0, 19).replace('T', ' '); // YYYY-MM-DD HH:MM:SS
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (?, ?, ?)
  `, [hashSessionToken(token), userId, expiresAtStr]);
  return token;
}

// Sign a user out everywhere. `exceptTokenHash` spares one session: changing your
// own password keeps you signed in on the device that just proved it knows it.
async function revokeSessions(userId, { exceptTokenHash = null } = {}) {
  if (exceptTokenHash) {
    return db.run(`DELETE FROM sessions WHERE user_id = ? AND token != ?`, [userId, exceptTokenHash]);
  }
  return db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

module.exports = {
  PBKDF2_ITERATIONS, hashPassword, hashPasswordSync, checkPassword, verifyPassword,
  generateSession, hashSessionToken, hashApiKey, revokeSessions
};
