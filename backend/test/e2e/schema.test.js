const assert = require('assert');
const harness = require('./harness');

// Point the db module at a throwaway database BEFORE requiring it. No server
// here: this suite drives initDb and the sorting helpers in its own process.
//
// It used to be a bare file named by PID that was never cleaned up, so once the
// OS recycled a PID this opened a database from an OLD run — one that already
// held this test's fixture rows — and the inserts below failed on a UNIQUE
// constraint. A fresh directory per run starts from empty.
const tmp = harness.tempDatabase('schema-test');

const db = require('../../src/db');
const compartmentSort = require('../../src/utils/compartmentSort');

// Setup mock fetchAndCacheSets
const tcgApi = require('../../src/tcgApi');
tcgApi.fetchAndCacheSets = async () => {};

const cleanup = () => harness.cleanup(db, tmp);

async function runTests() {
  await db.initDb();

  // F2-TC1: Assert that the collection table contains a game column
  try {
    const cols = await db.all(`PRAGMA table_info(collection)`);
    const hasGame = cols.some(c => c.name === 'game');
    assert.ok(hasGame, 'collection table must have game column');
    console.log('PASS: F2-TC1');
  } catch (err) {
    console.error('FAIL: F2-TC1 -', err.message);
    throw err;
  }

  // F2-TC2: Assert that the card_cache table contains a game column
  try {
    const cols = await db.all(`PRAGMA table_info(card_cache)`);
    const hasGame = cols.some(c => c.name === 'game');
    assert.ok(hasGame, 'card_cache table must have game column');
    console.log('PASS: F2-TC2');
  } catch (err) {
    console.error('FAIL: F2-TC2 -', err.message);
    throw err;
  }

  // F2-TC3: Verify that MTG cards are sorted in WUBRG sequence by the colour
  // sort. (The 'type' sort used to do this too; since #88 it sorts Magic by card
  // type, which F2-TC7 covers.)
  try {
    const cards = [
      { name: 'Mountain', types: ['Red'], color_identity: ['R'], game: 'mtg' },
      { name: 'Forest', types: ['Green'], color_identity: ['G'], game: 'mtg' },
      { name: 'Island', types: ['Blue'], color_identity: ['U'], game: 'mtg' },
      { name: 'Plains', types: ['White'], color_identity: ['W'], game: 'mtg' },
      { name: 'Swamp', types: ['Black'], color_identity: ['B'], game: 'mtg' }
    ];
    // WUBRG: White -> Blue -> Black -> Red -> Green
    const sorted = compartmentSort.sortCards(cards, [{ by: 'color', dir: 'asc' }], 'normals_first');
    const colorsSorted = sorted.map(c => c.types[0]);
    assert.deepStrictEqual(colorsSorted, ['White', 'Blue', 'Black', 'Red', 'Green'], 'MTG cards must sort in WUBRG order');
    console.log('PASS: F2-TC3');
  } catch (err) {
    console.error('FAIL: F2-TC3 -', err.message);
    throw err;
  }

  // F2-TC4: Query sorted collection list for a compartment and assert they sort by position
  try {
    const userId = 1;
    const locId = (await db.run(
      `INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`,
      ['Test Binder Schema', 'Binder', userId]
    )).lastID;
    const compId = (await db.run(
      `INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`,
      [locId, 1, 9]
    )).lastID;

    await db.run(
      `INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`,
      ['mtg-c1', 'Card 1', 'mtg']
    );

    // Insert cards with positions out of order
    await db.run(
      `INSERT INTO collection (card_id, quantity, location_id, compartment_id, position, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
      ['mtg-c1', 1, locId, compId, 2.5, userId]
    );
    await db.run(
      `INSERT INTO collection (card_id, quantity, location_id, compartment_id, position, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
      ['mtg-c1', 1, locId, compId, 1.0, userId]
    );

    const rows = await db.all(
      `SELECT position FROM collection WHERE compartment_id = ? ORDER BY position ASC`,
      [compId]
    );
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].position, 1.0);
    assert.strictEqual(rows[1].position, 2.5);
    console.log('PASS: F2-TC4');
  } catch (err) {
    console.error('FAIL: F2-TC4 -', err.message);
    throw err;
  }

  // F2-TC5: Add a location with MTG-related container types (Deck Box, Tin / Case)
  try {
    const userId = 1;
    const deckBox = await db.run(
      `INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`,
      ['Commander Deck', 'Deck Box', userId]
    );
    assert.ok(deckBox.lastID > 0);

    const tinCase = await db.run(
      `INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`,
      ['MTG Tin', 'Tin / Case', userId]
    );
    assert.ok(tinCase.lastID > 0);
    console.log('PASS: F2-TC5');
  } catch (err) {
    console.error('FAIL: F2-TC5 -', err.message);
    throw err;
  }

  // F2-TC6: Verify DB schema migration idempotency
  try {
    // Run initDb again on existing DB
    await db.initDb();
    const cols = await db.all(`PRAGMA table_info(collection)`);
    const gameCols = cols.filter(c => c.name === 'game');
    assert.strictEqual(gameCols.length, 1, 'Should only have one game column even after running initDb twice');
    console.log('PASS: F2-TC6');
  } catch (err) {
    console.error('FAIL: F2-TC6 -', err.message);
    throw err;
  }

  // F2-TC7: Verify multicolor cards sorting order under the colour sort, and
  // that the 'type' sort orders Magic by card type, not colour (#88)
  try {
    const cards = [
      { name: 'Azorius Card', types: ['White', 'Blue'], color_identity: ['W', 'U'], subtypes: ['Instant'], game: 'mtg' },
      { name: 'Island', types: [], color_identity: ['U'], subtypes: ['Basic', 'Land', 'Island'], game: 'mtg' },
      { name: 'Boros Card', types: ['Red', 'White'], color_identity: ['R', 'W'], subtypes: ['Creature', 'Human', 'Soldier'], game: 'mtg' },
      { name: 'Plains', types: [], color_identity: ['W'], subtypes: ['Basic', 'Land', 'Plains'], game: 'mtg' }
    ];
    const sorted = compartmentSort.sortCards(cards, [{ by: 'color', dir: 'asc' }, { by: 'name', dir: 'asc' }], 'normals_first');
    // Expected order: Plains (White) -> Island (Blue) -> Azorius Card (Multicolor) -> Boros Card (Multicolor)
    assert.strictEqual(sorted[0].name, 'Plains');
    assert.strictEqual(sorted[1].name, 'Island');
    assert.strictEqual(sorted[2].name, 'Azorius Card');
    assert.strictEqual(sorted[3].name, 'Boros Card');
    const byType = compartmentSort.sortCards(cards, 'type-name', 'normals_first');
    // Creature -> Instant -> Land, by name within a type
    assert.deepStrictEqual(byType.map(c => c.name), ['Boros Card', 'Azorius Card', 'Island', 'Plains']);
    console.log('PASS: F2-TC7');
  } catch (err) {
    console.error('FAIL: F2-TC7 -', err.message);
    throw err;
  }

  // F2-TC8: Verify a compound set-restriction rule rejects non-matching cards
  try {
    const location = {
      rule_type: 'compound',
      rule_config: JSON.stringify({ rules: [{ action: 'include', field: 'set_name', operator: 'equals', value: 'Throne of Eldraine' }] })
    };
    const matchingCard = { name: 'Questing Beast', set_name: 'Throne of Eldraine', game: 'mtg' };
    const nonMatchingCard = { name: 'Black Lotus', set_name: 'Limited Edition Alpha', game: 'mtg' };

    assert.ok(compartmentSort.locationAcceptsCard(location, matchingCard), 'Location should accept card from allowed set');
    assert.ok(!compartmentSort.locationAcceptsCard(location, nonMatchingCard), 'Location should reject card from forbidden set');
    console.log('PASS: F2-TC8');
  } catch (err) {
    console.error('FAIL: F2-TC8 -', err.message);
    throw err;
  }

  // F2-TC9: Verify compartment overflow logic (recommending next compartment when full)
  try {
    const userId = 1;
    const locId = (await db.run(
      `INSERT INTO locations (name, type, sort_order, foil_sorting, user_id) VALUES (?, ?, ?, ?, ?)`,
      ['Overflow Binder', 'Binder', 'name-asc', 'normals_first', userId]
    )).lastID;
    const p1 = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [locId, 1, 1])).lastID;
    const p2 = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [locId, 2, 1])).lastID;

    // Fill page 1
    await db.run(
      `INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`,
      ['mtg-c2', 'Black Lotus', 'mtg']
    );
    await db.run(
      `INSERT INTO collection (card_id, quantity, location_id, compartment_id, position, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
      ['mtg-c2', 1, locId, p1, 1.0, userId]
    );

    const locationObj = await db.get(`SELECT * FROM locations WHERE id = ?`, [locId]);
    const rec = await compartmentSort.recommendSlot(db, locationObj, {
      name: 'Mox Sapphire', set_name: 'Limited Edition Alpha', number: '1', types: [], printing: 'Normal', price_trend: 1000
    });

    assert.ok(rec, 'Must return a recommendation');
    assert.strictEqual(rec.compartment_id, p2, 'Must recommend page 2 since page 1 is full');
    console.log('PASS: F2-TC9');
  } catch (err) {
    console.error('FAIL: F2-TC9 -', err.message);
    throw err;
  }

  // F2-TC10: Verify price history handles null/zero values safely
  try {
    await db.run(
      `INSERT INTO card_cache (id, name, game, price_trend) VALUES (?, ?, ?, ?)`,
      ['mtg-c3', 'Promo Lotus', 'mtg', null]
    );
    await db.run(
      `INSERT INTO price_history (card_id, price) VALUES (?, ?)`,
      ['mtg-c3', 0.0]
    );
    const row = await db.get(`SELECT * FROM price_history WHERE card_id = ?`, ['mtg-c3']);
    assert.strictEqual(row.price, 0.0);
    console.log('PASS: F2-TC10');
  } catch (err) {
    console.error('FAIL: F2-TC10 -', err.message);
    throw err;
  }
}

runTests()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async err => {
    console.error(err);
    await cleanup();
    process.exit(1);
  });
