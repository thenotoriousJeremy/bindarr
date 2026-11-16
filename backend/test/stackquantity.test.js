// Runnable smoke test for setStackQuantity — the card popup's quantity field is
// absolute ("how many copies I own"), so editing it has to add AND remove rows.
// No framework — plain node + assert. Run: `node test/stackquantity.test.js`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The helper is driven through a fake db below, but its module requires the real
// one, which opens DB_PATH as it loads: a throwaway file, never the dev database.
const tmpDb = path.join(os.tmpdir(), `bindarr-stackquantity-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const { setStackQuantity } = require('../src/utils/collectionHelpers');
const realDb = require('../src/db');

const USER = 7;
const base = { user_id: USER, card_id: 'c-A', quantity: 1, condition: 'Near Mint', printing: 'Normal', language: 'English', purchase_price: 2, location_id: 5, compartment_id: 9, position: 4000, is_trade: 0, favorite: 0, list_type: 'collection', game: 'pokemon' };

// Fake db covering the three statements setStackQuantity issues.
function makeFakeDb(rows) {
  let nextId = 100;
  return {
    rows,
    async get(sql, params) {
      const [id, userId] = params;
      return rows.find(r => r.id === id && r.user_id === userId) || null;
    },
    async all(sql, params) {
      const [userId, cardId, condition, printing, language, listType, excludeId] = params;
      return rows
        .filter(r => r.user_id === userId && r.card_id === cardId && r.condition === condition
          && r.printing === printing && r.language === language && r.list_type === listType && r.id !== excludeId)
        // unplaced first, then newest — the trim order the helper asks for
        .sort((a, b) => ((a.location_id === null) === (b.location_id === null) ? b.id - a.id : (a.location_id === null ? -1 : 1)));
    },
    async run(sql, params) {
      if (/^\s*INSERT INTO collection/.test(sql)) {
        const [card_id, user_id, condition, printing, language, purchase_price,
          location_id, compartment_id, position, is_trade, favorite, list_type, game] = params;
        rows.push({ id: ++nextId, card_id, user_id, quantity: 1, condition, printing, language, purchase_price, location_id, compartment_id, position, is_trade, favorite, list_type, game });
      } else if (/^\s*DELETE FROM collection/.test(sql)) {
        rows.splice(rows.findIndex(r => r.id === params[0]), 1);
      } else if (/SET quantity = quantity - \?/.test(sql)) {
        rows.find(r => r.id === params[1]).quantity -= params[0];
      } else if (/SET quantity = \?/.test(sql)) {
        rows.find(r => r.id === params[1]).quantity = params[0];
      }
    },
  };
}

const copies = (db) => db.rows.filter(r => r.card_id === 'c-A').reduce((n, r) => n + r.quantity, 0);

async function main() {
  // The reported bug: two copies, asked for one, ended up with more.
  let db = makeFakeDb([{ ...base, id: 1 }, { ...base, id: 2, location_id: null, compartment_id: null }]);
  assert.strictEqual(await setStackQuantity(db, USER, 1, 1), -1, 'two copies down to one drops a copy');
  assert.strictEqual(copies(db), 1, 'exactly one copy left');
  assert.strictEqual(db.rows[0].id, 1, 'the edited row survives; the unplaced copy went first');

  // Saving the same number again is a no-op, not another duplicate.
  assert.strictEqual(await setStackQuantity(db, USER, 1, 1), 0, 're-saving changes nothing');
  assert.strictEqual(copies(db), 1, 'still one copy');

  // Growing mirrors the edited row's placement onto its own slot.
  assert.strictEqual(await setStackQuantity(db, USER, 1, 3), 2, 'one copy up to three adds two');
  const all = db.rows.filter(r => r.card_id === 'c-A');
  assert.strictEqual(all.length, 3, 'three single-card rows');
  assert.ok(all.every(r => r.quantity === 1 && r.compartment_id === 9), 'copies are single rows in the same compartment');
  assert.strictEqual(new Set(all.map(r => r.position)).size, 3, 'copies have distinct positions');

  // A different printing is not part of the stack and must not be trimmed.
  db = makeFakeDb([{ ...base, id: 1 }, { ...base, id: 2 }, { ...base, id: 3, printing: 'Holofoil' }]);
  await setStackQuantity(db, USER, 1, 1);
  assert.strictEqual(db.rows.length, 2, 'only the identical copy was removed');
  assert.ok(db.rows.some(r => r.printing === 'Holofoil'), 'the holo copy is untouched');

  // A legacy stacked row (quantity > 1) reconciles on its own quantity column.
  db = makeFakeDb([{ ...base, id: 1, quantity: 4 }]);
  assert.strictEqual(await setStackQuantity(db, USER, 1, 2), -2, 'a stacked row shrinks in place');
  assert.strictEqual(db.rows.length, 1, 'no rows deleted');
  assert.strictEqual(db.rows[0].quantity, 2, 'quantity reduced to the target');

  console.log('stackquantity.test.js passed');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(resolve => { try { realDb.dbConnection.close(() => resolve()); } catch { resolve(); } });
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  });
