// POST /api/backup/restore must not let a member write shared card data.
//
// card_cache, price_history and tcgplayer_product are read by every account. A
// backup file can say anything, so only an admin's restore adds those rows from
// the file. A member's restore gets each card it lacks from the provider that
// minted the id (here a stub), and skips rows naming a card no provider has.
//
// Same shape as adminseed.test.js: the real router in this process, with the auth
// middleware and cardApi swapped in the require cache, so no token and no network.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-backuprestore-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');

let user = null;
const stubModule = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stubModule('../src/middleware/auth', {
  ...require('../src/middleware/auth'),
  authenticateToken: (req, res, next) => { req.user = user; next(); },
});

// The provider knows one real card; asking for it caches it, as the real ones do.
const REAL = 'mtg-real-0001';
const fetched = [];
stubModule('../src/utils/cardApi', {
  ...require('../src/utils/cardApi'),
  getCardById: async (id) => {
    fetched.push(id);
    if (id !== REAL) return null;
    await db.run(
      `INSERT OR IGNORE INTO card_cache (id, name, game, image_url) VALUES (?, 'Llanowar Elves', 'mtg', 'https://cards.scryfall.io/real.jpg')`,
      [REAL]
    );
    return { id: REAL, name: 'Llanowar Elves' };
  },
});

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
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', require('../src/middleware/auth').authenticateToken);
  app.use('/api', require('../src/routes/backup'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

const restore = async (base, backup) => {
  const res = await fetch(`${base}/api/backup/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup }),
  });
  return { status: res.status, body: await res.json() };
};

// A file claiming two cards: the real one, under a forged name and image, and one
// that exists nowhere. Each is in the collection, a deck and a list.
const FAKE = 'mtg-planted-0002';
const forged = () => ({
  format: 'bindarr-backup',
  version: 1,
  data: {
    collection: [
      { id: 1, card_id: REAL, quantity: 1, condition: 'Near Mint', printing: 'Normal', language: 'English', position: 0 },
      { id: 2, card_id: FAKE, quantity: 1, condition: 'Near Mint', printing: 'Normal', language: 'English', position: 0 },
    ],
    decks: [{ id: 7, name: 'Elves', game: 'mtg' }],
    deck_cards: [{ deck_id: 7, card_id: REAL, quantity: 4 }, { deck_id: 7, card_id: FAKE, quantity: 1 }],
    card_lists: [{ id: 3, name: 'Wants', kind: 'wishlist' }],
    card_list_items: [{ list_id: 3, card_id: REAL, quantity_wanted: 1 }, { list_id: 3, card_id: FAKE, quantity_wanted: 1 }],
    card_cache: [
      { id: REAL, name: 'Totally Real Card', game: 'mtg', image_url: 'https://evil.example/real.png' },
      { id: FAKE, name: 'Free Money', game: 'mtg', image_url: 'https://evil.example/fake.png' },
    ],
    price_history: [{ card_id: FAKE, date: '2026-01-01', price: 9999 }],
    tcgplayer_product: [{ card_id: FAKE, product_id: 1 }],
  },
});

async function main() {
  await db.initDb();
  const mkUser = async (name, role) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    [name, db.hashPassword('x'), role, `share-${name}-${process.pid}`]
  )).lastID;
  const base = await startApp();

  // A member: nothing from the file reaches the shared tables.
  user = { id: await mkUser('member', 'member'), role: 'member', tcg_api_key: '' };
  const m = await restore(base, forged());
  assert.strictEqual(m.status, 200, JSON.stringify(m.body));
  const real = await db.get(`SELECT name, image_url FROM card_cache WHERE id = ?`, [REAL]);
  assert.deepStrictEqual(real, { name: 'Llanowar Elves', image_url: 'https://cards.scryfall.io/real.jpg' },
    'the card comes from its provider, not from the file');
  assert.strictEqual(await db.get(`SELECT 1 FROM card_cache WHERE id = ?`, [FAKE]), undefined, 'a planted card is not cached');
  assert.strictEqual(await db.get(`SELECT 1 FROM price_history WHERE card_id = ?`, [FAKE]), undefined, 'nor its prices');
  assert.strictEqual(await db.get(`SELECT 1 FROM tcgplayer_product WHERE card_id = ?`, [FAKE]), undefined, 'nor its product id');
  assert.deepStrictEqual(fetched.sort(), [FAKE, REAL].sort(), 'each missing card is asked of its provider once');
  assert.deepStrictEqual([m.body.cards, m.body.skipped, m.body.fetched_cards], [1, 1, 1]);
  const own = (table, extra = '') => db.all(`SELECT card_id FROM ${table} ${extra}`);
  assert.deepStrictEqual((await own('collection', `WHERE user_id = ${user.id}`)).map(r => r.card_id), [REAL]);
  assert.deepStrictEqual((await own('deck_cards')).map(r => r.card_id), [REAL], 'deck rows naming an unknown card are skipped');
  assert.deepStrictEqual((await own('card_list_items')).map(r => r.card_id), [REAL], 'list rows naming an unknown card are skipped');
  console.log('PASS: a member restore takes card data from providers, never from the file');

  // An admin: the file's card data is trusted, as before (moving a phone to a server).
  fetched.length = 0;
  user = { id: await mkUser('owner', 'admin'), role: 'admin', tcg_api_key: '' };
  const a = await restore(base, forged());
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.strictEqual(fetched.length, 0, 'an admin restore asks no provider');
  assert.strictEqual((await db.get(`SELECT name FROM card_cache WHERE id = ?`, [FAKE])).name, 'Free Money');
  assert.strictEqual((await db.get(`SELECT name FROM card_cache WHERE id = ?`, [REAL])).name, 'Llanowar Elves',
    'existing shared rows are never overwritten');
  assert.deepStrictEqual([a.body.cards, a.body.skipped, a.body.fetched_cards], [2, 0, undefined]);
  console.log('PASS: an admin restore adds the file\'s card data without overwriting');
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error('FAIL:', err && err.stack || err);
    process.exitCode = 1;
    await cleanup();
  });
