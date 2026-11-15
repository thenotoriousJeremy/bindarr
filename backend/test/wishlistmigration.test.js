// The collection's old wishlist moves onto the Lists Wishlist at boot (WEB-03,
// utils/wishlistMigration.js, called from initDb).
//
//   - every user's list_type 'wishlist' rows become items on their default
//     Wishlist, made when they have none: the rows of one card add up to the
//     copies wanted, notes come along, the earliest row dates the item;
//   - a card already on the list is not listed twice: it keeps the larger
//     quantity and its own notes, with the rows' notes added beneath;
//   - the rows are then deleted, and nothing owned changes (an owned copy of the
//     same card stays; a slot an old wishlist row held is free again);
//   - a row whose card card_cache lost stays put, and does not stop the rest;
//   - it all happens in one transaction: one failing user leaves every row;
//   - a second boot finds nothing to move and changes nothing.
//
// Real temporary SQLite, the boot path itself (db.initDb), no provider.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-wishlistmigration-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const db = require('../src/db');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const mkUser = async (name) => (await db.run(
  `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, 'x', 'member', ?)`, [name, `share-${name}`]
)).lastID;
const card = (id, name) => db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, 'pokemon')`, [id, name]);
const row = async (userId, cardId, extra = {}) => (await db.run(
  `INSERT INTO collection (card_id, user_id, quantity, list_type, notes, added_at, location_id, compartment_id, position, game)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pokemon')`,
  [cardId, userId, extra.quantity || 1, extra.list || 'wishlist', extra.notes || '', extra.added_at || '2026-01-01 00:00:00',
    extra.location || null, extra.compartment || null, extra.position || 0]
)).lastID;
const items = async (userId) => db.all(
  `SELECT i.card_id, i.quantity_wanted, i.notes, i.added_at
     FROM card_list_items i JOIN card_lists l ON l.id = i.list_id
    WHERE l.user_id = ? AND l.is_default = 1 ORDER BY i.card_id`, [userId]
);
const legacyRows = async () => (await db.all(`SELECT card_id FROM collection WHERE list_type = 'wishlist' ORDER BY card_id`)).map(r => r.card_id);

async function main() {
  // A fresh file: the collection table has no user_id column yet when the
  // migration runs, which must not stop the boot.
  await db.initDb();

  const alice = await mkUser('alice');
  const bob = await mkUser('bob');
  const carol = await mkUser('carol');
  for (const [id, name] of [['pk-a', 'Abra'], ['pk-b', 'Bulbasaur'], ['pk-c', 'Charmander'], ['pk-boom', 'Boom']]) await card(id, name);

  // Alice: Abra split into two single copies (as splitStackedRows leaves a stack),
  // one stacked row of two Bulbasaur, Charmander already hearted, and an owned Abra.
  await row(alice, 'pk-a', { notes: 'holo please', added_at: '2026-02-02 00:00:00' });
  await row(alice, 'pk-a', { notes: 'holo please', added_at: '2026-01-05 00:00:00' });
  await row(alice, 'pk-b', { quantity: 2 });
  await row(alice, 'pk-c', { quantity: 3, notes: 'for the deck' });
  const ownedAbra = await row(alice, 'pk-a', { list: 'collection' });
  const hearts = (await db.run(`INSERT INTO card_lists (user_id, name, kind, is_default) VALUES (?, 'My Wants', 'wishlist', 1)`, [alice])).lastID;
  await db.run(`INSERT INTO card_list_items (list_id, card_id, quantity_wanted, notes) VALUES (?, 'pk-c', 1, 'hearted')`, [hearts]);

  // Bob: no list yet, and a copy moved to the wishlist from his binder's page.
  const binder = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Bob Binder', 'Binder', ?)`, [bob])).lastID;
  const page = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)`, [binder])).lastID;
  await row(bob, 'pk-a', { location: binder, compartment: page, position: 1000 });
  // A row whose card card_cache no longer holds (written with the foreign key off).
  await db.run(`PRAGMA foreign_keys = OFF`);
  await row(bob, 'pk-gone');
  await db.run(`PRAGMA foreign_keys = ON`);
  // Carol has nothing on the old wishlist, so she gets no list.

  // ---- one transaction: a user that cannot be moved leaves everyone's rows
  await row(carol, 'pk-boom');
  await db.run(`CREATE TRIGGER no_boom BEFORE INSERT ON card_list_items WHEN NEW.card_id = 'pk-boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  await assert.rejects(db.initDb(), /boom/, 'a failed move fails loudly');
  // The move runs last in initDb, after the stack split, so the stacked rows are
  // single copies by now (the same quantities); the failed move deleted none.
  assert.deepStrictEqual(await legacyRows(), ['pk-a', 'pk-a', 'pk-a', 'pk-b', 'pk-b', 'pk-boom', 'pk-c', 'pk-c', 'pk-c', 'pk-gone'], 'nothing was deleted');
  assert.deepStrictEqual((await items(alice)).map(i => [i.card_id, i.quantity_wanted, i.notes]), [['pk-c', 1, 'hearted']],
    'nothing was added to the list either');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM card_lists WHERE user_id = ?`, [bob])).n, 0, 'no list was made');
  await db.run(`DROP TRIGGER no_boom`);
  await db.run(`DELETE FROM collection WHERE card_id = 'pk-boom'`);
  console.log('PASS: the move is one transaction');

  // ---- the boot moves them
  await db.initDb();

  assert.deepStrictEqual(await legacyRows(), ['pk-gone'], 'every movable wishlist row left the collection');
  const aliceItems = await items(alice);
  assert.deepStrictEqual(aliceItems.map(i => [i.card_id, i.quantity_wanted, i.notes]), [
    ['pk-a', 2, 'holo please'],
    ['pk-b', 2, ''],
    ['pk-c', 3, 'hearted\nfor the deck'],
  ]);
  assert.strictEqual(aliceItems[0].added_at, '2026-01-05 00:00:00', 'dated by the earliest want');
  const aliceList = await db.get(`SELECT name, kind, is_default FROM card_lists WHERE user_id = ?`, [alice]);
  assert.deepStrictEqual(aliceList, { name: 'My Wants', kind: 'wishlist', is_default: 1 }, 'her existing default list, renamed or not');
  assert.ok(await db.get(`SELECT 1 FROM collection WHERE id = ? AND list_type = 'collection'`, [ownedAbra]), 'her owned Abra stays');

  const bobList = await db.get(`SELECT name, kind, game, is_default FROM card_lists WHERE user_id = ?`, [bob]);
  assert.deepStrictEqual(bobList, { name: 'Wishlist', kind: 'wishlist', game: null, is_default: 1 }, 'made the way /lists/default makes it');
  assert.deepStrictEqual((await items(bob)).map(i => [i.card_id, i.quantity_wanted]), [['pk-a', 1]]);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE compartment_id = ?`, [page])).n, 0, "the page slot the old row held is free");
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM card_lists WHERE user_id = ?`, [carol])).n, 0, 'nothing to move makes no list');
  console.log('PASS: wishlist rows move onto each user\'s Wishlist');

  // ---- a second boot changes nothing
  const { migrateLegacyWishlists } = require('../src/utils/wishlistMigration');
  assert.deepStrictEqual(await migrateLegacyWishlists(), { users: 0, cards: 0, rows: 0 });
  await db.initDb();
  assert.deepStrictEqual(await items(alice), aliceItems, 'quantities are not added again');
  assert.deepStrictEqual(await legacyRows(), ['pk-gone']);
  console.log('PASS: the migration is idempotent');
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error('FAIL:', err);
    await cleanup();
    process.exit(1);
  });
