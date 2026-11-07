// Deleting copies is recoverable: a delete moves rows to collection_trash, a
// restore puts them back under their own ids with every column and every link,
// in their old slot when it is still free and in Unsorted when it is not. Trash is
// one user's alone, expires after 30 days, and can be emptied.
//
// Also covers the two other undo paths that share the placement rules (moving a
// copy back out of Unsorted) and the dry run that warns before a container loses
// pages.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-collectiontrash-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const { purgeExpiredTrash } = require('../src/utils/collectionTrash');

let server;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

// The acting user comes from a header, so one server can play both users.
function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.headers['x-user']), role: 'member' }; next(); });
  app.use('/api/collection/trash', require('../src/routes/trash'));
  app.use('/api', require('../src/routes/collection'));
  app.use('/api', require('../src/routes/storage'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

let base;
async function call(user, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user': String(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function makeUser(name) {
  return (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES (?, 'x', 'member', ?)`,
    [name, `share-${name}-${process.pid}`])).lastID;
}

async function makeContainer(userId, name, type, pages, capacity) {
  const locId = (await db.run(
    `INSERT INTO locations (name, type, sort_order, user_id) VALUES (?, ?, 'custom', ?)`, [name, type, userId])).lastID;
  const comps = [];
  for (let i = 1; i <= pages; i++) {
    comps.push((await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [locId, i, capacity])).lastID);
  }
  return { locId, comps };
}

async function addCopy(userId, cardId, place = {}, extra = {}) {
  const row = { card_id: cardId, user_id: userId, quantity: 1, game: 'mtg', location_id: place.locId || null, compartment_id: place.compId || null, position: place.position || 0, ...extra };
  const cols = Object.keys(row);
  return (await db.run(`INSERT INTO collection (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c]))).lastID;
}

const rowOf = (id) => db.get(`SELECT * FROM collection WHERE id = ?`, [id]);

async function main() {
  await db.initDb();
  base = await startApp();

  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) {
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, 'mtg')`, [id, `Card ${id}`]);
  }
  // Stand-ins for tables that reference collection(id): the deck-format branch's
  // deck_allocations, and a generic one like an upgraded install's collection_tags.
  await db.run(`CREATE TABLE IF NOT EXISTS deck_allocations (
    entry_id INTEGER PRIMARY KEY REFERENCES collection(id) ON DELETE CASCADE,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, allocated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await db.run(`CREATE TABLE entry_links (
    entry_id INTEGER NOT NULL REFERENCES collection(id) ON DELETE CASCADE, label TEXT)`);

  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const binder = await makeContainer(alice, 'A Binder', 'Binder', 3, 9);
  const box = await makeContainer(alice, 'A Box', 'Box', 1, 100);

  const graded = await addCopy(alice, 'c1', { locId: binder.locId, compId: binder.comps[0], position: 2000 },
    { grader: 'PSA', grade: 10, cert_number: 'CERT-1', notes: 'gift from Sam', purchase_price: 12.5, condition: 'Lightly Played' });
  const boxA = await addCopy(alice, 'c2', { locId: box.locId, compId: box.comps[0], position: 1000 });
  const boxB = await addCopy(alice, 'c3', { locId: box.locId, compId: box.comps[0], position: 2000 });
  const boxC = await addCopy(alice, 'c4', { locId: box.locId, compId: box.comps[0], position: 3000 });
  const bobs = await addCopy(bob, 'c1');

  const deckId = (await db.run(`INSERT INTO decks (name, user_id, checked_out) VALUES ('A deck', ?, 1)`, [alice])).lastID;
  await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'c1', 1)`, [deckId]);
  await db.run(`INSERT INTO deck_allocations (entry_id, deck_id, card_id) VALUES (?, ?, 'c1')`, [graded, deckId]);
  await db.run(`INSERT INTO entry_links (entry_id, label) VALUES (?, 'favourite')`, [graded]);

  // --- single delete goes to the trash, with its links -------------------------
  let res = await call(alice, 'DELETE', `/api/collection/${graded}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const batch1 = res.body.trash_batch;
  assert.ok(batch1, 'single delete reports its trash batch');
  assert.strictEqual(await rowOf(graded), undefined, 'row left the collection');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM deck_allocations`)).n, 0, 'allocation cascaded away');
  console.log('PASS: single delete moves the copy to the trash');

  // --- bulk delete, scoped to the caller ---------------------------------------
  res = await call(alice, 'POST', '/api/collection/bulk', { entry_ids: [boxA, boxB, bobs], action: 'delete' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.affected, 2, 'only her own two copies');
  const batch2 = res.body.trash_batch;
  assert.ok(await rowOf(bobs), "Bob's copy is untouched");
  console.log('PASS: bulk delete trashes only the caller\'s copies');

  // --- listing: newest first, per user -------------------------------------------
  res = await call(alice, 'GET', '/api/collection/trash');
  assert.deepStrictEqual(res.body.batches.map(b => b.batch_id).sort(), [batch1, batch2].sort());
  const listed2 = res.body.batches.find(b => b.batch_id === batch2);
  assert.strictEqual(listed2.count, 2);
  assert.deepStrictEqual(listed2.cards.map(c => c.name).sort(), ['Card c2', 'Card c3']);
  assert.ok(listed2.expires_at > listed2.deleted_at, 'carries its expiry');
  res = await call(bob, 'GET', '/api/collection/trash');
  assert.deepStrictEqual(res.body.batches, [], "Bob sees none of Alice's trash");
  console.log('PASS: trash lists the user\'s own batches only');

  // --- cross-user restore and delete -------------------------------------------
  res = await call(bob, 'POST', `/api/collection/trash/${batch1}/restore`);
  assert.strictEqual(res.status, 404);
  res = await call(bob, 'DELETE', `/api/collection/trash/${batch1}`);
  assert.strictEqual(res.status, 404);
  res = await call(bob, 'DELETE', '/api/collection/trash');
  assert.strictEqual(res.body.removed, 0);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection_trash WHERE user_id = ?`, [alice])).n, 3, "Alice's trash intact");
  assert.strictEqual(await rowOf(graded), undefined, 'nothing restored by Bob');
  res = await call(alice, 'POST', '/api/collection/trash/not-a-batch/restore');
  assert.strictEqual(res.status, 404);
  console.log('PASS: another user cannot restore or delete the trash');

  // --- restore: slot taken, so Unsorted; every column and link back -------------
  const squatter = await addCopy(alice, 'c5', { locId: binder.locId, compId: binder.comps[0], position: 2000 });
  res = await call(alice, 'POST', `/api/collection/trash/${batch1}/restore`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body, { restored: 1, skipped: 0, unsorted: 1 });
  let back = await rowOf(graded);
  assert.ok(back, 'back under its original id');
  assert.strictEqual(back.user_id, alice);
  assert.strictEqual(back.compartment_id, null, 'its pocket was taken, so Unsorted');
  assert.strictEqual(back.location_id, null);
  assert.strictEqual(back.grader, 'PSA');
  assert.strictEqual(back.grade, 10);
  assert.strictEqual(back.cert_number, 'CERT-1');
  assert.strictEqual(back.notes, 'gift from Sam');
  assert.strictEqual(back.purchase_price, 12.5);
  assert.strictEqual(back.condition, 'Lightly Played');
  assert.ok((await rowOf(squatter)).compartment_id, 'the card in the slot now stays put');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM deck_allocations WHERE entry_id = ?`, [graded])).n, 1, 'deck allocation back');
  assert.strictEqual((await db.get(`SELECT label FROM entry_links WHERE entry_id = ?`, [graded])).label, 'favourite', 'generic link back');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection_trash WHERE batch_id = ?`, [batch1])).n, 0, 'batch left the trash');
  console.log('PASS: restore keeps every column and link, and falls back to Unsorted');

  // --- restore into a box row: back in order -------------------------------------
  res = await call(alice, 'POST', `/api/collection/trash/${batch2}/restore`);
  assert.deepStrictEqual(res.body, { restored: 2, skipped: 0, unsorted: 0 });
  const order = (await db.all(`SELECT id FROM collection WHERE compartment_id = ? ORDER BY position`, [box.comps[0]])).map(r => r.id);
  assert.deepStrictEqual(order, [boxA, boxB, boxC], 'back in their old order ahead of the card that followed');
  console.log('PASS: restore puts copies back in their box row in order');

  // --- a free binder slot is reclaimed ---------------------------------------------
  const pocket = await addCopy(alice, 'c6', { locId: binder.locId, compId: binder.comps[1], position: 5000 });
  res = await call(alice, 'DELETE', `/api/collection/${pocket}`);
  res = await call(alice, 'POST', `/api/collection/trash/${res.body.trash_batch}/restore`);
  back = await rowOf(pocket);
  assert.deepStrictEqual([back.compartment_id, back.position], [binder.comps[1], 5000], 'same pocket');
  console.log('PASS: restore re-places a copy in its free binder pocket');

  // --- a returned deck does not get its allocation back ---------------------------
  await db.run(`UPDATE decks SET checked_out = 0 WHERE id = ?`, [deckId]);
  await db.run(`DELETE FROM deck_allocations`);
  await db.run(`INSERT INTO deck_allocations (entry_id, deck_id, card_id) VALUES (?, ?, 'c1')`, [graded, deckId]);
  res = await call(alice, 'DELETE', `/api/collection/${graded}`);
  // The same slab added again meanwhile: the cert is taken, the old row cannot return.
  const reAdded = await addCopy(alice, 'c1', {}, { grader: 'PSA', cert_number: 'CERT-1' });
  const batch3 = res.body.trash_batch;
  res = await call(alice, 'POST', `/api/collection/trash/${batch3}/restore`);
  assert.deepStrictEqual(res.body, { restored: 0, skipped: 1, unsorted: 0 });
  assert.ok(await rowOf(reAdded), 'the new row is untouched');
  await db.run(`DELETE FROM collection WHERE id = ?`, [reAdded]);
  const extra = await addCopy(alice, 'c1');
  await db.run(`INSERT INTO deck_allocations (entry_id, deck_id, card_id) VALUES (?, ?, 'c1')`, [extra, deckId]);
  res = await call(alice, 'DELETE', `/api/collection/${extra}`);
  res = await call(alice, 'POST', `/api/collection/trash/${res.body.trash_batch}/restore`);
  assert.strictEqual(res.body.restored, 1);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM deck_allocations WHERE entry_id = ?`, [extra])).n, 0,
    'no allocation for a deck no longer checked out');
  console.log('PASS: a restore that cannot apply skips cleanly, stale allocations stay gone');

  // --- ?trash=0 deletes outright -----------------------------------------------------
  const undoAdd = await addCopy(alice, 'c2');
  res = await call(alice, 'DELETE', `/api/collection/${undoAdd}?trash=0`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection_trash WHERE entry_id = ?`, [undoAdd])).n, 0);
  res = await call(bob, 'DELETE', `/api/collection/${extra}?trash=0`);
  assert.strictEqual(res.status, 404, "Bob cannot delete Alice's copy either way");
  console.log('PASS: ?trash=0 skips the trash, still scoped');

  // --- purge after 30 days, and empty --------------------------------------------------
  res = await call(alice, 'DELETE', `/api/collection/${extra}`);
  const old = res.body.trash_batch;
  await db.run(`UPDATE collection_trash SET deleted_at = DATETIME('now', '-31 days') WHERE batch_id = ?`, [old]);
  const bobTrash = await addCopy(bob, 'c3');
  res = await call(bob, 'DELETE', `/api/collection/${bobTrash}`);
  assert.strictEqual(await purgeExpiredTrash(), 1, 'only the expired row');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection_trash WHERE user_id = ?`, [bob])).n, 1);
  res = await call(alice, 'DELETE', `/api/collection/${boxC}`);
  res = await call(alice, 'DELETE', '/api/collection/trash');
  assert.strictEqual(res.body.removed, 1);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection_trash WHERE user_id = ?`, [bob])).n, 1, "emptying hers leaves Bob's");
  console.log('PASS: trash purges after 30 days and empties per user');

  // --- undo a move to Unsorted ------------------------------------------------------------
  const filed = await addCopy(alice, 'c4', { locId: binder.locId, compId: binder.comps[2], position: 7000 });
  res = await call(alice, 'POST', '/api/collection/bulk', { entry_ids: [filed], action: 'move', value: null });
  assert.deepStrictEqual(res.body.previous, [{ entry_id: filed, location_id: binder.locId, compartment_id: binder.comps[2], position: 7000 }]);
  res = await call(bob, 'POST', '/api/collection/restore-placement', { placements: res.body.previous });
  assert.deepStrictEqual(res.body, { restored: 0, unplaced: 0 }, 'Bob cannot move her copy');
  res = await call(alice, 'POST', '/api/collection/restore-placement', {
    placements: [{ entry_id: filed, location_id: binder.locId, compartment_id: binder.comps[2], position: 7000 }]
  });
  assert.deepStrictEqual(res.body, { restored: 1, unplaced: 0 });
  back = await rowOf(filed);
  assert.deepStrictEqual([back.compartment_id, back.position], [binder.comps[2], 7000]);
  console.log('PASS: a move to Unsorted can be undone, by its owner only');

  // --- dry run before shrinking a container ------------------------------------------------
  res = await call(alice, 'GET', `/api/locations/${binder.locId}/shrink-preview?count=1`);
  assert.deepStrictEqual(res.body, { wouldMove: 2, pagesRemoved: 2 }, 'pages 2 and 3 hold two copies');
  res = await call(alice, 'GET', `/api/locations/${binder.locId}/shrink-preview?count=3`);
  assert.deepStrictEqual(res.body, { wouldMove: 0, pagesRemoved: 0 });
  res = await call(bob, 'GET', `/api/locations/${binder.locId}/shrink-preview?count=1`);
  assert.strictEqual(res.status, 404);
  res = await call(alice, 'GET', `/api/locations/${binder.locId}/shrink-preview?count=0`);
  assert.strictEqual(res.status, 400);
  console.log('PASS: shrink preview counts the copies that would move');
}

main()
  .then(async () => { await cleanup(); console.log('collectiontrash tests passed'); })
  .catch(async (err) => { console.error(err); await cleanup(); process.exit(1); });
