// Sealed product review fixes (#91): a card can only be linked to the user's OWN
// sealed unit, a read never shows another user's purchase, quantities and
// amounts are bounded and validated, error bodies carry no internals, and
// opening a unit never makes a provider call while the write transaction is open.
//
// Real temporary SQLite, two users, every provider entry point stubbed: nothing
// here leaves the machine.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-sealedsecurity-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const cardApi = require('../src/utils/cardApi');
const tcgdexApi = require('../src/tcgdexApi');

// Record every provider-facing call, and whether a transaction was open at the
// time. sealed.js takes withTransaction from the db module when it loads, so the
// wrapper must be installed before the routes are required.
const events = [];
let inTransaction = false;
const realWithTransaction = db.withTransaction;
db.withTransaction = async (fn) => {
  events.push({ kind: 'BEGIN' });
  inTransaction = true;
  try { return await realWithTransaction(fn); }
  finally { inTransaction = false; events.push({ kind: 'END' }); }
};
const providerCall = (name, id) => events.push({ kind: 'provider', name, id, inTransaction });
cardApi.hydrate = async (id) => { providerCall('hydrate', id); };
cardApi.getCardById = async (id) => { providerCall('getCardById', id); return null; };
cardApi.printingInLanguage = async (card) => { providerCall('printingInLanguage', card && card.id); return null; };
tcgdexApi.learnEnglishName = async (card) => { providerCall('learnEnglishName', card && card.id); return card; };

let server;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp(usersById) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = Number(req.headers['x-user-id']);
    req.user = usersById.get(id) || { id, role: 'admin' };
    next();
  });
  app.use('/api', require('../src/routes/sealed'));
  app.use('/api', require('../src/routes/collection'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function main() {
  await db.initDb();

  const alice = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['sec-alice', db.hashPassword('x'), 'admin', `share-a-${process.pid}`]
  )).lastID;
  const bob = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['sec-bob', db.hashPassword('x'), 'admin', `share-b-${process.pid}`]
  )).lastID;

  const base = await startApp(new Map([[alice, { id: alice }], [bob, { id: bob }]]));
  const asUser = (userId) => ({ 'Content-Type': 'application/json', 'x-user-id': String(userId) });
  const call = (method, url, userId, body) => fetch(`${base}/api${url}`, {
    method, headers: asUser(userId), body: body === undefined ? undefined : JSON.stringify(body),
  });

  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
     VALUES ('sec-1', 'Security Card', 'Pokémon', '[]', '[]', 'Common', 'sec', 'Security Set', '1', '', 1, 'pokemon')`
  );

  // Bob's purchase: 3 units, with private details Alice must never see.
  let res = await call('POST', '/sealed/purchases', bob, {
    product_name: 'Bob Secret Box', store: 'Bob Private Store', unit_price: 99.5, quantity: 3, notes: 'bob notes',
  });
  assert.strictEqual(res.status, 201);
  const bobPurchase = (await res.json()).purchase;
  const bobUnits = await db.all(`SELECT id FROM sealed_units WHERE purchase_id = ? ORDER BY id`, [bobPurchase.id]);
  assert.strictEqual(bobUnits.length, 3);

  // --- 1. Alice cannot link a card to Bob's unit through any write path. ---
  res = await call('POST', '/collection', alice, { card_id: 'sec-1', sealed_unit_id: bobUnits[0].id });
  assert.strictEqual(res.status, 404, `POST /collection with another user's unit must 404, got ${res.status}`);
  assert.deepStrictEqual(Object.keys(await res.json()), ['error']);
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [alice])).n, 0,
    'a rejected add must write nothing');
  console.log("PASS: POST /collection rejects another user's sealed_unit_id");

  res = await call('POST', '/collection/bulk-add', alice, { card_ids: ['sec-1', 'sec-1'], sealed_unit_id: bobUnits[0].id });
  const bulk = await res.json();
  assert.strictEqual(bulk.added, 0, "bulk-add must not add any card linked to another user's unit");
  assert.strictEqual(bulk.failed.length, 2);
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM collection WHERE sealed_unit_id IS NOT NULL`)).n, 0);
  console.log("PASS: POST /collection/bulk-add rejects another user's sealed_unit_id");

  res = await call('POST', '/collection', alice, { card_id: 'sec-1' });
  assert.strictEqual(res.status, 200);
  const aliceEntry = (await res.json()).id;
  res = await call('PUT', `/collection/${aliceEntry}`, alice, { sealed_unit_id: bobUnits[0].id });
  assert.strictEqual(res.status, 404, `PUT /collection/:id with another user's unit must 404, got ${res.status}`);
  assert.strictEqual((await db.get(`SELECT sealed_unit_id FROM collection WHERE id = ?`, [aliceEntry])).sealed_unit_id, null);
  console.log("PASS: PUT /collection/:id rejects another user's sealed_unit_id");

  // Her own unit still links fine, and shows her own purchase details.
  res = await call('POST', '/sealed/purchases', alice, { product_name: 'Alice Box', store: 'Alice Store', quantity: 1 });
  const alicePurchase = (await res.json()).purchase;
  const aliceUnit = await db.get(`SELECT id FROM sealed_units WHERE purchase_id = ?`, [alicePurchase.id]);
  res = await call('POST', '/collection', alice, { card_id: 'sec-1', sealed_unit_id: aliceUnit.id });
  assert.strictEqual(res.status, 200, 'linking to your own unit must still succeed');
  const aliceLinked = (await res.json()).id;
  res = await call('PUT', `/collection/${aliceEntry}`, alice, { sealed_unit_id: aliceUnit.id });
  assert.strictEqual(res.status, 200, 'editing a link to your own unit must still succeed');
  await call('PUT', `/collection/${aliceEntry}`, alice, { sealed_unit_id: null });
  console.log('PASS: linking a card to your own sealed unit still works on add and edit');

  // --- 2. A row that already points at Bob's unit (data written before the fix)
  // must not leak Bob's purchase through GET /collection, nor interfere with Bob.
  await db.run(`UPDATE collection SET sealed_unit_id = ? WHERE id = ?`, [bobUnits[0].id, aliceEntry]);
  const extra = (await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, sealed_unit_id, game) VALUES ('sec-1', ?, 1, ?, 'pokemon')`,
    [alice, bobUnits[1].id]
  )).lastID;

  res = await call('GET', '/collection', alice);
  const rows = await res.json();
  const serialized = JSON.stringify(rows);
  for (const secret of ['Bob Secret Box', 'Bob Private Store', 'bob notes', '99.5']) {
    assert.ok(!serialized.includes(secret), `GET /collection must never return another user's sealed data (${secret})`);
  }
  for (const id of [aliceEntry, extra]) {
    const row = rows.find(r => r.entry_id === id);
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith('sealed_')) assert.strictEqual(value, null, `${key} must be null for a link to someone else's unit`);
    }
  }
  const own = rows.find(r => r.entry_id === aliceLinked);
  assert.strictEqual(own.sealed_product_name, 'Alice Box', "the user's own link must still show its purchase");
  assert.strictEqual(own.sealed_unit_id, aliceUnit.id);
  console.log("PASS: GET /collection never returns another user's sealed fields, and still returns your own");

  // Alice's stray links must not block Bob's quantity edit (3 -> 1 needs two
  // removable units; two of his three are "linked" only by Alice's rows).
  res = await call('PUT', `/sealed/purchases/${bobPurchase.id}`, bob, { quantity: 1 });
  assert.strictEqual(res.status, 200, `another user's link must not block a quantity edit, got ${res.status}`);
  console.log("PASS: another user's link cannot block a quantity decrease");

  // ...nor hide Bob's opened unit from his own "link cards" picker.
  res = await call('POST', '/sealed/purchases', bob, { product_name: 'Bob Pack', quantity: 1 });
  const bobPack = (await res.json()).purchase;
  const bobPackUnit = await db.get(`SELECT id FROM sealed_units WHERE purchase_id = ?`, [bobPack.id]);
  await call('PUT', `/sealed/units/${bobPackUnit.id}/open`, bob, { opened: true });
  await db.run(`UPDATE collection SET sealed_unit_id = ? WHERE id = ?`, [bobPackUnit.id, extra]);
  res = await call('GET', '/sealed/units?opened=1&unlinked=1', bob);
  const picker = (await res.json()).units;
  assert.ok(picker.some(u => u.id === bobPackUnit.id), "another user's link must not hide a unit from its owner's picker");
  console.log("PASS: another user's link cannot hide a unit from its owner's picker");

  // --- 3. Bounded quantities and validated amounts. ---
  const expect400 = async (label, method, url, body, userId = alice) => {
    const r = await call(method, url, userId, body);
    assert.strictEqual(r.status, 400, `${label}: expected 400, got ${r.status}`);
    const json = await r.json();
    assert.deepStrictEqual(Object.keys(json), ['error'], `${label}: the error body must carry only { error }`);
  };
  const before = (await db.get(`SELECT COUNT(*) n FROM sealed_units`)).n;
  for (const quantity of [0, -1, 1001, 1e9, 1.5, 'abc']) {
    await expect400(`purchase quantity ${quantity}`, 'POST', '/sealed/purchases', { product_name: 'X', quantity });
  }
  for (const [field, value] of [
    ['unit_price', -1], ['unit_price', 'abc'], ['unit_price', 'Infinity'],
    ['expected_packs', -1], ['expected_packs', 2.5], ['expected_cards', 'x'],
    ['market_value', -5], ['market_value', 'NaN'], ['game', 'yugioh'],
  ]) {
    await expect400(`purchase ${field}=${value}`, 'POST', '/sealed/purchases', { product_name: 'X', [field]: value });
  }
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM sealed_units`)).n, before, 'rejected purchases must write no units');

  res = await call('POST', '/sealed/purchases', alice, { product_name: 'Max Box', quantity: 1000, unit_price: '2.50' });
  assert.strictEqual(res.status, 201, 'a quantity of exactly 1000 is allowed');
  const maxPurchase = (await res.json()).purchase;
  assert.strictEqual(maxPurchase.unit_price, 2.5);
  console.log('PASS: purchase quantity is capped at 1..1000 and amounts/game are validated');

  for (const [field, value] of [['quantity', 1001], ['quantity', 0], ['unit_price', -2], ['expected_cards', 'x'], ['market_value', 'Infinity']]) {
    await expect400(`edit ${field}=${value}`, 'PUT', `/sealed/purchases/${alicePurchase.id}`, { [field]: value });
  }
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM sealed_units WHERE purchase_id = ?`, [alicePurchase.id])).n, 1);
  res = await call('PUT', `/sealed/purchases/${alicePurchase.id}`, alice, { quantity: 4, unit_price: 3 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM sealed_units WHERE purchase_id = ?`, [alicePurchase.id])).n, 4);
  console.log('PASS: purchase edits validate quantity (1..1000) and amounts');

  const component = (extra) => ({ component_type: 'product', product_name: 'Pack', quantity: 1, ...extra });
  await expect400('component quantity 1001', 'POST', '/sealed/templates', { product_name: 'T', components: [component({ quantity: 1001 })] });
  await expect400('component quantity 0', 'POST', '/sealed/templates', { product_name: 'T', components: [component({ quantity: 0 })] });
  await expect400('component game', 'POST', '/sealed/templates', { product_name: 'T', components: [component({ game: 'yugioh' })] });
  await expect400('template game', 'POST', '/sealed/templates', { product_name: 'T', game: 'yugioh', components: [component()] });
  await expect400('recipe total', 'POST', '/sealed/templates', { product_name: 'T', components: [component({ quantity: 600 }), component({ quantity: 600 })] });
  await expect400('component expected_cards', 'POST', '/sealed/templates', { product_name: 'T', components: [component({ expected_cards: -3 })] });
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM sealed_templates WHERE product_name = 'T'`)).n, 0);
  console.log('PASS: recipe component quantities are capped and game/expected_cards validated');

  // --- 4. Opening a unit: provider calls only before the transaction. ---
  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
     VALUES ('tx-promo', 'Tx Promo', 'Pokémon', '[]', '[]', 'Promo', 'sec', 'Security Set', '2', '', 4, 'pokemon')`
  );
  res = await call('POST', '/sealed/templates', alice, {
    product_name: 'Tx Box', components: [
      { component_type: 'card', card_id: 'tx-promo', quantity: 2 },
      { component_type: 'product', product_name: 'Tx Pack', quantity: 3, expected_cards: 10 },
    ],
  });
  assert.strictEqual(res.status, 201);
  res = await call('POST', '/sealed/purchases', alice, { product_name: 'Tx Box', quantity: 1, unit_price: 32 });
  const txPurchase = (await res.json()).purchase;
  const txUnit = await db.get(`SELECT id FROM sealed_units WHERE purchase_id = ?`, [txPurchase.id]);

  events.length = 0;
  res = await call('PUT', `/sealed/units/${txUnit.id}/open`, alice, { opened: true });
  assert.strictEqual(res.status, 200, `opening a unit with a recipe must succeed, got ${res.status}`);
  const provider = events.filter(e => e.kind === 'provider');
  assert.ok(provider.some(e => e.name === 'hydrate' && e.id === 'tx-promo'), 'the recipe card must be hydrated');
  assert.deepStrictEqual(provider.filter(e => e.inTransaction), [], 'no provider call may run inside the open-unit transaction');
  const firstBegin = events.findIndex(e => e.kind === 'BEGIN');
  const lastProvider = events.map(e => e.kind).lastIndexOf('provider');
  assert.ok(firstBegin > lastProvider, 'every provider call must come before BEGIN');
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM collection WHERE sealed_unit_id = ? AND user_id = ?`, [txUnit.id, alice])).n, 2,
    'the recipe cards must still be added, linked to the unit');
  assert.strictEqual((await db.get(`SELECT SUM(quantity) n FROM sealed_purchases WHERE source_unit_id = ?`, [txUnit.id])).n, 3);
  console.log('PASS: opening a unit resolves recipe cards before BEGIN and makes no provider call inside it');

  // All-or-nothing: a recipe card that cannot be resolved fails the open
  // before anything is written.
  res = await call('POST', '/sealed/templates', alice, {
    product_name: 'Broken Box', components: [
      { component_type: 'product', product_name: 'Broken Pack', quantity: 2 },
      { component_type: 'card', card_id: 'not-cached-anywhere', quantity: 1 },
    ],
  });
  assert.strictEqual(res.status, 201);
  res = await call('POST', '/sealed/purchases', alice, { product_name: 'Broken Box', quantity: 1 });
  const brokenPurchase = (await res.json()).purchase;
  const brokenUnit = await db.get(`SELECT id FROM sealed_units WHERE purchase_id = ?`, [brokenPurchase.id]);
  events.length = 0;
  res = await call('PUT', `/sealed/units/${brokenUnit.id}/open`, alice, { opened: true });
  assert.strictEqual(res.status, 404, `an unresolvable recipe card must fail the open, got ${res.status}`);
  assert.deepStrictEqual(Object.keys(await res.json()), ['error']);
  assert.ok(!events.some(e => e.kind === 'BEGIN'), 'a failed resolve must not even start the transaction');
  assert.strictEqual((await db.get(`SELECT opened_at FROM sealed_units WHERE id = ?`, [brokenUnit.id])).opened_at, null);
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM sealed_purchases WHERE source_unit_id = ?`, [brokenUnit.id])).n, 0);
  console.log('PASS: a recipe card that cannot be resolved leaves the unit unopened and nothing written');
}

main()
  .then(() => cleanup())
  .catch(async err => {
    console.error('FAIL:', err.stack || err.message);
    await cleanup();
    process.exitCode = 1;
  });
