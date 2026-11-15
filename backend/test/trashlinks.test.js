// Putting a copy back from the trash after what it pointed at has gone
// (utils/collectionTrash.js).
//
// A copy names the record of the trade or outside deal that brought it in, and
// the sealed unit it was opened from. Any of those can be deleted while the copy
// sits in the trash, and restoring it used to fail on its foreign key: the card
// was counted as skipped and left the trash for good. Now it comes back without
// the link. Which links those are is read from the schema, so one a later
// migration adds is covered too, and so are the rows the trash puts back with
// the copy.
//
// And the other way round: a trade's or deal's record of a copy is not deleted
// with it (ON DELETE SET NULL), only unlinked. Restoring the copy links it again,
// unless it has been pointed elsewhere since, and never brings back a record
// deleted in the meantime.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-trashlinks-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const { trashEntries } = require('../src/utils/collectionTrash');

let server;
let base;

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
  app.use((req, res, next) => { req.user = { id: Number(req.headers['x-user']), role: 'member' }; next(); });
  app.use('/api/collection/trash', require('../src/routes/trash'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function restore(userId, batch) {
  const res = await fetch(`${base}/api/collection/trash/${batch}/restore`, { method: 'POST', headers: { 'x-user': String(userId) } });
  return { status: res.status, body: await res.json() };
}

async function trash(userId, ids) {
  const { batchId, trashed } = await trashEntries(ids, userId);
  assert.strictEqual(trashed, ids.length);
  return batchId;
}

async function addUser(name) {
  return (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES (?, 'x', 'member', ?)`,
    [name, `share-${name}-${process.pid}`])).lastID;
}

async function addCopy(userId, cardId, extra = {}) {
  const row = { card_id: cardId, user_id: userId, quantity: 1, game: 'mtg', ...extra };
  const cols = Object.keys(row);
  return (await db.run(`INSERT INTO collection (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map(c => row[c]))).lastID;
}

async function transferItem(fromId, toId, { status = 'accepted', source = null, cardId = 'c-transfer' } = {}) {
  const transfer = (await db.run(
    `INSERT INTO user_transfers (proposer_id, recipient_id, transfer_type, status) VALUES (?, ?, 'gift', ?)`,
    [fromId, toId, status])).lastID;
  const item = (await db.run(
    `INSERT INTO user_transfer_items (transfer_id, from_user_id, to_user_id, item_type, source_collection_id, item_snapshot)
     VALUES (?, ?, ?, 'card', ?, ?)`, [transfer, fromId, toId, source, JSON.stringify({ card_id: cardId })])).lastID;
  return { transfer, item };
}

async function historicalItem(creatorId, recipientId, cardId, fields = {}) {
  const trade = (await db.run(
    `INSERT INTO historical_trades (creator_id, recipient_id, status, completed_at) VALUES (?, ?, 'confirmed', '2026-02-01')`,
    [creatorId, recipientId])).lastID;
  const cols = ['trade_id', 'from_user_id', 'to_user_id', 'card_id', 'item_snapshot', ...Object.keys(fields)];
  const item = (await db.run(
    `INSERT INTO historical_trade_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    [trade, creatorId, recipientId, cardId, '{}', ...Object.values(fields)])).lastID;
  return { trade, item };
}

async function externalItem(userId, source = null) {
  const deal = (await db.run(
    `INSERT INTO external_transactions (user_id, contact_name_snapshot, transaction_type) VALUES (?, 'Sam', 'gift')`, [userId])).lastID;
  const item = (await db.run(
    `INSERT INTO external_transaction_items (transaction_id, direction, item_type, source_collection_id, item_snapshot)
     VALUES (?, 'received', 'card', ?, '{}')`, [deal, source])).lastID;
  return { deal, item };
}

const rowOf = (id) => db.get(`SELECT * FROM collection WHERE id = ?`, [id]);
const itemOf = (table, id) => db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);

async function main() {
  await db.initDb();
  base = await startApp();
  for (const id of ['c-transfer', 'c-hist', 'c-ext', 'c-sealed', 'c-plain', 'c-gone']) {
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, 'mtg')`, [id, `Card ${id}`]);
  }
  const alice = await addUser('alice');
  const bob = await addUser('bob');
  const carol = await addUser('carol');

  // --- the sender's account is deleted while the received copies are in the trash --
  const gift = await transferItem(alice, bob);
  const fromAlice = await addCopy(bob, 'c-transfer', { acquired_via_transfer_item_id: gift.item, notes: 'from alice' });
  const traded = await addCopy(bob, 'c-hist');
  const recorded = await historicalItem(alice, bob, 'c-hist', { recipient_collection_id: traded });
  await db.run(`UPDATE collection SET acquired_via_historical_trade_item_id = ? WHERE id = ?`, [recorded.item, traded]);

  let batch = await trash(bob, [fromAlice, traded]);
  assert.strictEqual((await itemOf('historical_trade_items', recorded.item)).recipient_collection_id, null,
    'trashing the copy unlinks the trade\'s record of it');
  await db.run(`DELETE FROM users WHERE id = ?`, [alice]);
  assert.deepStrictEqual([(await itemOf('user_transfer_items', gift.item)).from_user_id, (await itemOf('user_transfer_items', gift.item)).to_user_id],
    [null, bob], 'the schema keeps bob\'s record, without its sender');

  let r = await restore(bob, batch);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body, { restored: 2, skipped: 0, unsorted: 0, wishlisted: 0 });
  let back = await rowOf(fromAlice);
  assert.deepStrictEqual([back.user_id, back.notes, back.acquired_via_transfer_item_id], [bob, 'from alice', gift.item],
    'the record is still there, so the copy keeps its link');
  assert.strictEqual((await rowOf(traded)).acquired_via_historical_trade_item_id, recorded.item);
  assert.strictEqual((await itemOf('historical_trade_items', recorded.item)).recipient_collection_id, traded,
    'and the trade\'s record of the copy is linked again');
  console.log('PASS: received copies come back after the sender\'s account is deleted, links intact');

  // --- the records themselves are gone ------------------------------------------------
  const giftFromCarol = await transferItem(carol, bob);
  const viaTransfer = await addCopy(bob, 'c-transfer', { acquired_via_transfer_item_id: giftFromCarol.item, grader: 'PSA', grade: 9 });
  const tradeWithCarol = await historicalItem(carol, bob, 'c-hist');
  const viaTrade = await addCopy(bob, 'c-hist', { acquired_via_historical_trade_item_id: tradeWithCarol.item });
  const dealWithSam = await externalItem(bob);
  const viaDeal = await addCopy(bob, 'c-ext', { acquired_via_external_item_id: dealWithSam.item });
  await db.run(`UPDATE external_transaction_items SET source_collection_id = ? WHERE id = ?`, [viaDeal, dealWithSam.item]);
  const purchase = (await db.run(`INSERT INTO sealed_purchases (user_id, product_name, quantity) VALUES (?, 'Booster Box', 1)`, [bob])).lastID;
  const unit = (await db.run(`INSERT INTO sealed_units (purchase_id, opened_at) VALUES (?, CURRENT_TIMESTAMP)`, [purchase])).lastID;
  const opened = await addCopy(bob, 'c-sealed', { sealed_unit_id: unit });

  batch = await trash(bob, [viaTransfer, viaTrade, viaDeal, opened]);
  await db.run(`DELETE FROM user_transfers WHERE id = ?`, [giftFromCarol.transfer]);
  await db.run(`DELETE FROM historical_trades WHERE id = ?`, [tradeWithCarol.trade]);
  await db.run(`DELETE FROM external_transactions WHERE id = ?`, [dealWithSam.deal]);
  await db.run(`DELETE FROM sealed_purchases WHERE id = ?`, [purchase]);

  r = await restore(bob, batch);
  assert.deepStrictEqual(r.body, { restored: 4, skipped: 0, unsorted: 0, wishlisted: 0 }, 'every card comes back');
  back = await rowOf(viaTransfer);
  assert.deepStrictEqual([back.acquired_via_transfer_item_id, back.grader, back.grade], [null, 'PSA', 9]);
  assert.strictEqual((await rowOf(viaTrade)).acquired_via_historical_trade_item_id, null);
  assert.strictEqual((await rowOf(viaDeal)).acquired_via_external_item_id, null);
  assert.strictEqual((await rowOf(opened)).sealed_unit_id, null);
  assert.strictEqual(await itemOf('external_transaction_items', dealWithSam.item), undefined, 'the deleted deal is not brought back');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection_trash WHERE batch_id = ?`, [batch])).n, 0);
  console.log('PASS: copies whose trade, deal or sealed records are gone come back without those links');

  // --- records that point at a copy get their link back ---------------------------------
  const offered = await addCopy(carol, 'c-plain');
  const offer = await transferItem(carol, bob, { status: 'pending', source: offered, cardId: 'c-plain' });
  const fromSam = await externalItem(bob);
  const received = await addCopy(bob, 'c-ext', { acquired_via_external_item_id: fromSam.item });
  await db.run(`UPDATE external_transaction_items SET source_collection_id = ? WHERE id = ?`, [received, fromSam.item]);
  const repointed = await addCopy(carol, 'c-plain');
  const otherOffer = await transferItem(carol, bob, { status: 'pending', source: repointed, cardId: 'c-plain' });
  const withdrawn = await addCopy(carol, 'c-plain');
  const lapsed = await transferItem(carol, bob, { status: 'pending', source: withdrawn, cardId: 'c-plain' });

  const carolsBatch = await trash(carol, [offered, repointed, withdrawn]);
  const bobsBatch = await trash(bob, [received]);
  assert.strictEqual((await itemOf('user_transfer_items', offer.item)).source_collection_id, null);
  assert.strictEqual((await itemOf('external_transaction_items', fromSam.item)).source_collection_id, null);
  const standIn = await addCopy(carol, 'c-plain');
  await db.run(`UPDATE user_transfer_items SET source_collection_id = ? WHERE id = ?`, [standIn, otherOffer.item]);
  await db.run(`DELETE FROM user_transfer_items WHERE id = ?`, [lapsed.item]);

  r = await restore(carol, carolsBatch);
  assert.deepStrictEqual(r.body, { restored: 3, skipped: 0, unsorted: 0, wishlisted: 0 });
  assert.strictEqual((await itemOf('user_transfer_items', offer.item)).source_collection_id, offered,
    'the pending offer names its copy again, so it can still be accepted');
  assert.strictEqual((await itemOf('user_transfer_items', otherOffer.item)).source_collection_id, standIn,
    'a record pointed at another copy since is left alone');
  assert.strictEqual(await itemOf('user_transfer_items', lapsed.item), undefined, 'a record deleted since stays deleted');
  r = await restore(bob, bobsBatch);
  assert.deepStrictEqual(r.body, { restored: 1, skipped: 0, unsorted: 0, wishlisted: 0 });
  assert.strictEqual((await rowOf(received)).acquired_via_external_item_id, fromSam.item);
  assert.strictEqual((await itemOf('external_transaction_items', fromSam.item)).source_collection_id, received,
    'the deal names the copy it brought in again');
  console.log('PASS: a trade\'s or deal\'s record of a copy is linked again when the copy comes back');

  // --- links read from the schema: a column and a table added later ---------------------
  // A migration adds a reference to collection, and two tables that point at copies:
  // one whose own link can be cleared, one whose link cannot.
  await db.run(`ALTER TABLE collection ADD COLUMN pinned_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL`);
  await db.run(`CREATE TABLE copy_labels (
    entry_id INTEGER NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
    note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL, label TEXT)`);
  await db.run(`CREATE TABLE copy_pins (
    entry_id INTEGER NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE)`);
  const note = async (title) => (await db.run(`INSERT INTO notes (user_id, title) VALUES (?, ?)`, [bob, title])).lastID;
  const pinnedNote = await note('pinned');
  const labelNote = await note('label');
  const pinNote = await note('pin');
  const labelled = await addCopy(bob, 'c-plain', { pinned_note_id: pinnedNote });
  await db.run(`INSERT INTO copy_labels (entry_id, note_id, label) VALUES (?, ?, 'binder pick')`, [labelled, labelNote]);
  await db.run(`INSERT INTO copy_pins (entry_id, note_id) VALUES (?, ?)`, [labelled, pinNote]);
  const orphan = await addCopy(bob, 'c-gone');

  batch = await trash(bob, [labelled, orphan]);
  await db.run(`DELETE FROM notes WHERE id IN (?, ?, ?)`, [pinnedNote, labelNote, pinNote]);
  // The card itself gone from card_cache: a link the copy cannot do without.
  await db.run(`DELETE FROM card_cache WHERE id = 'c-gone'`);

  r = await restore(bob, batch);
  assert.deepStrictEqual(r.body, { restored: 1, skipped: 1, unsorted: 0, wishlisted: 0 },
    'the copy whose card is gone stays out; the rest of its batch comes back');
  assert.strictEqual((await rowOf(labelled)).pinned_note_id, null, 'a reference added by a later migration is cleared too');
  assert.deepStrictEqual(await db.all(`SELECT entry_id, note_id, label FROM copy_labels`), [{ entry_id: labelled, note_id: null, label: 'binder pick' }],
    'a row put back with the copy loses only its dangling link');
  assert.deepStrictEqual(await db.all(`SELECT * FROM copy_pins`), [], 'one that cannot do without it stays out');
  assert.strictEqual(await rowOf(orphan), undefined);
  console.log('PASS: the links checked are read from the schema, for the copy and the rows put back with it');
}

main()
  .then(async () => { await cleanup(); console.log('trashlinks tests passed'); })
  .catch(async (err) => { console.error(err); await cleanup(); process.exit(1); });
