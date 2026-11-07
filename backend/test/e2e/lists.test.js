// Card lists end to end (routes/lists.js): CRUD with ownership isolation
// between two users, owned/missing with mixed currencies, deck -> missing list,
// add a deck to the collection, used-in-decks, and the filtered CSV export.
// Every card is seeded into card_cache, so nothing here reaches a provider.
// A fresh database would otherwise run a full TCGCSV sync at boot.
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-lists-test-${process.pid}-`));
const tmpDb = path.join(tmpDir, 'bindarr.db');
process.env.DB_PATH = tmpDb;
const port = '3046';
const base = `http://localhost:${port}`;

const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server on port ${port} did not start in time`);
}

async function waitForAdmin() {
  for (let i = 0; i < 150; i++) {
    try {
      const admin = await db.get(`SELECT id FROM users WHERE username = ?`, ['admin']);
      if (admin) return admin.id;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Database did not initialize in time');
}

async function createMember(username) {
  const { lastID } = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [username, 'unused', crypto.randomBytes(16).toString('hex')]
  );
  return lastID;
}

async function sessionHeaders(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [token, userId, new Date(Date.now() + 86400000).toISOString()]);
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

const card = (id, name, game, price, currency, extra = {}) => db.run(
  `INSERT INTO card_cache (id, name, game, set_id, set_name, number, price_trend, price_currency, supertype, language, printed_name)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, name, game, extra.set_id || 'set1', extra.set_name || 'Set One', extra.number || '1', price, currency,
    extra.supertype || 'Card', extra.language || 'English', extra.printed_name || null]
);
const own = (userId, cardId, game, { condition = 'Near Mint', language = 'English' } = {}) => db.run(
  `INSERT INTO collection (card_id, user_id, quantity, condition, language, game, list_type) VALUES (?, ?, 1, ?, ?, ?, 'collection')`,
  [cardId, userId, condition, language, game]
).then(r => r.lastID);

function check(name, fn) {
  return fn().then(() => console.log(`PASS: ${name}`), err => {
    console.error(`FAIL: ${name} -`, err.message);
    throw err;
  });
}

async function runTests() {
  const server = spawn('node', [path.join(projectRoot, 'backend/src/server.js')], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb, HTTPS_PORT: '' }
  });

  try {
    await waitForServer();
    await waitForAdmin();
    const aliceId = await createMember('alice');
    const bobId = await createMember('bob');
    const A = await sessionHeaders(aliceId);
    const B = await sessionHeaders(bobId);
    const api = (headers) => async (method, url, body) => {
      const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* csv */ }
      return { status: res.status, json, text };
    };
    const alice = api(A);
    const bob = api(B);

    await card('mtg-bolt-a', 'Lightning Bolt', 'mtg', 2.5, 'USD', { set_id: 'mtg-m10', number: '146' });
    await card('mtg-bolt-b', 'Lightning Bolt', 'mtg', 1, 'USD', { set_id: 'mtg-2ed', number: '161' });
    await card('mtg-counter', 'Counterspell', 'mtg', 3, 'USD');
    await card('mtg-unpriced', 'Mystery Card', 'mtg', null, 'USD');
    await card('tcgdex-de-glurak', 'Charizard', 'pokemon', 10, 'EUR', { language: 'German', printed_name: 'Glurak' });

    // Alice owns one M10 bolt and one Revised-era bolt (another printing).
    const boltEntry = await own(aliceId, 'mtg-bolt-a', 'mtg');
    const otherBoltEntry = await own(aliceId, 'mtg-bolt-b', 'mtg', { condition: 'Heavily Played' });
    const bobEntry = await own(bobId, 'mtg-counter', 'mtg');

    let list;
    await check('F9-TC1', async () => {
      // Create, validate, add, merge.
      assert.strictEqual((await alice('POST', '/api/lists', { name: '  ' })).status, 400);
      assert.strictEqual((await alice('POST', '/api/lists', { name: 'x', kind: 'shopping' })).status, 400);
      assert.strictEqual((await alice('POST', '/api/lists', { name: 'x', game: 'chess' })).status, 400);
      const created = await alice('POST', '/api/lists', { name: 'Buylist', kind: 'buylist' });
      assert.strictEqual(created.status, 201);
      list = created.json;
      assert.strictEqual(list.kind, 'buylist');
      assert.strictEqual(list.game, null);

      for (const bad of [0, 10000, 2.5, '3x', -1]) {
        const r = await alice('POST', `/api/lists/${list.id}/items`, { card_id: 'mtg-bolt-a', quantity_wanted: bad });
        assert.strictEqual(r.status, 400, `quantity ${bad} must be refused`);
      }
      assert.strictEqual((await alice('POST', `/api/lists/${list.id}/items`, { card_id: 'mtg-bolt-a', quantity_wanted: 2 })).status, 201);
      const merged = await alice('POST', `/api/lists/${list.id}/items`, { card_id: 'mtg-bolt-a', quantity_wanted: 2 });
      assert.strictEqual(merged.json.quantity_wanted, 4, 'adding an existing card merges quantities');
      assert.strictEqual((await alice('POST', `/api/lists/${list.id}/items`, { card_id: 'tcgdex-de-glurak', quantity_wanted: 2 })).status, 201);
      assert.strictEqual((await alice('POST', `/api/lists/${list.id}/items`, { card_id: 'mtg-unpriced' })).status, 201);
      const rows = await db.all(`SELECT card_id FROM card_list_items WHERE list_id = ?`, [list.id]);
      assert.strictEqual(rows.length, 3, 'unique (list_id, card_id)');

      // A game-scoped list refuses other games' cards.
      const mtgOnly = (await alice('POST', '/api/lists', { name: 'MTG wants', game: 'mtg' })).json;
      assert.strictEqual((await alice('POST', `/api/lists/${mtgOnly.id}/items`, { card_id: 'tcgdex-de-glurak' })).status, 400);
      assert.strictEqual((await alice('DELETE', `/api/lists/${mtgOnly.id}`)).status, 200);
    });

    await check('F9-TC2', async () => {
      // Owned vs missing: exact, then any printing; per-currency money, unknown prices left out.
      let detail = (await alice('GET', `/api/lists/${list.id}`)).json;
      const boltItem = detail.items.find(i => i.card_id === 'mtg-bolt-a');
      assert.strictEqual(boltItem.owned, 1);
      assert.strictEqual(boltItem.missing, 3);
      assert.deepStrictEqual(detail.summary.missing_value, { USD: 7.5, EUR: 20 });
      assert.strictEqual(detail.summary.unpriced, 1);
      assert.strictEqual(detail.items.find(i => i.card_id === 'mtg-unpriced').missing_value, null);

      assert.strictEqual((await alice('PUT', `/api/lists/${list.id}/items/${boltItem.id}`, { any_printing: true })).status, 200);
      detail = (await alice('GET', `/api/lists/${list.id}`)).json;
      assert.strictEqual(detail.items.find(i => i.id === boltItem.id).owned, 2, 'another printing counts');
      await alice('PUT', `/api/lists/${list.id}/items/${boltItem.id}`, { condition_min: 'Lightly Played' });
      detail = (await alice('GET', `/api/lists/${list.id}`)).json;
      assert.strictEqual(detail.items.find(i => i.id === boltItem.id).owned, 1, 'a Heavily Played copy is below the minimum');
      assert.strictEqual((await alice('PUT', `/api/lists/${list.id}/items/${boltItem.id}`, { quantity_wanted: 0 })).status, 400);

      const index = (await alice('GET', '/api/lists')).json;
      assert.strictEqual(index.length, 1);
      assert.strictEqual(index[0].summary.items, 3);
    });

    await check('F9-TC3', async () => {
      // Bob can neither see nor change Alice's list or its items.
      const item = (await db.get(`SELECT id FROM card_list_items WHERE list_id = ? LIMIT 1`, [list.id]));
      assert.deepStrictEqual((await bob('GET', '/api/lists')).json, []);
      assert.strictEqual((await bob('GET', `/api/lists/${list.id}`)).status, 404);
      assert.strictEqual((await bob('PUT', `/api/lists/${list.id}`, { name: 'pwned' })).status, 404);
      assert.strictEqual((await bob('POST', `/api/lists/${list.id}/items`, { card_id: 'mtg-counter' })).status, 404);
      assert.strictEqual((await bob('PUT', `/api/lists/${list.id}/items/${item.id}`, { quantity_wanted: 9 })).status, 404);
      assert.strictEqual((await bob('DELETE', `/api/lists/${list.id}/items/${item.id}`)).status, 404);
      assert.strictEqual((await bob('DELETE', `/api/lists/${list.id}`)).status, 404);
      // An item id from Alice's list cannot be edited through Bob's own list either.
      const bobList = (await bob('POST', '/api/lists', { name: 'Bob' })).json;
      assert.strictEqual((await bob('PUT', `/api/lists/${bobList.id}/items/${item.id}`, { quantity_wanted: 9 })).status, 404);
      assert.strictEqual((await bob('DELETE', `/api/lists/${bobList.id}/items/${item.id}`)).status, 404);
      const after = await db.get(`SELECT name FROM card_lists WHERE id = ?`, [list.id]);
      assert.strictEqual(after.name, 'Buylist');
      assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM card_list_items WHERE list_id = ?`, [list.id])).n, 3);
      assert.strictEqual((await db.get(`SELECT quantity_wanted FROM card_list_items WHERE id = ?`, [item.id])).quantity_wanted !== 9, true);
      // Unauthenticated is refused at the gate.
      assert.strictEqual((await fetch(`${base}/api/lists`)).status, 401);
    });

    // A precon decklist: 4 bolts (Alice owns 1 of that printing), 2 counterspells (owns 0).
    const deckId = (await db.run(`INSERT INTO decks (user_id, name, game) VALUES (?, 'Izzet Precon', 'mtg')`, [aliceId])).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'mtg-bolt-a', 4), (?, 'mtg-counter', 2)`, [deckId, deckId]);

    let missingListId;
    await check('F9-TC4', async () => {
      // Deck -> missing list, then rebuilt in place after buying.
      assert.strictEqual((await bob('POST', `/api/decks/${deckId}/missing-list`)).status, 404);
      const first = await alice('POST', `/api/decks/${deckId}/missing-list`);
      assert.strictEqual(first.status, 201);
      assert.strictEqual(first.json.copies, 5);
      missingListId = first.json.list_id;
      const items = await db.all(`SELECT card_id, quantity_wanted FROM card_list_items WHERE list_id = ? ORDER BY card_id`, [missingListId]);
      assert.deepStrictEqual(items, [{ card_id: 'mtg-bolt-a', quantity_wanted: 3 }, { card_id: 'mtg-counter', quantity_wanted: 2 }]);
      const meta = await db.get(`SELECT kind, deck_id, game FROM card_lists WHERE id = ?`, [missingListId]);
      assert.deepStrictEqual(meta, { kind: 'missing', deck_id: deckId, game: 'mtg' });

      await own(aliceId, 'mtg-counter', 'mtg');
      await own(aliceId, 'mtg-counter', 'mtg');
      const again = await alice('POST', `/api/decks/${deckId}/missing-list`);
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.json.list_id, missingListId, 'the same list is updated');
      const now = await db.all(`SELECT card_id, quantity_wanted FROM card_list_items WHERE list_id = ?`, [missingListId]);
      assert.deepStrictEqual(now, [{ card_id: 'mtg-bolt-a', quantity_wanted: 3 }]);
    });

    await check('F9-TC5', async () => {
      // Add the whole deck to the collection, into a chosen container, in one go.
      const loc = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Precon Box', 'Box', ?)`, [aliceId])).lastID;
      await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 100)`, [loc]);
      const bobLoc = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Bob Box', 'Box', ?)`, [bobId])).lastID;

      const before = (await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [aliceId])).n;
      assert.strictEqual((await bob('POST', `/api/decks/${deckId}/add-to-collection`, {})).status, 404);
      assert.strictEqual((await alice('POST', `/api/decks/${deckId}/add-to-collection`, { location_id: bobLoc })).status, 400);
      assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [aliceId])).n, before, 'a refused add writes nothing');

      const res = await alice('POST', `/api/decks/${deckId}/add-to-collection`, { location_id: loc });
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(res.json.cards, 2);
      assert.strictEqual(res.json.copies, 6);
      const added = await db.all(`SELECT card_id, quantity, location_id FROM collection WHERE user_id = ? AND location_id = ?`, [aliceId, loc]);
      assert.strictEqual(added.length, 6, 'one row per copy, like every add');
      assert.ok(added.every(r => r.quantity === 1));
      assert.strictEqual(added.filter(r => r.card_id === 'mtg-bolt-a').length, 4);

      // Now owned: the missing list rebuilds empty.
      await alice('POST', `/api/decks/${deckId}/missing-list`);
      assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM card_list_items WHERE list_id = ?`, [missingListId])).n, 0);
    });

    await check('F9-TC6', async () => {
      // Used in decks: exact printing and other printings of the same name, the user's decks only.
      const bobDeck = (await db.run(`INSERT INTO decks (user_id, name, game) VALUES (?, 'Bob Burn', 'mtg')`, [bobId])).lastID;
      await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'mtg-bolt-a', 4)`, [bobDeck]);
      const second = (await db.run(`INSERT INTO decks (user_id, name, game) VALUES (?, 'Old Burn', 'mtg')`, [aliceId])).lastID;
      await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'mtg-bolt-b', 3)`, [second]);

      const used = (await alice('GET', '/api/cards/mtg-bolt-a/decks')).json;
      assert.deepStrictEqual(used.map(d => [d.name, d.exact_qty, d.other_printings_qty]), [
        ['Izzet Precon', 4, 0],
        ['Old Burn', 0, 3],
      ]);
      assert.deepStrictEqual((await alice('GET', '/api/cards/mtg-unpriced/decks')).json, []);
    });

    await check('F9-TC7', async () => {
      // Filtered export: exactly the rows sent, in that order, same CSV columns as the full export.
      const res = await alice('POST', '/api/export', { entry_ids: [otherBoltEntry, boltEntry, bobEntry, boltEntry] });
      assert.strictEqual(res.status, 200);
      const lines = res.text.split('\n');
      const full = (await fetch(`${base}/api/export`, { headers: A }).then(r => r.text())).split('\n');
      assert.strictEqual(lines[0], full[0], 'same header as the full export');
      assert.strictEqual(lines.length, 3, 'two of Alice\'s rows, Bob\'s dropped, duplicates collapsed');
      assert.ok(lines[1].startsWith('"mtg-bolt-b"') && lines[1].includes('"Heavily Played"'));
      assert.ok(lines[2].startsWith('"mtg-bolt-a"'));
      assert.strictEqual((await alice('POST', '/api/export', { entry_ids: [] })).status, 400);
      assert.strictEqual((await bob('POST', '/api/export', { entry_ids: [boltEntry] })).text, '', 'another user\'s rows export as nothing');
    });

    await check('F9-TC8', async () => {
      // Deleting a list cascades its items; deleting a deck keeps its missing list.
      await db.run(`DELETE FROM decks WHERE id = ?`, [deckId]);
      assert.strictEqual((await db.get(`SELECT deck_id FROM card_lists WHERE id = ?`, [missingListId])).deck_id, null);
      assert.strictEqual((await alice('DELETE', `/api/lists/${list.id}`)).status, 200);
      assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM card_list_items WHERE list_id = ?`, [list.id])).n, 0);
    });
  } finally {
    try { server.kill('SIGKILL'); } catch { /* gone */ }
    try { await new Promise(resolve => db.dbConnection.close(() => resolve())); } catch { /* closed */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* locked */ }
  }
}

runTests().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
