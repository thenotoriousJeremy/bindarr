// A full backup of an account that has traded (routes/backup.js), restored where
// the records of those trades are and where they are not.
//
// Trades and gifts between accounts, and trades recorded after the fact, belong
// to both accounts, so a backup does not carry them: a copy's link to one is kept
// only where this install holds it as the restorer's own receipt. Copied as it
// was, the link failed the whole restore on its foreign key wherever the record
// was missing (a fresh install, a phone), and named someone else's trade where it
// was not. Deals with people outside Bindarr are the account's own, so they
// travel with it, renumbered: contacts, deals, their items, the copy or sealed
// unit each item gave away or brought in, and the item each copy came in by. A
// backup from before any of that still restores, and leaves the account's deals
// as they are.
//
// The fresh install is a second process with a database of its own: this file
// again, with --fresh-install and the backup file this one exported.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const { spawnSync } = require('child_process');

const FRESH = process.argv[2] === '--fresh-install';
const tmpDb = path.join(os.tmpdir(), `bindarr-backuptrades${FRESH ? '-fresh' : ''}-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');

// The providers a member's restore asks for the cards an install lacks. Here
// every card exists, and asking for one caches it, as the real ones do.
const fetched = [];
const stubModule = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stubModule('../src/utils/cardApi', {
  ...require('../src/utils/cardApi'),
  getCardById: async (id) => {
    fetched.push(id);
    await db.run(`INSERT OR IGNORE INTO card_cache (id, name, game) VALUES (?, ?, 'mtg')`, [id, `Card ${id}`]);
    return { id };
  },
});

const TRANSFER_CARD = 'mtg-bt-transfer';
const HISTORICAL_CARD = 'mtg-bt-historical';
const EXTERNAL_CARD = 'mtg-bt-external';
const GIVEN_CARD = 'mtg-bt-given';
const CARDS = [TRANSFER_CARD, HISTORICAL_CARD, EXTERNAL_CARD, GIVEN_CARD];

let server;
let scratch;
let base;
const accounts = new Map();

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}

// The acting account comes from a header, so one server can play all of them.
function startApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => { req.user = accounts.get(Number(req.headers['x-user'])); next(); });
  app.use('/api', require('../src/routes/backup'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function api(userId, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user': String(userId) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function addUser(name, role = 'member') {
  const id = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES (?, 'x', ?, ?)`,
    [name, role, `share-${name}-${process.pid}`])).lastID;
  accounts.set(id, { id, username: name, role, tcg_api_key: '' });
  return id;
}

async function addCopy(userId, cardId, extra = {}) {
  const row = { card_id: cardId, user_id: userId, quantity: 1, game: 'mtg', ...extra };
  const cols = Object.keys(row);
  return (await db.run(`INSERT INTO collection (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map(c => row[c]))).lastID;
}

const copyOf = (userId, cardId) => db.get(`SELECT * FROM collection WHERE user_id = ? AND card_id = ?`, [userId, cardId]);

// What a member's upload holds: the shared card tables stay behind
// (frontend/src/utils/backupUpload.js), and the restore asks the providers.
function asMemberUploads(file) {
  const data = { ...file.data };
  for (const table of ['card_cache', 'price_history', 'tcgplayer_product']) delete data[table];
  return { ...file, data };
}

// Bob's two deals with people outside Bindarr, as they come back into `userId`
// from his file: renumbered, and every link between the deals and the restored
// copies and units pointing at this account's own new rows.
async function assertDealsRestored(userId) {
  const contacts = await db.all(`SELECT name FROM external_contacts WHERE user_id = ? ORDER BY name`, [userId]);
  assert.deepStrictEqual(contacts.map(c => c.name), ['Pat', 'Sam'], 'contacts come back once each, the one without deals too');
  const deals = await db.all(
    `SELECT t.id, t.contact_name_snapshot, t.transaction_type, t.message, t.completed_at, c.name AS contact, c.user_id AS contact_owner
       FROM external_transactions t LEFT JOIN external_contacts c ON c.id = t.contact_id
      WHERE t.user_id = ? ORDER BY t.id`,
    [userId]
  );
  assert.deepStrictEqual(
    deals.map(d => [d.contact, d.contact_owner, d.contact_name_snapshot, d.transaction_type, d.message, d.completed_at]),
    [['Sam', userId, 'Sam', 'trade', 'At league night', '2026-04-02 18:00:00'], [null, null, 'Lee', 'gift', null, '2026-05-01 12:00:00']],
    'each deal names its restored contact, or none when its contact was deleted'
  );
  const items = await db.all(
    `SELECT i.* FROM external_transaction_items i JOIN external_transactions t ON t.id = i.transaction_id
      WHERE t.user_id = ? ORDER BY i.id`,
    [userId]
  );
  const item = (dealId, direction, type) => items.find(i => i.transaction_id === dealId && i.direction === direction && i.item_type === type);
  const [trade, gift] = deals;
  assert.strictEqual(items.length, 4);

  const received = item(trade.id, 'received', 'card');
  const receivedCopy = await copyOf(userId, EXTERNAL_CARD);
  assert.strictEqual(receivedCopy.acquired_via_external_item_id, received.id, 'the copy names the restored item it came in by');
  assert.strictEqual(received.source_collection_id, receivedCopy.id, 'and that item names the restored copy');
  assert.deepStrictEqual([received.received_cost, JSON.parse(received.item_snapshot).name], [1.5, 'Shock']);

  const given = item(trade.id, 'given', 'card');
  assert.strictEqual(given.source_collection_id, (await copyOf(userId, GIVEN_CARD)).id, 'a copy partly given away is still linked');
  assert.deepStrictEqual([given.purchase_cost, JSON.parse(given.item_snapshot).card_id], [1.5, GIVEN_CARD]);

  const box = item(trade.id, 'received', 'sealed');
  const unit = await db.get(
    `SELECT p.user_id, p.product_name, p.store FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id WHERE u.id = ?`,
    [box.source_sealed_unit_id]
  );
  assert.deepStrictEqual(unit, { user_id: userId, product_name: 'Booster Pack', store: 'External: Sam' },
    'a sealed item names the restored unit, in this account\'s own purchase');

  const sent = item(gift.id, 'given', 'sealed');
  assert.strictEqual(sent.source_sealed_unit_id, null, 'a unit given away stays given away');
  assert.strictEqual(JSON.parse(sent.item_snapshot).product_name, 'Collector Booster');
  return items;
}

// --- the fresh install ----------------------------------------------------------

async function freshInstall(file) {
  await db.initDb();
  const bob = await addUser('bob');
  base = await startApp();

  const r = await api(bob, 'POST', '/api/backup/restore', { backup: asMemberUploads(file) });
  assert.strictEqual(r.status, 200, `a fresh install restores a received card: ${JSON.stringify(r.body)}`);
  assert.deepStrictEqual([r.body.cards, r.body.skipped, r.body.external_deals, r.body.fetched_cards], [4, 0, 2, 4]);
  assert.deepStrictEqual(fetched.sort(), [...CARDS].sort(), 'each card came from its provider');
  for (const card of [TRANSFER_CARD, HISTORICAL_CARD]) {
    const copy = await copyOf(bob, card);
    assert.deepStrictEqual([copy.acquired_via_transfer_item_id, copy.acquired_via_historical_trade_item_id], [null, null],
      `${card}: this install has no record of the trade`);
  }
  console.log('PASS: a member\'s backup holding received cards restores on a fresh install, without the trade links');
  await assertDealsRestored(bob);
  console.log('PASS: on the fresh install, the outside deals come back linked to the restored copies and units');
}

// --- the install the backup comes from --------------------------------------------

async function main() {
  await db.initDb();
  const alice = await addUser('alice');
  const bob = await addUser('bob');
  const carol = await addUser('carol');
  const dana = await addUser('dana', 'admin');
  base = await startApp();
  for (const [id, name] of [[TRANSFER_CARD, 'Llanowar Elves'], [HISTORICAL_CARD, 'Giant Growth'], [EXTERNAL_CARD, 'Shock'], [GIVEN_CARD, 'Opt']]) {
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, 'mtg')`, [id, name]);
  }

  // A gift from alice, accepted: bob's copy names the transfer item.
  const transfer = (await db.run(
    `INSERT INTO user_transfers (proposer_id, recipient_id, proposer_name, recipient_name, transfer_type, status, completed_at)
     VALUES (?, ?, 'alice', 'bob', 'gift', 'accepted', CURRENT_TIMESTAMP)`, [alice, bob])).lastID;
  const transferItem = (await db.run(
    `INSERT INTO user_transfer_items (transfer_id, from_user_id, to_user_id, item_type, quantity, received_cost, item_snapshot)
     VALUES (?, ?, ?, 'card', 1, 0, ?)`, [transfer, alice, bob, JSON.stringify({ card_id: TRANSFER_CARD, name: 'Llanowar Elves' })])).lastID;
  await addCopy(bob, TRANSFER_CARD, { purchase_price: 0, acquired_via_transfer_item_id: transferItem });

  // A trade bob recorded after the fact, which alice confirmed.
  const trade = (await db.run(
    `INSERT INTO historical_trades (creator_id, recipient_id, creator_name, recipient_name, status, completed_at, confirmed_at)
     VALUES (?, ?, 'bob', 'alice', 'confirmed', '2026-03-01', CURRENT_TIMESTAMP)`, [bob, alice])).lastID;
  const historicalCopy = await addCopy(bob, HISTORICAL_CARD);
  const historicalItem = (await db.run(
    `INSERT INTO historical_trade_items (trade_id, from_user_id, to_user_id, card_id, quantity, item_snapshot, creator_collection_id)
     VALUES (?, ?, ?, ?, 1, ?, ?)`, [trade, alice, bob, HISTORICAL_CARD, JSON.stringify({ name: 'Giant Growth' }), historicalCopy])).lastID;
  await db.run(`UPDATE collection SET acquired_via_historical_trade_item_id = ? WHERE id = ?`, [historicalItem, historicalCopy]);

  // Two deals outside Bindarr: a trade with Sam (one of two Opts out; a Shock and
  // a booster pack in), and a gift to Lee, whose contact has since been deleted.
  // Made in that order, the second a month later: the deals' index lists them
  // newest first, and the restore must still renumber them in the order made.
  const sam = (await db.run(`INSERT INTO external_contacts (user_id, name) VALUES (?, 'Sam')`, [bob])).lastID;
  await db.run(`INSERT INTO external_contacts (user_id, name) VALUES (?, 'Pat')`, [bob]);
  const deal = (await db.run(
    `INSERT INTO external_transactions (user_id, contact_id, contact_name_snapshot, transaction_type, message, created_at, completed_at)
     VALUES (?, ?, 'Sam', 'trade', 'At league night', '2026-04-02 18:00:00', '2026-04-02 18:00:00')`, [bob, sam])).lastID;
  const givenCopy = await addCopy(bob, GIVEN_CARD, { purchase_price: 1.5 });
  await db.run(
    `INSERT INTO external_transaction_items (transaction_id, direction, item_type, source_collection_id, purchase_cost, item_snapshot)
     VALUES (?, 'given', 'card', ?, 1.5, ?)`, [deal, givenCopy, JSON.stringify({ card_id: GIVEN_CARD, name: 'Opt' })]);
  const receivedCopy = await addCopy(bob, EXTERNAL_CARD, { purchase_price: 1.5 });
  const receivedItem = (await db.run(
    `INSERT INTO external_transaction_items (transaction_id, direction, item_type, source_collection_id, received_cost, item_snapshot)
     VALUES (?, 'received', 'card', ?, 1.5, ?)`, [deal, receivedCopy, JSON.stringify({ card_id: EXTERNAL_CARD, name: 'Shock' })])).lastID;
  await db.run(`UPDATE collection SET acquired_via_external_item_id = ? WHERE id = ?`, [receivedItem, receivedCopy]);
  const pack = (await db.run(
    `INSERT INTO sealed_purchases (user_id, product_name, game, store, quantity, unit_price) VALUES (?, 'Booster Pack', 'mtg', 'External: Sam', 1, 0)`,
    [bob])).lastID;
  const packUnit = (await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [pack])).lastID;
  await db.run(
    `INSERT INTO external_transaction_items (transaction_id, direction, item_type, source_sealed_unit_id, received_cost, item_snapshot)
     VALUES (?, 'received', 'sealed', ?, 0, ?)`, [deal, packUnit, JSON.stringify({ product_name: 'Booster Pack' })]);
  const gift = (await db.run(
    `INSERT INTO external_transactions (user_id, contact_id, contact_name_snapshot, transaction_type, created_at, completed_at)
     VALUES (?, NULL, 'Lee', 'gift', '2026-05-01 12:00:00', '2026-05-01 12:00:00')`, [bob])).lastID;
  await db.run(
    `INSERT INTO external_transaction_items (transaction_id, direction, item_type, item_snapshot)
     VALUES (?, 'given', 'sealed', ?)`, [gift, JSON.stringify({ product_name: 'Collector Booster' })]);

  // --- the backup carries the deals ---------------------------------------------
  const exported = await api(bob, 'GET', '/api/backup');
  assert.strictEqual(exported.status, 200, JSON.stringify(exported.body));
  const file = exported.body;
  assert.deepStrictEqual(file.data.external_contacts.map(c => c.name).sort(), ['Pat', 'Sam']);
  assert.strictEqual(file.data.external_transactions.length, 2);
  assert.strictEqual(file.data.external_transaction_items.length, 4);
  assert.ok(!('user_transfers' in file.data) && !('historical_trades' in file.data), 'trades between accounts are not in it');
  const other = await api(carol, 'GET', '/api/backup');
  assert.deepStrictEqual([other.body.data.external_contacts, other.body.data.external_transactions, other.body.data.external_transaction_items],
    [[], [], []], 'an account\'s backup holds its own deals only');
  console.log('PASS: a backup carries the account\'s outside deals, and no trades between accounts');

  // --- the same install -----------------------------------------------------------
  const oldItems = (await db.all(`SELECT id FROM external_transaction_items`)).map(i => i.id);
  let r = await api(bob, 'POST', '/api/backup/restore', { backup: asMemberUploads(file) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.cards, r.body.skipped, r.body.external_deals], [4, 0, 2]);
  assert.strictEqual((await copyOf(bob, TRANSFER_CARD)).acquired_via_transfer_item_id, transferItem,
    'the gift bob received is on this install: the link stays');
  assert.strictEqual((await copyOf(bob, HISTORICAL_CARD)).acquired_via_historical_trade_item_id, historicalItem);
  assert.ok(await db.get(`SELECT 1 FROM user_transfer_items WHERE id = ? AND to_user_id = ?`, [transferItem, bob]),
    'the shared record itself is untouched');
  const bobsItems = await assertDealsRestored(bob);
  assert.ok(bobsItems.every(i => !oldItems.includes(i.id)), 'the deals were replaced by the file\'s, renumbered');
  console.log('PASS: restored on the same install, the received cards keep their trade links and the deals come back renumbered');

  // --- the same file, restored into accounts whose trades these are not ------------
  // Carol (a member) and dana (an admin, whose restore takes the card data from the
  // file, as a phone's own does) restore bob's file: the trade records exist here,
  // but are bob's, so the links go; the deals are theirs now, and bob's stay his.
  for (const userId of [carol, dana]) {
    fetched.length = 0;
    r = await api(userId, 'POST', '/api/backup/restore', { backup: accounts.get(userId).role === 'admin' ? file : asMemberUploads(file) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.cards, r.body.skipped, r.body.external_deals], [4, 0, 2]);
    assert.strictEqual(fetched.length, 0, 'every card is cached here');
    for (const card of [TRANSFER_CARD, HISTORICAL_CARD]) {
      const copy = await copyOf(userId, card);
      assert.deepStrictEqual([copy.acquired_via_transfer_item_id, copy.acquired_via_historical_trade_item_id], [null, null],
        `${card}: another account's trade is not this one's`);
    }
    await assertDealsRestored(userId);
  }
  const bobsNow = await copyOf(bob, EXTERNAL_CARD);
  const bobsItem = await db.get(`SELECT * FROM external_transaction_items WHERE id = ?`, [bobsNow.acquired_via_external_item_id]);
  assert.strictEqual(bobsItem.source_collection_id, bobsNow.id, 'bob\'s deals still point at his own copies');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM external_transactions WHERE user_id = ?`, [bob])).n, 2);
  console.log('PASS: restored into another account, member or admin, trade links go and the deals become that account\'s');

  // --- a backup made before the deals were in it ------------------------------------
  // It still names the received copies' records. Bob's, on this install, are kept;
  // a link to carol's deal is not his to keep, so it goes. The deals bob has stay.
  const withoutDeals = (f) => {
    const data = { ...f.data };
    for (const table of ['external_contacts', 'external_transactions', 'external_transaction_items']) delete data[table];
    return { ...f, data: { ...data, collection: data.collection.map(c => ({ ...c })) } };
  };
  const between = withoutDeals(file);
  const carolsItem = (await copyOf(carol, EXTERNAL_CARD)).acquired_via_external_item_id;
  between.data.collection.find(c => c.card_id === EXTERNAL_CARD).acquired_via_external_item_id = bobsNow.acquired_via_external_item_id;
  between.data.collection.find(c => c.card_id === GIVEN_CARD).acquired_via_external_item_id = carolsItem;
  r = await api(bob, 'POST', '/api/backup/restore', { backup: asMemberUploads(between) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.cards, r.body.skipped, r.body.external_deals], [4, 0, 0]);
  assert.strictEqual((await copyOf(bob, EXTERNAL_CARD)).acquired_via_external_item_id, bobsNow.acquired_via_external_item_id,
    'a link to one of bob\'s own deals stays');
  assert.strictEqual((await copyOf(bob, GIVEN_CARD)).acquired_via_external_item_id, null, 'one to carol\'s deal goes');
  assert.strictEqual((await copyOf(bob, TRANSFER_CARD)).acquired_via_transfer_item_id, transferItem);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM external_transactions WHERE user_id = ?`, [bob])).n, 2,
    'a file without deals leaves the account\'s deals alone');
  assert.deepStrictEqual((await db.all(`SELECT name FROM external_contacts WHERE user_id = ? ORDER BY name`, [bob])).map(c => c.name), ['Pat', 'Sam']);

  // And one from before trades existed at all: no deals, no trade columns.
  const old = withoutDeals(file);
  for (const copy of old.data.collection) {
    for (const column of Object.keys(copy)) if (column.startsWith('acquired_via_')) delete copy[column];
  }
  r = await api(bob, 'POST', '/api/backup/restore', { backup: asMemberUploads(old) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.cards, r.body.skipped, r.body.external_deals], [4, 0, 0]);
  for (const card of CARDS) {
    const copy = await copyOf(bob, card);
    assert.deepStrictEqual(
      [copy.acquired_via_transfer_item_id, copy.acquired_via_historical_trade_item_id, copy.acquired_via_external_item_id],
      [null, null, null], card);
  }
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM external_transactions WHERE user_id = ?`, [bob])).n, 2);
  console.log('PASS: an older backup, without deals or trade columns, restores and leaves the account\'s deals alone');

  // --- a fresh install ------------------------------------------------------------
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-backuptrades-${process.pid}-`));
  const filePath = path.join(scratch, 'backup.json');
  fs.writeFileSync(filePath, JSON.stringify(file));
  const env = { ...process.env };
  delete env.DB_PATH;
  const child = spawnSync(process.execPath, [__filename, '--fresh-install', filePath], { env, stdio: 'inherit', timeout: 120000 });
  assert.strictEqual(child.status, 0, `the fresh install's restore (exit ${child.status}${child.error ? `, ${child.error.message}` : ''})`);
}

(FRESH ? freshInstall(JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))) : main())
  .then(async () => { await cleanup(); if (!FRESH) console.log('backuptrades tests passed'); })
  .catch(async (err) => { console.error(err); await cleanup(); process.exit(1); });
