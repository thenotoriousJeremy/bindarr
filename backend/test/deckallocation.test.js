// Which physical copies a deck takes (utils/deckAllocation.js): the exact-first
// planner, the all-or-nothing checkout, the conditional claim, re-allocation of a
// checked-out deck, and the one-time backfill for decks checked out before
// allocations were stored. Real temporary SQLite throughout.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-deck-allocation-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const {
  planDeck, deckAvailability, locationsFor, claimCopies, checkoutDeck, returnDeck, syncDeckAllocation,
} = require('../src/utils/deckAllocation');
const { checkedOutAllocation } = require('../src/utils/collectionHelpers');

let userId;
let binderId;

async function cache(id, name, game, oracleId = null) {
  await db.run(`INSERT INTO card_cache (id, name, game, oracle_id) VALUES (?, ?, ?, ?)`, [id, name, game, oracleId]);
}
// One physical copy per row, as the collection keeps them. `filed` puts it in the
// starter binder, which the planner prefers over a loose copy.
async function own(cardId, game, { filed = false } = {}) {
  return (await db.run(
    `INSERT INTO collection (card_id, quantity, game, user_id, location_id) VALUES (?, 1, ?, ?, ?)`,
    [cardId, game, userId, filed ? binderId : null]
  )).lastID;
}
async function deck(name, game, cards, { anyPrinting = 0, format = 'Modern' } = {}) {
  const id = (await db.run(
    `INSERT INTO decks (name, game, format, any_printing, user_id) VALUES (?, ?, ?, ?, ?)`,
    [name, game, format, anyPrinting, userId]
  )).lastID;
  for (const [cardId, quantity] of cards) {
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)`, [id, cardId, quantity]);
  }
  return id;
}
const held = async (deckId) => (await db.all(
  `SELECT entry_id, card_id, quantity FROM deck_allocations WHERE deck_id = ? ORDER BY entry_id`, [deckId]
));
async function rejects(promise, status, pattern) {
  try {
    await promise;
  } catch (err) {
    assert.strictEqual(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
    if (pattern) assert.match(err.message + JSON.stringify(err.details || []), pattern);
    return err;
  }
  assert.fail(`expected a ${status} refusal`);
}

// Pure planner: exact printings go out before any substitute, so a deck listing two
// printings of one card gets each one rather than the first-listed card taking
// whatever copy happens to be preferred.
function testPlannerPrefersExactPrintings() {
  const same = (a, b) => a.card_id === b.card_id || a.name === b.name;
  const cards = [
    { card_id: 'ring-cmr', name: 'Sol Ring', quantity: 1 },
    { card_id: 'ring-c21', name: 'Sol Ring', quantity: 1 },
  ];
  // Preference order: the C21 copy first, then an unrelated printing.
  const copies = [
    { entry_id: 1, card_id: 'ring-c21', name: 'Sol Ring', quantity: 1, held_by: null },
    { entry_id: 2, card_id: 'ring-old', name: 'Sol Ring', quantity: 1, held_by: null },
  ];
  const plan = planDeck({ cards, copies, matches: same, anyPrinting: true, deckId: 9, keepHeld: false, topUp: true });
  assert.deepStrictEqual(plan.map(p => p.takes.map(t => t.copy.entry_id)), [[2], [1]],
    'the C21 slot keeps the C21 copy; the CMR slot takes the substitute');
  assert.deepStrictEqual(plan.map(p => p.need), [0, 0]);

  const exact = planDeck({ cards, copies, matches: (a, b) => a.card_id === b.card_id, anyPrinting: false, deckId: 9, keepHeld: false, topUp: true });
  assert.deepStrictEqual(exact.map(p => p.need), [1, 0], 'an exact deck never substitutes');

  // A copy another checked-out deck holds is owned but not usable.
  const lockedPlan = planDeck({
    cards: [{ card_id: 'ring-c21', name: 'Sol Ring', quantity: 1 }],
    copies: [{ entry_id: 1, card_id: 'ring-c21', name: 'Sol Ring', quantity: 1, held_by: 4, held_by_name: 'Other' }],
    matches: same, anyPrinting: false, deckId: 9, keepHeld: false, topUp: true,
  });
  assert.deepStrictEqual([lockedPlan[0].owned, lockedPlan[0].locked, [...lockedPlan[0].lockedBy], lockedPlan[0].need], [1, 1, ['Other'], 1]);
}

async function testCheckoutClaimsAllOrNothing() {
  await cache('mtg-bolt', 'Lightning Bolt', 'mtg', 'o-bolt');
  const filedBolt = await own('mtg-bolt', 'mtg', { filed: true });
  const looseBolt = await own('mtg-bolt', 'mtg');

  const burn = await deck('Burn', 'mtg', [['mtg-bolt', 2]]);
  const zoo = await deck('Zoo', 'mtg', [['mtg-bolt', 1]]);

  await checkoutDeck(burn, userId);
  assert.deepStrictEqual((await held(burn)).map(h => h.entry_id).sort(), [filedBolt, looseBolt].sort());
  assert.strictEqual((await db.get(`SELECT checked_out FROM decks WHERE id = ?`, [burn])).checked_out, 1);

  const refused = await rejects(checkoutDeck(zoo, userId), 400, /Not enough cards/);
  assert.deepStrictEqual(refused.details, ['Missing 1x Lightning Bolt (Owned: 2, In Use: 2)']);
  assert.deepStrictEqual(await held(zoo), [], 'a refused checkout claims nothing');
  assert.strictEqual((await db.get(`SELECT checked_out FROM decks WHERE id = ?`, [zoo])).checked_out, 0);

  await rejects(checkoutDeck(burn, userId), 409, /already checked out/);

  // The storage view greys out exactly the claimed copies.
  const pulled = await checkedOutAllocation(userId);
  assert.deepStrictEqual([pulled.get(filedBolt), pulled.get(looseBolt)], [1, 1]);

  await returnDeck(burn, userId);
  assert.deepStrictEqual(await held(burn), [], 'returning releases every copy');
  await checkoutDeck(zoo, userId);
  assert.deepStrictEqual((await held(zoo)).map(h => h.entry_id), [filedBolt], 'filed copies first');
  await returnDeck(zoo, userId);
}

// The claim itself refuses a copy that was taken after the plan was read, and the
// transaction around it then rolls back everything the checkout had claimed.
async function testClaimRefusesATakenCopy() {
  await cache('mtg-path', 'Path to Exile', 'mtg', 'o-path');
  const a = await own('mtg-path', 'mtg');
  const b = await own('mtg-path', 'mtg');
  const first = await deck('Taker', 'mtg', [['mtg-path', 1]]);
  const second = await deck('Late', 'mtg', [['mtg-path', 2]]);

  const plan = planDeck({
    cards: [{ card_id: 'mtg-path', name: 'Path to Exile', quantity: 2 }],
    copies: [a, b].map(entry_id => ({ entry_id, card_id: 'mtg-path', name: 'Path to Exile', quantity: 1, held_by: null })),
    matches: (x, y) => x.card_id === y.card_id, anyPrinting: false, deckId: second, keepHeld: false, topUp: true,
  });
  // Between that read and the claim, another deck takes one of the two copies.
  await db.run(`UPDATE decks SET checked_out = 1 WHERE id = ?`, [first]);
  await db.run(`INSERT INTO deck_allocations (entry_id, deck_id, card_id) VALUES (?, ?, 'mtg-path')`, [b, first]);

  await rejects(db.withTransaction(() => claimCopies(second, plan, { strict: true })), 409, /just checked out/);
  assert.deepStrictEqual(await held(second), [], 'the copy it could claim is rolled back too');
  assert.deepStrictEqual((await held(first)).map(h => h.entry_id), [b], "and the other deck's claim is untouched");

  // A row left by a deck that is no longer checked out does not block anyone.
  await db.run(`UPDATE decks SET checked_out = 0 WHERE id = ?`, [first]);
  await checkoutDeck(second, userId);
  assert.deepStrictEqual((await held(second)).map(h => h.entry_id).sort(), [a, b].sort());
  await returnDeck(second, userId);
}

async function testAnyPrintingFillsFromOtherPrintings() {
  await cache('mtg-ring-cmr', 'Sol Ring', 'mtg', 'o-ring');
  await cache('mtg-ring-c21', 'Sol Ring', 'mtg', 'o-ring');
  // Cached before oracle ids were: matched by its name until re-cached.
  await cache('mtg-ring-old', 'Sol Ring', 'mtg', null);
  const cmr = await own('mtg-ring-cmr', 'mtg');
  const c21 = await own('mtg-ring-c21', 'mtg', { filed: true });
  const old = await own('mtg-ring-old', 'mtg');

  const exact = await deck('Exact', 'mtg', [['mtg-ring-cmr', 3]], { anyPrinting: 0 });
  const exactView = await deckAvailability(await db.get(`SELECT * FROM decks WHERE id = ?`, [exact]), userId);
  assert.deepStrictEqual([exactView.get('mtg-ring-cmr').owned, exactView.get('mtg-ring-cmr').need], [1, 2],
    'an exact deck only counts the printing it lists');

  const any = await deck('Any', 'mtg', [['mtg-ring-cmr', 3]], { anyPrinting: 1 });
  const anyDeck = await db.get(`SELECT * FROM decks WHERE id = ?`, [any]);
  const view = await deckAvailability(anyDeck, userId);
  assert.deepStrictEqual([view.get('mtg-ring-cmr').owned, view.get('mtg-ring-cmr').need], [3, 0]);
  const pull = locationsFor(view)[0];
  assert.deepStrictEqual(pull.locations.map(l => [l.entry_id, l.substitute]), [[cmr, false], [c21, true], [old, true]],
    'the listed printing first, then other printings filed-first');

  await checkoutDeck(any, userId);
  assert.deepStrictEqual((await held(any)).map(h => h.card_id), ['mtg-ring-cmr', 'mtg-ring-cmr', 'mtg-ring-cmr']);

  // Out on the table, turning any-printing off gives the substitutes back...
  await db.run(`UPDATE decks SET any_printing = 0 WHERE id = ?`, [any]);
  await syncDeckAllocation(any, userId);
  assert.deepStrictEqual((await held(any)).map(h => h.entry_id), [cmr]);
  // ...and cutting the card from the deck releases the rest.
  await db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [any]);
  await syncDeckAllocation(any, userId);
  assert.deepStrictEqual(await held(any), []);
  // A card added to a checked-out deck takes a free copy if there is one.
  await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'mtg-ring-c21', 1)`, [any]);
  await syncDeckAllocation(any, userId);
  assert.deepStrictEqual((await held(any)).map(h => h.entry_id), [c21]);
  await returnDeck(any, userId);
}

async function testPokemonIsAlwaysExact() {
  await cache('p-pika-a', 'Pikachu', 'pokemon');
  await cache('p-pika-b', 'Pikachu', 'pokemon');
  await own('p-pika-b', 'pokemon');
  // Even a deck row that says any printing: a different Pikachu is a different card.
  const pika = await deck('Pika', 'pokemon', [['p-pika-a', 1]], { anyPrinting: 1, format: 'Standard' });
  await rejects(checkoutDeck(pika, userId), 400, /Missing 1x Pikachu \(Owned: 0, In Use: 0\)/);
}

// Decks checked out before deck_allocations existed get the copies the old storage
// view greyed out, handed out in checkout order.
async function testBackfillForDecksAlreadyCheckedOut() {
  await cache('mtg-ponder', 'Ponder', 'mtg', 'o-ponder');
  const loose1 = await own('mtg-ponder', 'mtg');
  const filed = await own('mtg-ponder', 'mtg', { filed: true });
  const loose2 = await own('mtg-ponder', 'mtg');
  const early = await deck('Early', 'mtg', [['mtg-ponder', 1]]);
  const late = await deck('Late', 'mtg', [['mtg-ponder', 2]]);
  await db.run(`UPDATE decks SET checked_out = 1, checked_out_at = '2026-01-01 10:00:00' WHERE id = ?`, [early]);
  await db.run(`UPDATE decks SET checked_out = 1, checked_out_at = '2026-01-02 10:00:00' WHERE id = ?`, [late]);

  // Every other test's claims stay put; only these two decks start without any.
  const before = await db.all(`SELECT * FROM deck_allocations ORDER BY entry_id`);
  await db.run(`DROP TABLE deck_allocations`);
  await db.initDb();
  for (const row of before) {
    await db.run(`INSERT OR IGNORE INTO deck_allocations (entry_id, deck_id, card_id, quantity) VALUES (?, ?, ?, ?)`,
      [row.entry_id, row.deck_id, row.card_id, row.quantity]);
  }

  assert.deepStrictEqual((await held(early)).map(h => h.entry_id), [filed], 'the first deck out gets the filed copy');
  assert.deepStrictEqual((await held(late)).map(h => h.entry_id), [loose1, loose2].sort((x, y) => x - y));
  await db.initDb();
  assert.strictEqual((await held(late)).length, 2, 'the backfill runs once, when the table is created');
}

async function main() {
  try {
    await db.initDb();
    userId = (await db.get(`SELECT id FROM users WHERE username = 'admin'`)).id;
    binderId = (await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Binder'`, [userId])).id;

    testPlannerPrefersExactPrintings();
    await testCheckoutClaimsAllOrNothing();
    await testClaimRefusesATakenCopy();
    await testAnyPrintingFillsFromOtherPrintings();
    await testPokemonIsAlwaysExact();
    await testBackfillForDecksAlreadyCheckedOut();
    console.log('deckallocation.test.js passed');
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
