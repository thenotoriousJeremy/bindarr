// Deals with people outside Bindarr (routes/externalTransfers.js): the real router
// on a real temporary SQLite database, behind a stand-in for the authentication gate
// (x-user-id; x-api-key: 1 marks the request as an API key's).
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

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: Number(req.headers['x-user-id']), via_api_key: req.headers['x-api-key'] === '1' };
    next();
  });
  app.use('/api/collection/trash', require('../src/routes/trash'));
  app.use('/api', require('../src/routes/collection'));
  app.use('/api', require('../src/routes/sealed'));
  app.use('/api', require('../src/routes/externalTransfers'));
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
  const base = await startApp();
  const request = async (pathName, userId, method = 'GET', body, { apiKey = false } = {}) => fetch(`${base}${pathName}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user-id': String(userId), ...(apiKey ? { 'x-api-key': '1' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  // The status, and for a refusal the stable code beside the message.
  const expectStatus = async (response, status, label, code) => {
    const text = await response.text();
    assert.strictEqual(response.status, status, `${label}: ${response.status} ${text}`);
    const json = text ? JSON.parse(text) : null;
    if (code) assert.strictEqual(json.code, code, `${label}: ${text}`);
    return json;
  };
  let cardCount = 0;
  const addCard = async (userId, { name = 'Card', price = 1, quantity = 1, market = null, game = 'pokemon', id } = {}) => {
    const cardId = id || `external-card-${++cardCount}-${process.pid}`;
    await db.run(
      `INSERT INTO card_cache (id, name, printed_name, set_name, number, image_url, game, price_trend, language)
       VALUES (?, ?, ?, 'External Set', ?, 'card.png', ?, ?, 'English')`,
      [cardId, name, name, String(cardCount), game, market]
    );
    const entry = userId == null ? null : (await db.run(
      `INSERT INTO collection (card_id, user_id, quantity, purchase_price, game) VALUES (?, ?, ?, ?, ?)`,
      [cardId, userId, quantity, price, game]
    )).lastID;
    return { cardId, entry };
  };
  const record = (body) => request('/api/transfers/external', ownerId, 'POST', body);

  try {
    let response = await request('/api/transfers/external/contacts', ownerId, 'POST', { name: 'Local League Friend' });
    assert.strictEqual(response.status, 201);
    const contact = (await response.json()).contact;
    response = await request('/api/transfers/external/contacts', ownerId, 'POST', { name: 'local league friend' });
    await expectStatus(response, 409, 'contact names should be unique per owner, ignoring case', 'name_taken');
    assert.deepStrictEqual((await (await request('/api/transfers/external/contacts', otherId)).json()).contacts, []);
    const second = (await expectStatus(
      await request('/api/transfers/external/contacts', ownerId, 'POST', { name: 'Second Contact' }), 201, 'a second contact'
    )).contact;
    await expectStatus(await request(`/api/transfers/external/contacts/${second.id}`, ownerId, 'PUT', { name: 'LOCAL LEAGUE FRIEND' }),
      409, 'renaming onto a name taken in another case', 'name_taken');
    await expectStatus(await request(`/api/transfers/external/contacts/${second.id}`, ownerId, 'PUT', { name: 'SECOND contact' }),
      200, 'a contact takes its own name in another case');
    await expectStatus(await request('/api/transfers/external/contacts/999999', ownerId, 'PUT', { name: 'Local League Friend' }),
      404, 'renaming no contact', 'not_found');
    console.log('PASS: external contacts are reusable and scoped to their owner');

    // The phone's SQLite plugin rejects a failed statement with a bare message and
    // no `code` (Android: "Run: " + SQLite's message). A write the unique index
    // refuses all the same (one that raced the name check) is still a 409 there,
    // and any other such error is not mistaken for one.
    const realRun = db.run;
    const phoneError = (message) => async (sql, params) => {
      if (/^\s*(INSERT INTO|UPDATE) external_contacts/.test(sql)) throw new Error(`Run: ${message}`);
      return realRun(sql, params);
    };
    try {
      db.run = phoneError('UNIQUE constraint failed: external_contacts.user_id, external_contacts.name (code 2067 SQLITE_CONSTRAINT_UNIQUE)');
      await expectStatus(await request('/api/transfers/external/contacts', ownerId, 'POST', { name: 'Raced Name' }),
        409, 'a constraint failure with no code', 'name_taken');
      await expectStatus(await request(`/api/transfers/external/contacts/${second.id}`, ownerId, 'PUT', { name: 'Raced Rename' }),
        409, 'a rename refused with no code', 'name_taken');
      db.run = phoneError('disk I/O error (code 10 SQLITE_IOERR)');
      const logged = [];
      const realError = console.error;
      console.error = (...args) => logged.push(args.map(String).join(' '));
      try {
        await expectStatus(await request('/api/transfers/external/contacts', ownerId, 'POST', { name: 'Unlucky Name' }),
          500, 'another failure with no code', 'server_error');
      } finally {
        console.error = realError;
      }
      assert.ok(logged.some(line => line.includes('disk I/O error')), 'and the server logs it');
    } finally {
      db.run = realRun;
    }
    assert.ok(!(await db.get(`SELECT 1 FROM external_contacts WHERE name IN ('Raced Name', 'Unlucky Name')`)), 'nothing was written');
    await expectStatus(await request(`/api/transfers/external/contacts/${second.id}`, ownerId, 'DELETE'), 200, 'tidying up');
    console.log('PASS: a taken contact name is a 409 even when the driver reports no error code');

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
    response = await record({
      contact_id: contact.id,
      transaction_type: 'trade',
      given_items: [{ type: 'card', id: givenEntry.id }],
      received_items: [{ type: 'card', card_id: `external-received-${process.pid}`, quantity: 2, game: 'pokemon' }]
    });
    assert.strictEqual(response.status, 201);
    const trade = await response.json();
    assert.deepStrictEqual(Object.keys(trade).sort(), ['transaction', 'trash_batch', 'warnings'],
      'the shape the app reads, plus the trash batch for an Undo');
    assert.strictEqual(trade.transaction.contact_name, 'Local League Friend');
    assert.strictEqual((await db.get(
      `SELECT COUNT(*) AS count FROM collection WHERE user_id = ? AND card_id = ?`,
      [ownerId, `external-given-${process.pid}`]
    )).count, 0);
    const received = await db.all(
      `SELECT id, purchase_price, location_id, acquired_via_external_item_id FROM collection WHERE user_id = ? AND card_id = ? ORDER BY id`,
      [ownerId, `external-received-${process.pid}`]
    );
    assert.deepStrictEqual(received.map(row => row.purchase_price), [0.15, 0.15]);
    assert.ok(received.every(row => row.location_id == null));
    assert.strictEqual(trade.transaction.items.filter(item => item.direction === 'given').length, 1);
    const receivedLines = trade.transaction.items.filter(item => item.direction === 'received');
    assert.strictEqual(receivedLines.length, 2);
    assert.deepStrictEqual(received.map(row => row.acquired_via_external_item_id), receivedLines.map(item => item.id),
      'each received copy names the line of the deal that brought it in');
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

    // The given card went to the trash, and Undo brings it back.
    assert.ok(trade.trash_batch, 'the response names the trash batch, for an Undo');
    const trashed = await db.get(`SELECT entry_id FROM collection_trash WHERE batch_id = ? AND user_id = ?`, [trade.trash_batch, ownerId]);
    assert.strictEqual(trashed.entry_id, givenEntry.id);
    response = await request(`/api/collection/trash/${trade.trash_batch}/restore`, ownerId, 'POST');
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await db.get(`SELECT user_id FROM collection WHERE id = ?`, [givenEntry.id])).user_id, ownerId,
      'the given card is restored under its own id');
    const history = (await (await request('/api/transfers/external', ownerId)).json()).transactions;
    assert.strictEqual(history.find(item => item.id === trade.transaction.id).items.length, 3, 'the record stays');
    console.log('PASS: given cards go to the trash, restorable, rather than being deleted');

    // Some copies of an entry: only those leave, as a trash row of their own.
    const three = await addCard(ownerId, { name: 'Three Copies', price: 2, quantity: 3 });
    const somethingBack = await addCard(null, { name: 'Something Back' });
    const partial = await expectStatus(await record({
      contact_id: contact.id,
      transaction_type: 'trade',
      given_items: [{ type: 'card', id: three.entry, quantity: 2 }],
      received_items: [{ type: 'card', card_id: somethingBack.cardId }],
    }), 201, 'giving two of three copies');
    assert.strictEqual((await db.get(`SELECT quantity FROM collection WHERE id = ?`, [three.entry])).quantity, 1);
    const trashRow = JSON.parse((await db.get(`SELECT row_json FROM collection_trash WHERE batch_id = ?`, [partial.trash_batch])).row_json);
    assert.strictEqual(trashRow.quantity, 2);
    assert.strictEqual(trashRow.card_id, three.cardId);
    assert.strictEqual((await db.get(`SELECT purchase_price AS p FROM collection WHERE user_id = ? AND card_id = ?`, [ownerId, somethingBack.cardId])).p, 4,
      'two copies at $2 cost $4');
    await expectStatus(await request(`/api/collection/trash/${partial.trash_batch}/restore`, ownerId, 'POST'), 200, 'restoring');
    assert.strictEqual((await db.get(`SELECT SUM(quantity) AS n FROM collection WHERE user_id = ? AND card_id = ?`, [ownerId, three.cardId])).n, 3);
    console.log('PASS: giving some copies of an entry trashes just those');

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
    response = await record({
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

    // Priced: a $100 card for a $95 card and a $5 card gives them $95 and $5.
    const dear = await addCard(ownerId, { name: 'Dear Card', price: 100, market: 100 });
    const big = await addCard(null, { name: 'Big Card', market: 95 });
    const small = await addCard(null, { name: 'Small Card', market: 5 });
    await expectStatus(await record({
      contact_id: contact.id,
      transaction_type: 'trade',
      given_items: [{ type: 'card', id: dear.entry }],
      received_items: [{ type: 'card', card_id: big.cardId }, { type: 'card', card_id: small.cardId }],
    }), 201, 'a priced trade');
    const costOf = async (cardId) => (await db.get(`SELECT purchase_price AS p FROM collection WHERE user_id = ? AND card_id = ?`, [ownerId, cardId])).p;
    assert.deepStrictEqual([await costOf(big.cardId), await costOf(small.cardId)], [95, 5]);
    console.log('PASS: external trade costs are split by market value');

    const sealedPurchase = await db.run(
      `INSERT INTO sealed_purchases (user_id, product_name, sealed_type, game, quantity, unit_price)
       VALUES (?, 'External Gift Bundle', 'Booster Bundle', 'pokemon', 1, 24.00)`,
      [ownerId]
    );
    const sealedUnit = await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [sealedPurchase.lastID]);
    response = await record({
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
    assert.strictEqual(gift.trash_batch, null, 'nothing given, nothing trashed');
    const receivedUnits = await db.all(
      `SELECT p.id, p.product_name, p.unit_price, p.source_product_name, p.source_unit_number, p.store, p.notes, u.opened_at
         FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id
        WHERE p.user_id = ? AND p.product_name = 'Booster Pack'`,
      [ownerId]
    );
    assert.strictEqual(receivedUnits.length, 2);
    assert.ok(receivedUnits.every(unit => unit.unit_price === 0 && unit.source_product_name === 'Booster Bundle' && unit.source_unit_number === 1 && unit.opened_at == null));
    assert.ok(receivedUnits.every(unit => unit.store === null && unit.notes === null), 'no English written into the purchase');
    const purchases = (await (await request('/api/sealed/purchases', ownerId)).json()).purchases;
    for (const unit of receivedUnits) {
      const row = purchases.find(purchase => purchase.id === unit.id);
      assert.strictEqual(row.acquired_external_contact, 'Local League Friend');
      assert.strictEqual(row.acquired_external_transaction_type, 'gift');
      assert.strictEqual(row.acquired_transfer_partner, null);
    }
    console.log('PASS: external gifts create unopened sealed units with bundle provenance and zero cost');

    response = await record({
      contact_id: contact.id,
      transaction_type: 'gift',
      given_items: [{ type: 'sealed', id: sealedUnit.lastID }]
    });
    assert.strictEqual(response.status, 201);
    assert.strictEqual((await db.get(`SELECT COUNT(*) AS count FROM sealed_units WHERE id = ?`, [sealedUnit.lastID])).count, 0);
    assert.strictEqual((await db.get(`SELECT quantity FROM sealed_purchases WHERE id = ?`, [sealedPurchase.lastID])).quantity, 0);
    console.log('PASS: external gifts remove sent unopened sealed units from local inventory');

    // Sealed units follow the claim rule here too.
    const shared = await db.run(
      `INSERT INTO sealed_purchases (user_id, product_name, sealed_type, game, quantity, unit_price, available_to_all)
       VALUES (?, 'Shared Box', 'Booster Box', 'pokemon', 2, 90, 1)`,
      [otherId]
    );
    const claimedByOwner = (await db.run(`INSERT INTO sealed_units (purchase_id, claimed_by_user_id) VALUES (?, ?)`, [shared.lastID, ownerId])).lastID;
    const ownBox = await db.run(
      `INSERT INTO sealed_purchases (user_id, product_name, sealed_type, game, quantity, unit_price)
       VALUES (?, 'Own Box', 'Booster Box', 'pokemon', 2, 90)`,
      [ownerId]
    );
    const claimedByOther = (await db.run(`INSERT INTO sealed_units (purchase_id, claimed_by_user_id) VALUES (?, ?)`, [ownBox.lastID, otherId])).lastID;
    const resealed = (await db.run(`INSERT INTO sealed_units (purchase_id, claimed_by_user_id) VALUES (?, ?)`, [ownBox.lastID, ownerId])).lastID;
    const otherContact = (await (await request('/api/transfers/external/contacts', otherId, 'POST', { name: 'Shop' })).json()).contact;
    await expectStatus(await record({
      contact_id: contact.id, transaction_type: 'gift', given_items: [{ type: 'sealed', id: claimedByOther }],
    }), 409, "giving a unit of one's own purchase that someone else claimed", 'unit_claimed');
    await expectStatus(await request('/api/transfers/external', otherId, 'POST', {
      contact_id: otherContact.id, transaction_type: 'gift', given_items: [{ type: 'sealed', id: claimedByOther }],
    }), 201, 'its claimant gives it');
    await expectStatus(await record({
      contact_id: contact.id, transaction_type: 'gift', given_items: [{ type: 'sealed', id: claimedByOwner }],
    }), 201, "giving a unit claimed from someone else's purchase");
    await expectStatus(await record({
      contact_id: contact.id, transaction_type: 'gift', given_items: [{ type: 'sealed', id: resealed }],
    }), 201, 'giving a resealed unit');
    assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM sealed_units WHERE id IN (?, ?, ?)`, [claimedByOwner, claimedByOther, resealed])).n, 0);
    console.log('PASS: external deals follow the sealed claim rule');

    // Copies a checked-out deck holds stay.
    const held = await addCard(ownerId, { name: 'Held Card', quantity: 2 });
    const deck = (await db.run(`INSERT INTO decks (user_id, name, game, checked_out) VALUES (?, 'League Deck', 'pokemon', 1)`, [ownerId])).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, 3)`, [deck, held.cardId]);
    await db.run(`INSERT INTO deck_allocations (entry_id, deck_id, card_id, quantity) VALUES (?, ?, ?, 1)`, [held.entry, deck, held.cardId]);
    const refusal = await expectStatus(await record({
      contact_id: contact.id, transaction_type: 'gift', given_items: [{ type: 'card', id: held.entry, quantity: 2 }],
    }), 409, 'giving copies a deck holds', 'deck_allocated');
    assert.deepStrictEqual(refusal.decks, ['League Deck']);
    const warned = await expectStatus(await record({
      contact_id: contact.id, transaction_type: 'gift', given_items: [{ type: 'card', id: held.entry, quantity: 1 }],
    }), 201, 'giving the free copy');
    // It needs three and holds one: the free copy could have made it one short.
    assert.strictEqual(warned.warnings.length, 1, 'a deck still missing copies is warned about');
    assert.strictEqual(warned.warnings[0].copies_short, 2);
    assert.deepStrictEqual(warned.warnings[0].decks, ['League Deck']);
    assert.ok(await db.get(`SELECT 1 FROM deck_allocations WHERE entry_id = ?`, [held.entry]), 'the deck keeps its copy');
    console.log('PASS: external gifts cannot take copies a checked-out deck holds, and warn about decks they leave short');

    // Every game in the registry, Riftbound included.
    const rune = await addCard(null, { name: 'Rune Card', game: 'riftbound', id: `riftbound-test-${process.pid}` });
    await expectStatus(await record({
      contact_id: contact.id,
      transaction_type: 'gift',
      received_items: [
        { type: 'card', card_id: rune.cardId, game: 'riftbound' },
        { type: 'sealed', product_name: 'Riftbound Booster', game: 'riftbound' },
      ],
    }), 201, 'a Riftbound gift');
    assert.strictEqual((await db.get(`SELECT game FROM collection WHERE user_id = ? AND card_id = ?`, [ownerId, rune.cardId])).game, 'riftbound');
    assert.strictEqual((await db.get(`SELECT game FROM sealed_purchases WHERE user_id = ? AND product_name = 'Riftbound Booster'`, [ownerId])).game, 'riftbound');
    await expectStatus(await record({
      contact_id: contact.id, transaction_type: 'gift', received_items: [{ type: 'card', card_id: rune.cardId, game: 'yugioh' }],
    }), 400, 'a game nobody registered', 'invalid');
    await expectStatus(await record({
      contact_id: contact.id, transaction_type: 'gift', received_items: [{ type: 'card', card_id: rune.cardId, condition: 'Mint' }],
    }), 400, 'a condition the collection does not take', 'invalid');
    await expectStatus(await record({
      contact_id: contact.id, transaction_type: 'gift', received_items: [{ type: 'card', card_id: `no-such-card-${process.pid}` }],
    }), 404, 'a card no catalog knows', 'not_found');
    console.log('PASS: received cards resolve like any add, in every registered game');

    response = await record({
      contact_id: contact.id,
      transaction_type: 'trade',
      given_items: [{ type: 'card', id: 999999 }],
      received_items: [{ type: 'card', card_id: `external-received-${process.pid}` }]
    });
    await expectStatus(response, 404, 'an unknown card', 'not_found');
    const historyResponse = await request('/api/transfers/external', ownerId);
    const allHistory = (await historyResponse.json());
    assert.strictEqual(allHistory.transactions.length, 10, 'failed recordings must not create partial history');
    assert.strictEqual(allHistory.next_cursor, null);
    console.log('PASS: invalid external records do not create partial history');

    const page1 = await expectStatus(await request('/api/transfers/external?limit=4', ownerId), 200, 'page one');
    assert.strictEqual(page1.transactions.length, 4);
    assert.ok(page1.next_cursor);
    const page2 = await expectStatus(await request(`/api/transfers/external?limit=4&cursor=${encodeURIComponent(page1.next_cursor)}`, ownerId), 200, 'page two');
    assert.ok(page2.next_cursor);
    const page3 = await expectStatus(await request(`/api/transfers/external?limit=4&cursor=${encodeURIComponent(page2.next_cursor)}`, ownerId), 200, 'page three');
    assert.strictEqual(page3.transactions.length, 2);
    assert.strictEqual(page3.next_cursor, null);
    const ids = [...page1.transactions, ...page2.transactions, ...page3.transactions].map(item => item.id);
    assert.deepStrictEqual(ids, allHistory.transactions.map(item => item.id), 'the pages, in order, are the whole list');
    assert.ok(page2.transactions.every(item => Array.isArray(item.items) && item.items.length > 0));
    await expectStatus(await request('/api/transfers/external?limit=500', ownerId), 400, 'too big a page', 'invalid');
    console.log('PASS: outside deals page newest first');

    for (const pathName of ['/api/transfers/external', '/api/transfers/external/contacts']) {
      await expectStatus(await request(pathName, ownerId, 'GET', undefined, { apiKey: true }), 403, `${pathName} with an API key`, 'api_key_refused');
    }
    console.log('PASS: outside deals refuse an API key');

    response = await request(`/api/transfers/external/contacts/${contact.id}`, ownerId, 'DELETE');
    assert.strictEqual(response.status, 200);
    const preserved = (await (await request('/api/transfers/external', ownerId)).json()).transactions;
    assert.ok(preserved.some(item => item.contact_name === 'Local League Friend'));
    await expectStatus(await request(`/api/transfers/external/contacts/${contact.id}`, ownerId, 'DELETE'), 404, 'deleting it again', 'not_found');
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
