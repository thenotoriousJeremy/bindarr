// Writes to the collection through the real routes on a temp SQLite:
//
//   - copies of one add are filed one by one, so a page with one free pocket takes
//     one copy and the rest wait in Unsorted (it used to take all three: 5 of 3),
//     and a quantity raised on a full page does the same;
//   - the copies of one add land together or not at all;
//   - a bulk move into a container whose rules refuse a card leaves that card
//     where it was and says so (it used to unfile it and count it as moved);
//   - a selection of 33,000 copies is a bulk action like any other, not a 500;
//   - a swap is both moves or neither;
//   - list_type, game, purchase_price, sort_order and foil_sorting are checked,
//     and the API-only `stackable` option is gone;
//   - the date added can be corrected, one copy or a selection at a time, is
//     stored as UTC, re-sorts a container sorted by it, and is checked;
//   - a card from a sealed unit the user claimed keeps its sealed link;
//   - a 500 answers with a fixed message, never the database's own words.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-collectionwrites-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const gradedPrices = require('../src/gradedPrices');

let server;
let userId;
let otherId;

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
  app.use((req, res, next) => { req.user = { id: Number(req.get('x-test-user')) || userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/storage'));
  app.use('/api', require('../src/routes/collection'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api`));
  });
}

let base;
const api = async (method, url, body, as) => {
  const headers = { 'Content-Type': 'application/json' };
  if (as) headers['x-test-user'] = String(as);
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const mkLocation = async (name, type, extra = {}) => (await db.run(
  `INSERT INTO locations (name, type, sort_order, game, user_id) VALUES (?, ?, ?, ?, ?)`,
  [name, type, extra.sort || 'name-asc', extra.game || 'any', extra.user || userId]
)).lastID;
const mkPage = async (locId, capacity) => (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, ?)`, [locId, capacity])).lastID;
const card = (id, name, game = 'pokemon') => db.run(`INSERT OR REPLACE INTO card_cache (id, name, game, language) VALUES (?, ?, ?, 'English')`, [id, name, game]);
const copy = async (cardId, locId, compId, position, user = userId) => (await db.run(
  `INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id, position, game) VALUES (?, ?, 1, ?, ?, ?, 'pokemon')`,
  [cardId, user, locId, compId, position]
)).lastID;
const where = (id) => db.get(`SELECT location_id, compartment_id, position FROM collection WHERE id = ?`, [id]);

async function copiesRespectCapacity() {
  const binder = await mkLocation('Small Binder', 'Binder');
  const page = await mkPage(binder, 3);
  await card('cap-a', 'Alpha');
  await card('cap-b', 'Bravo');
  await card('cap-c', 'Charlie');
  await copy('cap-a', binder, page, 1000);
  await copy('cap-b', binder, page, 2000);

  const res = await api('POST', '/collection', { card_id: 'cap-c', quantity: 3, location_id: binder });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.ids.length, 3, 'three copies were added');
  const onPage = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE compartment_id = ?`, [page]);
  assert.strictEqual(onPage.n, 3, 'the page holds three cards, its capacity, not five');
  const unsorted = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE card_id = 'cap-c' AND compartment_id IS NULL AND location_id IS NULL`);
  assert.strictEqual(unsorted.n, 2, 'the two that did not fit are in Unsorted');
  assert.strictEqual(res.body.unplaced, 2, 'and the response says how many');
  assert.strictEqual(res.body.container_full, true);
  assert.ok(res.body.placement, 'the copy that fit has its place');

  // Raising the quantity of a copy on the now-full page: the new copies go to
  // Unsorted rather than onto the page.
  const filedA = await db.get(`SELECT id FROM collection WHERE card_id = 'cap-a'`);
  const raised = await api('PUT', `/collection/${filedA.id}`, { quantity: 3 });
  assert.strictEqual(raised.status, 200, JSON.stringify(raised.body));
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE compartment_id = ?`, [page])).n, 3, 'the page is still at capacity');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE card_id = 'cap-a'`)).n, 3, 'the quantity is three');
  assert.strictEqual(raised.body.unplaced_copies, 2, 'the two extra copies are reported as unplaced');
  console.log('PASS: multi-copy adds and quantity edits stop at a page\'s capacity');
}

async function addIsAtomic() {
  await card('atom', 'Atomic');
  await db.run(`CREATE TRIGGER fail_third_copy BEFORE INSERT ON collection
                WHEN NEW.card_id = 'atom' AND (SELECT COUNT(*) FROM collection WHERE card_id = 'atom') >= 2
                BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  const res = await api('POST', '/collection', { card_id: 'atom', quantity: 3 });
  assert.strictEqual(res.status, 500, JSON.stringify(res.body));
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE card_id = 'atom'`)).n, 0, 'no copy of a failed add is left behind');
  assert.ok(!JSON.stringify(res.body).includes('disk full'), 'the database error is not sent to the client');
  await db.run(`DROP TRIGGER fail_third_copy`);
  console.log('PASS: the copies of one add land together or not at all');
}

async function refusedMovesStayPut() {
  const mtgOnly = await mkLocation('Magic Only', 'Box', { game: 'mtg' });
  await mkPage(mtgOnly, 50);
  const home = await mkLocation('Home Box', 'Box');
  const homeRow = await mkPage(home, 50);
  await card('pk-refused', 'Pikachu');
  await card('mtg-ok', 'Shock', 'mtg');
  const pika = await copy('pk-refused', home, homeRow, 1000);
  const shock = (await db.run(`INSERT INTO collection (card_id, user_id, location_id, compartment_id, position, game) VALUES ('mtg-ok', ?, ?, ?, 2000, 'mtg')`, [userId, home, homeRow])).lastID;
  const before = await where(pika);
  const res = await api('POST', '/collection/bulk', { entry_ids: [pika, shock], action: 'move', value: mtgOnly });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(await where(pika), before, 'a card the container refuses stays where it was');
  assert.strictEqual((await where(shock)).location_id, mtgOnly, 'the card it accepts moves');
  assert.strictEqual(res.body.affected, 1, 'only the moved card counts as moved');
  assert.match(res.body.message, /1 did not match the container's rules/);
  console.log('PASS: a bulk move leaves refused cards in place and reports them');
}

async function hugeSelections() {
  const ids = Array.from({ length: 33000 }, (_, i) => i + 1);
  for (const action of ['trade', 'untrade']) {
    const res = await api('POST', '/collection/bulk', { entry_ids: ids, action });
    assert.strictEqual(res.status, 200, `${action} over 33,000 ids: ${JSON.stringify(res.body)}`);
  }
  const res = await api('POST', '/collection/bulk', { entry_ids: ids, action: 'condition', value: 'Damaged' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const loc = await mkLocation('Bulk Target', 'Box');
  await mkPage(loc, 5);
  const moved = await api('POST', '/collection/bulk', { entry_ids: ids, action: 'move', value: loc });
  assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
  const batch = await api('POST', `/locations/${loc}/recommend-batch`, { entry_ids: ids });
  assert.strictEqual(batch.status, 200, JSON.stringify(batch.body).slice(0, 200));
  console.log('PASS: bulk actions take a 33,000-copy selection');
}

async function swapIsAtomic() {
  const binder = (await db.run(`INSERT INTO locations (name, type, sort_order, user_id) VALUES ('Swap Binder', 'Binder', 'custom', ?)`, [userId])).lastID;
  const page = await mkPage(binder, 9);
  await card('sw-a', 'Swap A');
  await card('sw-b', 'Swap B');
  const a = await copy('sw-a', binder, page, 1000);
  const b = await copy('sw-b', binder, page, 2000);
  await db.run(`CREATE TRIGGER fail_swap BEFORE UPDATE OF position ON collection WHEN NEW.id = ${b}
                BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  const res = await api('POST', `/collection/${a}/place`, { compartment_id: page, slot: 2, swap_with: b });
  assert.strictEqual(res.status, 500);
  assert.strictEqual((await where(a)).position, 1000, 'the first card did not move without the second');
  assert.strictEqual((await where(b)).position, 2000);
  await db.run(`DROP TRIGGER fail_swap`);
  const ok = await api('POST', `/collection/${a}/place`, { compartment_id: page, slot: 2, swap_with: b });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual([(await where(a)).position, (await where(b)).position], [2000, 1000], 'a swap that succeeds swaps');
  console.log('PASS: a swap is both moves or neither');
}

async function validation() {
  await card('val', 'Validated');
  const entry = await copy('val', null, null, 0);
  for (const [body, label] of [
    [{ list_type: 'bogus' }, 'list_type'],
    [{ game: 'chess' }, 'game'],
    [{ purchase_price: -1 }, 'negative purchase_price'],
    [{ purchase_price: 'abc' }, 'text purchase_price'],
    [{ purchase_price: { x: 1 } }, 'object purchase_price'],
  ]) {
    const res = await api('PUT', `/collection/${entry}`, body);
    assert.strictEqual(res.status, 400, `${label} is refused: ${JSON.stringify(res.body)}`);
  }
  const row = await db.get(`SELECT list_type, game, purchase_price FROM collection WHERE id = ?`, [entry]);
  assert.deepStrictEqual(row, { list_type: 'collection', game: 'pokemon', purchase_price: null }, 'nothing refused was stored');
  // (list_type 'wishlist' is an older app's "move to wishlist": wishlistunified.test.js.)
  const good = await api('PUT', `/collection/${entry}`, { list_type: 'collection', game: 'mtg', purchase_price: '2.50' });
  assert.strictEqual(good.status, 200);
  assert.deepStrictEqual(await db.get(`SELECT list_type, game, purchase_price FROM collection WHERE id = ?`, [entry]),
    { list_type: 'collection', game: 'mtg', purchase_price: 2.5 });
  assert.strictEqual((await api('POST', '/collection', { card_id: 'val', list_type: 'trade-binder' })).status, 400, 'an add checks list_type');
  assert.strictEqual((await api('POST', '/collection', { card_id: 'val', purchase_price: -5 })).status, 400, 'an add checks purchase_price');

  for (const [body, label] of [
    [{ name: 'Bad Sort', type: 'Box', sort_order: 'by-vibes' }, 'an unknown named sort'],
    [{ name: 'Bad Sort', type: 'Box', sort_order: '[{"by":"weight"}]' }, 'a criterion on an unknown field'],
    [{ name: 'Bad Sort', type: 'Box', sort_order: '[{"by":"name","dir":"sideways"}]' }, 'an unknown direction'],
    [{ name: 'Bad Sort', type: 'Box', foil_sorting: 'shiny_first' }, 'an unknown foil sorting'],
  ]) {
    assert.strictEqual((await api('POST', '/locations', body)).status, 400, `create refuses ${label}`);
  }
  const made = await api('POST', '/locations', { name: 'Good Sort', type: 'Box', sort_order: '[{"id":"1","by":"added_at","dir":"desc","divider":false}]' });
  assert.strictEqual(made.status, 200, 'a criteria list as the sort builder sends it is accepted');
  assert.strictEqual((await api('PUT', `/locations/${made.body.id}`, { sort_order: 'nonsense' })).status, 400, 'update refuses an unknown sort');
  assert.strictEqual((await api('PUT', `/locations/${made.body.id}`, { sort_order: 'set-number', foil_sorting: 'foils_first' })).status, 200);

  // `stackable` was an API-only switch to put every copy on one row; the next
  // startup split such rows again. It is ignored now: a copy is a row.
  const stacked = await api('POST', '/collection', { card_id: 'val', quantity: 3, stackable: true });
  assert.strictEqual(stacked.status, 200);
  const rows = await db.all(`SELECT quantity FROM collection WHERE id IN (${stacked.body.ids.join(',')})`);
  assert.deepStrictEqual(rows.map(r => r.quantity), [1, 1, 1], 'three copies are three rows');
  console.log('PASS: list_type, game, purchase_price, sort_order and foil_sorting are validated; stackable is gone');
}

async function dateAdded() {
  await card('dated', 'Dated');
  const entry = await copy('dated', null, null, 0);
  const addedAt = async (id) => (await db.get(`SELECT added_at FROM collection WHERE id = ?`, [id])).added_at;
  const stamped = await addedAt(entry);

  // The single edit: an instant with an offset is stored as UTC, the way
  // CURRENT_TIMESTAMP writes the column; the stored form and a bare day are taken too.
  for (const [sent, stored] of [
    ['2020-05-17T09:15:30.000Z', '2020-05-17 09:15:30'],
    ['2020-05-17T09:15:30+02:00', '2020-05-17 07:15:30'],
    ['2019-12-31 23:59:59', '2019-12-31 23:59:59'],
    ['2018-02-03T04:05', '2018-02-03 04:05:00'],
    ['2018-02-03', '2018-02-03 00:00:00'],
  ]) {
    const res = await api('PUT', `/collection/${entry}`, { added_at: sent });
    assert.strictEqual(res.status, 200, `${sent}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(await addedAt(entry), stored, `${sent} is stored as ${stored}`);
  }
  assert.strictEqual((await api('GET', `/collection/${entry}`)).body.added_at, '2018-02-03 00:00:00', 'the entry reads back the new date');

  const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  for (const bad of ['', 'yesterday', '2020-02-30', '2020-13-01', '2020-05-17T25:00:00Z', '17/05/2020', 1589706930, null, { day: 1 }, future]) {
    const res = await api('PUT', `/collection/${entry}`, { added_at: bad });
    assert.strictEqual(res.status, 400, `${JSON.stringify(bad)} is refused: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_added_at');
    const bulk = await api('POST', '/collection/bulk', { entry_ids: [entry], action: 'added_at', value: bad });
    assert.strictEqual(bulk.status, 400, `bulk: ${JSON.stringify(bad)} is refused`);
  }
  assert.strictEqual(await addedAt(entry), '2018-02-03 00:00:00', 'nothing refused was stored');
  // An edit that does not name the date leaves it alone.
  assert.strictEqual((await api('PUT', `/collection/${entry}`, { notes: 'kept' })).status, 200);
  assert.strictEqual(await addedAt(entry), '2018-02-03 00:00:00');

  // The bulk action: every selected copy of this user's, and no one else's.
  const second = await copy('dated', null, null, 0);
  const theirs = await copy('dated', null, null, 0, otherId);
  const theirStamp = await addedAt(theirs);
  const res = await api('POST', '/collection/bulk', { entry_ids: [entry, second, theirs], action: 'added_at', value: '2021-06-01T12:00:00Z' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.affected, 2);
  assert.deepStrictEqual([await addedAt(entry), await addedAt(second)], ['2021-06-01 12:00:00', '2021-06-01 12:00:00']);
  assert.strictEqual(await addedAt(theirs), theirStamp, "another user's copy keeps its date");
  assert.strictEqual((await api('PUT', `/collection/${theirs}`, { added_at: '2021-06-01T12:00:00Z' })).status, 404);
  assert.ok(stamped, 'a copy starts with a date');

  // A box sorted newest first: redating a copy moves it within its row.
  const box = await mkLocation('By Date', 'Box', { sort: '[{"id":"1","by":"added_at","dir":"desc","divider":false}]' });
  const row = await mkPage(box, 10);
  const first = await copy('dated', box, row, 1000);
  const last = await copy('dated', box, row, 2000);
  await db.run(`UPDATE collection SET added_at = '2022-01-02 00:00:00' WHERE id = ?`, [first]);
  await db.run(`UPDATE collection SET added_at = '2022-01-01 00:00:00' WHERE id = ?`, [last]);
  const order = async () => (await db.all(`SELECT id FROM collection WHERE compartment_id = ? ORDER BY position`, [row])).map(r => r.id);
  assert.strictEqual((await api('PUT', `/collection/${last}`, { added_at: '2022-01-03T00:00:00Z' })).status, 200);
  assert.deepStrictEqual(await order(), [last, first], 'the single edit re-sorts the row');
  assert.strictEqual((await api('POST', '/collection/bulk', { entry_ids: [last], action: 'added_at', value: '2021-12-31T00:00:00Z' })).status, 200);
  assert.deepStrictEqual(await order(), [first, last], 'and so does the bulk action');
  console.log('PASS: the date added is corrected one copy or many at a time, validated and re-sorted');
}

async function claimedSealedLink() {
  // The other user's shared purchase; this user claimed one of its units.
  const purchase = (await db.run(
    `INSERT INTO sealed_purchases (user_id, product_name, game, available_to_all) VALUES (?, 'Shared Box', 'pokemon', 1)`, [otherId]
  )).lastID;
  const unit = (await db.run(`INSERT INTO sealed_units (purchase_id, claimed_by_user_id, opened_at) VALUES (?, ?, CURRENT_TIMESTAMP)`, [purchase, userId])).lastID;
  await card('pulled', 'Pulled Card');
  const res = await api('POST', '/collection', { card_id: 'pulled', sealed_unit_id: unit });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const list = await api('GET', '/collection');
  const row = list.body.find(r => r.entry_id === res.body.id);
  assert.strictEqual(row.sealed_unit_id, unit, 'a card from a claimed unit keeps its sealed link in the collection list');
  assert.strictEqual(row.sealed_product_name, 'Shared Box');
  const one = await api('GET', `/collection/${res.body.id}`);
  assert.strictEqual(one.body.sealed_unit_id, unit, 'and in the single entry');
  // The buyer does not see the claimant's card as theirs.
  const theirs = await api('GET', '/collection', undefined, otherId);
  assert.ok(!theirs.body.some(r => r.entry_id === res.body.id));
  console.log('PASS: a card from a claimed sealed unit keeps its sealed link');
}

async function clientSafeErrors() {
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('slab', 'Slab', 'pokemon')`);
  const slab = (await db.run(`INSERT INTO collection (card_id, user_id, grader, grade, game) VALUES ('slab', ?, 'PSA', 10, 'pokemon')`, [userId])).lastID;
  const real = gradedPrices.fetchGradedPrice;
  gradedPrices.fetchGradedPrice = async () => { throw new Error('SQLITE_CORRUPT: database disk image is malformed (secret path)'); };
  try {
    const res = await api('POST', `/collection/${slab}/market-value/fetch`);
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error, 'Failed to fetch graded price');
    assert.ok(!JSON.stringify(res.body).includes('SQLITE'), 'the database error stays in the log');
  } finally {
    gradedPrices.fetchGradedPrice = real;
  }
  console.log('PASS: a failed graded-price fetch answers with a fixed message');
}

async function main() {
  await db.initDb();
  userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('writer', 'x', 'admin', 'tok1')`)).lastID;
  otherId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('other', 'x', 'member', 'tok2')`)).lastID;
  base = await startApp();
  await copiesRespectCapacity();
  await addIsAtomic();
  await refusedMovesStayPut();
  await hugeSelections();
  await swapIsAtomic();
  await validation();
  await dateAdded();
  await claimedSealedLink();
  await clientSafeErrors();
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
