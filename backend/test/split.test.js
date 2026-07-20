// Runnable smoke test for splitStackedEntries (one physical card = one row).
// No framework — plain node + assert. Run: `node test/split.test.js`.
// Uses an in-memory fake db client so it never touches a real database.
const assert = require('assert');
const { splitStackedEntries } = require('../src/utils/collectionHelpers');

// Minimal fake matching the two queries splitStackedEntries issues:
//   all(`... WHERE quantity > 1`)  and  run(UPDATE ... quantity=1) / run(INSERT ...)
function makeFakeDb() {
  let nextId = 100;
  const rows = [
    { id: 1, card_id: 'c-A', user_id: 7, quantity: 3, condition: 'Near Mint', printing: 'Normal', language: 'English', purchase_price: 2, location_id: 5, compartment_id: 9, position: 4000, is_trade: 0, favorite: 0, list_type: 'collection', game: 'pokemon' },
    { id: 2, card_id: 'c-B', user_id: 7, quantity: 1, condition: 'Near Mint', printing: 'Normal', language: 'English', purchase_price: 0, location_id: null, compartment_id: null, position: 0, is_trade: 0, favorite: 0, list_type: 'collection', game: 'pokemon' },
  ];
  return {
    rows,
    async all() { return rows.filter(r => r.quantity > 1); },
    async run(sql, params) {
      if (/UPDATE collection SET quantity = 1/.test(sql)) {
        rows.find(r => r.id === params[0]).quantity = 1;
      } else if (/INSERT INTO collection/.test(sql)) {
        const [card_id, user_id, condition, printing, language, purchase_price,
          location_id, compartment_id, position, is_trade, favorite, list_type, game] = params;
        rows.push({ id: ++nextId, card_id, user_id, quantity: 1, condition, printing, language, purchase_price, location_id, compartment_id, position, is_trade, favorite, list_type, game });
      }
    },
  };
}

async function main() {
  const dbFake = makeFakeDb();
  const created = await splitStackedEntries(dbFake);

  assert.strictEqual(created, 2, 'a quantity-3 row yields 2 extra rows');
  const copiesOfA = dbFake.rows.filter(r => r.card_id === 'c-A');
  assert.strictEqual(copiesOfA.length, 3, 'c-A now has 3 single-card rows');
  assert.ok(copiesOfA.every(r => r.quantity === 1), 'every copy is quantity 1');
  // Placement/metadata preserved, positions distinct so each takes its own slot.
  assert.ok(copiesOfA.every(r => r.compartment_id === 9 && r.condition === 'Near Mint'), 'metadata carried to copies');
  assert.strictEqual(new Set(copiesOfA.map(r => r.position)).size, 3, 'copies have distinct positions');
  assert.strictEqual(dbFake.rows.filter(r => r.card_id === 'c-B').length, 1, 'quantity-1 rows untouched');

  // Idempotent: nothing left to split.
  const secondRun = await splitStackedEntries(dbFake);
  assert.strictEqual(secondRun, 0, 're-running splits nothing');

  console.log('split.test.js passed');
}

main().catch(err => { console.error(err); process.exit(1); });
