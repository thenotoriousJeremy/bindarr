// Sealed product purchases: buy N identical units, mark them opened one at a
// time, link a pulled card back to the unit it came from, and make sure deleting
// the purchase never deletes a card the user still owns.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-sealed-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const tcgcsv = require('../src/tcgcsvApi');

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
    ['sealed-alice', db.hashPassword('x'), 'admin', `share-a-${process.pid}`]
  )).lastID;
  const bob = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['sealed-bob', db.hashPassword('x'), 'admin', `share-b-${process.pid}`]
  )).lastID;

  const base = await startApp(new Map([[alice, { id: alice }], [bob, { id: bob }]]));
  const asUser = (userId) => ({ 'Content-Type': 'application/json', 'x-user-id': String(userId) });

  // Create a purchase of 3 identical units (a Build & Battle Box: 4 boosters +
  // a 40-card preconstructed deck, per unit).
  let res = await fetch(`${base}/api/sealed/purchases`, {
    method: 'POST',
    headers: asUser(alice),
    body: JSON.stringify({
      product_name: '30th Celebration Elite Trainer Box', sealed_type: 'Elite Trainer Box',
      game: 'pokemon', store: 'GameStop - Seattle', purchase_date: '2026-09-24',
      unit_price: 89.99, quantity: 3, expected_packs: 4, expected_cards: 40, contents_note: '1 coin',
    }),
  });
  assert.strictEqual(res.status, 201, `creating a purchase must succeed, got ${res.status}`);
  const { purchase } = await res.json();
  assert.strictEqual(purchase.quantity, 3);
  assert.strictEqual(purchase.expected_packs, 4, 'expected_packs must be stored as given');
  assert.strictEqual(purchase.expected_cards, 40, 'expected_cards must be stored as given');
  assert.strictEqual(purchase.contents_note, '1 coin');
  console.log('PASS: a purchase stores its expected contents (packs/cards/note)');

  res = await fetch(`${base}/api/sealed/purchases/${purchase.id}`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ expected_cards: 41 }),
  });
  assert.strictEqual(res.status, 200, 'editing expected_cards must succeed');
  assert.strictEqual((await res.json()).purchase.expected_cards, 41, 'expected_cards must be editable after creation');
  console.log('PASS: expected contents can be edited after creation');

  let units = (await db.all(`SELECT * FROM sealed_units WHERE purchase_id = ?`, [purchase.id]));
  assert.strictEqual(units.length, 3, `quantity 3 must create 3 units, got ${units.length}`);
  assert.ok(units.every(u => u.opened_at == null), 'all units must start sealed');
  console.log('PASS: creating a purchase creates one sealed unit per quantity');

  // Mark one unit opened, then undo it.
  const unitId = units[0].id;
  res = await fetch(`${base}/api/sealed/units/${unitId}/open`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: true }),
  });
  assert.strictEqual(res.status, 200, 'marking a unit opened must succeed');
  let unit = (await res.json()).unit;
  assert.ok(unit.opened_at, 'opened unit must have opened_at set');

  res = await fetch(`${base}/api/sealed/units/${unitId}/open`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: false }),
  });
  unit = (await res.json()).unit;
  assert.strictEqual(unit.opened_at, null, 'undoing must clear opened_at');
  console.log('PASS: a unit\'s opened status can be toggled and undone');

  // Re-open it for the link test.
  await fetch(`${base}/api/sealed/units/${unitId}/open`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: true }),
  });

  // Link a card to the opened unit.
  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
     VALUES ('sv9-1', 'Test Card', 'Pokémon', '[]', '[]', 'Common', 'sv9', 'Set', '1', '', 1, 'pokemon')`
  );
  res = await fetch(`${base}/api/collection`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ card_id: 'sv9-1', sealed_unit_id: unitId }),
  });
  assert.strictEqual(res.status, 200, `adding a linked card must succeed, got ${res.status}`);
  const added = await res.json();
  const entryId = added.id || added.placement?.id || added.insertedIds?.[0];
  const row = await db.get(`SELECT * FROM collection WHERE card_id = 'sv9-1' AND user_id = ?`, [alice]);
  assert.strictEqual(row.sealed_unit_id, unitId, 'the collection row must carry the sealed_unit_id it was linked with');
  console.log('PASS: a card add can be linked to an opened sealed unit');

  // Purchase list reports sealed/opened counts.
  res = await fetch(`${base}/api/sealed/purchases`, { headers: asUser(alice) });
  const { purchases } = await res.json();
  const listed = purchases.find(p => p.id === purchase.id);
  assert.strictEqual(listed.opened_count, 1, `one unit is opened, got ${listed.opened_count}`);
  assert.strictEqual(listed.sealed_count, 2, `two units are still sealed, got ${listed.sealed_count}`);
  console.log('PASS: the purchase list reports sealed vs opened unit counts');

  await db.run(
    `INSERT INTO tcgplayer_catalog (product_id, category_id, group_id, name, number, game)
     VALUES (99001, 3, 7, 'Market Test Booster Box', NULL, 'pokemon')`
  );
  res = await fetch(`${base}/api/sealed/purchases`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ product_id: 99001, product_name: 'Market Test Booster Box', quantity: 2, unit_price: 50 }),
  });
  assert.strictEqual(res.status, 201);
  const marketPurchase = (await res.json()).purchase;
  const realGetPrices = tcgcsv.getPrices;
  try {
    tcgcsv.getPrices = async (categoryId, groupId) => {
      assert.strictEqual(categoryId, 3);
      assert.strictEqual(groupId, 7);
      return [{ productId: 99001, marketPrice: 72.5, midPrice: 70 }];
    };
    res = await fetch(`${base}/api/sealed/purchases/${marketPurchase.id}/refresh-value`, {
      method: 'POST', headers: asUser(alice),
    });
    assert.strictEqual(res.status, 200, 'refresh must fetch the linked product market price');
    const refreshedValue = await res.json();
    assert.strictEqual(refreshedValue.market_value, 72.5);
    assert.strictEqual(refreshedValue.market_value_source, 'tcgcsv');
    const alicePurchases = (await (await fetch(`${base}/api/sealed/purchases`, { headers: asUser(alice) })).json()).purchases;
    const listedMarketPurchase = alicePurchases.find(p => p.id === marketPurchase.id);
    assert.strictEqual(listedMarketPurchase.market_value, 72.5);
    assert.strictEqual(listedMarketPurchase.sealed_count, 2);

    res = await fetch(`${base}/api/sealed/purchases/${marketPurchase.id}`, {
      method: 'PUT', headers: asUser(alice), body: JSON.stringify({ store: 'Local shop' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).purchase.market_value_source, 'tcgcsv',
      'editing unrelated purchase details must preserve the provider value source');

    res = await fetch(`${base}/api/sealed/purchases/${marketPurchase.id}`, {
      method: 'PUT', headers: asUser(alice), body: JSON.stringify({ market_value: 68 }),
    });
    assert.strictEqual(res.status, 200);
    const manualPurchase = (await res.json()).purchase;
    assert.strictEqual(manualPurchase.market_value, 68);
    assert.strictEqual(manualPurchase.market_value_source, 'manual');
    console.log('PASS: sealed market value refreshes from TCGCSV and supports manual override');

    res = await fetch(`${base}/api/sealed/purchases/${marketPurchase.id}/refresh-value`, {
      method: 'POST', headers: asUser(bob),
    });
    assert.strictEqual(res.status, 404, 'another user must not refresh this purchase value');
    console.log('PASS: sealed market-value refresh is scoped to the purchase owner');
  } finally {
    tcgcsv.getPrices = realGetPrices;
  }

  // Delete the purchase: units cascade away, the linked card survives with its
  // link cleared.
  res = await fetch(`${base}/api/sealed/purchases/${purchase.id}`, { method: 'DELETE', headers: asUser(alice) });
  assert.strictEqual(res.status, 200, 'deleting a purchase must succeed');
  units = await db.all(`SELECT * FROM sealed_units WHERE purchase_id = ?`, [purchase.id]);
  assert.strictEqual(units.length, 0, 'units must cascade-delete with their purchase');
  const survivor = await db.get(`SELECT * FROM collection WHERE card_id = 'sv9-1' AND user_id = ?`, [alice]);
  assert.ok(survivor, 'the card itself must survive deleting the purchase it was linked to');
  assert.strictEqual(survivor.sealed_unit_id, null, 'the surviving card must have its sealed_unit_id cleared');
  console.log('PASS: deleting a purchase cascades its units but never deletes a card');

  // User isolation: Bob cannot see, open or delete Alice's purchases.
  res = await fetch(`${base}/api/sealed/purchases`, {
    method: 'POST', headers: asUser(bob),
    body: JSON.stringify({ product_name: 'Bob\'s Booster Box', game: 'pokemon', quantity: 1, unit_price: 100 }),
  });
  const bobPurchase = (await res.json()).purchase;

  res = await fetch(`${base}/api/sealed/purchases`, { headers: asUser(bob) });
  const bobList = (await res.json()).purchases;
  assert.strictEqual(bobList.length, 1, 'Bob must only see his own purchase');
  assert.strictEqual(bobList[0].id, bobPurchase.id);

  res = await fetch(`${base}/api/sealed/purchases/${bobPurchase.id}`, { method: 'DELETE', headers: asUser(alice) });
  assert.strictEqual(res.status, 404, 'Alice must not be able to delete Bob\'s purchase');
  const stillThere = await db.get(`SELECT * FROM sealed_purchases WHERE id = ?`, [bobPurchase.id]);
  assert.ok(stillThere, 'Bob\'s purchase must survive Alice\'s delete attempt');
  console.log('PASS: purchases, units and deletes are isolated per user');
}

main()
  .then(() => cleanup())
  .catch(async err => {
    console.error('FAIL:', err.stack || err.message);
    await cleanup();
    process.exitCode = 1;
  });
