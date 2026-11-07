// Splitting stacked rows on upgrade keeps everything a copy carries. A quantity
// > 1 row is split into single copies at startup (#64), and there used to be two
// splits: db.splitStackedRows inside initDb, which copies every column, and an
// older one in server.js that rebuilt copies from a column list written before
// notes, grading and market value existed — so a copy it made came out raw, with
// no notes or value, dated today, and a slab was duplicated into raw copies.
// Only the first is left. This builds a database the way an old release left it,
// runs the startup migration over it, and checks what came out.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const sqlite3 = require('sqlite3');

const tmpDb = path.join(os.tmpdir(), `bindarr-stacksplit-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}

// The v1.4.x schema: compartment storage, one user, and a collection table with
// no user_id, notes, grading or market value columns yet.
const OLD_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', share_token TEXT UNIQUE NOT NULL, share_enabled INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE locations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL,
    rule_type TEXT DEFAULT 'any', rule_config TEXT);
  CREATE TABLE compartments (id INTEGER PRIMARY KEY AUTOINCREMENT, location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, label TEXT, capacity INTEGER NOT NULL DEFAULT 40, rule_config TEXT, UNIQUE(location_id, idx));
  CREATE TABLE card_cache (id TEXT PRIMARY KEY, name TEXT NOT NULL, supertype TEXT, subtypes TEXT, types TEXT, rarity TEXT,
    set_id TEXT, set_name TEXT, number TEXT, image_url TEXT, price_trend REAL, price_normal REAL, price_holofoil REAL,
    price_reverse_holofoil REAL, price_avg1 REAL, price_avg7 REAL, price_avg30 REAL, cmc REAL, color_identity TEXT,
    game TEXT DEFAULT 'pokemon', last_updated DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE collection (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, quantity INTEGER DEFAULT 1,
    condition TEXT DEFAULT 'Near Mint', printing TEXT DEFAULT 'Normal', language TEXT DEFAULT 'English', purchase_price REAL,
    location_id INTEGER, compartment_id INTEGER, position REAL DEFAULT 0, favorite INTEGER DEFAULT 0, is_trade INTEGER DEFAULT 0,
    list_type TEXT DEFAULT 'collection', game TEXT DEFAULT 'pokemon', added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE SET NULL,
    FOREIGN KEY(compartment_id) REFERENCES compartments(id) ON DELETE SET NULL,
    FOREIGN KEY(card_id) REFERENCES card_cache(id));
  INSERT INTO users (username, password_hash, role, share_token) VALUES ('admin', 'x', 'admin', 'old-share-token');
  INSERT INTO locations (name, type) VALUES ('Old Binder', 'Binder');
  INSERT INTO compartments (location_id, idx, capacity) VALUES (1, 1, 9);
  INSERT INTO card_cache (id, name, game) VALUES ('old-card', 'Old Card', 'pokemon');
  INSERT INTO collection (card_id, quantity, condition, purchase_price, location_id, compartment_id, position, favorite, added_at)
    VALUES ('old-card', 3, 'Lightly Played', 2.5, 1, 1, 4000, 1, '2025-01-02 03:04:05');
`;

function buildOldDatabase() {
  return new Promise((resolve, reject) => {
    const old = new sqlite3.Database(tmpDb, err => {
      if (err) return reject(err);
      old.exec(OLD_SCHEMA, execErr => old.close(closeErr => (execErr || closeErr ? reject(execErr || closeErr) : resolve())));
    });
  });
}

let db;
async function cleanup() {
  if (db) await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function main() {
  await buildOldDatabase();
  process.env.DB_PATH = tmpDb;
  db = require('../src/db');

  // --- upgrading the old database --------------------------------------------------
  await db.initDb();
  const cols = (await db.all(`PRAGMA table_info(collection)`)).map(c => c.name);
  for (const col of ['user_id', 'notes', 'grader', 'grade', 'cert_number', 'market_value', 'market_value_source', 'market_value_at']) {
    assert.ok(cols.includes(col), `the upgrade added collection.${col}`);
  }
  const { id: adminId } = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  const upgraded = await db.all(`SELECT * FROM collection WHERE card_id = 'old-card' ORDER BY position`);
  assert.strictEqual(upgraded.length, 3, 'the stacked row became one row per copy');
  for (const row of upgraded) {
    assert.strictEqual(row.quantity, 1);
    assert.strictEqual(row.user_id, adminId, 'every copy belongs to the owner');
    assert.strictEqual(row.condition, 'Lightly Played');
    assert.strictEqual(row.purchase_price, 2.5);
    assert.strictEqual(row.favorite, 1);
    assert.strictEqual(row.compartment_id, 1);
    assert.strictEqual(row.added_at, '2025-01-02 03:04:05', 'a copy keeps the date the card was added');
    assert.strictEqual(row.grader, 'Raw');
  }
  assert.deepStrictEqual(upgraded.map(r => r.position), [4000, 4000.001, 4000.002], 'the copies sit next to the original');

  // --- rows stacked on today's schema keep grading, notes and value ----------------
  // What a stacked row can still look like now: an API `stackable` add lands one
  // row with a quantity, and the next startup splits it.
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('new-card', 'New Card', 'mtg')`);
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, notes, market_value, market_value_source, market_value_at, purchase_price, game, added_at)
     VALUES ('new-card', ?, 2, 'signed by the artist', 40, 'manual', '2026-03-04 05:06:07', 12, 'mtg', '2026-01-01 00:00:00')`,
    [adminId]
  );
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, grader, grade, cert_number, notes, market_value, market_value_source, game)
     VALUES ('new-card', ?, 3, 'PSA', 10, 'CERT-1', 'the slab', 900, 'pokemonpricetracker', 'mtg')`,
    [adminId]
  );
  await db.initDb();   // the same migration, as the next startup runs it

  const raw = await db.all(`SELECT * FROM collection WHERE card_id = 'new-card' AND grader = 'Raw'`);
  assert.strictEqual(raw.length, 2);
  for (const row of raw) {
    assert.strictEqual(row.notes, 'signed by the artist', 'notes survive the split');
    assert.strictEqual(row.market_value, 40, 'so does the value on record');
    assert.strictEqual(row.market_value_source, 'manual');
    assert.strictEqual(row.market_value_at, '2026-03-04 05:06:07');
    assert.strictEqual(row.purchase_price, 12);
    assert.strictEqual(row.added_at, '2026-01-01 00:00:00');
  }
  const slabs = await db.all(`SELECT quantity, grader, grade, cert_number, notes, market_value FROM collection WHERE card_id = 'new-card' AND grader != 'Raw'`);
  assert.deepStrictEqual(slabs, [{ quantity: 1, grader: 'PSA', grade: 10, cert_number: 'CERT-1', notes: 'the slab', market_value: 900 }],
    'a slab collapses to one copy with its grade, cert, notes and value intact');

  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE quantity > 1`)).n, 0, 'nothing left stacked');
  console.log('stacksplitmigration ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
