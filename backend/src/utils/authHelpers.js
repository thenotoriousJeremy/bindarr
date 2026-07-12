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

async function generateSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiration
  const expiresAtStr = expiresAt.toISOString().slice(0, 19).replace('T', ' '); // YYYY-MM-DD HH:MM:SS
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (?, ?, ?)
  `, [token, userId, expiresAtStr]);
  return token;
}

module.exports = { verifyPassword, generateSession };
