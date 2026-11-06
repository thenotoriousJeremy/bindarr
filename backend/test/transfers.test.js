const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-transfer-api-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
let server;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => {
    try { db.dbConnection.close(() => resolve()); } catch { resolve(); }
  });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp(users) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = Number(req.headers['x-user-id']);
    req.user = users.get(id) || { id };
    next();
  });
  app.use('/api', require('../src/routes/sealed'));
  app.use('/api', require('../src/routes/transfers'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function main() {
  await db.initDb();
  const alice = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['transfer-api-alice', 'hash', 'member', `transfer-api-a-${process.pid}`]
  )).lastID;
  const bob = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['transfer-api-bob', 'hash', 'member', `transfer-api-b-${process.pid}`]
  )).lastID;
  const base = await startApp(new Map([[alice, { id: alice }], [bob, { id: bob }]]));
  const headers = userId => ({ 'Content-Type': 'application/json', 'x-user-id': String(userId) });
  const addCard = async (ownerId, id, name, price, isTrade = 0) => {
    await db.run(
      `INSERT INTO card_cache (id, name, printed_name, set_name, number, image_url, game)
       VALUES (?, ?, ?, 'Transfer Test Set', '1', 'test.png', 'pokemon')`,
      [id, name, name]
    );
    return (await db.run(
      `INSERT INTO collection (card_id, user_id, quantity, purchase_price, is_trade)
       VALUES (?, ?, 1, ?, ?)`,
      [id, ownerId, price, isTrade]
    )).lastID;
  };
  const request = async (pathName, userId, method = 'GET', body) => fetch(`${base}${pathName}`, {
    method,
    headers: headers(userId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const assertStatus = async (response, expected, message) => {
    const detail = response.status === expected ? '' : `: ${await response.text()}`;
    assert.strictEqual(response.status, expected, `${message}${detail}`);
  };

  try {
    const aliceCard = await addCard(alice, `transfer-a-${process.pid}`, 'Card A', 0.30);
    const bobCard = await addCard(bob, `transfer-b-${process.pid}`, 'Card B', 0.40, 1);
    const discovery = await request(`/api/transfers/marked/${bob}`);
    assert.strictEqual(discovery.status, 200);
    const discoverJson = await discovery.json();
    assert.deepStrictEqual(discoverJson.cards.map(card => card.entry_id), [bobCard]);
    assert.ok(!('purchase_price' in discoverJson.cards[0]), 'discovery must not reveal private cost basis');
    assert.ok(Object.hasOwn(discoverJson.cards[0], 'rarity'), 'discovery includes rarity for the trade card badge');
    console.log('PASS: trade discovery exposes marked cards only and omits private cost');

    let response = await request('/api/transfers', alice, 'POST', {
      recipient_id: bob,
      transfer_type: 'trade',
      offered_items: [{ type: 'card', id: aliceCard }],
      requested_items: [{ type: 'card', id: bobCard }]
    });
    await assertStatus(response, 201, 'creating trade should succeed');
    let transfer = (await response.json()).transfer;
    assert.strictEqual(transfer.status, 'pending');
    let historyResponse = await request('/api/transfers', bob);
    let bobView = (await historyResponse.json()).transfers.find(item => item.id === transfer.id);
    const aliceSentItem = bobView.items.find(item => item.from_user_id === alice);
    const bobRequestedItem = bobView.items.find(item => item.from_user_id === bob);
    assert.strictEqual(aliceSentItem.purchase_cost, null, "the other user must not see the sender's private cost basis");
    assert.ok(!('purchase_cost' in aliceSentItem.item_snapshot));
    assert.strictEqual(bobRequestedItem.purchase_cost, 0.4, 'a user can see the cost of their own offered item');
    response = await request(`/api/transfers/${transfer.id}/accept`, bob, 'PUT');
    await assertStatus(response, 200, 'accepting trade should succeed');
    transfer = (await response.json()).transfer;
    assert.strictEqual(transfer.status, 'accepted');
    let ownership = await db.all(
      `SELECT c.user_id, c.card_id, c.purchase_price, c.location_id
         FROM collection c WHERE c.card_id IN (?, ?) ORDER BY c.card_id`,
      [`transfer-a-${process.pid}`, `transfer-b-${process.pid}`]
    );
    assert.strictEqual(ownership.find(row => row.card_id === `transfer-a-${process.pid}`).user_id, bob);
    assert.strictEqual(ownership.find(row => row.card_id === `transfer-b-${process.pid}`).user_id, alice);
    assert.strictEqual(ownership.find(row => row.card_id === `transfer-a-${process.pid}`).purchase_price, 0.4);
    assert.strictEqual(ownership.find(row => row.card_id === `transfer-b-${process.pid}`).purchase_price, 0.3);
    assert.ok(ownership.every(row => row.location_id == null), 'received cards must be unsorted');
    assert.ok(transfer.items.every(item => item.item_snapshot.name), 'accepted history keeps card snapshots');
    console.log('PASS: one-for-one trades exchange cost basis and move cards to unsorted collection');

    const aliceUnmarked = await addCard(alice, `counter-a-${process.pid}`, 'Counter Card A', 0.25);
    const bobUnmarked = await addCard(bob, `counter-b-${process.pid}`, 'Counter Card B', 0.15);
    response = await request('/api/transfers', alice, 'POST', {
      recipient_id: bob,
      transfer_type: 'trade',
      offered_items: [{ type: 'card', id: aliceUnmarked }],
      requested_items: []
    });
    assert.strictEqual(response.status, 201);
    const original = (await response.json()).transfer;
    assert.strictEqual(original.items.length, 1, 'offer-only trade proposals preserve the offered item');
    response = await request(`/api/transfers/${original.id}/accept`, bob, 'PUT');
    assert.strictEqual(response.status, 409, 'an offer-only trade must be countered before it can complete');
    assert.strictEqual((await db.get(`SELECT user_id FROM collection WHERE id = ?`, [aliceUnmarked])).user_id, alice);
    response = await request(`/api/transfers/${original.id}/counter`, bob, 'POST', {
      offered_items: [{ type: 'card', id: bobUnmarked }],
      requested_items: [{ type: 'card', id: aliceUnmarked }]
    });
    assert.strictEqual(response.status, 201);
    const counter = (await response.json()).transfer;
    assert.strictEqual(counter.response_to_transfer_id, original.id);
    response = await request(`/api/transfers/${counter.id}/accept`, alice, 'PUT');
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await db.get(`SELECT status FROM user_transfers WHERE id = ?`, [original.id])).status, 'countered');
    assert.strictEqual((await db.get(`SELECT purchase_price FROM collection WHERE user_id = ? AND card_id = ?`, [alice, `counter-b-${process.pid}`])).purchase_price, 0.25);
    assert.strictEqual((await db.get(`SELECT purchase_price FROM collection WHERE user_id = ? AND card_id = ?`, [bob, `counter-a-${process.pid}`])).purchase_price, 0.15);
    console.log('PASS: offer-only trades require a bilateral counterproposal and preserve negotiation history');

    const aliceKnown = await addCard(alice, `multi-a1-${process.pid}`, 'Multi Alice Known', 0.20);
    const aliceUnknown = await addCard(alice, `multi-a2-${process.pid}`, 'Multi Alice Unknown', null);
    const bobFirst = await addCard(bob, `multi-b1-${process.pid}`, 'Multi Bob First', 0.30, 1);
    const bobSecond = await addCard(bob, `multi-b2-${process.pid}`, 'Multi Bob Second', 0.40, 1);
    response = await request('/api/transfers', alice, 'POST', {
      recipient_id: bob,
      transfer_type: 'trade',
      offered_items: [
        { type: 'card', id: aliceKnown },
        { type: 'card', id: aliceUnknown }
      ],
      requested_items: [
        { type: 'card', id: bobFirst },
        { type: 'card', id: bobSecond }
      ]
    });
    const multiTrade = (await response.json()).transfer;
    response = await request(`/api/transfers/${multiTrade.id}/accept`, bob, 'PUT');
    assert.strictEqual(response.status, 200);
    const bobReceived = await db.all(
      `SELECT purchase_price FROM collection WHERE user_id = ? AND card_id LIKE ? ORDER BY card_id`,
      [bob, `multi-a%-${process.pid}`]
    );
    const aliceReceived = await db.all(
      `SELECT purchase_price FROM collection WHERE user_id = ? AND card_id LIKE ? ORDER BY card_id`,
      [alice, `multi-b%-${process.pid}`]
    );
    assert.deepStrictEqual(bobReceived.map(row => row.purchase_price), [0.35, 0.35]);
    assert.deepStrictEqual(aliceReceived.map(row => row.purchase_price), [null, null]);
    console.log('PASS: multi-item trades split known costs evenly and preserve unknown allocations');

    const bundlePurchase = await db.run(
      `INSERT INTO sealed_purchases (user_id, product_name, sealed_type, game, unit_price, quantity)
       VALUES (?, 'Booster Bundle', 'Bundle', 'pokemon', 20, 1)`,
      [alice]
    );
    const bundleUnit = await db.run(
      `INSERT INTO sealed_units (purchase_id, opened_at) VALUES (?, CURRENT_TIMESTAMP)`,
      [bundlePurchase.lastID]
    );
    const packPurchase = await db.run(
      `INSERT INTO sealed_purchases (user_id, product_name, sealed_type, game, unit_price, quantity, source_unit_id)
       VALUES (?, 'Booster Pack', 'Booster Pack', 'pokemon', 0.60, 1, ?)`,
      [alice, bundleUnit.lastID]
    );
    const packUnit = await db.run(
      `INSERT INTO sealed_units (purchase_id, is_trade) VALUES (?, 1)`,
      [packPurchase.lastID]
    );
    response = await request(`/api/transfers/marked/${alice}`);
    assert.strictEqual((await response.json()).sealed[0].unit_id, packUnit.lastID);
    response = await request('/api/transfers', alice, 'POST', {
      recipient_id: bob,
      transfer_type: 'gift',
      offered_items: [{ type: 'sealed', id: packUnit.lastID }]
    });
    assert.strictEqual(response.status, 201);
    const gift = (await response.json()).transfer;
    response = await request(`/api/transfers/${gift.id}/accept`, bob, 'PUT');
    assert.strictEqual(response.status, 200);
    const receivedPurchase = await db.get(
      `SELECT * FROM sealed_purchases WHERE user_id = ? AND product_name = 'Booster Pack'`,
      [bob]
    );
    assert.strictEqual(receivedPurchase.unit_price, 0);
    assert.strictEqual(receivedPurchase.source_product_name, 'Booster Bundle');
    assert.strictEqual(receivedPurchase.source_unit_number, 1);
    assert.strictEqual((await db.get(`SELECT purchase_id FROM sealed_units WHERE id = ?`, [packUnit.lastID])).purchase_id, receivedPurchase.id);
    const sealedResponse = await request('/api/sealed/purchases', bob);
    const visiblePurchase = (await sealedResponse.json()).purchases.find(item => item.id === receivedPurchase.id);
    assert.strictEqual(visiblePurchase.source_product_name, 'Booster Bundle');
    console.log('PASS: gifts transfer only unopened packs, zero their cost, and preserve bundle origin for the recipient');

    const opened = await request(`/api/transfers/sealed/${bundleUnit.lastID}/trade`, alice, 'PUT', { is_trade: true });
    assert.strictEqual(opened.status, 409, 'an opened bundle must not be listable for trade');

    const staleOffered = await addCard(alice, `stale-a-${process.pid}`, 'Stale Offered Card', 1);
    const staleRequested = await addCard(bob, `stale-b-${process.pid}`, 'Stale Requested Card', 2, 1);
    response = await request('/api/transfers', alice, 'POST', {
      recipient_id: bob,
      transfer_type: 'trade',
      offered_items: [{ type: 'card', id: staleOffered }],
      requested_items: [{ type: 'card', id: staleRequested }]
    });
    const staleTransfer = (await response.json()).transfer;
    await db.run(`DELETE FROM collection WHERE id = ?`, [staleRequested]);
    response = await request(`/api/transfers/${staleTransfer.id}/accept`, bob, 'PUT');
    assert.strictEqual(response.status, 409, 'stale requested inventory must be rejected');
    assert.strictEqual((await db.get(`SELECT user_id FROM collection WHERE id = ?`, [staleOffered])).user_id, alice,
      'failed acceptance must not partially transfer the other side');
    console.log('PASS: acceptance revalidates both sides and rolls back stale trades atomically');

    const checkedOutCard = await addCard(alice, `deck-warning-${process.pid}`, 'Deck Warning Card', 1);
    const deck = await db.run(
      `INSERT INTO decks (user_id, name, game, checked_out) VALUES (?, 'In Play', 'pokemon', 1)`,
      [alice]
    );
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, 1)`,
      [deck.lastID, `deck-warning-${process.pid}`]);
    response = await request('/api/transfers', alice, 'POST', {
      recipient_id: bob,
      transfer_type: 'gift',
      offered_items: [{ type: 'card', id: checkedOutCard }]
    });
    const warnedGift = (await response.json()).transfer;
    assert.strictEqual(warnedGift.deck_warnings.length, 1);
    assert.strictEqual(warnedGift.deck_warnings[0].copies_short, 1);
    response = await request(`/api/transfers/${warnedGift.id}/cancel`, alice, 'PUT');
    assert.strictEqual(response.status, 200);
    console.log('PASS: checked-out deck shortages are warned about without blocking offers');
  } finally {
    await cleanup();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
