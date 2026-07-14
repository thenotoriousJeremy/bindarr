const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Set isolated test database
const testDbPath = path.join(__dirname, '../../database/test_pokemon_cards.db');
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
}
process.env.DB_PATH = testDbPath;

const db = require('../../src/db');
const { getCompartmentOccupancy, resolveCompartmentAndPosition, checkedOutAllocation } = require('../../src/utils/collectionHelpers');
const { sortCards, prepareCardMetadata } = require('../../src/utils/compartmentSort');
const { parseThirdPartyCSV } = require('../../src/utils/csvMappers');
const { generateExportCSV } = require('../../src/utils/csvExporters');

async function runTests() {
  console.log('--- STARTING POKEDEXRR E2E & VERIFICATION TEST SUITE ---');

  // 1. Initialize DB
  await db.initDb();
  console.log('✔ DB initialization & migrations completed');

  // 2. Test SUM(quantity) vs COUNT(*) in Compartment Occupancy
  await db.run(`INSERT INTO card_cache (id, name) VALUES ('test-card-1', 'Test Card 1')`);
  await db.run(`INSERT INTO locations (id, name, type, user_id) VALUES (10, 'Test Binder', 'Binder', 1)`);
  await db.run(`INSERT INTO compartments (id, location_id, idx, label, capacity) VALUES (101, 10, 1, 'Slot 1', 10)`);
  
  // Single row with quantity = 10
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id, position) VALUES ('test-card-1', 1, 10, 10, 101, 1000)`);

  
  const totalOccupancy = await getCompartmentOccupancy(db, 101);
  assert.strictEqual(totalOccupancy, 10, `Expected occupancy to be 10 via SUM(quantity), got ${totalOccupancy}`);
  console.log('✔ SUM(quantity) capacity calculation verified (1 row with quantity=10 returns total_cards=10)');

  // Verify resolveCompartmentAndPosition returns null when capacity (10) is met
  const resolvedFull = await resolveCompartmentAndPosition(db, 10, 'test-card-2', 1);
  assert.strictEqual(resolvedFull, null, 'Expected full compartment to return null');
  console.log('✔ resolveCompartmentAndPosition capacity limit enforcement verified');

  // 3. Test withTransaction Helper
  let txExecuted = false;
  await db.withTransaction(async (tx) => {
    await tx.run(`INSERT INTO tags (user_id, name, color) VALUES (1, 'Transaction Tag', '#FF0000')`);
    txExecuted = true;
  });
  assert.strictEqual(txExecuted, true);
  const tagCheck = await db.get(`SELECT * FROM tags WHERE name = 'Transaction Tag'`);
  assert.ok(tagCheck, 'Tag created in transaction should persist after commit');
  console.log('✔ withTransaction commit functionality verified');

  // Test Rollback
  try {
    await db.withTransaction(async (tx) => {
      await tx.run(`INSERT INTO tags (user_id, name, color) VALUES (1, 'Failing Tag', '#00FF00')`);
      throw new Error('Forced Rollback Failure');
    });
  } catch (e) {
    // Expected error
  }
  const rollbackCheck = await db.get(`SELECT * FROM tags WHERE name = 'Failing Tag'`);
  assert.strictEqual(rollbackCheck, undefined, 'Failing tag should not exist after rollback');
  console.log('✔ withTransaction rollback functionality verified');

  // 4. Test Single JOIN checkedOutAllocation
  await db.run(`INSERT INTO decks (id, user_id, name) VALUES (1, 1, 'Main Deck')`);
  await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out) VALUES (1, 'test-card-1', 2, 1)`);
  
  const allocMap = await checkedOutAllocation(db, 1);
  assert.ok(allocMap.has('test-card-1'), 'Map should contain test-card-1 key');
  const allocData = allocMap.get('test-card-1');
  assert.strictEqual(allocData.required, 2);
  assert.strictEqual(allocData.allocated.length, 1);
  console.log('✔ checkedOutAllocation single JOIN query verified');

  // 5. Test Pre-parsed JSON in compartmentSort
  const rawCard = {
    id: 'c1',
    name: 'Pikachu',
    types: '["Lightning"]',
    subtypes: '["Basic"]'
  };
  const prepared = prepareCardMetadata(rawCard);
  assert.deepStrictEqual(prepared.parsed_types, ['Lightning']);
  assert.deepStrictEqual(prepared.parsed_subtypes, ['Basic']);
  console.log('✔ prepareCardMetadata pre-parsing verified');

  const sorted = sortCards([
    { id: 'c2', name: 'Zubat', types: '["Darkness"]' },
    { id: 'c1', name: 'Abra', types: '["Psychic"]' }
  ], [{ by: 'name', dir: 'asc' }]);
  assert.strictEqual(sorted[0].name, 'Abra');
  assert.strictEqual(sorted[1].name, 'Zubat');
  console.log('✔ Memory card sorting with pre-parsed metadata verified');

  // 6. Test CSV Strategy Mappers & Export Hygiene
  const thirdPartyRows = [
    { 'Card Name': 'Charizard', 'Set Code': 'base1', 'Number': '4', 'Quantity': '2', 'Condition': 'Near Mint', 'Printing': 'Foil' }
  ];
  const parsedTCG = parseThirdPartyCSV(thirdPartyRows, 'tcgplayer');
  assert.strictEqual(parsedTCG[0].name, 'Charizard');
  assert.strictEqual(parsedTCG[0].printing, 'Holofoil');
  assert.strictEqual(parsedTCG[0].quantity, 2);
  console.log('✔ TCGPlayer CSV Import Mapper verified');

  const exportItem = [{
    name: 'Blastoise',
    set_code: 'base1',
    collector_number: '2',
    quantity: 1,
    condition: 'Near Mint',
    printing: 'Holofoil'
  }];
  const exportedDS = generateExportCSV(exportItem, 'dragonshield');
  assert.ok(exportedDS.includes('"Blastoise"'), 'Exported CSV should include Blastoise');
  assert.ok(exportedDS.includes('"Foil"'), 'Dragon Shield export should format Holofoil as Foil');
  assert.ok(exportedDS.includes('"NM"'), 'Dragon Shield export should format Near Mint as NM');
  console.log('✔ Dragon Shield CSV Export Hygiene Mapper verified');

  // Clean up test DB file asynchronously after closing sqlite handle
  db.dbConnection.close((err) => {
    if (!err && fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    console.log('=========================================');
    console.log('ALL TESTS PASSED CLEANLY (100% SUCCESS)');
    console.log('=========================================');
  });
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
