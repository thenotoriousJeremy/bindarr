// Trades and gifts between two members, end to end against a real server and its
// real sign-in: two accounts log in with their passwords, turn trading on in
// Settings, and a gift and a trade are offered and accepted over HTTP. Then an API
// key is refused by every trade route, and an admin deletes one account while the
// other keeps its history. The unit suite (test/transfers.test.js) covers the
// refusals case by case behind a stand-in gate; this one proves the real gate,
// mounts and opt-in carry them.
//
// Runs offline (harness.js): every card is seeded into card_cache, and nothing
// here reaches a provider.
const assert = require('assert');
const crypto = require('crypto');
const harness = require('./harness');

const tmp = harness.tempDatabase('transfers');
const db = require('../../src/db');

let srv;

async function main() {
  await harness.prepare(db);
  const { hashPassword } = require('../../src/utils/authHelpers');
  const account = async (username, password) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [username, await hashPassword(password), crypto.randomBytes(16).toString('hex')]
  )).lastID;
  const aliceId = await account('alice', 'alice-password-1');
  const bobId = await account('bob', 'bob-password-1');
  for (const [id, name, price] of [
    ['e2e-gift', 'Gift Card', 3], ['e2e-dear', 'Dear Card', 100], ['e2e-big', 'Big Card', 95],
    ['e2e-small', 'Small Card', 5], ['e2e-left', 'Left Open', 1],
  ]) {
    await db.run(
      `INSERT INTO card_cache (id, name, game, set_id, set_name, number, price_trend, language, last_updated)
       VALUES (?, ?, 'pokemon', 'base1', 'Base Set', '1', ?, 'English', datetime('now'))`,
      [id, name, price]
    );
  }
  const copy = async (userId, cardId, price, isTrade = 0) => (await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, purchase_price, is_trade, game) VALUES (?, ?, 1, ?, ?, 'pokemon')`,
    [cardId, userId, price, isTrade]
  )).lastID;
  const giftEntry = await copy(aliceId, 'e2e-gift', 3);
  const dearEntry = await copy(aliceId, 'e2e-dear', 100);
  const leftEntry = await copy(aliceId, 'e2e-left', 1);
  const bigEntry = await copy(bobId, 'e2e-big', 10, 1);
  const smallEntry = await copy(bobId, 'e2e-small', 20, 1);
  const admin = await harness.admin(db);

  srv = await harness.startServer(tmp);
  const req = (method, url, opts = {}) => srv.request(method, url, opts);
  const ok = (res, status, label) => {
    assert.strictEqual(res.status, status, `${label}: ${res.status} ${res.text}`);
    return res.json;
  };
  const refused = (res, status, code, label) => {
    assert.strictEqual(res.status, status, `${label}: ${res.status} ${res.text}`);
    assert.strictEqual(res.json && res.json.code, code, `${label}: ${res.text}`);
  };

  // --- Signing in, and opting in ----------------------------------------------------
  const login = async (username, password) => {
    const body = ok(await req('POST', '/api/auth/login', { body: { username, password } }), 200, `${username} signs in`);
    assert.strictEqual(body.user.trades_enabled, false, 'trading starts off');
    return { id: body.user.id, headers: { Authorization: `Bearer ${body.token}` } };
  };
  const alice = await login('alice', 'alice-password-1');
  const bob = await login('bob', 'bob-password-1');
  assert.deepStrictEqual([alice.id, bob.id], [aliceId, bobId]);

  refused(await req('GET', '/api/transfers/users', { as: alice }), 403, 'trades_disabled', 'listing before opting in');
  refused(await req('POST', '/api/transfers', {
    as: alice, body: { recipient_id: bobId, transfer_type: 'gift', offered_items: [{ type: 'card', id: giftEntry }] },
  }), 403, 'trades_disabled', 'offering before opting in');
  assert.deepStrictEqual(ok(await req('GET', '/api/transfers', { as: alice }), 200, 'own offers'), { transfers: [], next_cursor: null });

  const settings = ok(await req('PUT', '/api/auth/settings', { as: alice, body: { trades_enabled: true } }), 200, 'alice opts in');
  assert.strictEqual(settings.user.trades_enabled, true);
  assert.strictEqual(settings.user.id, aliceId, 'the saved settings answer with the whole session user, id included');
  assert.strictEqual(settings.user.username, 'alice');
  assert.strictEqual(ok(await req('GET', '/api/auth/me', { as: alice }), 200, 'me').user.trades_enabled, true);
  refused(await req('POST', '/api/transfers', {
    as: alice, body: { recipient_id: bobId, transfer_type: 'gift', offered_items: [{ type: 'card', id: giftEntry }] },
  }), 404, 'not_found', 'offering to a member who has not opted in');
  ok(await req('PUT', '/api/auth/settings', { as: bob, body: { trades_enabled: true } }), 200, 'bob opts in');
  assert.deepStrictEqual(ok(await req('GET', '/api/transfers/users', { as: alice }), 200, 'members').users.map(u => u.username), ['bob'],
    'the members who opted in, never yourself (the admin has not opted in)');
  console.log('PASS: two members sign in, and trading is off until each turns it on in Settings');

  // --- A gift --------------------------------------------------------------------------
  const offered = ok(await req('POST', '/api/transfers', {
    as: alice,
    body: { recipient_id: bobId, transfer_type: 'gift', offered_items: [{ type: 'card', id: giftEntry }], message: 'For your binder' },
  }), 201, 'offering a gift').transfer;
  const inbox = ok(await req('GET', '/api/transfers', { as: bob }), 200, "bob's offers").transfers;
  const waiting = inbox.find(t => t.id === offered.id);
  assert.strictEqual(waiting.status, 'pending');
  assert.strictEqual(waiting.proposer_username, 'alice');
  assert.strictEqual(waiting.message, 'For your binder');
  assert.strictEqual(waiting.items[0].purchase_cost, null, "the sender's cost is theirs");
  const accepted = ok(await req('PUT', `/api/transfers/${offered.id}/accept`, { as: bob }), 200, 'accepting the gift');
  assert.strictEqual(accepted.transfer.status, 'accepted');
  const bobCards = ok(await req('GET', '/api/collection', { as: bob }), 200, "bob's collection");
  const gifted = bobCards.find(c => c.card_id === 'e2e-gift');
  assert.ok(gifted, 'the gift arrived');
  assert.strictEqual(gifted.purchase_price, 0, 'a gift costs nothing');
  assert.strictEqual(gifted.acquired_transfer_partner, 'alice');
  assert.strictEqual(gifted.acquired_transfer_type, 'gift');
  assert.ok(!ok(await req('GET', '/api/collection', { as: alice }), 200, "alice's collection").some(c => c.card_id === 'e2e-gift'),
    'and left the sender');
  console.log('PASS: a gift is offered and accepted over HTTP');

  // --- A trade ---------------------------------------------------------------------------
  const marked = ok(await req('GET', `/api/transfers/marked/${bobId}`, { as: alice }), 200, "bob's trade binder");
  assert.deepStrictEqual(marked.cards.map(c => c.entry_id).sort((a, b) => a - b), [bigEntry, smallEntry]);
  const trade = ok(await req('POST', '/api/transfers', {
    as: alice,
    body: {
      recipient_id: bobId,
      transfer_type: 'trade',
      offered_items: [{ type: 'card', id: dearEntry }],
      requested_items: [{ type: 'card', id: bigEntry }, { type: 'card', id: smallEntry }],
    },
  }), 201, 'offering a trade').transfer;
  ok(await req('PUT', `/api/transfers/${trade.id}/accept`, { as: bob }), 200, 'accepting the trade');
  const aliceCards = ok(await req('GET', '/api/collection', { as: alice }), 200, "alice's collection");
  const costOf = (cards, cardId) => cards.find(c => c.card_id === cardId).purchase_price;
  assert.strictEqual(costOf(aliceCards, 'e2e-big'), 95, 'a $100 card for a $95 card and a $5 card: $95 and $5, by market value');
  assert.strictEqual(costOf(aliceCards, 'e2e-small'), 5);
  assert.strictEqual(costOf(ok(await req('GET', '/api/collection', { as: bob }), 200, "bob's collection"), 'e2e-dear'), 30,
    "what bob's two cards cost him");
  assert.strictEqual(aliceCards.find(c => c.card_id === 'e2e-big').acquired_transfer_partner, 'bob');
  console.log('PASS: a trade is offered and accepted over HTTP, its cost split by market value');

  // --- API keys ---------------------------------------------------------------------------
  const key = ok(await req('POST', '/api/auth/api-key', { as: alice }), 200, 'issuing an API key').api_key;
  const viaKey = { Authorization: `Bearer ${key}` };
  ok(await req('GET', '/api/collection', { headers: viaKey }), 200, 'the key still reads the collection');
  for (const url of ['/api/transfers', '/api/transfers/users', '/api/transfers/history', '/api/transfers/external',
    '/api/transfers/external/contacts', `/api/transfers/marked/${bobId}`]) {
    refused(await req('GET', url, { headers: viaKey }), 403, 'api_key_refused', `${url} with an API key`);
  }
  console.log('PASS: an API key reads the collection but no trade route');

  // --- A deleted account --------------------------------------------------------------------
  const left = ok(await req('POST', '/api/transfers', {
    as: alice, body: { recipient_id: bobId, transfer_type: 'gift', offered_items: [{ type: 'card', id: leftEntry }] },
  }), 201, 'an offer left open').transfer;
  ok(await req('DELETE', `/api/admin/users/${bobId}`, { as: admin }), 200, 'the admin deletes bob');
  const history = ok(await req('GET', '/api/transfers', { as: alice }), 200, "alice's offers after the deletion").transfers;
  for (const id of [offered.id, trade.id]) {
    const kept = history.find(t => t.id === id);
    assert.ok(kept, `offer ${id} outlives the other member's account`);
    assert.strictEqual(kept.status, 'accepted');
    assert.strictEqual(kept.recipient_id, null);
    assert.strictEqual(kept.recipient_username, 'bob', 'named from the snapshot');
  }
  assert.strictEqual(history.find(t => t.id === left.id).status, 'cancelled', 'nothing stays pending against a deleted account');
  const stillMine = ok(await req('GET', '/api/collection', { as: alice }), 200, "alice's collection").find(c => c.card_id === 'e2e-big');
  assert.strictEqual(stillMine.acquired_transfer_partner, 'bob', 'the received card keeps where it came from');
  assert.ok(ok(await req('GET', '/api/collection', { as: alice }), 200, 'collection').some(c => c.card_id === 'e2e-left'),
    'the cancelled offer moved nothing');
  assert.deepStrictEqual(ok(await req('GET', '/api/transfers/users', { as: alice }), 200, 'members').users, []);
  console.log("PASS: deleting a member keeps the other member's history and settles what was open");
}

main()
  .then(async () => { await srv.stop(); await harness.cleanup(db, tmp); process.exit(0); })
  .catch(async (err) => {
    console.error(err.stack || err.message);
    if (srv) console.error(`--- server log (tail) ---\n${srv.tail()}`);
    try { if (srv) await srv.stop(); } catch { /* already down */ }
    await harness.cleanup(db, tmp);
    process.exit(1);
  });
