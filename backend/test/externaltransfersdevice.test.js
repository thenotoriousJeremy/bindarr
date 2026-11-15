// Deals with people outside Bindarr on the phone (device mode, MOBILE.md). The
// externals router is the one /api/transfers router the phone mounts
// (routes/mounts.js), and on its way it reaches the trash, the card resolver and
// the transfer helpers, so all of that has to run on the device stand-ins
// (embedded/aliases.js). Trades and gifts between members, and records of past
// trades, need a server: 501 there.
const assert = require('assert');
const { loadEmbedded } = require('./deviceHarness');

const { embedded, db, cleanup } = loadEmbedded('externaldevice');

let token;
async function call(method, url, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await embedded.handle({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const isJson = /json/.test(res.headers['content-type'] || '');
  return { ...res, json: isJson && res.body ? JSON.parse(res.body) : null };
}

async function main() {
  try {
    ({ token } = await embedded.start({ background: false }));
    const me = await call('GET', '/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.json.user.trades_enabled, false, 'the profile says whether trading with members is on');
    const userId = me.json.user.id;

    for (const [id, name, price] of [['mtg-device-given', 'Given Away', 4], ['mtg-device-received', 'Came Back', 2]]) {
      await db.run(
        `INSERT INTO card_cache (id, name, printed_name, set_id, set_name, number, game, price_trend, language)
         VALUES (?, ?, ?, 'mtg-dev', 'Device Set', '1', 'mtg', ?, 'English')`,
        [id, name, name, price]
      );
    }
    const entry = (await db.run(
      `INSERT INTO collection (card_id, user_id, quantity, purchase_price, game) VALUES ('mtg-device-given', ?, 2, 3, 'mtg')`,
      [userId]
    )).lastID;

    const contact = await call('POST', '/api/transfers/external/contacts', { name: 'Card Shop' });
    assert.strictEqual(contact.status, 201, JSON.stringify(contact.json));
    const deal = await call('POST', '/api/transfers/external', {
      contact_id: contact.json.contact.id,
      transaction_type: 'trade',
      given_items: [{ type: 'card', id: entry, quantity: 1 }],
      received_items: [{ type: 'card', card_id: 'mtg-device-received', game: 'mtg' }],
    });
    assert.strictEqual(deal.status, 201, JSON.stringify(deal.json));
    assert.ok(deal.json.trash_batch, 'the given copy went to the trash');
    assert.strictEqual((await db.get(`SELECT quantity FROM collection WHERE id = ?`, [entry])).quantity, 1);

    const listed = await call('GET', '/api/transfers/external?limit=1');
    assert.strictEqual(listed.status, 200);
    assert.deepStrictEqual(listed.json.transactions.map(t => t.id), [deal.json.transaction.id]);
    assert.strictEqual(listed.json.next_cursor, null);

    const collection = await call('GET', '/api/collection');
    const received = collection.json.find(row => row.card_id === 'mtg-device-received');
    assert.strictEqual(received.acquired_external_contact, 'Card Shop');
    assert.strictEqual(received.purchase_price, 3, 'the one copy given cost $3');

    const restored = await call('POST', `/api/collection/trash/${deal.json.trash_batch}/restore`);
    assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
    assert.strictEqual((await db.get(`SELECT SUM(quantity) AS n FROM collection WHERE card_id = 'mtg-device-given'`)).n, 2,
      'Undo brings the given copy back');
    console.log('PASS: outside deals run on the phone, trash and all');

    for (const url of ['/api/transfers', '/api/transfers/users', '/api/transfers/history', '/api/transfers/history/1/confirm']) {
      const res = await call('GET', url);
      assert.strictEqual(res.status, 501, `${url} on the phone`);
    }
    console.log('PASS: trades between members answer 501 on the phone');
  } finally {
    await cleanup();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
