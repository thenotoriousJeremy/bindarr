// Runnable smoke test for the recommendSlot capacity fix (audit finding A1).
// No framework — plain node + assert. Run: `npm test` (from backend/) or
// `node test/sort.test.js`. Uses a throwaway SQLite file so it never touches
// the real database.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

// Point the db module at a throwaway file BEFORE requiring it (db.js reads
// DB_PATH at import time).
const tmpDb = path.join(os.tmpdir(), `bindarr-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { recommendSlot, sortCards, getSortCategory } = require('../src/utils/compartmentSort');

// Pure test (no DB): the 'language' filing scheme orders by language rank
// (English, Japanese, ...) then by name, and buckets cards by language.
function testLanguageScheme() {
  const cards = [
    { name: 'Zebra', language: 'Japanese' },
    { name: 'Alpha', language: 'English' },
    { name: 'Beta', language: 'Japanese' },
    { name: 'Gamma', language: 'German' },
  ];
  const sorted = sortCards(cards, 'language', 'normals_first');
  assert.deepStrictEqual(sorted.map(c => c.name), ['Alpha', 'Beta', 'Zebra', 'Gamma'],
    'language scheme must order English, then Japanese-by-name, then German');
  assert.strictEqual(getSortCategory({ language: 'Japanese' }, 'language'), 'Japanese');
  assert.strictEqual(getSortCategory({}, 'language'), 'English', 'missing language defaults to English');
  console.log('PASS: language filing scheme orders by language then name');
}

// Pure test (no DB): favorite as primary sort key floats starred cards to the
// front while the secondary key (name) still sub-orders within each group.
function testFavoriteScheme() {
  const cards = [
    { name: 'Bravo', favorite: 0 },
    { name: 'Alpha', favorite: 1 },
    { name: 'Delta', favorite: 0 },
    { name: 'Charlie', favorite: 1 },
  ];
  const sorted = sortCards(cards, [{ by: 'favorite', dir: 'desc' }, { by: 'name', dir: 'asc' }], 'normals_first');
  assert.deepStrictEqual(sorted.map(c => c.name), ['Alpha', 'Charlie', 'Bravo', 'Delta'],
    'favorites must sort to the front, sub-ordered by name');
  console.log('PASS: favorite sort key floats starred cards to the front');
}

function cleanup() {
  try { db.dbConnection.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
}

async function insertCard(id, name) {
  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, 'Pokémon', '[]', '[]', 'Common', 's1', 'Set One', '1', '', 1]
  );
}

async function main() {
  testLanguageScheme();
  testFavoriteScheme();
  await db.initDb(); // creates schema + default admin (user id 1)
  const userId = 1;

  // Three cards that all share sort-category 'A' (first letter), so the full
  // page below is a genuine candidate for the new card — the exact condition
  // that used to overfill it.
  await insertCard('c-aaa', 'Aaa');
  await insertCard('c-aab', 'Aab');
  await insertCard('c-aac', 'Aac');

  // A-Z binder, two pages of capacity 2.
  const loc = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Test Binder', 'Binder', 'name-asc', 'normals_first', 'any', userId]
  );
  const locId = loc.lastID;
  const page1 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [locId, 1, 2]);
  const page2 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [locId, 2, 2]);

  // Fill page 1 to capacity (2/2) with cards that sort AFTER 'Aaa'.
  for (const cid of ['c-aab', 'c-aac']) {
    await db.run(
      `INSERT INTO collection (card_id, quantity, condition, printing, language, location_id, compartment_id, position, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cid, 1, 'Near Mint', 'Normal', 'English', locId, page1.lastID, 1000, userId]
    );
  }

  const location = await db.get(`SELECT * FROM locations WHERE id = ?`, [locId]);

  // 'Aaa' sorts first (target index 0 -> page-1's capacity window), but page 1
  // is full. Pre-fix this returned page 1 (a 3rd card in a 2-slot page); it
  // must now spill to page 2.
  const rec = await recommendSlot(db, location, {
    name: 'Aaa', set_name: 'Set One', number: '1', types: [], printing: 'Normal', price_trend: 1
  });

  assert(rec, 'expected a recommendation, got null');
  assert.strictEqual(
    rec.compartment_id, page2.lastID,
    `A1: a card sorting into a full page must spill to the next page with room (got compartment ${rec.compartment_id}, expected ${page2.lastID})`
  );

  // General invariant: never recommend a compartment that is already full.
  const cnt = await db.get(`SELECT COUNT(*) as n FROM collection WHERE compartment_id = ? AND user_id = ?`, [rec.compartment_id, userId]);
  const comp = await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [rec.compartment_id]);
  assert(cnt.n < comp.capacity, `recommended compartment is already full (${cnt.n}/${comp.capacity})`);

  console.log('PASS: recommendSlot spills a full compartment to the next with space (A1)');

  // A2: a partly-filled row must recommend a DENSE slot (right after its real
  // cards), not a slot derived from the global sorted rank. A big-capacity Box
  // row holding 3 cards should offer Pos 4 (position 4000) for a card that
  // sorts last — pre-fix the packed-assumption returned a slot far past the 3
  // real cards, leaving phantom empty pockets around the recommendation.
  await insertCard('c-boxa', 'Boxa');
  await insertCard('c-boxb', 'Boxb');
  await insertCard('c-boxc', 'Boxc');
  const box = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Test Box', 'Box', 'name-asc', 'normals_first', 'any', userId]
  );
  const boxId = box.lastID;
  const boxRow = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [boxId, 1, 400]);
  // Stored positions are sparse on purpose (1000, 50000, 90000) — a real row
  // that has churned. Dense slot must come from card count, not stored position.
  const sparse = { 'c-boxa': 1000, 'c-boxb': 50000, 'c-boxc': 90000 };
  for (const cid of Object.keys(sparse)) {
    await db.run(
      `INSERT INTO collection (card_id, quantity, condition, printing, language, location_id, compartment_id, position, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cid, 1, 'Near Mint', 'Normal', 'English', boxId, boxRow.lastID, sparse[cid], userId]
    );
  }
  const boxLoc = await db.get(`SELECT * FROM locations WHERE id = ?`, [boxId]);
  const boxRec = await recommendSlot(db, boxLoc, {
    name: 'Boxd', set_name: 'Set One', number: '1', types: [], printing: 'Normal', price_trend: 1
  });
  assert(boxRec, 'expected a box recommendation, got null');
  assert.strictEqual(
    boxRec.position, 4000,
    `A2: partly-filled row must offer the dense next slot (Pos 4 = 4000), got ${boxRec.position}`
  );
  console.log('PASS: recommendSlot uses a dense slot in a partly-filled row (A2)');

  // LOCK: a locked compartment is skipped by filing (card spills to an unlocked
  // one), and a locked location accepts nothing at all.
  const lockBox = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Lock Test Box', 'Box', 'name-asc', 'normals_first', 'any', userId]
  );
  const lockBoxId = lockBox.lastID;
  const rowA = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [lockBoxId, 1, 2]);
  const rowB = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [lockBoxId, 2, 2]);
  // Lock row A; a card that would normally land in row 1 must skip to row B.
  await db.run(`UPDATE compartments SET locked = 1 WHERE id = ?`, [rowA.lastID]);
  const lockLoc = await db.get(`SELECT * FROM locations WHERE id = ?`, [lockBoxId]);
  const lockedCompRec = await recommendSlot(db, lockLoc, {
    name: 'Aaa', set_name: 'Set One', number: '1', types: [], printing: 'Normal', price_trend: 1
  });
  assert(lockedCompRec, 'expected a recommendation into the unlocked row, got null');
  assert.strictEqual(
    lockedCompRec.compartment_id, rowB.lastID,
    `LOCK: filing must skip a locked compartment (got ${lockedCompRec.compartment_id}, expected unlocked ${rowB.lastID})`
  );
  console.log('PASS: recommendSlot skips a locked compartment');

  // Now lock the whole container: it must accept nothing.
  await db.run(`UPDATE locations SET locked = 1 WHERE id = ?`, [lockBoxId]);
  const lockedLoc = await db.get(`SELECT * FROM locations WHERE id = ?`, [lockBoxId]);
  const lockedLocRec = await recommendSlot(db, lockedLoc, {
    name: 'Aaa', set_name: 'Set One', number: '1', types: [], printing: 'Normal', price_trend: 1
  });
  assert.strictEqual(lockedLocRec, null, 'LOCK: a locked container must recommend nothing (got a slot)');
  console.log('PASS: recommendSlot returns null for a locked container');
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch(err => { console.error('FAIL:', err.stack || err.message); cleanup(); process.exit(1); });
