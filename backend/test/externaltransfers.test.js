const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-external-transfers-${process.pid}.db`);
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
  app.use('/api', require('../src/routes/externalTransfers'));
  app.use('/api', require('../src/routes/collection'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function main() {
  await db.initDb();
  const ownerId = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['external-owner', 'hash', 'member', `external-owner-${process.pid}`]
  )).lastID;
  const otherId = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['external-other', 'hash', 'member', `external-other-${process.pid}`]
  )).lastID;
  const base = await startApp(new Map([[ownerId, { id: ownerId }], [otherId, { id: otherId }]]));
  const headers = userId => ({ 'Content-Type': 'application/json', 'x-user-id': String(userId) });
  const request = async (pathName, userId, method = 'GET', body) => fetch(`${base}${pathName}`, {
    method,
    headers: headers(userId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  try {
    let response = await request('/api/transfers/external/contacts', ownerId, 'POST', { name: 'Local League Friend' });
    assert.strictEqual(response.status, 201);
    const contact = (await response.json()).contact;
    response = await request('/api/transfers/external/contacts', ownerId, 'POST', { name: 'local league friend' });
    assert.strictEqual(response.status, 409, 'contact names should be unique per owner, ignoring case');
    assert.deepStrictEqual((await (await request('/api/transfers/external/contacts', otherId)).json()).contacts, []);
    console.log('PASS: external contacts are reusable and scoped to their owner');

    await db.run(
      `INSERT INTO card_cache (id, name, printed_name, set_name, number, image_url, game)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`external-given-${process.pid}`, 'Given Card', 'Given Card', 'External Set', '1', 'given.png', 'pokemon']
    );
    await db.run(
      `INSERT INTO collection (card_id, user_id, quantity, purchase_price)
       VALUES (?, ?, 1, ?)`,
      [`external-given-${process.pid}`, ownerId, 0.30]
    );
    await db.run(
      `INSERT INTO card_cache (id, name, printed_name, set_name, number, image_url, game)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`external-received-${process.pid}`, 'Received Card', 'Received Card', 'External Set', '2', 'received.png', 'pokemon']
    );
    const givenEntry = await db.get(
      `SELECT id FROM collection WHERE user_id = ? AND card_id = ?`,
      [ownerId, `external-given-${process.pid}`]
    );
    response = await request('/api/transfers/external', ownerId, 'POST', {
      contact_id: contact.id,
      transaction_type: 'trade',
      given_items: [{ type: 'card', id: givenEntry.id }],
      received_items: [{ type: 'card', card_id: `external-received-${process.pid}`, quantity: 2, game: 'pokemon' }]
    });
    assert.strictEqual(response.status, 201);
    const trade = await response.json();
    assert.strictEqual(trade.transaction.contact_name, 'Local League Friend');
    assert.strictEqual((await db.get(
      `SELECT COUNT(*) AS count FROM collection WHERE user_id = ? AND card_id = ?`,
      [ownerId, `external-given-${process.pid}`]
    )).count, 0);
    const received = await db.all(
      `SELECT purchase_price, location_id FROM collection WHERE user_id = ? AND card_id = ? ORDER BY id`,
      [ownerId, `external-received-${process.pid}`]
    );
    assert.deepStrictEqual(received.map(row => row.purchase_price), [0.15, 0.15]);
    assert.ok(received.every(row => row.location_id == null));
    assert.strictEqual(trade.transaction.items.filter(item => item.direction === 'given').length, 1);
    assert.strictEqual(trade.transaction.items.filter(item => item.direction === 'received').length, 2);
    const collectionResponse = await request('/api/collection', ownerId);
    assert.strictEqual(collectionResponse.status, 200);
    const collection = await collectionResponse.json();
    const receivedCards = collection.filter(row => row.card_id === `external-received-${process.pid}`);
    assert.strictEqual(receivedCards.length, 2);
    assert.ok(receivedCards.every(row =>
      row.acquired_external_transaction_id === trade.transaction.id
      && row.acquired_external_transaction_type === 'trade'
      && row.acquired_external_contact === 'Local League Friend'
    ));
    console.log('PASS: external trades update collection and allocate the outgoing cost to received copies');

    await db.run(
      `INSERT INTO card_cache (id, name, printed_name, set_name, number, image_url, game)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`external-unknown-given-${process.pid}`, 'Unknown Cost Card', 'Unknown Cost Card', 'External Set', '3', 'unknown-given.png', 'pokemon']
    );
    const unknownEntry = await db.run(
      `INSERT INTO collection (card_id, user_id, quantity, purchase_price) VALUES (?, ?, 1, NULL)`,
      [`external-unknown-given-${process.pid}`, ownerId]
    );
    await db.run(
      `INSERT INTO card_cache (id, name, printed_name, set_name, number, image_url, game)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`external-unknown-received-${process.pid}`, 'Unknown Received Card', 'Unknown Received Card', 'External Set', '4', 'unknown-received.png', 'pokemon']
    );
    response = await request('/api/transfers/external', ownerId, 'POST', {
      contact_id: contact.id,
      transaction_type: 'trade',
      given_items: [{ type: 'card', id: unknownEntry.lastID }],
      received_items: [{ type: 'card', card_id: `external-unknown-received-${process.pid}` }]
    });
    assert.strictEqual(response.status, 201);
    assert.strictEqual((await db.get(
      `SELECT purchase_price FROM collection WHERE user_id = ? AND card_id = ?`,
      [ownerId, `external-unknown-received-${process.pid}`]
    )).purchase_price, null);
    console.log('PASS: external trades preserve unknown cost allocations');

    const sealedPurchase = await db.run(
      `INSERT INTO sealed_purchases (user_id, product_name, sealed_type, game, quantity, unit_price)
       VALUES (?, 'External Gift Bundle', 'Booster Bundle', 'pokemon', 1, 24.00)`,
      [ownerId]
    );
    const sealedUnit = await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [sealedPurchase.lastID]);
    response = await request('/api/transfers/external', ownerId, 'POST', {
      contact_id: contact.id,
      transaction_type: 'gift',
      received_items: [{
        type: 'sealed',
        product_name: 'Booster Pack',
        set_name: 'External Set',
        sealed_type: 'Booster Pack',
        game: 'pokemon',
        quantity: 2,
        origin_product_name: 'Booster Bundle',
        origin_unit_number: 1
      }]
    });
    assert.strictEqual(response.status, 201);
    const gift = await response.json();
    assert.ok(gift.transaction.items.every(item => item.received_cost === 0));
    const receivedUnits = await db.all(
      `SELECT p.product_name, p.unit_price, p.source_product_name, p.source_unit_number, u.opened_at
         FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id
        WHERE p.user_id = ? AND p.product_name = 'Booster Pack'`,
      [ownerId]
    );
    assert.strictEqual(receivedUnits.length, 2);
    assert.ok(receivedUnits.every(unit => unit.unit_price === 0 && unit.source_product_name === 'Booster Bundle' && unit.source_unit_number === 1 && unit.opened_at == null));
    console.log('PASS: external gifts create unopened sealed units with bundle provenance and zero cost');

    response = await request('/api/transfers/external', ownerId, 'POST', {
      contact_id: contact.id,
      transaction_type: 'gift',
      given_items: [{ type: 'sealed', id: sealedUnit.lastID }]
    });
    assert.strictEqual(response.status, 201);
    assert.strictEqual((await db.get(`SELECT COUNT(*) AS count FROM sealed_units WHERE id = ?`, [sealedUnit.lastID])).count, 0);
    assert.strictEqual((await db.get(`SELECT quantity FROM sealed_purchases WHERE id = ?`, [sealedPurchase.lastID])).quantity, 0);
    console.log('PASS: external gifts remove sent unopened sealed units from local inventory');

    response = await request('/api/transfers/external', ownerId, 'POST', {
      contact_id: contact.id,
      transaction_type: 'trade',
      given_items: [{ type: 'card', id: 999999 }],
      received_items: [{ type: 'card', card_id: `external-received-${process.pid}` }]
    });
    assert.strictEqual(response.status, 404);
    const historyResponse = await request('/api/transfers/external', ownerId);
    const history = (await historyResponse.json()).transactions;
    assert.strictEqual(history.length, 4, 'failed recordings must not create partial history');
    console.log('PASS: invalid external records do not create partial history');

    response = await request(`/api/transfers/external/contacts/${contact.id}`, ownerId, 'DELETE');
    assert.strictEqual(response.status, 200);
    const preserved = (await (await request('/api/transfers/external', ownerId)).json()).transactions;
    assert.ok(preserved.some(item => item.contact_name === 'Local League Friend'));
    console.log('PASS: deleting a saved contact preserves its transaction history snapshot');
  } finally {
    await cleanup();
  }
}

main().catch(async error => {
  console.error(error);
  await cleanup();
  process.exitCode = 1;
});
