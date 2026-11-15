// Trades and gifts between members (routes/transfers.js) and trades recorded after
// the fact (routes/historicalTrades.js): the real routers on a real temporary SQLite
// database, behind a stand-in for the authentication gate. x-user-id names the
// caller; x-api-key: 1 marks the request as an API key's, as authenticateToken does.
// test/e2e/transfers.test.js drives the same routes through the real gate.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-transfer-api-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { getOwnedUnit } = require('../src/utils/sealedOwnership');
const { closePendingTradesFor } = require('../src/utils/transferAssets');

let server;
let base;

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
  // The order server.js mounts them in (routes/mounts.js).
  app.use('/api', require('../src/routes/collection'));
  app.use('/api', require('../src/routes/sealed'));
  app.use('/api', require('../src/routes/externalTransfers'));
  app.use('/api', require('../src/routes/historicalTrades'));
  app.use('/api', require('../src/routes/transfers'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function call(method, pathName, userId, body, { apiKey = false } = {}) {
  const response = await fetch(`${base}${pathName}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user-id': String(userId), ...(apiKey ? { 'x-api-key': '1' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text };
}
const get = (pathName, userId, options) => call('GET', pathName, userId, undefined, options);

// The status, and for a refusal the stable code beside the message.
function expect(response, status, label, code) {
  assert.strictEqual(response.status, status, `${label}: got ${response.status} ${response.text}`);
  if (code) {
    assert.strictEqual(response.json && response.json.code, code, `${label}: code, got ${response.text}`);
    assert.strictEqual(typeof response.json.error, 'string', `${label}: a refusal still says why in words`);
  }
  return response.json;
}

async function addUser(name, { trades = true } = {}) {
  return (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, trades_enabled) VALUES (?, 'hash', 'member', ?, ?)`,
    [name, `share-${name}-${process.pid}`, trades ? 1 : 0]
  )).lastID;
}

let cardCount = 0;
// A card of its own (market: its card_cache price) and one entry of it.
async function addCard(ownerId, { name = 'Card', price = 1, isTrade = 0, quantity = 1, market = null } = {}) {
  const cardId = `xfer-card-${++cardCount}-${process.pid}`;
  await db.run(
    `INSERT INTO card_cache (id, name, printed_name, set_name, number, image_url, game, price_trend)
     VALUES (?, ?, ?, 'Transfer Test Set', ?, 'test.png', 'pokemon', ?)`,
    [cardId, name, name, String(cardCount), market]
  );
  const entry = (await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, purchase_price, is_trade) VALUES (?, ?, ?, ?, ?)`,
    [cardId, ownerId, quantity, price, isTrade]
  )).lastID;
  return { cardId, entry };
}

// One purchase of `units` unopened units.
async function addSealed(ownerId, { name = 'Booster Pack', price = 5, units = 1, shared = 0, isTrade = 0 } = {}) {
  const purchase = (await db.run(
    `INSERT INTO sealed_purchases (user_id, product_name, sealed_type, game, unit_price, quantity, available_to_all)
     VALUES (?, ?, 'Booster Pack', 'pokemon', ?, ?, ?)`,
    [ownerId, name, price, units, shared]
  )).lastID;
  const unitIds = [];
  for (let i = 0; i < units; i++) {
    unitIds.push((await db.run(`INSERT INTO sealed_units (purchase_id, is_trade) VALUES (?, ?)`, [purchase, isTrade])).lastID);
  }
  return { purchase, units: unitIds };
}

// A checked-out deck: each card needs `need` copies and holds the entries in `hold`.
async function checkedOutDeck(ownerId, name, cards) {
  const deck = (await db.run(
    `INSERT INTO decks (user_id, name, game, checked_out) VALUES (?, ?, 'pokemon', 1)`, [ownerId, name]
  )).lastID;
  for (const card of cards) {
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)`, [deck, card.cardId, card.need]);
    for (const hold of card.hold || []) {
      await db.run(
        `INSERT INTO deck_allocations (entry_id, deck_id, card_id, quantity) VALUES (?, ?, ?, ?)`,
        [hold.entry, deck, card.cardId, hold.quantity || 1]
      );
    }
  }
  return deck;
}

const gift = (recipientId, items) => ({ recipient_id: recipientId, transfer_type: 'gift', offered_items: items });
const card = (entry, quantity = 1) => ({ type: 'card', id: entry, quantity });
const sealed = (unit) => ({ type: 'sealed', id: unit });
const ownerOf = async (entry) => (await db.get(`SELECT user_id FROM collection WHERE id = ?`, [entry]))?.user_id;

async function propose(userId, body) {
  return expect(await call('POST', '/api/transfers', userId, body), 201, 'proposing').transfer;
}

// --- The happy paths ---------------------------------------------------------------

async function testTradesGiftsAndHistory() {
  const alice = await addUser('transfer-api-alice');
  const bob = await addUser('transfer-api-bob');

  const aliceCard = await addCard(alice, { name: 'Card A', price: 0.30 });
  const bobCard = await addCard(bob, { name: 'Card B', price: 0.40, isTrade: 1 });
  const discovery = expect(await get(`/api/transfers/marked/${bob}`, alice), 200, 'discovery');
  assert.deepStrictEqual(discovery.cards.map(c => c.entry_id), [bobCard.entry]);
  assert.ok(!('purchase_price' in discovery.cards[0]), 'discovery must not reveal private cost basis');
  assert.ok(Object.hasOwn(discovery.cards[0], 'rarity'), 'discovery includes rarity for the trade card badge');
  console.log('PASS: trade discovery exposes marked cards only and omits private cost');

  let transfer = await propose(alice, {
    recipient_id: bob, transfer_type: 'trade', offered_items: [card(aliceCard.entry)], requested_items: [card(bobCard.entry)],
  });
  assert.strictEqual(transfer.status, 'pending');
  assert.strictEqual(transfer.proposer_username, 'transfer-api-alice');
  assert.strictEqual(transfer.recipient_username, 'transfer-api-bob');
  const bobView = expect(await get('/api/transfers', bob), 200, 'bob lists').transfers.find(t => t.id === transfer.id);
  const aliceSent = bobView.items.find(item => item.from_user_id === alice);
  const bobRequested = bobView.items.find(item => item.from_user_id === bob);
  assert.strictEqual(aliceSent.purchase_cost, null, "the other member must not see the sender's cost basis");
  assert.ok(!('purchase_cost' in aliceSent.item_snapshot));
  assert.strictEqual(aliceSent.from_username, 'transfer-api-alice');
  assert.strictEqual(bobRequested.purchase_cost, 0.4, 'a member sees the cost of their own item');
  const accepted = expect(await call('PUT', `/api/transfers/${transfer.id}/accept`, bob), 200, 'accepting');
  transfer = accepted.transfer;
  assert.strictEqual(transfer.status, 'accepted');
  const moved = await db.all(
    `SELECT user_id, card_id, purchase_price, location_id FROM collection WHERE card_id IN (?, ?)`,
    [aliceCard.cardId, bobCard.cardId]
  );
  assert.strictEqual(moved.find(row => row.card_id === aliceCard.cardId).user_id, bob);
  assert.strictEqual(moved.find(row => row.card_id === bobCard.cardId).user_id, alice);
  assert.strictEqual(moved.find(row => row.card_id === aliceCard.cardId).purchase_price, 0.4);
  assert.strictEqual(moved.find(row => row.card_id === bobCard.cardId).purchase_price, 0.3);
  assert.ok(moved.every(row => row.location_id == null), 'received cards must be unsorted');
  assert.ok(transfer.items.every(item => item.item_snapshot.name), 'accepted history keeps card snapshots');
  const received = expect(await get('/api/collection', bob), 200, 'collection').find(row => row.card_id === aliceCard.cardId);
  assert.strictEqual(received.acquired_transfer_id, transfer.id);
  assert.strictEqual(received.acquired_transfer_type, 'trade');
  assert.strictEqual(received.acquired_transfer_partner, 'transfer-api-alice');
  console.log('PASS: one-for-one trades exchange cost basis and move cards to the unsorted collection');

  const pastGiven = await addCard(alice, { name: 'Past Alice Given', price: 0.25 });
  const pastReceived = await addCard(alice, { name: 'Past Alice Received', price: 0.35 });
  const bobPastGiven = (await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, purchase_price) VALUES (?, ?, 1, 0.3)`, [pastReceived.cardId, bob]
  )).lastID;
  const bobPastReceived = (await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, purchase_price) VALUES (?, ?, 1, 0.2)`, [pastGiven.cardId, bob]
  )).lastID;
  let pastTrade = expect(await call('POST', '/api/transfers/history', alice, {
    recipient_id: bob,
    completed_at: '2024-02-10',
    message: 'First recorded trade',
    items: [
      { direction: 'given', card_id: pastGiven.cardId, quantity: 1, collection_entry_id: pastGiven.entry },
      { direction: 'received', card_id: pastReceived.cardId, quantity: 1, collection_entry_id: pastReceived.entry },
    ],
  }), 201, 'recording a past trade').trade;
  assert.strictEqual(pastTrade.status, 'pending_confirmation');
  assert.strictEqual(pastTrade.creator_username, 'transfer-api-alice');
  assert.strictEqual(pastTrade.recipient_username, 'transfer-api-bob');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE id IN (?, ?)`, [pastGiven.entry, pastReceived.entry])).n, 2,
    'a pending record must not change the creator inventory');
  pastTrade = expect(await call('PUT', `/api/transfers/history/${pastTrade.id}/confirm`, bob, {
    items: [
      { id: pastTrade.items[0].id, collection_entry_id: bobPastReceived },
      { id: pastTrade.items[1].id, collection_entry_id: bobPastGiven },
    ],
  }), 200, 'confirming').trade;
  assert.strictEqual(pastTrade.status, 'confirmed');
  assert.strictEqual(await db.get(`SELECT id FROM collection WHERE id = ?`, [pastGiven.entry]), undefined);
  assert.strictEqual(await db.get(`SELECT id FROM collection WHERE id = ?`, [bobPastGiven]), undefined);
  assert.strictEqual((await db.get(`SELECT acquired_via_historical_trade_item_id AS v FROM collection WHERE id = ?`, [pastReceived.entry])).v, pastTrade.items[1].id);
  assert.strictEqual((await db.get(`SELECT acquired_via_historical_trade_item_id AS v FROM collection WHERE id = ?`, [bobPastReceived])).v, pastTrade.items[0].id);
  const linked = expect(await get('/api/collection', bob), 200, 'collection').find(row => row.entry_id === bobPastReceived);
  assert.strictEqual(linked.acquired_historical_trade_id, pastTrade.id);
  assert.strictEqual(linked.acquired_historical_trade_partner, 'transfer-api-alice');
  console.log('PASS: past trades wait for the other member and reconcile both members\' copies on confirmation');

  const declined = expect(await call('POST', '/api/transfers/history', alice, {
    recipient_id: bob,
    completed_at: '2024-02-11',
    items: [
      { direction: 'given', card_id: pastGiven.cardId, quantity: 1 },
      { direction: 'received', card_id: pastReceived.cardId, quantity: 1 },
    ],
  }), 201, 'a history-only record').trade;
  expect(await call('PUT', `/api/transfers/history/${declined.id}/reject`, bob), 200, 'declining');
  assert.strictEqual((await db.get(`SELECT status FROM historical_trades WHERE id = ?`, [declined.id])).status, 'rejected');
  const bobHistory = expect(await get('/api/transfers/history', bob), 200, 'history');
  assert.ok(!bobHistory.trades.some(trade => trade.id === declined.id), 'the recipient no longer sees a declined record');
  assert.ok(expect(await get('/api/transfers/history', alice), 200, 'history').trades.some(trade => trade.id === declined.id),
    'its creator still does');
  console.log('PASS: history-only records can be declined without inventory changes');

  const aliceOffer = await addCard(alice, { name: 'Counter Card A', price: 0.25 });
  const bobOffer = await addCard(bob, { name: 'Counter Card B', price: 0.15 });
  const original = await propose(alice, {
    recipient_id: bob, transfer_type: 'trade', offered_items: [card(aliceOffer.entry)], requested_items: [],
  });
  assert.strictEqual(original.items.length, 1, 'an offer-only trade keeps the offered item');
  expect(await call('PUT', `/api/transfers/${original.id}/accept`, bob), 409, 'an offer-only trade', 'needs_counter');
  assert.strictEqual(await ownerOf(aliceOffer.entry), alice);
  const counter = expect(await call('POST', `/api/transfers/${original.id}/counter`, bob, {
    offered_items: [card(bobOffer.entry)], requested_items: [card(aliceOffer.entry)],
  }), 201, 'countering').transfer;
  assert.strictEqual(counter.response_to_transfer_id, original.id);
  expect(await call('PUT', `/api/transfers/${counter.id}/accept`, alice), 200, 'accepting the counter');
  assert.strictEqual((await db.get(`SELECT status FROM user_transfers WHERE id = ?`, [original.id])).status, 'countered');
  assert.strictEqual((await db.get(`SELECT purchase_price FROM collection WHERE user_id = ? AND card_id = ?`, [alice, bobOffer.cardId])).purchase_price, 0.25);
  assert.strictEqual((await db.get(`SELECT purchase_price FROM collection WHERE user_id = ? AND card_id = ?`, [bob, aliceOffer.cardId])).purchase_price, 0.15);
  console.log('PASS: offer-only trades need a counteroffer and keep the negotiation history');

  // No market prices at all: splitPrice falls back to equal shares.
  const aliceKnown = await addCard(alice, { name: 'Multi Alice Known', price: 0.20 });
  const aliceUnknown = await addCard(alice, { name: 'Multi Alice Unknown', price: null });
  const bobFirst = await addCard(bob, { name: 'Multi Bob First', price: 0.30, isTrade: 1 });
  const bobSecond = await addCard(bob, { name: 'Multi Bob Second', price: 0.40, isTrade: 1 });
  const multi = await propose(alice, {
    recipient_id: bob, transfer_type: 'trade',
    offered_items: [card(aliceKnown.entry), card(aliceUnknown.entry)],
    requested_items: [card(bobFirst.entry), card(bobSecond.entry)],
  });
  expect(await call('PUT', `/api/transfers/${multi.id}/accept`, bob), 200, 'accepting');
  const costOf = async (userId, cardId) => (await db.get(`SELECT purchase_price AS p FROM collection WHERE user_id = ? AND card_id = ?`, [userId, cardId])).p;
  assert.deepStrictEqual([await costOf(bob, aliceKnown.cardId), await costOf(bob, aliceUnknown.cardId)], [0.35, 0.35]);
  assert.deepStrictEqual([await costOf(alice, bobFirst.cardId), await costOf(alice, bobSecond.cardId)], [null, null]);
  console.log('PASS: unpriced trades split known costs evenly and keep unknown ones unknown');

  // Priced: a $100 card for a $95 card and a $5 card gives them $95 and $5.
  const dear = await addCard(alice, { name: 'Dear Card', price: 100, market: 100 });
  const big = await addCard(bob, { name: 'Big Card', price: 10, isTrade: 1, market: 95 });
  const small = await addCard(bob, { name: 'Small Card', price: 20, isTrade: 1, market: 5 });
  const weighted = await propose(alice, {
    recipient_id: bob, transfer_type: 'trade', offered_items: [card(dear.entry)], requested_items: [card(big.entry), card(small.entry)],
  });
  expect(await call('PUT', `/api/transfers/${weighted.id}/accept`, bob), 200, 'accepting');
  assert.deepStrictEqual([await costOf(alice, big.cardId), await costOf(alice, small.cardId)], [95, 5],
    'the received cards share the cost by market value, not evenly');
  assert.strictEqual(await costOf(bob, dear.cardId), 30, 'one received card carries the whole outgoing cost');
  console.log('PASS: trade costs are split by market value');

  const bundle = await addSealed(alice, { name: 'Booster Bundle', price: 20 });
  await db.run(`UPDATE sealed_units SET opened_at = CURRENT_TIMESTAMP WHERE id = ?`, [bundle.units[0]]);
  const pack = (await db.run(
    `INSERT INTO sealed_purchases (user_id, product_name, sealed_type, game, unit_price, quantity, source_unit_id)
     VALUES (?, 'Booster Pack', 'Booster Pack', 'pokemon', 0.60, 1, ?)`,
    [alice, bundle.units[0]]
  )).lastID;
  const packUnit = (await db.run(`INSERT INTO sealed_units (purchase_id, is_trade) VALUES (?, 1)`, [pack])).lastID;
  assert.strictEqual(expect(await get(`/api/transfers/marked/${alice}`, bob), 200, 'marked').sealed[0].unit_id, packUnit);
  const packGift = await propose(alice, gift(bob, [sealed(packUnit)]));
  expect(await call('PUT', `/api/transfers/${packGift.id}/accept`, bob), 200, 'accepting the pack');
  const receivedPurchase = await db.get(`SELECT * FROM sealed_purchases WHERE user_id = ? AND product_name = 'Booster Pack'`, [bob]);
  assert.strictEqual(receivedPurchase.unit_price, 0);
  assert.strictEqual(receivedPurchase.source_product_name, 'Booster Bundle');
  assert.strictEqual(receivedPurchase.source_unit_number, 1);
  assert.strictEqual(receivedPurchase.source_unit_id, null, "the parent unit is another account's: kept as a snapshot");
  assert.strictEqual(receivedPurchase.store, null, 'no English written into the purchase');
  assert.strictEqual(receivedPurchase.notes, null);
  assert.strictEqual((await db.get(`SELECT purchase_id FROM sealed_units WHERE id = ?`, [packUnit])).purchase_id, receivedPurchase.id);
  const visible = expect(await get('/api/sealed/purchases', bob), 200, 'purchases').purchases.find(p => p.id === receivedPurchase.id);
  assert.strictEqual(visible.source_product_name, 'Booster Bundle');
  assert.strictEqual(visible.acquired_transfer_partner, 'transfer-api-alice');
  assert.strictEqual(visible.acquired_transfer_type, 'gift');
  const unitRow = expect(await get('/api/sealed/units?opened=0', bob), 200, 'units').units.find(u => u.id === packUnit);
  assert.strictEqual(unitRow.acquired_transfer_partner, 'transfer-api-alice');
  assert.strictEqual(unitRow.acquired_transfer_type, 'gift');
  const ownPurchase = expect(await get('/api/sealed/purchases', alice), 200, 'purchases').purchases.find(p => p.id === bundle.purchase);
  assert.strictEqual(ownPurchase.acquired_transfer_partner, null, 'a bought purchase came from no one');
  assert.strictEqual(ownPurchase.acquired_transfer_type, null);
  console.log('PASS: gifts move unopened packs at no cost, keep their bundle origin, and say who sent them');

  expect(await call('PUT', `/api/transfers/sealed/${bundle.units[0]}/trade`, alice, { is_trade: true }), 409,
    'an opened bundle', 'asset_changed');
  console.log('PASS: an opened unit cannot be marked for trade');

  const staleOffered = await addCard(alice, { name: 'Stale Offered Card', price: 1 });
  const staleRequested = await addCard(bob, { name: 'Stale Requested Card', price: 2, isTrade: 1 });
  const stale = await propose(alice, {
    recipient_id: bob, transfer_type: 'trade', offered_items: [card(staleOffered.entry)], requested_items: [card(staleRequested.entry)],
  });
  await db.run(`DELETE FROM collection WHERE id = ?`, [staleRequested.entry]);
  expect(await call('PUT', `/api/transfers/${stale.id}/accept`, bob), 409, 'a deleted requested card', 'asset_changed');
  assert.strictEqual(await ownerOf(staleOffered.entry), alice, 'a failed acceptance moves nothing');
  console.log('PASS: acceptance rechecks both sides and rolls back atomically');
}

// --- Opt-in, API keys, who may do what --------------------------------------------------

async function testOptInAndApiKeys() {
  const ann = await addUser('optin-ann');
  const ben = await addUser('optin-ben');
  const cleo = await addUser('optin-cleo', { trades: false });
  const annCard = await addCard(ann, { isTrade: 1 });
  const cleoCard = await addCard(cleo, { isTrade: 1 });

  expect(await get('/api/transfers/users', cleo), 403, 'listing members without opting in', 'trades_disabled');
  expect(await call('POST', '/api/transfers', cleo, gift(ann, [card(cleoCard.entry)])), 403, 'offering without opting in', 'trades_disabled');
  expect(await get(`/api/transfers/marked/${ann}`, cleo), 403, 'browsing without opting in', 'trades_disabled');
  expect(await call('POST', '/api/transfers/history', cleo, {
    recipient_id: ann, completed_at: '2024-01-01',
    items: [{ direction: 'given', card_id: cleoCard.cardId }, { direction: 'received', card_id: annCard.cardId }],
  }), 403, 'recording without opting in', 'trades_disabled');
  assert.deepStrictEqual(expect(await get('/api/transfers', cleo), 200, 'own offers stay readable'), { transfers: [], next_cursor: null });
  expect(await get('/api/transfers/history', cleo), 200, 'own records stay readable');

  const listed = expect(await get('/api/transfers/users', ann), 200, 'listing members').users.map(u => u.id);
  assert.ok(listed.includes(ben), 'a member who opted in is listed');
  assert.ok(!listed.includes(cleo), 'one who did not is not');
  assert.ok(!listed.includes(ann), 'never yourself');
  const unknown = expect(await call('POST', '/api/transfers', ann, gift(999999, [card(annCard.entry)])), 404, 'no such member', 'not_found');
  const notTrading = expect(await call('POST', '/api/transfers', ann, gift(cleo, [card(annCard.entry)])), 404, 'a member who does not trade', 'not_found');
  assert.deepStrictEqual(notTrading, unknown, 'not trading reads exactly like no such account');
  expect(await get(`/api/transfers/marked/${cleo}`, ann), 404, "a non-trader's marked items", 'not_found');
  expect(await call('POST', '/api/transfers/history', ann, {
    recipient_id: cleo, completed_at: '2024-01-01',
    items: [{ direction: 'given', card_id: annCard.cardId }, { direction: 'received', card_id: cleoCard.cardId }],
  }), 404, 'recording with a non-trader', 'not_found');
  console.log('PASS: trading is opt-in: a member who has not turned it on is invisible and cannot act');

  // Turning it off keeps what is open readable and settleable, and nothing more.
  const toBen = await propose(ann, gift(ben, [card(annCard.entry)]));
  const second = await propose(ann, gift(ben, [card(annCard.entry)]));
  await db.run(`UPDATE users SET trades_enabled = 0 WHERE id = ?`, [ben]);
  assert.ok(expect(await get('/api/transfers', ben), 200, 'listing').transfers.some(t => t.id === toBen.id));
  expect(await call('PUT', `/api/transfers/${toBen.id}/accept`, ben), 403, 'accepting after opting out', 'trades_disabled');
  expect(await call('POST', `/api/transfers/${toBen.id}/counter`, ben, {
    offered_items: [card(annCard.entry)], requested_items: [card(annCard.entry)],
  }), 403, 'countering after opting out', 'trades_disabled');
  expect(await call('PUT', `/api/transfers/${toBen.id}/reject`, ben), 200, 'rejecting after opting out');
  await db.run(`UPDATE users SET trades_enabled = 0 WHERE id = ?`, [ann]);
  expect(await call('PUT', `/api/transfers/${second.id}/cancel`, ann), 200, 'cancelling after opting out');
  console.log('PASS: a member who turns trading off still sees, rejects and cancels what they have');

  const paths = ['/api/transfers', '/api/transfers/users', `/api/transfers/marked/${ann}`, '/api/transfers/history',
    '/api/transfers/external', '/api/transfers/external/contacts', `/api/transfers/${toBen.id}`];
  for (const pathName of paths) {
    expect(await get(pathName, ann, { apiKey: true }), 403, `${pathName} with an API key`, 'api_key_refused');
  }
  console.log('PASS: every /api/transfers route refuses an API key');
}

async function testWhoMayDoWhat() {
  const dana = await addUser('auth-dana');
  const eli = await addUser('auth-eli');
  const fay = await addUser('auth-fay');
  const danaCard = await addCard(dana, { name: 'Dana Card' });
  const eliCard = await addCard(eli, { name: 'Eli Card', isTrade: 1 });
  const offer = await propose(dana, {
    recipient_id: eli, transfer_type: 'trade', offered_items: [card(danaCard.entry)], requested_items: [card(eliCard.entry)],
  });
  for (const action of ['accept', 'reject', 'cancel']) {
    expect(await call('PUT', `/api/transfers/${offer.id}/${action}`, fay), 403, `a third member's ${action}`, 'forbidden');
  }
  expect(await call('POST', `/api/transfers/${offer.id}/counter`, fay, {
    offered_items: [card(eliCard.entry)], requested_items: [card(danaCard.entry)],
  }), 403, "a third member's counter", 'forbidden');
  expect(await call('PUT', `/api/transfers/${offer.id}/accept`, dana), 403, 'the proposer accepting', 'forbidden');
  expect(await call('POST', `/api/transfers/${offer.id}/counter`, dana, {
    offered_items: [card(danaCard.entry)], requested_items: [card(eliCard.entry)],
  }), 403, 'the proposer countering', 'forbidden');
  expect(await call('PUT', `/api/transfers/${offer.id}/cancel`, eli), 403, 'the recipient cancelling', 'forbidden');
  expect(await call('PUT', `/api/transfers/${offer.id}/reject`, dana), 403, 'the proposer rejecting', 'forbidden');
  expect(await call('PUT', '/api/transfers/999999/accept', eli), 404, 'no such offer', 'not_found');
  assert.strictEqual((await db.get(`SELECT status FROM user_transfers WHERE id = ?`, [offer.id])).status, 'pending');
  assert.strictEqual(await ownerOf(danaCard.entry), dana);

  // Asking for what the other member did not mark is asking for nothing that exists.
  const unmarked = await addCard(eli, { name: 'Eli Unmarked' });
  const missing = expect(await call('POST', '/api/transfers', dana, {
    recipient_id: eli, transfer_type: 'trade', offered_items: [card(danaCard.entry)], requested_items: [card(unmarked.entry)],
  }), 404, 'requesting an unmarked card', 'not_found');
  const nobody = expect(await call('POST', '/api/transfers', dana, {
    recipient_id: eli, transfer_type: 'trade', offered_items: [card(danaCard.entry)], requested_items: [card(999999)],
  }), 404, 'requesting a card that does not exist', 'not_found');
  assert.deepStrictEqual(missing, nobody, "an unmarked card reads exactly like none: nothing about the other's collection");
  expect(await call('POST', '/api/transfers', dana, gift(eli, [card(eliCard.entry)])), 404, "offering someone else's card", 'not_found');
  expect(await call('POST', '/api/transfers', dana, gift(eli, [{ type: 'card', id: 'x' }])), 400, 'a bad id', 'invalid');
  expect(await call('POST', '/api/transfers', dana, { ...gift(eli, [card(danaCard.entry)]), transfer_type: 'swap' }), 400, 'a bad type', 'invalid');
  expect(await call('POST', '/api/transfers', dana, gift(dana, [card(danaCard.entry)])), 400, 'an offer to yourself', 'invalid');
  console.log('PASS: only the recipient accepts, rejects or counters, only the proposer cancels, and refusals reveal nothing');
}

// --- Races ------------------------------------------------------------------------------

async function testConcurrency() {
  const gus = await addUser('race-gus');
  const hal = await addUser('race-hal');
  const gusCard = await addCard(gus, { name: 'Race Card' });
  const offer = await propose(gus, gift(hal, [card(gusCard.entry)]));
  const both = await Promise.all([
    call('PUT', `/api/transfers/${offer.id}/accept`, hal),
    call('PUT', `/api/transfers/${offer.id}/accept`, hal),
  ]);
  assert.deepStrictEqual(both.map(r => r.status).sort(), [200, 409], `double accept: ${both.map(r => r.text).join(' | ')}`);
  assert.strictEqual(both.find(r => r.status === 409).json.code, 'not_pending');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ? AND card_id = ?`, [hal, gusCard.cardId])).n, 1,
    'the card arrived once');
  console.log('PASS: a double accept hands the card over once');

  for (const [action, by] of [['cancel', gus], ['reject', hal]]) {
    const entry = (await addCard(gus, { name: `After ${action}` })).entry;
    const settled = await propose(gus, gift(hal, [card(entry)]));
    expect(await call('PUT', `/api/transfers/${settled.id}/${action}`, by), 200, action);
    expect(await call('PUT', `/api/transfers/${settled.id}/accept`, hal), 409, `accepting after ${action}`, 'not_pending');
    expect(await call('PUT', `/api/transfers/${settled.id}/${action}`, by), 409, `${action} twice`, 'not_pending');
    assert.strictEqual(await ownerOf(entry), gus);
  }
  const mine = await addCard(gus, { name: 'Countered Card' });
  const theirs = await addCard(hal, { name: 'Counter Answer' });
  const countered = await propose(gus, {
    recipient_id: hal, transfer_type: 'trade', offered_items: [card(mine.entry)], requested_items: [],
  });
  expect(await call('POST', `/api/transfers/${countered.id}/counter`, hal, {
    offered_items: [card(theirs.entry)], requested_items: [card(mine.entry)],
  }), 201, 'countering');
  expect(await call('PUT', `/api/transfers/${countered.id}/accept`, hal), 409, 'accepting a countered offer', 'not_pending');
  expect(await call('POST', `/api/transfers/${countered.id}/counter`, hal, {
    offered_items: [card(theirs.entry)], requested_items: [card(mine.entry)],
  }), 409, 'countering twice', 'not_pending');
  console.log('PASS: an offer settled by cancel, reject or counter cannot be accepted');

  // One copy in two offers: whichever is accepted first takes it.
  const only = await addCard(gus, { name: 'Only Copy' });
  const first = await propose(gus, gift(hal, [card(only.entry)]));
  const secondOffer = await propose(gus, gift(hal, [card(only.entry)]));
  const raced = await Promise.all([
    call('PUT', `/api/transfers/${first.id}/accept`, hal),
    call('PUT', `/api/transfers/${secondOffer.id}/accept`, hal),
  ]);
  assert.deepStrictEqual(raced.map(r => r.status).sort(), [200, 409], `one copy, two offers: ${raced.map(r => r.text).join(' | ')}`);
  assert.strictEqual(raced.find(r => r.status === 409).json.code, 'asset_changed');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE card_id = ?`, [only.cardId])).n, 1, 'one copy, still one copy');
  const pendingAfter = (await db.all(`SELECT status FROM user_transfers WHERE id IN (?, ?)`, [first.id, secondOffer.id])).map(r => r.status).sort();
  assert.deepStrictEqual(pendingAfter, ['accepted', 'pending'], 'the losing offer stays pending, for its proposer to cancel');
  console.log('PASS: one copy offered twice moves once');
}

// --- The copy offered is the copy that moves ------------------------------------------

async function testOfferedCopyIsWhatMoves() {
  const ida = await addUser('copy-ida');
  const jon = await addUser('copy-jon');
  const slab = await addCard(ida, { name: 'Edited Card' });
  const offer = await propose(ida, gift(jon, [card(slab.entry)]));
  await db.run(`UPDATE collection SET condition = 'Damaged' WHERE id = ?`, [slab.entry]);
  expect(await call('PUT', `/api/transfers/${offer.id}/accept`, jon), 409, 'an edited copy', 'asset_changed');
  assert.strictEqual(await ownerOf(slab.entry), ida);
  const stored = JSON.parse((await db.get(`SELECT item_snapshot FROM user_transfer_items WHERE transfer_id = ?`, [offer.id])).item_snapshot);
  assert.strictEqual(stored.condition, 'Near Mint', 'the snapshot stays what was offered');
  for (const [column, value] of [['printing', 'Holofoil'], ['language', 'Japanese'], ['grader', 'PSA']]) {
    await db.run(`UPDATE collection SET condition = 'Near Mint', printing = 'Normal', language = 'English', grader = 'Raw' WHERE id = ?`, [slab.entry]);
    const again = await propose(ida, gift(jon, [card(slab.entry)]));
    await db.run(`UPDATE collection SET ${column} = ? WHERE id = ?`, [value, slab.entry]);
    expect(await call('PUT', `/api/transfers/${again.id}/accept`, jon), 409, `a changed ${column}`, 'asset_changed');
    await call('PUT', `/api/transfers/${again.id}/cancel`, ida);
  }
  await db.run(`UPDATE collection SET condition = 'Near Mint', printing = 'Normal', language = 'English', grader = 'Raw' WHERE id = ?`, [slab.entry]);
  await call('PUT', `/api/transfers/${offer.id}/cancel`, ida);

  // A new price or a note is the owner's own business, and does not stop it. What
  // arrives is the copy, never the sender's note or their sealed link.
  const unit = await addSealed(ida, { name: 'Pulled From' });
  await db.run(`UPDATE collection SET notes = 'private note', sealed_unit_id = ? WHERE id = ?`, [unit.units[0], slab.entry]);
  const fine = await propose(ida, gift(jon, [card(slab.entry)]));
  assert.ok(!('sealed_unit_id' in fine.items[0].item_snapshot), 'no sealed link in the snapshot');
  await db.run(`UPDATE collection SET purchase_price = 7, notes = 'changed note' WHERE id = ?`, [slab.entry]);
  expect(await call('PUT', `/api/transfers/${fine.id}/accept`, jon), 200, 'accepting after a price edit');
  const arrived = await db.get(`SELECT notes, sealed_unit_id, condition FROM collection WHERE user_id = ? AND card_id = ?`, [jon, slab.cardId]);
  assert.deepStrictEqual(arrived, { notes: null, sealed_unit_id: null, condition: 'Near Mint' });
  console.log('PASS: an offered copy that changed is refused at acceptance; the snapshot, notes and sealed link stay put');

  const graded = await addCard(ida, { name: 'Slab' });
  await db.run(`UPDATE collection SET grader = 'PSA', grade = 10, cert_number = 'CERT-1' WHERE id = ?`, [graded.entry]);
  expect(await call('POST', '/api/transfers', ida, gift(jon, [card(graded.entry, 2)])), 400, 'two of one slab', 'invalid');
  const slabOffer = await propose(ida, gift(jon, [card(graded.entry)]));
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, grader, grade, cert_number) VALUES (?, ?, 1, 'PSA', 10, 'CERT-1')`,
    [graded.cardId, jon]
  );
  expect(await call('PUT', `/api/transfers/${slabOffer.id}/accept`, jon), 409, 'a slab already owned', 'already_owned');
  console.log('PASS: a slab is one copy, and one already owned is refused');
}

// --- Sealed units follow the claim rule --------------------------------------------------

async function testSealedClaims() {
  const kai = await addUser('claim-kai');      // bought a shared purchase
  const lou = await addUser('claim-lou');      // claimed a unit of it
  const max = await addUser('claim-max');      // receives
  const shared = await addSealed(kai, { name: 'Shared Box', price: 30, units: 2, shared: 1 });
  const [claimedUnit, freeUnit] = shared.units;
  // Opened by Lou, then resealed: still sealed, and Lou's.
  await db.run(`UPDATE sealed_units SET claimed_by_user_id = ? WHERE id = ?`, [lou, claimedUnit]);

  expect(await call('POST', '/api/transfers', kai, gift(max, [sealed(claimedUnit)])), 409, "giving a unit someone claimed", 'unit_claimed');
  const fromClaimant = await propose(lou, gift(max, [sealed(claimedUnit)]));
  expect(await call('PUT', `/api/transfers/${fromClaimant.id}/accept`, max), 200, "accepting the claimant's unit");
  const movedUnit = await db.get(`SELECT * FROM sealed_units WHERE id = ?`, [claimedUnit]);
  assert.strictEqual(movedUnit.claimed_by_user_id, null, 'the claim is cleared when the unit moves');
  assert.ok(await getOwnedUnit(max, claimedUnit), 'the recipient owns it');
  assert.ok(!(await getOwnedUnit(lou, claimedUnit)), 'the claimant no longer does');
  assert.ok(!(await getOwnedUnit(kai, claimedUnit)), 'nor the buyer');
  assert.strictEqual((await db.get(`SELECT quantity FROM sealed_purchases WHERE id = ?`, [shared.purchase])).quantity, 1);
  console.log('PASS: a claimed unit is its claimant\'s to give, not its buyer\'s, and the claim ends when it moves');

  const late = await propose(kai, gift(max, [sealed(freeUnit)]));
  await db.run(`UPDATE sealed_units SET claimed_by_user_id = ? WHERE id = ?`, [lou, freeUnit]);
  expect(await call('PUT', `/api/transfers/${late.id}/accept`, max), 409, 'a unit claimed after the offer', 'unit_claimed');
  assert.strictEqual((await db.get(`SELECT purchase_id FROM sealed_units WHERE id = ?`, [freeUnit])).purchase_id, shared.purchase);
  console.log('PASS: a unit claimed after the offer is refused at acceptance');

  // Opened by its buyer (which claims it for them) and resealed: still theirs to give,
  // and the recipient gets a unit that is wholly theirs, contents not yet applied.
  const own = await addSealed(kai, { name: 'Resealed Box', price: 12 });
  await db.run(
    `UPDATE sealed_units SET claimed_by_user_id = ?, opened_at = NULL, components_applied_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [kai, own.units[0]]
  );
  const resealed = await propose(kai, gift(max, [sealed(own.units[0])]));
  expect(await call('PUT', `/api/transfers/${resealed.id}/accept`, max), 200, 'accepting a resealed unit');
  const after = await db.get(`SELECT claimed_by_user_id, components_applied_at, is_trade FROM sealed_units WHERE id = ?`, [own.units[0]]);
  assert.deepStrictEqual(after, { claimed_by_user_id: null, components_applied_at: null, is_trade: 0 });
  assert.ok(await getOwnedUnit(max, own.units[0]), 'the recipient owns the resealed unit');
  assert.ok(!(await getOwnedUnit(kai, own.units[0])), 'the old claim no longer makes it the sender\'s');
  expect(await call('PUT', `/api/transfers/sealed/${own.units[0]}/trade`, max, { is_trade: true }), 200, 'the recipient marks it for trade');
  expect(await call('PUT', `/api/transfers/sealed/${own.units[0]}/trade`, kai, { is_trade: false }), 404, 'the sender cannot', 'not_found');
  console.log('PASS: a resealed unit moves wholly to its recipient');

  // Opened units cannot change hands.
  const opened = await addSealed(kai, { name: 'Opened Box' });
  await db.run(`UPDATE sealed_units SET opened_at = CURRENT_TIMESTAMP, claimed_by_user_id = ? WHERE id = ?`, [kai, opened.units[0]]);
  expect(await call('POST', '/api/transfers', kai, gift(max, [sealed(opened.units[0])])), 409, 'an opened unit', 'asset_changed');
  expect(await call('POST', '/api/transfers', kai, gift(max, [sealed(own.units[0])])), 404, "a unit that is now someone else's", 'not_found');
}

// --- Copies a checked-out deck holds --------------------------------------------------------

async function testDeckAllocations() {
  const ned = await addUser('deck-ned');
  const ola = await addUser('deck-ola');
  const pair = await addCard(ned, { name: 'Deck Pair', quantity: 2, isTrade: 1 });
  await checkedOutDeck(ned, 'Ned Deck', [{ cardId: pair.cardId, need: 1, hold: [{ entry: pair.entry, quantity: 1 }] }]);
  const refused = expect(await call('POST', '/api/transfers', ned, gift(ola, [card(pair.entry, 2)])), 409,
    'offering copies a deck holds', 'deck_allocated');
  assert.deepStrictEqual(refused.decks, ['Ned Deck']);
  const marked = expect(await get(`/api/transfers/marked/${ned}`, ola), 200, 'marked').cards.find(c => c.entry_id === pair.entry);
  assert.strictEqual(marked.quantity, 1, 'only the free copy is on offer');
  const oneFree = await propose(ned, gift(ola, [card(pair.entry, 1)]));
  assert.deepStrictEqual(oneFree.deck_warnings, [], 'a deck that has its copy loses nothing');
  expect(await call('PUT', `/api/transfers/${oneFree.id}/accept`, ola), 200, 'accepting the free copy');
  assert.strictEqual((await db.get(`SELECT quantity FROM collection WHERE id = ?`, [pair.entry])).quantity, 1);
  assert.ok(await db.get(`SELECT 1 FROM deck_allocations WHERE entry_id = ?`, [pair.entry]), 'the deck still holds its copy');

  // The other member's copy, taken by a deck after the offer: refused, without
  // saying which deck.
  const later = await addCard(ned, { name: 'Later Deck Card' });
  const offer = await propose(ned, gift(ola, [card(later.entry)]));
  await checkedOutDeck(ned, 'Ned Later Deck', [{ cardId: later.cardId, need: 1, hold: [{ entry: later.entry }] }]);
  const theirs = expect(await call('PUT', `/api/transfers/${offer.id}/accept`, ola), 409, "the other member's held copy", 'asset_changed');
  assert.ok(!('decks' in theirs), "never the other member's deck names");
  // The caller's own copy, taken after the offer: refused with the deck's name.
  const olaCard = await addCard(ola, { name: 'Ola Requested', isTrade: 1 });
  const nedOffer = await addCard(ned, { name: 'Ned Offer' });
  const trade = await propose(ned, {
    recipient_id: ola, transfer_type: 'trade', offered_items: [card(nedOffer.entry)], requested_items: [card(olaCard.entry)],
  });
  await checkedOutDeck(ola, 'Ola Deck', [{ cardId: olaCard.cardId, need: 1, hold: [{ entry: olaCard.entry }] }]);
  const own = expect(await call('PUT', `/api/transfers/${trade.id}/accept`, ola), 409, 'my own held copy', 'deck_allocated');
  assert.deepStrictEqual(own.decks, ['Ola Deck']);
  assert.strictEqual(await ownerOf(nedOffer.entry), ned);
  console.log('PASS: copies a checked-out deck holds cannot be offered or accepted away');

  // Warnings, from what decks hold and what they still miss: a deck holding one of
  // the two copies it needs is short the moment the last free copy goes.
  const needed = await addCard(ned, { name: 'Needed Card' });
  const spare = (await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES (?, ?, 1)`, [needed.cardId, ned])).lastID;
  await checkedOutDeck(ned, 'Short Deck', [{ cardId: needed.cardId, need: 2, hold: [{ entry: needed.entry }] }]);
  const warned = await propose(ned, gift(ola, [card(spare)]));
  assert.strictEqual(warned.deck_warnings.length, 1);
  assert.strictEqual(warned.deck_warnings[0].copies_short, 1);
  assert.deepStrictEqual(warned.deck_warnings[0].decks, ['Short Deck']);
  assert.strictEqual(warned.deck_warnings[0].card_id, needed.cardId);
  const listedWarning = expect(await get('/api/transfers', ned), 200, 'listing').transfers.find(t => t.id === warned.id).deck_warnings;
  assert.deepStrictEqual(listedWarning, warned.deck_warnings, 'the list reports the same warning');
  assert.deepStrictEqual(expect(await get('/api/transfers', ola), 200, 'listing').transfers.find(t => t.id === warned.id).deck_warnings, [],
    "never the other member's");
  const accepted = expect(await call('PUT', `/api/transfers/${warned.id}/accept`, ola), 200, 'accepting');
  assert.deepStrictEqual(accepted.deck_warnings, [], "the accepting member is not warned about the sender's deck");
  // A deck that holds all it needs is not warned about however many free copies go.
  const plenty = await addCard(ned, { name: 'Plenty', quantity: 3 });
  const held = (await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES (?, ?, 1)`, [plenty.cardId, ned])).lastID;
  await checkedOutDeck(ned, 'Full Deck', [{ cardId: plenty.cardId, need: 1, hold: [{ entry: held }] }]);
  assert.deepStrictEqual((await propose(ned, gift(ola, [card(plenty.entry, 3)]))).deck_warnings, []);
  console.log('PASS: deck warnings come from what decks hold and still miss, so they are true');
}

// --- Spam and paging ------------------------------------------------------------------------

async function testPendingCapAndPaging() {
  const pia = await addUser('cap-pia');
  const quinn = await addUser('cap-quinn');
  const piaCard = await addCard(pia, { name: 'Cap Card' });
  const quinnCard = await addCard(quinn, { name: 'Cap Answer' });
  const offers = [];
  for (let i = 0; i < 5; i++) offers.push(await propose(pia, gift(quinn, [card(piaCard.entry)])));
  for (let i = 0; i < 5; i++) await propose(quinn, gift(pia, [card(quinnCard.entry)]));
  expect(await call('POST', '/api/transfers', pia, gift(quinn, [card(piaCard.entry)])), 409, 'an eleventh open offer', 'too_many_pending');
  expect(await call('POST', '/api/transfers', quinn, gift(pia, [card(quinnCard.entry)])), 409, 'either way round', 'too_many_pending');
  const trade = await db.run(`UPDATE user_transfers SET transfer_type = 'trade' WHERE id = ?`, [offers[0].id]);
  assert.strictEqual(trade.changes, 1);
  expect(await call('POST', `/api/transfers/${offers[0].id}/counter`, quinn, {
    offered_items: [card(quinnCard.entry)], requested_items: [card(piaCard.entry)],
  }), 201, 'a counter replaces the offer it answers');
  expect(await call('PUT', `/api/transfers/${offers[1].id}/cancel`, pia), 200, 'cancelling one');
  await propose(pia, gift(quinn, [card(piaCard.entry)]));
  console.log('PASS: at most ten open offers between two members, counting both directions');

  // Paging: the open offer is on page one however old; settled ones follow, newest first.
  const rae = await addUser('page-rae');
  const sol = await addUser('page-sol');
  const raeCard = await addCard(rae, { name: 'Page Card' });
  const old = await propose(rae, gift(sol, [card(raeCard.entry)]));
  const closed = [];
  for (let i = 0; i < 3; i++) {
    const offer = await propose(rae, gift(sol, [card(raeCard.entry)]));
    expect(await call('PUT', `/api/transfers/${offer.id}/cancel`, rae), 200, 'cancelling');
    closed.push(offer.id);
  }
  const first = expect(await get('/api/transfers?limit=2', rae), 200, 'page one');
  assert.deepStrictEqual(first.transfers.map(t => t.id), [closed[2], closed[1], old.id], 'two settled offers, and the old open one');
  assert.ok(first.next_cursor, 'more to come');
  const second = expect(await get(`/api/transfers?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`, rae), 200, 'page two');
  assert.deepStrictEqual(second.transfers.map(t => t.id), [closed[0]], 'the rest, and no open offer again');
  assert.strictEqual(second.next_cursor, null, 'the last page');
  assert.ok(second.transfers[0].items.length, 'items come along');
  const all = expect(await get('/api/transfers', rae), 200, 'default page');
  assert.strictEqual(all.transfers.length, 4);
  assert.strictEqual(all.next_cursor, null);
  for (const query of ['limit=0', 'limit=101', 'limit=x', 'cursor=abc', 'cursor=-1']) {
    expect(await get(`/api/transfers?${query}`, rae), 400, `?${query}`, 'invalid');
  }
  console.log('PASS: offers page newest first, with every open offer on the first page');

  // Records page by the date the trade happened.
  const tom = await addUser('page-tom');
  const given = await addCard(rae, { name: 'Record Given' });
  const got = await addCard(tom, { name: 'Record Received' });
  const record = async (date) => expect(await call('POST', '/api/transfers/history', rae, {
    recipient_id: tom, completed_at: date,
    items: [{ direction: 'given', card_id: given.cardId }, { direction: 'received', card_id: got.cardId }],
  }), 201, 'recording').trade;
  const waiting = await record('2023-01-01');
  const declined = [];
  for (const date of ['2024-01-01', '2024-02-01', '2024-03-01']) {
    const trade = await record(date);
    expect(await call('PUT', `/api/transfers/history/${trade.id}/reject`, tom), 200, 'declining');
    declined.push(trade.id);
  }
  const page1 = expect(await get('/api/transfers/history?limit=2', rae), 200, 'records page one');
  assert.deepStrictEqual(page1.trades.map(t => t.id), [declined[2], declined[1], waiting.id]);
  const page2 = expect(await get(`/api/transfers/history?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`, rae), 200, 'records page two');
  assert.deepStrictEqual(page2.trades.map(t => t.id), [declined[0]]);
  assert.strictEqual(page2.next_cursor, null);
  console.log('PASS: trade records page newest first, with every waiting record on the first page');

  // The same cap on records waiting for confirmation.
  for (let i = 0; i < 9; i++) await record('2024-04-01');
  expect(await call('POST', '/api/transfers/history', rae, {
    recipient_id: tom, completed_at: '2024-04-02',
    items: [{ direction: 'given', card_id: given.cardId }, { direction: 'received', card_id: got.cardId }],
  }), 409, 'an eleventh waiting record', 'too_many_pending');
  console.log('PASS: at most ten records waiting between two members');
}

// --- A deleted account --------------------------------------------------------------------

async function testDeletedAccount() {
  const uma = await addUser('gone-uma');
  const vic = await addUser('stays-vic');
  const umaCard = await addCard(uma, { name: 'Left Behind' });
  const umaMore = await addCard(uma, { name: 'Never Sent' });
  const vicCard = await addCard(vic, { name: 'Vic Card' });
  const accepted = await propose(uma, gift(vic, [card(umaCard.entry)]));
  expect(await call('PUT', `/api/transfers/${accepted.id}/accept`, vic), 200, 'accepting');
  const pending = await propose(uma, gift(vic, [card(umaMore.entry)]));
  const record = expect(await call('POST', '/api/transfers/history', vic, {
    recipient_id: uma, completed_at: '2024-05-01',
    items: [{ direction: 'given', card_id: vicCard.cardId }, { direction: 'received', card_id: umaCard.cardId }],
  }), 201, 'recording').trade;

  // What the admin delete does (routes/admin.js), in one transaction.
  await db.withTransaction(async () => {
    await closePendingTradesFor(uma);
    await db.run(`DELETE FROM collection WHERE user_id = ?`, [uma]);
    await db.run(`DELETE FROM users WHERE id = ?`, [uma]);
  });

  const offers = expect(await get('/api/transfers', vic), 200, 'listing after the deletion').transfers;
  const kept = offers.find(t => t.id === accepted.id);
  assert.ok(kept, "the other member's history survives the deletion");
  assert.strictEqual(kept.proposer_id, null);
  assert.strictEqual(kept.proposer_username, 'gone-uma', 'named from the snapshot');
  assert.strictEqual(kept.items[0].from_username, 'gone-uma');
  assert.strictEqual(kept.items[0].item_snapshot.name, 'Left Behind');
  assert.strictEqual(offers.find(t => t.id === pending.id).status, 'cancelled', 'nothing stays pending against a deleted account');
  const records = expect(await get('/api/transfers/history', vic), 200, 'records').trades;
  const closed = records.find(t => t.id === record.id);
  assert.strictEqual(closed.status, 'rejected', 'a waiting record is rejected');
  assert.strictEqual(closed.recipient_username, 'gone-uma');
  const copy = expect(await get('/api/collection', vic), 200, 'collection').find(row => row.card_id === umaCard.cardId);
  assert.strictEqual(copy.acquired_transfer_id, accepted.id, 'the received copy keeps its provenance');
  assert.strictEqual(copy.acquired_transfer_partner, 'gone-uma');
  console.log('PASS: deleting an account keeps the other member\'s history, named from snapshots, and settles what was open');
}

async function main() {
  await db.initDb();
  base = await startApp();
  try {
    await testTradesGiftsAndHistory();
    await testOptInAndApiKeys();
    await testWhoMayDoWhat();
    await testConcurrency();
    await testOfferedCopyIsWhatMoves();
    await testSealedClaims();
    await testDeckAllocations();
    await testPendingCapAndPaging();
    await testDeletedAccount();
  } finally {
    await cleanup();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
