// Creating a deck from a pasted decklist (POST /api/decks):
//
//   - the cards are resolved before anything is written, and the deck and its cards
//     are one transaction. It used to insert the deck, then call Scryfall, then add
//     the cards, so a Scryfall failure left a half-made deck and a retry made a
//     second one;
//   - the cached cards a plain decklist names are looked up in one query per kind
//     of lookup, not one per line: a name compared lower-cased cannot use an index,
//     so each line was a full scan of card_cache.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-deckcreate-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');

let server;
let userId;

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
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api/decks', require('../src/routes/decks'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api`));
  });
}

let base;
const post = async (url, body) => {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const deckCount = async () => (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [userId])).n;

async function providerFailureWritesNothing() {
  const real = scryfallApi.bulkFetchByIdentifier;
  scryfallApi.bulkFetchByIdentifier = async () => { throw new Error('Scryfall is down'); };
  try {
    const res = await post('/decks', {
      name: 'ManaBox Deck', game: 'mtg', decklist_format: 'manabox',
      decklist_text: 'Name,Set code,Collector number,Quantity\nLightning Bolt,lea,161,4\n',
    });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(await deckCount(), 0, 'no deck is left behind when its cards could not be looked up');
  } finally {
    scryfallApi.bulkFetchByIdentifier = real;
  }
  console.log('PASS: a decklist that cannot be resolved creates no deck');
}

// Names with no number in them: a trailing number reads as a collector number.
const filler = (i) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26));

async function oneLookupForTheList() {
  const cards = [
    ['mtg-bolt-ja', 'Lightning Bolt', 'lea', '161', 'Japanese'],
    ['mtg-bolt', 'Lightning Bolt', 'lea', '161', 'English'],
    ['mtg-bolt-m10', 'Lightning Bolt', 'm10', '146', 'English'],
    ['mtg-forest', 'Forest', 'lea', '294', 'English'],
    ['mtg-eowyn', 'Éowyn, Fearless Knight', 'ltr', '201', 'English'],
  ];
  for (const [id, name, set, number, language] of cards) {
    await db.run(`INSERT INTO card_cache (id, name, game, set_id, number, language) VALUES (?, ?, 'mtg', ?, ?, ?)`, [id, name, set, number, language]);
  }
  for (let i = 0; i < 40; i++) {
    await db.run(`INSERT INTO card_cache (id, name, game, set_id, number) VALUES (?, ?, 'mtg', 'zzz', ?)`, [`mtg-filler-${i}`, `Filler Card ${filler(i)}`, String(i)]);
  }
  const lines = [
    '4 Lightning Bolt (LEA) 161',  // that printing, the English row first
    '2 lightning bolt',            // any printing of that name: the first cached
    '10 Forest',
    '1 Éowyn, Fearless Knight',
    '1 Not A Real Card',           // dropped, as before
    ...Array.from({ length: 40 }, (_, i) => `1 Filler Card ${filler(i)}`),
  ];

  const counts = { n: 0 };
  const realAll = db.all;
  const realGet = db.get;
  db.all = (sql, ...rest) => { if (/FROM card_cache/.test(sql)) counts.n++; return realAll(sql, ...rest); };
  db.get = (sql, ...rest) => { if (/FROM card_cache/.test(sql)) counts.n++; return realGet(sql, ...rest); };
  let res;
  try {
    res = await post('/decks', { name: 'Plain Deck', game: 'mtg', decklist_text: lines.join('\n') });
  } finally {
    db.all = realAll;
    db.get = realGet;
  }
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.ok(counts.n <= 2, `${lines.length} lines took ${counts.n} card lookups`);
  const deck = await db.all(`SELECT card_id, quantity FROM deck_cards WHERE deck_id = ? ORDER BY card_id`, [res.body.id]);
  const got = Object.fromEntries(deck.map(r => [r.card_id, r.quantity]));
  assert.strictEqual(got['mtg-bolt'], 4, 'the printing a line names, its English row first');
  assert.strictEqual(got['mtg-bolt-ja'], 2, 'a name alone takes the first cached card of that name, as it always has');
  assert.strictEqual(got['mtg-forest'], 10);
  assert.strictEqual(got['mtg-eowyn'], 1, 'a name with an accented capital still matches');
  assert.strictEqual(got['mtg-filler-39'], 1);
  assert.strictEqual(deck.length, 44, 'every line that names a cached card, and only those');
  console.log(`PASS: a ${lines.length}-line decklist is resolved in ${counts.n} lookups`);
}

async function main() {
  await db.initDb();
  userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('decker', 'x', 'admin', 'tok')`)).lastID;
  base = await startApp();
  await providerFailureWritesNothing();
  await oneLookupForTheList();
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
