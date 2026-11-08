const crypto = require('crypto');
const db = require('../db');

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

module.exports = { verifyPassword, generateSession, hashSessionToken, revokeSessions };
