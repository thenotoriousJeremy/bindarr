// POST /api/admin/seed-cards must never touch cards the admin already owns.
//
// The seed used to start by deleting every collection row whose card was in one of
// the seed sets (base1, sv1, swsh1, lea, mh3) — so an admin who owned a real Base Set
// Charizard lost it the moment they clicked "seed". Nothing marks a row as seeded, so
// the route now refuses outright when the account already has collection rows, and
// only seeds an empty one.
//
// Same shape as storagesettings.test.js: the real router mounted in this process. The
// auth middleware and the two card APIs are swapped in the require cache first, so the
// test needs no token, no network and no provider credits.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-adminseed-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');

let userId;
const stubModule = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stubModule('../src/middleware/auth', {
  ...require('../src/middleware/auth'),
  authenticateToken: (req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); },
  requireAdmin: (req, res, next) => next(),
});
const poolCard = { id: 'base1-4', name: 'Charizard', set_id: 'base1', price_normal: 100 };
stubModule('../src/tcgApi', { getCardsBySet: async (setId) => (setId === 'base1' ? [poolCard] : []) });
stubModule('../src/scryfallApi', { getCardsBySet: async () => [] });

let server;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../src/routes/admin'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

const seed = async (base) => {
  const res = await fetch(`${base}/api/admin/seed-cards`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
};
const rowsFor = (uid) => db.all(`SELECT id, card_id, quantity FROM collection WHERE user_id = ? ORDER BY id`, [uid]);

async function main() {
  await db.initDb();
  await db.run(
    `INSERT INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [poolCard.id, poolCard.name, 'Pokémon', '[]', '[]', 'Rare Holo', 'base1', 'Base', '4', '', 100]
  );
  const mkUser = async (name) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    [name, db.hashPassword('x'), 'admin', `share-${name}-${process.pid}`]
  )).lastID;
  const base = await startApp();

  // An admin who owns a real card from a seed set: the seed refuses and the card survives.
  userId = await mkUser('seed-owner');
  await db.run(
    `INSERT INTO collection (card_id, quantity, condition, printing, language, position, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [poolCard.id, 1, 'Near Mint', 'Normal', 'English', 0, userId]
  );
  const before = await rowsFor(userId);
  const refused = await seed(base);
  assert.strictEqual(refused.status, 409, `seed over existing data should be refused, got ${refused.status}`);
  assert.ok(typeof refused.body.error === 'string' && refused.body.error.length > 0, 'refusal should carry an error message');
  assert.deepStrictEqual(await rowsFor(userId), before, 'existing collection rows must survive a seed attempt');
  console.log('PASS: seed refuses an account with cards and leaves them untouched');

  // An empty account still seeds, and a second seed is refused rather than wiping the first.
  userId = await mkUser('seed-empty');
  const ok = await seed(base);
  assert.strictEqual(ok.status, 200, `seed into an empty account should succeed, got ${ok.status}: ${JSON.stringify(ok.body)}`);
  const seeded = await rowsFor(userId);
  assert.ok(seeded.length > 0, 'seed should have added collection rows');
  const again = await seed(base);
  assert.strictEqual(again.status, 409, 'a second seed should be refused');
  assert.deepStrictEqual(await rowsFor(userId), seeded, 'a refused re-seed must not change the seeded rows');
  console.log('PASS: empty account seeds once; re-seed is refused without deleting');
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error('FAIL:', err && err.stack || err);
    process.exitCode = 1;
    await cleanup();
  });
