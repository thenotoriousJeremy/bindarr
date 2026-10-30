// Sealed product "recipes": a reusable template of guaranteed components
// (specific cards, and/or sub-products) attached to a purchase by product
// identity, auto-applied the first time a unit is marked opened.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-sealedtemplates-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');

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
    ['tmpl-alice', db.hashPassword('x'), 'admin', `share-a-${process.pid}`]
  )).lastID;
  const bob = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['tmpl-bob', db.hashPassword('x'), 'admin', `share-b-${process.pid}`]
  )).lastID;

  const base = await startApp(new Map([[alice, { id: alice }], [bob, { id: bob }]]));
  const asUser = (userId) => ({ 'Content-Type': 'application/json', 'x-user-id': String(userId) });

  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
     VALUES ('promo-1', 'Guaranteed Promo', 'Pok\u00e9mon', '[]', '[]', 'Promo', 'bnb', 'Build & Battle', 'P1', '', 5, 'pokemon')`
  );

  // A Build & Battle Box: 1 guaranteed promo card + 4 Booster Packs + 1 Precon Deck.
  let res = await fetch(`${base}/api/sealed/templates`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({
      product_name: 'Build & Battle Box', game: 'pokemon',
      components: [
        { component_type: 'card', quantity: 1, card_id: 'promo-1' },
        { component_type: 'product', quantity: 4, product_name: 'Booster Pack', sealed_type: 'Booster Pack', game: 'pokemon', expected_cards: 10 },
        { component_type: 'product', quantity: 1, product_name: 'Precon Deck', sealed_type: 'Starter Deck', game: 'pokemon', expected_cards: 60 },
      ],
    }),
  });
  assert.strictEqual(res.status, 201, `creating a template must succeed, got ${res.status}`);
  const { template } = await res.json();
  assert.strictEqual(template.components.length, 3);
  console.log('PASS: a template saves card and product components together');

  // A purchase of the same product name auto-attaches the template.
  res = await fetch(`${base}/api/sealed/purchases`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ product_name: 'Build & Battle Box', game: 'pokemon', quantity: 1, unit_price: 29.99, expected_cards: 101 }),
  });
  assert.strictEqual(res.status, 201);
  const { purchase } = await res.json();
  assert.strictEqual(purchase.template_id, template.id, 'a purchase of the same product must auto-attach the matching template');
  console.log('PASS: a new purchase of a known product auto-attaches its recipe');

  const [unit] = await db.all(`SELECT * FROM sealed_units WHERE purchase_id = ?`, [purchase.id]);

  const originalAdd = await fetch(`${base}/api/collection`, {
    method: 'POST', headers: asUser(alice), body: JSON.stringify({ card_id: 'promo-1' }),
  });
  assert.strictEqual(originalAdd.status, 200);
  const originalCard = await originalAdd.json();

  // Opening the unit applies every component exactly once.
  res = await fetch(`${base}/api/sealed/units/${unit.id}/open`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: true }),
  });
  assert.strictEqual(res.status, 200, 'opening a unit with a recipe must succeed');
  const opened1 = await res.json();
  assert.strictEqual(opened1.applied.length, 3, 'opening must report the components it applied');

  const linkedPromo = await db.get(`SELECT * FROM collection WHERE card_id = 'promo-1' AND user_id = ? AND sealed_unit_id = ?`, [alice, unit.id]);
  assert.ok(linkedPromo, 'the guaranteed card component must be added to the collection');
  assert.strictEqual(linkedPromo.sealed_unit_id, unit.id, 'the guaranteed card must be linked to the unit it came from');
  assert.ok(Math.abs(linkedPromo.purchase_price - (29.99 / 101)) < 0.000001,
    'guaranteed cards must receive their share of the parent cost alongside generated sealed products');

  res = await fetch(`${base}/api/collection/bulk`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ entry_ids: [linkedPromo.id], action: 'delete' }),
  });
  assert.strictEqual(res.status, 200, 'deleting the duplicate recipe card must succeed');

  const subPurchases = await db.all(`SELECT * FROM sealed_purchases WHERE source_unit_id = ?`, [unit.id]);
  assert.strictEqual(subPurchases.length, 2, 'both product components must become their own sealed purchases');
  const boosterPurchase = subPurchases.find(p => p.product_name === 'Booster Pack');
  const preconPurchase = subPurchases.find(p => p.product_name === 'Precon Deck');
  await db.run(`UPDATE sealed_purchases SET set_name = CASE id WHEN ? THEN ? WHEN ? THEN ? END WHERE id IN (?, ?)`,
    [boosterPurchase.id, 'Booster Expansion', preconPurchase.id, 'Deck Expansion', boosterPurchase.id, preconPurchase.id]);
  const purchasesResponse = await fetch(`${base}/api/sealed/purchases`, { headers: asUser(alice) });
  const { purchases: listedPurchases } = await purchasesResponse.json();
  const listedParent = listedPurchases.find(row => row.id === purchase.id);
  assert.deepStrictEqual(new Set(listedParent.expansions), new Set(['Build & Battle', 'Booster Expansion', 'Deck Expansion']),
    'a sealed box must expose its own and contained card/product expansions for filtering');
  assert.strictEqual(boosterPurchase.quantity, 4, 'the booster sub-purchase must carry the component quantity');
  assert.strictEqual(boosterPurchase.expected_cards, 10, 'the spawned pack must inherit its configured expected-card limit');
  assert.ok(Math.abs(boosterPurchase.unit_price - (29.99 / 101 * 10)) < 0.000001,
    'each booster unit must receive cost for its expected cards');
  assert.ok(Math.abs(preconPurchase.unit_price - (29.99 / 101 * 60)) < 0.000001,
    'each spawned product unit must receive cost for its expected cards');
  const boosterUnits = await db.all(`SELECT * FROM sealed_units WHERE purchase_id = ?`, [boosterPurchase.id]);
  assert.strictEqual(boosterUnits.length, 4, 'the booster sub-purchase must get one sealed_unit per quantity');
  console.log('PASS: opening a unit auto-creates its card and sub-product components');

  // Re-sealing and re-opening must not duplicate anything.
  await fetch(`${base}/api/sealed/units/${unit.id}/open`, { method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: false }) });
  res = await fetch(`${base}/api/sealed/units/${unit.id}/open`, { method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: true }) });
  const opened2 = await res.json();
  assert.strictEqual(opened2.applied, null, 'a second opening must not re-apply components that were already applied');
  const cardsAfter = await db.all(`SELECT * FROM collection WHERE card_id = 'promo-1' AND user_id = ?`, [alice]);
  assert.strictEqual(cardsAfter.length, 1, 'the guaranteed card must not be duplicated on a second open');
  const subPurchasesAfter = await db.all(`SELECT * FROM sealed_purchases WHERE source_unit_id = ?`, [unit.id]);
  assert.strictEqual(subPurchasesAfter.length, 2, 'sub-purchases must not be duplicated on a second open');
  assert.strictEqual(subPurchasesAfter.find(p => p.product_name === 'Booster Pack').unit_price, boosterPurchase.unit_price,
    'reopening must retain existing child cost allocations');

  await db.run(`DELETE FROM sealed_purchases WHERE id = ?`, [boosterPurchase.id]);
  await fetch(`${base}/api/sealed/units/${unit.id}/open`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: false }),
  });
  res = await fetch(`${base}/api/sealed/units/${unit.id}/open`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: true }),
  });
  const reopenedWithMissingChild = await res.json();
  assert.ok(reopenedWithMissingChild.applied?.some(c => c.product_name === 'Booster Pack'),
    'reopening must recreate a missing generated child product');
  const restoredChildren = await db.all(`SELECT * FROM sealed_purchases WHERE source_unit_id = ?`, [unit.id]);
  assert.strictEqual(restoredChildren.length, 2, 'reopening must restore only the missing child, without duplicating existing children');
  const restoredBooster = restoredChildren.find(p => p.product_name === 'Booster Pack');
  assert.strictEqual(restoredBooster.quantity, 4, 'the restored child must have the template quantity');
  assert.ok(Math.abs(restoredBooster.unit_price - (29.99 / 101 * 10)) < 0.000001,
    'the restored child must receive its allocated per-unit cost');

  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
     VALUES ('promo-2', 'Second Test Card', 'Pok\u00e9mon', '[]', '[]', 'Common', 'bnb', 'Build & Battle', 'P2', '', 10, 'pokemon'),
            ('promo-3', 'Third Test Card', 'Pok\u00e9mon', '[]', '[]', 'Common', 'bnb', 'Build & Battle', 'P3', '', 20, 'pokemon'),
            ('promo-4', 'Fourth Test Card', 'Pok\u00e9mon', '[]', '[]', 'Common', 'bnb', 'Build & Battle', 'P4', '', 15, 'pokemon'),
            ('promo-5', 'Fifth Test Card', 'Pok\u00e9mon', '[]', '[]', 'Common', 'bnb', 'Build & Battle', 'P5', '', 12, 'pokemon')`
  );
  const linkedEntries = [{ id: originalCard.id }];
  for (const cardId of ['promo-2', 'promo-3', 'promo-4', 'promo-5']) {
    const addResponse = await fetch(`${base}/api/collection`, {
      method: 'POST', headers: asUser(alice), body: JSON.stringify({ card_id: cardId, quantity: cardId === 'promo-2' ? 2 : 1 }),
    });
    assert.strictEqual(addResponse.status, 200);
    const added = await addResponse.json();
    linkedEntries.push(...added.ids.map(id => ({ id })));
  }
  assert.strictEqual(linkedEntries.length, 6, 'the test must select all six original cards');
  res = await fetch(`${base}/api/collection/bulk`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ entry_ids: linkedEntries.map(row => row.id), action: 'link_sealed_unit', value: { unit_id: unit.id, total: 29.99, method: 'equal' } }),
  });
  assert.strictEqual(res.status, 200, 'linking all original cards from the sealed page must succeed');
  const costLinkedRows = await db.all(`SELECT * FROM collection WHERE sealed_unit_id = ? AND user_id = ?`, [unit.id, alice]);
  assert.strictEqual(costLinkedRows.length, 6, 'all six original cards must be linked after deleting the recipe duplicate');
  assert.ok(costLinkedRows.some(row => row.id === linkedEntries[0].id) && costLinkedRows.some(row => row.id === linkedEntries[5].id),
    'linking the original cards must stamp the opened unit after deleting the recipe duplicates');
  assert.ok(costLinkedRows.every(row => row.purchase_price >= 0.28 && row.purchase_price <= 0.30),
    'relinking six original cards must allocate only their card-equivalent share');
  const childUnitCost = await db.get(
    `SELECT SUM(p.unit_price * p.quantity) AS total FROM sealed_purchases p WHERE p.source_unit_id = ?`, [unit.id]
  );
  assert.ok(Math.abs(costLinkedRows.reduce((sum, row) => sum + row.purchase_price * row.quantity, 0) + childUnitCost.total - 29.99) < 0.000001,
    'collection-page linking must conserve the parent sealed product cost across linked cards and child products');
  console.log('PASS: collection-page linking updates purchase prices and links cards');

  const boosterUnit = (await db.all(`SELECT id FROM sealed_units WHERE purchase_id = ?`, [restoredBooster.id]))[0];
  await db.run(`UPDATE sealed_purchases SET expected_cards = 1 WHERE id = ?`, [restoredBooster.id]);
  res = await fetch(`${base}/api/collection/bulk`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ entry_ids: linkedEntries.map(row => row.id), action: 'set_sealed_unit', value: boosterUnit.id }),
  });
  assert.strictEqual(res.status, 409, 'cards linked to one product must not silently move to another');
  assert.match((await res.json()).error, /already linked to another sealed product/i,
    'the conflict response must explain why linking was rejected');
  const preservedLinks = await db.all(
    `SELECT id, sealed_unit_id FROM collection WHERE id IN (${linkedEntries.map(() => '?').join(',')})`,
    linkedEntries.map(row => row.id)
  );
  assert.ok(preservedLinks.every(row => row.sealed_unit_id === unit.id), 'rejecting a relink must preserve the original product links');
  res = await fetch(`${base}/api/collection/${linkedEntries[0].id}`, {
    method: 'PUT', headers: asUser(alice),
    body: JSON.stringify({ sealed_unit_id: boosterUnit.id }),
  });
  assert.strictEqual(res.status, 409, 'direct collection edits must also reject moving a card between products');
  console.log('PASS: cards already linked to a sealed product produce a warning and keep their original link');

  // Individually-added packs can be linked to the specific box they came from,
  // allowing different boxes of the same product to have different contents.
  const variableParent = await fetch(`${base}/api/sealed/purchases`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ product_name: 'Variable Contents Box', game: 'pokemon', quantity: 1, unit_price: 100, expected_cards: 100 }),
  }).then(r => r.json());
  const variableParentUnit = (await db.get(`SELECT id FROM sealed_units WHERE purchase_id = ?`, [variableParent.purchase.id])).id;
  await fetch(`${base}/api/sealed/units/${variableParentUnit}/open`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: true }),
  });
  const variablePack = await fetch(`${base}/api/sealed/purchases`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ product_name: 'Variable Booster Pack', game: 'pokemon', quantity: 2, unit_price: 7, expected_cards: 10 }),
  }).then(r => r.json());
  const variablePackUnit = (await db.get(`SELECT id FROM sealed_units WHERE purchase_id = ?`, [variablePack.purchase.id])).id;
  await fetch(`${base}/api/sealed/units/${variablePackUnit}/open`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ opened: true }),
  });
  res = await fetch(`${base}/api/sealed/purchases/${variablePack.purchase.id}/source-unit`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ source_unit_id: variableParentUnit }),
  });
  assert.strictEqual(res.status, 200, 'a sealed pack purchase must link to the specific opened box unit it came from');
  assert.strictEqual((await res.json()).unit_price, 10, 'a 10-card pack from a 100-card box must receive 10% of the box cost');

  const secondVariablePack = await fetch(`${base}/api/sealed/purchases`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ product_name: 'Second Variable Pack', game: 'pokemon', quantity: 1, unit_price: 9, expected_cards: 10 }),
  }).then(r => r.json());
  res = await fetch(`${base}/api/sealed/purchases/${secondVariablePack.purchase.id}/source-unit`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ source_unit_id: variableParentUnit }),
  });
  assert.strictEqual(res.status, 200);
  const repricedPacks = await db.all(
    `SELECT id, unit_price FROM sealed_purchases WHERE id IN (?, ?) ORDER BY id`,
    [variablePack.purchase.id, secondVariablePack.purchase.id]
  );
  assert.ok(repricedPacks.every(p => Math.abs(p.unit_price - 10) < 0.000001),
    'linking another pack must allocate cost by each pack card count over the box card count');

  const listedVariablePack = (await fetch(`${base}/api/sealed/purchases`, { headers: asUser(alice) })
    .then(r => r.json())).purchases.find(p => p.id === variablePack.purchase.id);
  assert.strictEqual(listedVariablePack.source_unit_id, variableParentUnit);
  assert.strictEqual(listedVariablePack.source_product_name, 'Variable Contents Box');
  assert.strictEqual(listedVariablePack.source_unit_number, 1);

  res = await fetch(`${base}/api/sealed/purchases/${variableParent.purchase.id}/source-unit`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ source_unit_id: variablePackUnit }),
  });
  assert.strictEqual(res.status, 400, 'linking a box to one of its contents must be rejected to prevent cycles');
  res = await fetch(`${base}/api/sealed/purchases/${variablePack.purchase.id}/source-unit`, {
    method: 'PUT', headers: asUser(bob), body: JSON.stringify({ source_unit_id: variableParentUnit }),
  });
  assert.strictEqual(res.status, 404, 'users must not link another user\'s sealed purchase');

  const unopenedParent = await fetch(`${base}/api/sealed/purchases`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ product_name: 'Unopened Parent Box', game: 'pokemon', quantity: 1 }),
  }).then(r => r.json());
  const unopenedParentUnit = (await db.get(`SELECT id FROM sealed_units WHERE purchase_id = ?`, [unopenedParent.purchase.id])).id;
  res = await fetch(`${base}/api/sealed/purchases/${variablePack.purchase.id}/source-unit`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ source_unit_id: unopenedParentUnit }),
  });
  assert.strictEqual(res.status, 400, 'a source relationship must point to an opened box unit');
  res = await fetch(`${base}/api/sealed/purchases/${variablePack.purchase.id}/source-unit`, {
    method: 'PUT', headers: asUser(alice), body: JSON.stringify({ source_unit_id: null }),
  });
  assert.strictEqual(res.status, 200, 'a sealed pack can be unlinked from its source box');
  assert.strictEqual((await res.json()).unit_price, 7, 'unlinking must restore the pack purchase price from before it was linked');
  const remainingPack = await db.get(`SELECT unit_price FROM sealed_purchases WHERE id = ?`, [secondVariablePack.purchase.id]);
  assert.strictEqual(remainingPack.unit_price, 10, 'remaining packs must retain their card-count share of the box cost');
  console.log('PASS: manually linking sealed packs to opened box units supports variable contents safely');

  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
     VALUES ('promo-4', 'Fourth Test Card', 'Pok\u00e9mon', '[]', '[]', 'Common', 'bnb', 'Build & Battle', 'P4', '', 1, 'pokemon')`
  );
  const overCapEntry = await db.run(
    `INSERT INTO collection (card_id, user_id, quantity) VALUES ('promo-4', ?, 2)`, [alice]
  );
  res = await fetch(`${base}/api/collection/bulk`, {
    method: 'POST', headers: asUser(alice),
    body: JSON.stringify({ entry_ids: [overCapEntry.lastID], action: 'set_sealed_unit', value: boosterUnit.id }),
  });
  assert.strictEqual(res.status, 400, 'linking beyond a pack expected-card limit must be rejected');
  console.log('PASS: pack expected-card limits prevent linking too many cards');
  console.log('PASS: re-opening a unit is idempotent \u2014 components are applied exactly once');

  // User isolation: Bob cannot see or match against Alice's template.
  res = await fetch(`${base}/api/sealed/templates/match?product_name=${encodeURIComponent('Build & Battle Box')}`, { headers: asUser(bob) });
  const bobMatch = await res.json();
  assert.strictEqual(bobMatch.template, null, 'templates must not match across users');

  res = await fetch(`${base}/api/sealed/templates`, { headers: asUser(bob) });
  assert.strictEqual((await res.json()).templates.length, 0, 'Bob must not see Alice\'s templates');
  console.log('PASS: templates are isolated per user');
}

main()
  .then(() => cleanup())
  .catch(async err => {
    console.error('FAIL:', err.stack || err.message);
    await cleanup();
    process.exitCode = 1;
  });
