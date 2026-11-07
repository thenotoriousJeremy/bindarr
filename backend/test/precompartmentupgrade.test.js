// Upgrading a database from before compartments (a7da01e) must keep every card.
//
// initDb used to see collection.sub_location_1 and DROP both collection and
// locations, so the first boot of a newer release emptied the collection. The
// database here is built in the exact shape the last pre-compartment initDb
// (a7da01e^) left behind, including its ALTER-added columns and the step-8
// locations rebuild. Then the current initDb runs on it, twice.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const sqlite3 = require('sqlite3');

const tmpDb = path.join(os.tmpdir(), `bindarr-precompartmentupgrade-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

function exec(conn, sql) {
  return new Promise((resolve, reject) => conn.exec(sql, err => (err ? reject(err) : resolve())));
}

// The legacy schema, as a7da01e^'s initDb leaves it after all its migrations.
// locations is in its step-8 rebuilt form (all nine container types), which is
// what any database that ran that release has.
const LEGACY_SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT CHECK(role IN ('admin', 'member')) NOT NULL DEFAULT 'member',
    share_token TEXT UNIQUE NOT NULL,
    share_enabled INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE card_cache (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    supertype TEXT,
    subtypes TEXT,
    types TEXT,
    rarity TEXT,
    set_id TEXT,
    set_name TEXT,
    number TEXT,
    image_url TEXT,
    price_trend REAL,
    price_normal REAL,
    price_holofoil REAL,
    price_reverse_holofoil REAL,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE collection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    condition TEXT CHECK(condition IN ('Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged')) DEFAULT 'Near Mint',
    printing TEXT CHECK(printing IN ('Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo')) DEFAULT 'Normal',
    language TEXT DEFAULT 'English',
    purchase_price REAL,
    location_id INTEGER,
    sub_location_1 TEXT,
    sub_location_2 TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE SET NULL,
    FOREIGN KEY(card_id) REFERENCES card_cache(id)
  );
  CREATE TABLE price_history (
    card_id TEXT NOT NULL,
    price REAL NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(card_id, recorded_at)
  );
  CREATE TABLE decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE deck_cards (
    deck_id INTEGER NOT NULL,
    card_id TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    PRIMARY KEY(deck_id, card_id),
    FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
  );
  CREATE TABLE locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT CHECK(type IN ('Binder', 'Toploader Binder', 'Box', 'Toploader Box', 'Graded Slab Box', 'Display Shelf / Stand', 'Deck Box', 'Tin / Case', 'Other')) NOT NULL,
    description TEXT,
    sort_order TEXT DEFAULT 'name-asc',
    max_pages INTEGER DEFAULT 30,
    page_style TEXT DEFAULT '3x3',
    max_rows INTEGER DEFAULT 3,
    max_capacity INTEGER DEFAULT 1000,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    foil_sorting TEXT DEFAULT 'normals_first'
  );
  -- Its migrations, in the order it ran them.
  ALTER TABLE collection ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE collection ADD COLUMN is_trade INTEGER DEFAULT 0;
  ALTER TABLE collection ADD COLUMN list_type TEXT DEFAULT 'collection';
  ALTER TABLE collection ADD COLUMN position REAL DEFAULT 0;
  ALTER TABLE users ADD COLUMN tcg_api_key TEXT DEFAULT '';
  ALTER TABLE card_cache ADD COLUMN price_avg1 REAL;
  ALTER TABLE card_cache ADD COLUMN price_avg7 REAL;
  ALTER TABLE card_cache ADD COLUMN price_avg30 REAL;
  ALTER TABLE decks ADD COLUMN checked_out INTEGER DEFAULT 0;
  ALTER TABLE decks ADD COLUMN checked_out_at DATETIME;
`;

const LEGACY_ROWS = `
  INSERT INTO users (id, username, password_hash, role, share_token) VALUES
    (1, 'admin', 'x', 'admin', 'share-admin'),
    (2, 'misty', 'x', 'member', 'share-misty');
  INSERT INTO card_cache (id, name, set_name, number) VALUES
    ('base1-4', 'Charizard', 'Base', '4'),
    ('base1-58', 'Pikachu', 'Base', '58'),
    ('base1-7', 'Hitmonchan', 'Base', '7'),
    ('fossil-3', 'Gengar', 'Fossil', '5');
  INSERT INTO locations (id, name, type, description, sort_order, max_pages, page_style, user_id, foil_sorting) VALUES
    (1, 'Main Binder', 'Binder', 'For ultra rares, holos and favorites.', 'set-number', 20, '3x3', 1, 'foils_first'),
    (2, 'Bulk Storage Box 1', 'Box', NULL, 'name-asc', 30, '3x3', 1, 'normals_first'),
    (3, 'Misty Binder', 'Binder', NULL, 'custom', 10, '2x2', 2, 'normals_first'),
    (4, 'Odd One', 'Tin / Case', NULL, 'from-some-fork', 30, '3x3', 2, 'normals_first');
  INSERT INTO collection (id, card_id, quantity, condition, printing, language, purchase_price, location_id,
                          sub_location_1, sub_location_2, added_at, user_id, is_trade, list_type, position) VALUES
    (1, 'base1-4', 1, 'Near Mint', 'Holofoil', 'English', 350.5, 1, 'Page 1', 'Slot 1', '2024-01-02 03:04:05', 1, 0, 'collection', 0),
    (2, 'base1-58', 3, 'Lightly Played', 'Normal', 'Japanese', 1.25, 2, 'Row 1', 'Slot 4', '2024-02-03 04:05:06', 1, 1, 'collection', 3000),
    (3, 'base1-7', 1, 'Damaged', 'Reverse Holofoil', 'English', NULL, NULL, NULL, NULL, '2024-03-04 05:06:07', 1, 0, 'wishlist', 0),
    (7, 'base1-58', 1, 'Near Mint', '1st Edition', 'German', 9.99, 3, 'Page 2', 'Slot 3', '2024-04-05 06:07:08', 2, 0, 'collection', 6000),
    (8, 'fossil-3', 1, 'Heavily Played', 'Promo', 'English', 4, 4, 'A', 'B', '2024-05-06 07:08:09', 2, 1, 'collection', 0),
    (9, 'gone-from-cache', 1, 'Near Mint', 'Normal', 'English', NULL, NULL, NULL, NULL, '2024-06-07 08:09:10', 2, 0, 'collection', 0);
`;

async function buildLegacyDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* none */ }
  }
  const conn = new sqlite3.Database(tmpDb);
  await exec(conn, LEGACY_SCHEMA);
  await exec(conn, LEGACY_ROWS);
  const rows = await new Promise((resolve, reject) =>
    conn.all(`SELECT * FROM collection ORDER BY id`, (err, r) => (err ? reject(err) : resolve(r))));
  await new Promise(resolve => conn.close(resolve));
  return rows;
}

let db;

async function cleanup() {
  if (db) await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function snapshot() {
  const tables = await db.all(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`);
  const out = { tables };
  for (const t of ['collection', 'locations', 'compartments', 'legacy_collection_pre_compartments', 'legacy_locations_pre_compartments']) {
    out[t] = await db.all(`SELECT * FROM ${t} ORDER BY rowid`);
  }
  return out;
}

async function main() {
  const legacyRows = await buildLegacyDb();
  db = require('../src/db');

  await db.initDb();

  // Every card is there, for the right user, with what it carried, and unplaced.
  // Row 2 stacked three copies; the usual startup split turns it into three rows.
  const cards = await db.all(`SELECT * FROM collection ORDER BY id`);
  assert.strictEqual(cards.length, legacyRows.length + 2, 'every legacy collection row must be copied (plus the split copies)');
  for (const old of legacyRows) {
    const now = cards.find(c => c.id === old.id);
    assert.ok(now, `legacy row ${old.id} must keep its id`);
    assert.strictEqual(now.quantity, 1, `row ${old.id} is one copy`);
    const copies = cards.filter(c => c.card_id === old.card_id && c.user_id === old.user_id && c.language === old.language);
    assert.strictEqual(copies.length, old.quantity, `row ${old.id}: all ${old.quantity} copies must be there`);
    for (const col of ['card_id', 'user_id', 'condition', 'printing', 'language', 'purchase_price', 'added_at', 'is_trade', 'list_type']) {
      assert.strictEqual(now[col], old[col], `row ${old.id}: ${col} must survive (${old[col]} -> ${now[col]})`);
    }
    assert.strictEqual(now.location_id, null, `row ${old.id} must be unplaced`);
    assert.strictEqual(now.compartment_id, null, `row ${old.id} must have no compartment`);
    assert.strictEqual(now.game, 'pokemon', 'pre-compartment releases were Pokémon-only');
    assert.strictEqual(now.notes, '', 'new columns take their defaults');
  }
  assert.deepStrictEqual(cards.filter(c => c.user_id === 1).map(c => c.id), [1, 2, 3, 10, 11]);
  assert.deepStrictEqual(cards.filter(c => c.user_id === 2).map(c => c.id), [7, 8, 9]);

  // Clean locations come across as plain containers under their own id; the one
  // whose sort order means nothing now does not.
  const locs = await db.all(`SELECT id, name, type, sort_order, foil_sorting, user_id FROM locations ORDER BY id`);
  assert.deepStrictEqual(locs, [
    { id: 1, name: 'Main Binder', type: 'Binder', sort_order: 'set-number', foil_sorting: 'foils_first', user_id: 1 },
    { id: 2, name: 'Bulk Storage Box 1', type: 'Box', sort_order: 'name-asc', foil_sorting: 'normals_first', user_id: 1 },
    { id: 3, name: 'Misty Binder', type: 'Binder', sort_order: 'custom', foil_sorting: 'normals_first', user_id: 2 },
  ]);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM compartments`)).n, 0, 'no compartments are invented');

  // The originals are kept, untouched, as the recovery copy.
  const keptCards = await db.all(`SELECT * FROM legacy_collection_pre_compartments ORDER BY id`);
  assert.deepStrictEqual(keptCards, legacyRows, 'the legacy collection table must be kept as it was');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM legacy_locations_pre_compartments`)).n, 4);
  assert.ok(!(await db.get(`SELECT name FROM sqlite_master WHERE name LIKE '%_pending'`)), 'no pending tables are left');
  assert.ok((await db.all(`PRAGMA table_info(collection)`)).every(c => c.name !== 'sub_location_1'));
  assert.deepStrictEqual(await db.all(`PRAGMA foreign_key_check(collection)`).then(r => r.map(x => x.rowid)), [9],
    'only the row that was already orphaned in the legacy database lacks its card_cache row');
  assert.strictEqual((await db.get(`PRAGMA foreign_keys`)).foreign_keys, 1, 'foreign keys must be back on');

  // A second boot changes nothing.
  const before = await snapshot();
  await db.initDb();
  assert.deepStrictEqual(await snapshot(), before, 'a second initDb must not change anything');

  console.log('precompartmentupgrade: all assertions passed');
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error(err);
    await cleanup();
    process.exit(1);
  });
