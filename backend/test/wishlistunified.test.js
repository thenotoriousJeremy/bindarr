// One wishlist (WEB-03): the Lists feature's default Wishlist is the only place a
// wanted card lives, so every request that still names the collection's old
// wishlist lands there instead, through the real routes on a temp SQLite:
//
//   - an older app's "move to wishlist" (PUT /collection/:id, bulk list_type)
//     puts the card on the Wishlist and the copies in the trash, from where they
//     come back; "move to collection" changes nothing;
//   - an add with list_type 'wishlist' (single or bulk) makes no copy;
//   - a trashed wishlist row, an imported wishlist row (JSON or a CSV List Type
//     column) and a full backup's wishlist rows go on the Wishlist, not into the
//     collection; the export holds owned copies only;
//   - the public wishlist link shows the Wishlist, in the shape the page reads.
//
// Every card is in card_cache, so no provider is asked.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-wishlistunified-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');

let server;
let base;
let alice;
let bob;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/shared', require('../src/routes/shared'));
  app.use((req, res, next) => { req.user = { id: Number(req.get('x-test-user')) || alice, role: 'admin' }; next(); });
  app.use('/api/collection/trash', require('../src/routes/trash'));
  app.use('/api', require('../src/routes/collection'));
  app.use('/api', require('../src/routes/importExport'));
  app.use('/api', require('../src/routes/backup'));
  app.use('/api', require('../src/routes/lists'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api`));
  });
}

const api = async (method, url, body, as) => {
  const headers = { 'Content-Type': 'application/json' };
  if (as) headers['x-test-user'] = String(as);
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};

const mkUser = async (name) => (await db.run(
  `INSERT INTO users (username, password_hash, role, share_token, share_enabled) VALUES (?, 'x', 'admin', ?, 1)`,
  [name, `share-${name}-${crypto.randomBytes(4).toString('hex')}`]
)).lastID;
const card = (id, name, extra = {}) => db.run(
  `INSERT INTO card_cache (id, name, game, set_id, set_name, number, price_trend, price_currency, types, subtypes, rarity)
   VALUES (?, ?, 'pokemon', 'base1', 'Base Set', ?, ?, 'USD', '["Fire"]', '["Basic"]', 'Rare')`,
  [id, name, extra.number || '1', extra.price ?? 2]
);
const copy = async (cardId, user = alice, listType = 'collection') => (await db.run(
  `INSERT INTO collection (card_id, user_id, quantity, list_type, game) VALUES (?, ?, 1, ?, 'pokemon')`, [cardId, user, listType]
)).lastID;
const wishlist = async (user = alice) => (await db.all(
  `SELECT i.card_id, i.quantity_wanted, i.notes FROM card_list_items i JOIN card_lists l ON l.id = i.list_id
    WHERE l.user_id = ? AND l.is_default = 1 ORDER BY i.card_id`, [user]
)).map(i => [i.card_id, i.quantity_wanted, i.notes]);
const copiesOf = async (cardId, user = alice) => (await db.get(
  `SELECT COUNT(*) AS n FROM collection WHERE card_id = ? AND user_id = ?`, [cardId, user]
)).n;
const clearWishlist = (user = alice) => db.run(`DELETE FROM card_lists WHERE user_id = ?`, [user]);

// An older app moving copies to the wishlist: the card goes on the Wishlist, the
// copies to the trash, and restoring the trash brings the copies back.
async function olderAppMovesCopies() {
  const single = await copy('pk-char');
  let res = await api('PUT', `/collection/${single}`, { list_type: 'wishlist', condition: 'Damaged', notes: 'x' });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(await wishlist(), [['pk-char', 1, '']], 'the card is on the Wishlist');
  assert.strictEqual(await copiesOf('pk-char'), 0, 'the copy left the collection');
  assert.ok(res.body.trash_batch, 'into the trash, as one undoable batch');
  res = await api('POST', `/collection/trash/${res.body.trash_batch}/restore`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.restored, 1);
  assert.deepStrictEqual(await db.get(`SELECT condition, list_type FROM collection WHERE id = ?`, [single]),
    { condition: 'Near Mint', list_type: 'collection' }, 'it comes back as it was, an owned copy');
  assert.deepStrictEqual(await wishlist(), [['pk-char', 1, '']], 'and the card stays wanted');

  // The bulk action: two Blastoise and a Venusaur, plus an id of Bob's.
  const mine = [await copy('pk-blast'), await copy('pk-blast'), await copy('pk-venu')];
  const bobs = await copy('pk-blast', bob);
  res = await api('POST', '/collection/bulk', { entry_ids: [...mine, bobs], action: 'list_type', value: 'wishlist' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.affected, 3, "three copies of hers; Bob's id is ignored");
  assert.strictEqual(res.body.wishlisted, 2, 'two cards');
  assert.deepStrictEqual(await wishlist(), [['pk-blast', 2, ''], ['pk-char', 1, ''], ['pk-venu', 1, '']],
    'the copies moved are the copies wanted');
  assert.strictEqual(await copiesOf('pk-blast'), 0);
  assert.strictEqual(await copiesOf('pk-blast', bob), 1, "Bob's copy is untouched");
  assert.deepStrictEqual(await wishlist(bob), [], 'and Bob has no wishlist from it');
  assert.strictEqual(await db.get(`SELECT COUNT(*) AS n FROM collection WHERE list_type = 'wishlist'`).then(r => r.n), 0,
    'no copy is ever stored on the wishlist again');
  res = await api('POST', `/collection/trash/${res.body.trash_batch}/restore`);
  assert.strictEqual(res.body.restored, 3, 'the three copies come back');
  assert.strictEqual(await copiesOf('pk-blast'), 2);

  // "Move to collection" has nothing to do: every copy is in it.
  res = await api('POST', '/collection/bulk', { entry_ids: mine, action: 'list_type', value: 'collection' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(await copiesOf('pk-blast'), 2);
  assert.strictEqual((await api('POST', '/collection/bulk', { entry_ids: mine, action: 'list_type', value: 'binder' })).status, 400);
  console.log("PASS: an older app's move to wishlist wants the card and trashes the copies");
}

// An add that says wishlist makes no copy.
async function addsToWishlist() {
  await clearWishlist();
  let res = await api('POST', '/collection', { card_id: 'pk-pika', list_type: 'wishlist', quantity: 2 });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.wishlisted, true);
  assert.strictEqual(await copiesOf('pk-pika'), 0, 'no copy was made');
  assert.deepStrictEqual(await wishlist(), [['pk-pika', 2, '']]);

  res = await api('POST', '/collection/bulk-add', { card_ids: ['pk-pika', 'pk-venu'], list_type: 'wishlist' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.added, 2);
  assert.strictEqual(await copiesOf('pk-pika'), 0);
  assert.deepStrictEqual(await wishlist(), [['pk-pika', 2, ''], ['pk-venu', 1, '']], 'a card already wanted keeps its count');

  res = await api('POST', '/collection', { card_id: 'pk-pika' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(await db.get(`SELECT list_type FROM collection WHERE id = ?`, [res.body.id]).then(r => r.list_type), 'collection');
  console.log('PASS: an add to the wishlist wants the card and makes no copy');
}

// A wishlist row deleted before the change comes back as a want.
async function trashedWishlistRow() {
  await clearWishlist();
  const batch = crypto.randomUUID();
  const legacy = { id: 900001, card_id: 'pk-mew', user_id: alice, quantity: 3, list_type: 'wishlist', notes: 'any set', condition: 'Near Mint' };
  const owned = { id: 900002, card_id: 'pk-mew', user_id: alice, quantity: 1, list_type: 'collection', condition: 'Near Mint', printing: 'Normal' };
  for (const row of [legacy, owned]) {
    await db.run(`INSERT INTO collection_trash (entry_id, batch_id, user_id, card_id, row_json) VALUES (?, ?, ?, ?, ?)`,
      [row.id, batch, alice, row.card_id, JSON.stringify(row)]);
  }
  const res = await api('POST', `/collection/trash/${batch}/restore`);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual([res.body.restored, res.body.wishlisted], [1, 1]);
  assert.deepStrictEqual(await wishlist(), [['pk-mew', 3, 'any set']]);
  assert.deepStrictEqual((await db.all(`SELECT id, list_type FROM collection WHERE card_id = 'pk-mew'`)),
    [{ id: 900002, list_type: 'collection' }], 'only the owned copy is a collection row');
  console.log('PASS: a trashed wishlist row is restored onto the Wishlist');
}

// Imports and full backups from before the change.
async function importsAndBackups() {
  await clearWishlist();
  // A JSON file made from GET /collection, wishlist rows and all.
  let res = await api('POST', '/import', {
    format: 'json',
    data: JSON.stringify([
      { card_id: 'pk-onix', quantity: 1, list_type: 'collection' },
      { card_id: 'pk-mew', quantity: 2, list_type: 'wishlist', notes: 'shiny' },
    ]),
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual([res.body.count, res.body.wishlisted], [1, 1]);
  assert.strictEqual(await copiesOf('pk-onix'), 1);
  assert.strictEqual(await db.get(`SELECT COUNT(*) AS n FROM collection WHERE card_id = 'pk-mew' AND list_type = 'wishlist'`).then(r => r.n), 0);
  assert.deepStrictEqual(await wishlist(), [['pk-mew', 2, 'shiny']]);

  // A CSV with a List Type column.
  res = await api('POST', '/import', {
    format: 'csv',
    data: 'Card ID,Quantity,List Type\npk-zap,1,Wishlist\npk-onix,1,collection\n',
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual([res.body.count, res.body.wishlisted], [1, 1]);
  assert.strictEqual(await copiesOf('pk-zap'), 0);
  assert.strictEqual(await copiesOf('pk-onix'), 2);
  assert.deepStrictEqual(await wishlist(), [['pk-mew', 2, 'shiny'], ['pk-zap', 1, '']]);

  // The export lists owned copies only (a leftover wishlist row is not one).
  await copy('pk-zap', alice, 'wishlist');
  res = await api('GET', '/export?format=json');
  assert.ok(!res.body.some(r => r.card_id === 'pk-zap'), 'a wishlist row is not exported as a copy');
  await db.run(`DELETE FROM collection WHERE list_type = 'wishlist'`);

  // A full backup made before the change, whose collection holds wishlist rows.
  const backup = {
    format: 'bindarr-backup',
    version: 1,
    data: {
      collection: [
        { id: 1, card_id: 'pk-onix', quantity: 1, list_type: 'collection', condition: 'Near Mint', printing: 'Normal', language: 'English', game: 'pokemon' },
        { id: 2, card_id: 'pk-mew', quantity: 2, list_type: 'wishlist', condition: 'Near Mint', printing: 'Normal', language: 'English', game: 'pokemon', notes: '' },
        { id: 3, card_id: 'pk-zap', quantity: 1, list_type: 'wishlist', condition: 'Near Mint', printing: 'Normal', language: 'English', game: 'pokemon' },
      ],
      card_lists: [{ id: 7, name: 'Hearts', kind: 'wishlist', is_default: 1 }],
      card_list_items: [{ list_id: 7, card_id: 'pk-mew', quantity_wanted: 1, notes: 'hearted' }],
    },
  };
  res = await api('POST', '/backup/restore', { backup });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual([res.body.cards, res.body.wishlisted], [1, 2]);
  assert.deepStrictEqual(await db.all(`SELECT card_id, list_type FROM collection WHERE user_id = ?`, [alice]),
    [{ card_id: 'pk-onix', list_type: 'collection' }], 'only the owned copy is restored as a copy');
  assert.deepStrictEqual(await wishlist(), [['pk-mew', 2, 'hearted'], ['pk-zap', 1, '']],
    "onto the backup's own default list, which keeps the larger count");
  assert.strictEqual((await db.get(`SELECT name FROM card_lists WHERE user_id = ? AND is_default = 1`, [alice])).name, 'Hearts');
  console.log('PASS: imports and backups put wishlist rows on the Wishlist');
}

// The public wishlist link reads the Wishlist, in the shape the page draws.
async function sharedWishlist() {
  const tokenOf = async (user) => (await db.get(`SELECT share_token FROM users WHERE id = ?`, [user])).share_token;
  // Someone who has wanted nothing yet. (A share is cached for a few seconds, so
  // each case below reads its own owner or list once.)
  const carol = await mkUser('carol');
  let res = await api('GET', `/shared/${await tokenOf(carol)}?list=wishlist`);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.collection, [], 'nothing wanted yet');
  assert.strictEqual(res.body.stats.summary.totalCards, 0);

  // Bob hearts two cards, and wants three of one at Lightly Played or better.
  await copy('pk-char', bob, 'wishlist');   // a leftover old-wishlist row is not shown
  res = await api('POST', '/lists/default/items', { card_ids: ['pk-char', 'pk-mew'] }, bob);
  assert.strictEqual(res.status, 201, res.text);
  await db.run(`UPDATE card_list_items SET quantity_wanted = 3, condition_min = 'Lightly Played'
                 WHERE card_id = 'pk-mew' AND list_id IN (SELECT id FROM card_lists WHERE user_id = ?)`, [bob]);
  const token = await tokenOf(bob);
  res = await api('GET', `/shared/${token}?list=wishlist`);
  assert.strictEqual(res.status, 200, res.text);
  const body = res.body;
  const byCard = Object.fromEntries(body.collection.map(c => [c.card_id, c]));
  assert.deepStrictEqual(Object.keys(byCard).sort(), ['pk-char', 'pk-mew']);
  const mew = byCard['pk-mew'];
  assert.strictEqual(mew.quantity, 3, 'quantity is the copies wanted');
  assert.strictEqual(mew.condition, 'Lightly Played');
  assert.strictEqual(mew.list_type, 'wishlist');
  assert.ok(Array.isArray(mew.types) && Array.isArray(mew.subtypes), 'parsed like a collection row');
  assert.ok(Number.isInteger(mew.entry_id) && mew.name === 'Mew' && mew.set_name === 'Base Set');
  assert.ok(!('location' in mew), 'a wanted card is stored nowhere');
  assert.strictEqual(body.stats.summary.totalCards, 4);
  assert.strictEqual(body.stats.summary.uniqueCards, 2);
  assert.strictEqual(body.stats.summary.totalValue, 8, '4 cards at $2');

  // The collection view still reads his copies, and only those.
  await copy('pk-onix', bob);
  res = await api('GET', `/shared/${token}?list=collection`);
  assert.deepStrictEqual(res.body.collection.map(c => c.card_id).sort(), ['pk-blast', 'pk-onix']);
  console.log('PASS: the public wishlist link shows the Wishlist');
}

async function main() {
  await db.initDb();
  alice = await mkUser('alice');
  bob = await mkUser('bob');
  for (const [id, name, number] of [
    ['pk-char', 'Charizard', '4'], ['pk-blast', 'Blastoise', '2'], ['pk-venu', 'Venusaur', '15'], ['pk-pika', 'Pikachu', '58'],
    ['pk-mew', 'Mew', '8'], ['pk-onix', 'Onix', '56'], ['pk-zap', 'Zapdos', '16'],
  ]) await card(id, name, { number });
  base = await startApp();

  await olderAppMovesCopies();
  await addsToWishlist();
  await trashedWishlistRow();
  await importsAndBackups();
  await sharedWishlist();
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error('FAIL:', err);
    await cleanup();
    process.exit(1);
  });
