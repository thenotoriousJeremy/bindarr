// Named lists take many cards in one request, and a deck's missing list counts
// what the deck page counts.
//
//   - POST /api/lists/:id/items with { card_ids } adds every card in one call,
//     merging into what is already there the way one card does; a card from
//     another game or one no provider knows is reported, not fatal. The one-card
//     body still works, and another user's list id is a 404 that writes nothing.
//   - POST /api/decks/:id/missing-list builds from the deck page's own numbers, so
//     a Commander deck (any printing) that the page shows complete gets an empty
//     list, and a copy another checked-out deck holds counts as missing.
//   - A list can be scoped to any game in the registry, Riftbound included.
//
// Runs offline (harness.js): every card is seeded into card_cache, and an id no
// provider could have minted resolves to nothing without a request.
const assert = require('assert');
const harness = require('./harness');

const tmp = harness.tempDatabase('listsbulk');
const db = require('../../src/db');

let srv;
let passCount = 0;

async function testCase(id, title, fn) {
  try {
    await fn();
    passCount++;
    console.log(`PASS: ${id} - ${title}`);
  } catch (err) {
    console.error(`FAIL: ${id} - ${title}: ${err.message}`);
    throw err;
  }
}

const card = (id, name, game, extra = {}) => db.run(
  `INSERT INTO card_cache (id, name, game, language, set_id, set_name, number, oracle_id, last_updated)
   VALUES (?, ?, ?, 'English', ?, 'Test Set', ?, ?, datetime('now'))`,
  [id, name, game, extra.set_id || `${game}-tst`, extra.number || '1', extra.oracle_id || null]
);
const own = (userId, cardId, game, quantity = 1) => db.run(
  `INSERT INTO collection (card_id, user_id, quantity, condition, language, game, list_type)
   VALUES (?, ?, ?, 'Near Mint', 'English', ?, 'collection')`,
  [cardId, userId, quantity, game]
);
const deck = async (userId, name, cards, { game = 'mtg', format = 'Commander / EDH', anyPrinting = 1 } = {}) => {
  const { lastID } = await db.run(
    `INSERT INTO decks (user_id, name, game, format, any_printing) VALUES (?, ?, ?, ?, ?)`,
    [userId, name, game, format, anyPrinting]
  );
  for (const [cardId, quantity] of cards) {
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)`, [lastID, cardId, quantity]);
  }
  return lastID;
};
const items = (listId) => db.all(
  `SELECT card_id, quantity_wanted FROM card_list_items WHERE list_id = ? ORDER BY card_id`, [listId]
);

async function runTests() {
  srv = await harness.startServer(tmp);
  const alice = await harness.member(db, 'alice');
  const bob = await harness.member(db, 'bob');
  const req = (...args) => srv.request(...args);

  await card('mtg-bolt', 'Lightning Bolt', 'mtg');
  await card('mtg-counter', 'Counterspell', 'mtg', { oracle_id: 'oracle-counter' });
  await card('mtg-ring-a', 'Sol Ring', 'mtg', { oracle_id: 'oracle-ring', number: '1' });
  await card('mtg-ring-b', 'Sol Ring', 'mtg', { oracle_id: 'oracle-ring', number: '2' });
  await card('lorcana-mickey', 'Mickey Mouse - Brave Little Tailor', 'lorcana');
  await card('riftbound-jinx', 'Jinx', 'riftbound');

  let mtgList;
  await testCase('F11-TC1', 'a named list takes many cards in one request', async () => {
    const created = await req('POST', '/api/lists', { as: alice, body: { name: 'Buylist', kind: 'buylist', game: 'mtg' } });
    assert.strictEqual(created.status, 201, created.text);
    mtgList = created.json.id;

    // Duplicates in one request count once, as the default list's do.
    const res = await req('POST', `/api/lists/${mtgList}/items`, {
      as: alice, body: { card_ids: ['mtg-bolt', 'mtg-counter', 'mtg-bolt'], quantity_wanted: 1 },
    });
    assert.strictEqual(res.status, 201, res.text);
    assert.deepStrictEqual(res.json, { added: 2, failed: [], error: null });
    assert.deepStrictEqual(await items(mtgList), [
      { card_id: 'mtg-bolt', quantity_wanted: 1 },
      { card_id: 'mtg-counter', quantity_wanted: 1 },
    ]);
  });

  await testCase('F11-TC2', 'a bulk add merges, and reports the cards that cannot go on the list', async () => {
    const res = await req('POST', `/api/lists/${mtgList}/items`, {
      as: alice, body: { card_ids: ['mtg-bolt', 'lorcana-mickey', 'nosuchcard'] },
    });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.json.added, 1);
    assert.deepStrictEqual(res.json.failed, ['lorcana-mickey', 'nosuchcard']);
    assert.match(res.json.error, /only takes mtg cards/);
    assert.deepStrictEqual(await items(mtgList), [
      { card_id: 'mtg-bolt', quantity_wanted: 2 },
      { card_id: 'mtg-counter', quantity_wanted: 1 },
    ]);

    // Nothing that can go on it: a 400 naming why, and nothing written.
    const none = await req('POST', `/api/lists/${mtgList}/items`, { as: alice, body: { card_ids: ['lorcana-mickey'] } });
    assert.strictEqual(none.status, 400, none.text);
    assert.deepStrictEqual({ added: none.json.added, failed: none.json.failed }, { added: 0, failed: ['lorcana-mickey'] });
    assert.match(none.json.error, /only takes mtg cards/);

    for (const bad of [[], 'mtg-bolt', [42], Array.from({ length: 501 }, (_, i) => `mtg-x${i}`)]) {
      const refused = await req('POST', `/api/lists/${mtgList}/items`, { as: alice, body: { card_ids: bad } });
      assert.strictEqual(refused.status, 400, `card_ids ${JSON.stringify(bad).slice(0, 40)}: ${refused.text}`);
    }
    assert.strictEqual((await items(mtgList)).length, 2);
  });

  await testCase('F11-TC3', 'the one-card body still adds and merges', async () => {
    const res = await req('POST', `/api/lists/${mtgList}/items`, { as: alice, body: { card_id: 'mtg-counter', quantity_wanted: 2 } });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.json.card_id, 'mtg-counter');
    assert.strictEqual(res.json.quantity_wanted, 3);
    const wrongGame = await req('POST', `/api/lists/${mtgList}/items`, { as: alice, body: { card_id: 'lorcana-mickey' } });
    assert.strictEqual(wrongGame.status, 400, wrongGame.text);
  });

  await testCase('F11-TC4', "another user's list takes nothing, in either form", async () => {
    const before = await items(mtgList);
    for (const body of [{ card_ids: ['mtg-bolt'] }, { card_id: 'mtg-bolt' }]) {
      const res = await req('POST', `/api/lists/${mtgList}/items`, { as: bob, body });
      assert.strictEqual(res.status, 404, res.text);
      assert.ok(!res.text.includes('Buylist'), "the refusal names Alice's list");
    }
    assert.deepStrictEqual(await items(mtgList), before);
  });

  await testCase('F11-TC5', 'a Commander deck the page shows complete gets an empty missing list', async () => {
    // The deck lists one printing of Sol Ring; Alice owns the other. Any printing
    // counts in this deck, so the page says nothing is missing.
    const deckId = await deck(alice.id, 'Ring deck', [['mtg-ring-a', 1]]);
    await own(alice.id, 'mtg-ring-b', 'mtg');
    const page = await req('GET', `/api/decks/${deckId}`, { as: alice });
    assert.strictEqual(page.status, 200, page.text);
    assert.strictEqual(page.json.cards[0].missing_qty, 0);

    const res = await req('POST', `/api/decks/${deckId}/missing-list`, { as: alice });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.json.cards, 0, `the list wants ${res.json.copies} copy/copies the deck page does not`);
    assert.deepStrictEqual(await items(res.json.list_id), []);
  });

  await testCase('F11-TC6', "the missing list wants exactly the deck page's missing copies", async () => {
    // Two Counterspells wanted, one owned, and that one is held by another deck
    // that is checked out: the page counts both as missing.
    await own(alice.id, 'mtg-counter', 'mtg');
    const other = await deck(alice.id, 'Other deck', [['mtg-counter', 1]]);
    const out = await req('PUT', `/api/decks/${other}/checkout`, { as: alice });
    assert.strictEqual(out.status, 200, out.text);
    const deckId = await deck(alice.id, 'Control', [['mtg-counter', 2], ['mtg-bolt', 1]]);

    const page = await req('GET', `/api/decks/${deckId}`, { as: alice });
    assert.strictEqual(page.status, 200, page.text);
    const wanted = Object.fromEntries(page.json.cards.filter(c => c.missing_qty > 0).map(c => [c.id, c.missing_qty]));
    assert.deepStrictEqual(wanted, { 'mtg-counter': 2, 'mtg-bolt': 1 });

    const res = await req('POST', `/api/decks/${deckId}/missing-list`, { as: alice });
    assert.strictEqual(res.status, 201, res.text);
    const got = Object.fromEntries((await items(res.json.list_id)).map(i => [i.card_id, i.quantity_wanted]));
    assert.deepStrictEqual(got, wanted);
    assert.deepStrictEqual({ cards: res.json.cards, copies: res.json.copies }, { cards: 2, copies: 3 });
  });

  await testCase('F11-TC7', 'a list can be scoped to Riftbound, and to no unknown game', async () => {
    const created = await req('POST', '/api/lists', { as: alice, body: { name: 'Runes', game: 'riftbound' } });
    assert.strictEqual(created.status, 201, created.text);
    assert.strictEqual(created.json.game, 'riftbound');
    const added = await req('POST', `/api/lists/${created.json.id}/items`, { as: alice, body: { card_ids: ['riftbound-jinx', 'mtg-bolt'] } });
    assert.strictEqual(added.status, 201, added.text);
    assert.deepStrictEqual({ added: added.json.added, failed: added.json.failed }, { added: 1, failed: ['mtg-bolt'] });
    const renamed = await req('PUT', `/api/lists/${created.json.id}`, { as: alice, body: { game: 'riftbound' } });
    assert.strictEqual(renamed.status, 200, renamed.text);
    const unknown = await req('POST', '/api/lists', { as: alice, body: { name: 'Chess', game: 'chess' } });
    assert.strictEqual(unknown.status, 400, unknown.text);
  });

  console.log(`listsbulk.test.js: ${passCount} cases passed`);
}

runTests()
  .then(async () => { await srv.stop(); await harness.cleanup(db, tmp); process.exit(0); })
  .catch(async (err) => {
    console.error(err.stack || err.message);
    if (srv) console.error(`--- server log (tail) ---\n${srv.tail()}`);
    try { if (srv) await srv.stop(); } catch { /* already down */ }
    await harness.cleanup(db, tmp);
    process.exit(1);
  });
