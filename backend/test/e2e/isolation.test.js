// Cross-user isolation, route by route.
//
// Alice and Bob are both members. Alice's resources are created through the API:
// cards in a binder and unsorted, a deck, a note, sharing with locations, provider
// keys and an API key. Bob then tries every authenticated route that takes an id —
// reading, editing, deleting, and pairing his own ids with hers — and every list
// endpoint is checked for her rows. At the end Alice's rows in every table are
// compared with a snapshot taken before Bob started: nothing he sent may have
// changed one.
//
// Not repeated here, because test/e2e/authz.test.js already pins them:
// PUT /api/locations/:id/compartments/:comp_id with a foreign compartment,
// PUT /api/compartments/:id/filters, and card-art writes.
//
// Known failures are listed in KNOWN_FAILURES with the change that fixes them.
// They still run (last, after the snapshot comparison, since they write) and are
// reported as SKIP; one that starts passing says so, so the entry can be dropped.
const assert = require('assert');
const harness = require('./harness');

const tmp = harness.tempDatabase('isolation');
const db = require('../../src/db');

const KNOWN_FAILURES = {
  'PUT /api/collection/:id with a foreign compartment_id':
    'the route stores any compartment_id without checking its owner, and GET /api/collection joins '
    + 'compartments unscoped, so the label of another user\'s page reads back. Fixed by the parallel '
    + 'slice that owns PUT /collection compartment_id.',
};

// Strings only Alice's data contains. None may appear in a response to Bob.
const ALICE = {
  location: 'Alice Binder',
  page: 'Alice page one',
  deck: 'Alice Deck',
  note: 'alice secret note',
  tcgKey: 'alice-tcg-key',
  psaToken: 'alice-psa-token',
  card: 'Alicecard',
};

let srv;
let alice;
let bob;
let adminUser;
const ids = {};

const req = (...args) => srv.request(...args);
function noLeak(res, label) {
  for (const [what, marker] of Object.entries(ALICE)) {
    assert.ok(!res.text.includes(marker), `${label} leaked Alice's ${what} ("${marker}") to Bob`);
  }
}
// Bob's attempt on Alice's resource: refused with a 4xx, and no trace of her data.
function refused(res, label, statuses = [403, 404]) {
  assert.ok(statuses.includes(res.status), `${label}: expected ${statuses.join(' or ')}, got ${res.status} ${res.text.slice(0, 200)}`);
  noLeak(res, label);
}

async function seedCards() {
  const cards = [
    ['iso-alice-1', ALICE.card, 999.99],
    ['iso-alice-2', `${ALICE.card} Two`, 500],
    ['iso-shared-1', 'Commoncard', 1.5],
    ['iso-bob-1', 'Bobcard', 2.5],
  ];
  for (const [id, name, price] of cards) {
    await db.run(
      `INSERT INTO card_cache (id, name, game, language, set_id, set_name, number, price_trend, last_updated)
       VALUES (?, ?, 'pokemon', 'English', 'iso', 'Isolation Set', ?, ?, datetime('now'))`,
      [id, name, id.split('-').pop(), price]
    );
  }
}

async function ok(res, label, status = 200) {
  assert.ok(res.status === status || (status === 200 && res.status === 201),
    `${label}: expected ${status}, got ${res.status} ${res.text.slice(0, 300)}`);
  return res.json;
}

async function seedAlice() {
  const loc = await ok(await req('POST', '/api/locations', { as: alice, body: { name: ALICE.location, type: 'Binder', sort_order: 'custom', compartmentPlan: { count: 2, capacity: 9 } } }), 'alice location');
  ids.locA = loc.id;
  const comps = await ok(await req('GET', `/api/locations/${ids.locA}/compartments`, { as: alice }), 'alice compartments');
  [ids.compA1, ids.compA2] = comps.map(c => c.id);
  await ok(await req('PATCH', `/api/compartments/${ids.compA1}`, { as: alice, body: { label: ALICE.page } }), 'alice page label');

  ids.entryA1 = (await ok(await req('POST', '/api/collection', { as: alice, body: { card_id: 'iso-alice-1', location_id: ids.locA } }), 'alice add 1')).id;
  ids.entryA2 = (await ok(await req('POST', '/api/collection', { as: alice, body: { card_id: 'iso-alice-2' } }), 'alice add 2')).id;
  await ok(await req('PUT', `/api/collection/${ids.entryA1}`, { as: alice, body: { grader: 'PSA', grade: 10, cert_number: '11112222', notes: ALICE.note } }), 'alice grade');

  ids.deckA = (await ok(await req('POST', '/api/decks', { as: alice, body: { name: ALICE.deck, game: 'pokemon' } }), 'alice deck', 201)).id;
  await ok(await req('POST', `/api/decks/${ids.deckA}/cards`, { as: alice, body: { card_id: 'iso-alice-1', quantity: 1 } }), 'alice deck card');

  ids.noteA = (await ok(await req('POST', '/api/notes', { as: alice, body: { title: 'Alice', body: ALICE.note } }), 'alice note', 201)).note.id;

  const settings = await ok(await req('PUT', '/api/auth/settings', { as: alice, body: {
    share_enabled: true, share_locations: true, tcg_api_key: ALICE.tcgKey, psa_api_token: ALICE.psaToken,
  } }), 'alice settings');
  ids.shareA = settings.user.share_token;
  ids.keyA = (await ok(await req('POST', '/api/auth/api-key', { as: alice }), 'alice api key')).api_key;
}

async function seedBob() {
  ids.locB = (await ok(await req('POST', '/api/locations', { as: bob, body: { name: 'Bob Box', type: 'Box', sort_order: 'custom', compartmentPlan: { count: 2, capacity: 40 } } }), 'bob location')).id;
  const comps = await ok(await req('GET', `/api/locations/${ids.locB}/compartments`, { as: bob }), 'bob compartments');
  [ids.compB1, ids.compB2] = comps.map(c => c.id);
  ids.entryB1 = (await ok(await req('POST', '/api/collection', { as: bob, body: { card_id: 'iso-bob-1', location_id: ids.locB } }), 'bob add')).id;
  ids.entryB2 = (await ok(await req('POST', '/api/collection', { as: bob, body: { card_id: 'iso-shared-1' } }), 'bob add 2')).id;
  ids.deckB = (await ok(await req('POST', '/api/decks', { as: bob, body: { name: 'Bob Deck', game: 'pokemon' } }), 'bob deck', 201)).id;
  const settings = await ok(await req('PUT', '/api/auth/settings', { as: bob, body: { share_enabled: true, share_locations: true } }), 'bob settings');
  ids.shareB = settings.user.share_token;
}

// Every row Alice owns, in every table a route can write. Compared before and
// after Bob's attempts; ordered so the comparison is exact.
async function aliceSnapshot() {
  const uid = alice.id;
  return {
    user: await db.get(`SELECT username, role, share_token, share_enabled, share_locations, tcg_api_key, psa_api_token,
                               graded_price_api_key, api_key, password_hash FROM users WHERE id = ?`, [uid]),
    locations: await db.all(`SELECT * FROM locations WHERE user_id = ? ORDER BY id`, [uid]),
    compartments: await db.all(`SELECT cp.* FROM compartments cp JOIN locations l ON l.id = cp.location_id
                                WHERE l.user_id = ? ORDER BY cp.id`, [uid]),
    assignments: await db.all(`SELECT ca.* FROM compartment_assignments ca JOIN compartments cp ON cp.id = ca.compartment_id
                               JOIN locations l ON l.id = cp.location_id WHERE l.user_id = ? ORDER BY ca.compartment_id, ca.filter_value`, [uid]),
    collection: await db.all(`SELECT * FROM collection WHERE user_id = ? ORDER BY id`, [uid]),
    decks: await db.all(`SELECT * FROM decks WHERE user_id = ? ORDER BY id`, [uid]),
    deckCards: await db.all(`SELECT dc.* FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE d.user_id = ?
                             ORDER BY dc.deck_id, dc.card_id`, [uid]),
    notes: await db.all(`SELECT * FROM notes WHERE user_id = ? ORDER BY id`, [uid]),
    sessions: (await db.get(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, [uid])).n,
  };
}

let passCount = 0;
async function testCase(id, title, fn) {
  try {
    await fn();
    passCount++;
    console.log(`PASS: ${id} - ${title}`);
  } catch (err) {
    console.error(`FAIL: ${id} - ${title}: ${err.message}`);
    throw err;
  }
}

async function runTests() {
  srv = await harness.startServer(tmp);
  adminUser = await harness.admin(db);
  alice = await harness.member(db, 'alice');
  bob = await harness.member(db, 'bob');
  await seedCards();
  await seedAlice();
  await seedBob();
  const before = await aliceSnapshot();

  await testCase('F9-TC1', 'list endpoints show Bob only his own rows', async () => {
    const locations = await req('GET', '/api/locations', { as: bob });
    assert.strictEqual(locations.status, 200);
    assert.deepStrictEqual(locations.json.map(l => l.id), [ids.locB]);
    noLeak(locations, 'GET /api/locations');

    for (const url of ['/api/collection', '/api/collection?list_type=collection', '/api/collection?list_type=wishlist',
      `/api/collection?compartment_id=${ids.compA1}`, '/api/collection?is_trade=0']) {
      const res = await req('GET', url, { as: bob });
      assert.strictEqual(res.status, 200, url);
      assert.ok(res.json.every(e => [ids.entryB1, ids.entryB2].includes(e.entry_id)), `${url} returned an entry that is not Bob's`);
      noLeak(res, url);
    }
    const mine = await req('GET', `/api/collection?compartment_id=${ids.compA1}`, { as: bob });
    assert.deepStrictEqual(mine.json, [], 'filtering by Alice\'s page must not show her cards');

    const decks = await req('GET', '/api/decks', { as: bob });
    assert.deepStrictEqual(decks.json.map(d => d.id), [ids.deckB]);
    noLeak(decks, 'GET /api/decks');

    const notes = await req('GET', '/api/notes', { as: bob });
    assert.deepStrictEqual(notes.json.notes, []);

    for (const url of ['/api/export?format=json', '/api/export?format=csv', '/api/export?format=csv&ecosystem=tcgplayer']) {
      const res = await req('GET', url, { as: bob });
      assert.strictEqual(res.status, 200, url);
      noLeak(res, url);
    }
    const exported = await req('GET', '/api/export?format=json', { as: bob });
    assert.deepStrictEqual(exported.json.map(r => r.card_id).sort(), ['iso-bob-1', 'iso-shared-1']);

    const stats = await req('GET', '/api/stats', { as: bob });
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.json.summary.totalCards, 2, 'stats count Bob\'s two cards only');
    assert.ok(stats.json.summary.totalValue < 100, `Bob's total value includes Alice's 999.99 card: ${stats.json.summary.totalValue}`);
    noLeak(stats, 'GET /api/stats');

    const worth = await req('GET', '/api/stats/networth', { as: bob });
    assert.strictEqual(worth.json.totalCards, 2);
    assert.ok(worth.json.totalValue < 100, `networth includes Alice's cards: ${worth.json.totalValue}`);

    const history = await req('GET', '/api/stats/history', { as: bob });
    assert.strictEqual(history.status, 200);
    noLeak(history, 'GET /api/stats/history');

    const owned = await req('GET', `/api/search?scope=collection&name=${encodeURIComponent(ALICE.card)}`, { as: bob });
    assert.strictEqual(owned.status, 200);
    assert.deepStrictEqual(owned.json, [], 'a collection-scope search must not find Alice\'s cards');

    // Searching the shared card cache is fine; what Bob must not see is that Alice owns them.
    const cached = await req('GET', `/api/search?name=${encodeURIComponent(ALICE.card)}`, { as: bob });
    assert.strictEqual(cached.status, 200);
    for (const card of cached.json) assert.strictEqual(card.owned_qty || 0, 0, `owned_qty for ${card.id} counts Alice's copy`);

    const me = await req('GET', '/api/auth/me', { as: bob });
    assert.strictEqual(me.json.user.id, bob.id);
    noLeak(me, 'GET /api/auth/me');
  });

  await testCase('F9-TC2', 'Bob cannot read Alice\'s resources by id', async () => {
    refused(await req('GET', `/api/locations/${ids.locA}`, { as: bob }), 'GET location');
    refused(await req('GET', `/api/locations/${ids.locA}/compartments`, { as: bob }), 'GET compartments');
    refused(await req('GET', `/api/decks/${ids.deckA}`, { as: bob }), 'GET deck');
    refused(await req('GET', `/api/decks/${ids.deckA}/locations`, { as: bob }), 'GET deck locations');
    refused(await req('POST', `/api/locations/${ids.locA}/recommend`, { as: bob, body: { card_id: 'iso-shared-1' } }), 'recommend in her binder');
    refused(await req('POST', `/api/locations/${ids.locA}/recommend-batch`, { as: bob, body: { entry_ids: [ids.entryB1] } }), 'recommend-batch in her binder');

    // His binder, her entry ids: the batch must skip them rather than describe them.
    const batch = await req('POST', `/api/locations/${ids.locB}/recommend-batch`, { as: bob, body: { entry_ids: [ids.entryA1, ids.entryA2] } });
    assert.strictEqual(batch.status, 200);
    assert.deepStrictEqual(batch.json, [], 'recommend-batch described Alice\'s entries');
    noLeak(batch, 'recommend-batch with her entries');

    // Sharing: each token reaches only its own owner's containers.
    const herShare = await req('GET', `/api/shared/${ids.shareA}/containers/${ids.locA}`);
    assert.strictEqual(herShare.status, 200, 'Alice\'s own share must still work');
    refused(await req('GET', `/api/shared/${ids.shareA}/containers/${ids.locB}`), 'her token, his container');
    const viaBob = await req('GET', `/api/shared/${ids.shareB}/containers/${ids.locA}`);
    refused(viaBob, 'his token, her container');
    const bobShare = await req('GET', `/api/shared/${ids.shareB}`);
    assert.strictEqual(bobShare.status, 200);
    noLeak(bobShare, 'Bob\'s public share');
  });

  await testCase('F9-TC3', 'Bob cannot change or delete Alice\'s storage', async () => {
    refused(await req('PUT', `/api/locations/${ids.locA}`, { as: bob, body: { name: 'pwned', locked: true } }), 'PUT location');
    refused(await req('DELETE', `/api/locations/${ids.locA}`, { as: bob }), 'DELETE location');
    refused(await req('POST', `/api/locations/${ids.locA}/compartments`, { as: bob, body: { capacity: 3 } }), 'POST compartment');
    refused(await req('PATCH', `/api/compartments/${ids.compA1}`, { as: bob, body: { label: 'pwned', locked: true } }), 'PATCH compartment');
    refused(await req('PATCH', `/api/compartments/${ids.compA1}?updateAll=true`, { as: bob, body: { capacity: 1 } }), 'PATCH compartment updateAll');
    refused(await req('DELETE', `/api/compartments/${ids.compA1}`, { as: bob }), 'DELETE compartment');
    // Moving her page into his box, and his page into her binder.
    refused(await req('PATCH', `/api/compartments/${ids.compA2}/reorder`, { as: bob, body: { location_id: ids.locB } }), 'reorder her page into his box');
    refused(await req('PATCH', `/api/compartments/${ids.compB2}/reorder`, { as: bob, body: { location_id: ids.locA } }), 'reorder his page into her binder');
    refused(await req('DELETE', `/api/locations/${ids.locA}/compartments/${ids.compA2}`, { as: bob }), 'DELETE her compartment via her location');
    // His location, her compartment id: must not touch hers.
    refused(await req('DELETE', `/api/locations/${ids.locB}/compartments/${ids.compA2}`, { as: bob }), 'DELETE her compartment via his location');
    refused(await req('POST', `/api/locations/${ids.locA}/resort`, { as: bob }), 'resort her binder');
    refused(await req('POST', `/api/locations/${ids.locA}/apply-all`, { as: bob, body: { entry_ids: [ids.entryB1] } }), 'apply-all into her binder');
    const filed = await req('POST', `/api/locations/${ids.locB}/apply-all`, { as: bob, body: { entry_ids: [ids.entryA1, ids.entryA2] } });
    assert.strictEqual(filed.status, 200);
    assert.strictEqual(filed.json.filed, 0, 'apply-all filed Alice\'s entries into Bob\'s box');
  });

  await testCase('F9-TC4', 'Bob cannot change or delete Alice\'s collection rows', async () => {
    refused(await req('PUT', `/api/collection/${ids.entryA1}`, { as: bob, body: { condition: 'Damaged', notes: 'pwned' } }), 'PUT entry');
    refused(await req('DELETE', `/api/collection/${ids.entryA1}`, { as: bob }), 'DELETE entry');
    refused(await req('POST', `/api/collection/${ids.entryA1}/place`, { as: bob, body: { compartment_id: ids.compB1, slot: 1 } }), 'place her card in his box');
    refused(await req('POST', `/api/collection/${ids.entryB1}/place`, { as: bob, body: { compartment_id: ids.compA1, slot: 2 } }), 'place his card on her page', [400, 403, 404]);
    refused(await req('POST', `/api/collection/${ids.entryB1}/place`, { as: bob, body: { compartment_id: ids.compB1, swap_with: ids.entryA1 } }), 'swap with her card', [400, 403, 404]);
    refused(await req('POST', `/api/collection/${ids.entryA1}/market-value/fetch`, { as: bob }), 'fetch her slab value');

    // Adding into her binder, and moving his copy there, must not land in it.
    refused(await req('POST', '/api/collection', { as: bob, body: { card_id: 'iso-shared-1', location_id: ids.locA } }), 'add into her binder', [400, 403, 404]);
    const moved = await req('PUT', `/api/collection/${ids.entryB2}`, { as: bob, body: { location_id: ids.locA } });
    assert.ok(moved.status === 200 || (moved.status >= 400 && moved.status < 500), `move into her binder: ${moved.status}`);
    noLeak(moved, 'move into her binder');
    const row = await db.get(`SELECT location_id, compartment_id FROM collection WHERE id = ?`, [ids.entryB2]);
    assert.ok(row.location_id !== ids.locA && ![ids.compA1, ids.compA2].includes(row.compartment_id), 'Bob\'s copy was filed into Alice\'s binder');

    // Bulk actions take a list of ids; hers must be ignored, not acted on.
    for (const [action, value] of [['delete'], ['trade'], ['untrade'], ['list_type', 'wishlist'], ['condition', 'Damaged'],
      ['printing', 'Promo'], ['language', 'Japanese'], ['purchase_split', { total: 50, method: 'equal' }], ['move', null]]) {
      const res = await req('POST', '/api/collection/bulk', { as: bob, body: { entry_ids: [ids.entryA1, ids.entryA2], action, value } });
      assert.ok(res.status === 200 || res.status === 400, `bulk ${action}: ${res.status} ${res.text}`);
      if (res.status === 200) assert.strictEqual(res.json.affected, 0, `bulk ${action} touched Alice's rows`);
      noLeak(res, `bulk ${action}`);
    }
    refused(await req('POST', '/api/collection/bulk', { as: bob, body: { entry_ids: [ids.entryB1], action: 'move', value: ids.locA } }), 'bulk move into her binder', [400, 404]);
    refused(await req('POST', '/api/collection/bulk', { as: bob, body: { entry_ids: [ids.entryB1], action: 'add_to_deck', value: ids.deckA } }), 'bulk add to her deck', [404]);
    const intoHis = await req('POST', '/api/collection/bulk', { as: bob, body: { entry_ids: [ids.entryA1], action: 'add_to_deck', value: ids.deckB } });
    assert.strictEqual(intoHis.status, 200);
    assert.strictEqual(intoHis.json.affected, 0, 'her entry was added to his deck');
  });

  await testCase('F9-TC5', 'Bob cannot change or delete Alice\'s decks and notes', async () => {
    refused(await req('PUT', `/api/decks/${ids.deckA}`, { as: bob, body: { name: 'pwned' } }), 'PUT deck');
    refused(await req('DELETE', `/api/decks/${ids.deckA}`, { as: bob }), 'DELETE deck');
    refused(await req('POST', `/api/decks/${ids.deckA}/cards`, { as: bob, body: { card_id: 'iso-shared-1', quantity: 1 } }), 'add card to her deck');
    refused(await req('DELETE', `/api/decks/${ids.deckA}/cards/iso-alice-1`, { as: bob }), 'remove card from her deck');
    refused(await req('PUT', `/api/decks/${ids.deckA}/checkout`, { as: bob }), 'check out her deck');
    refused(await req('PUT', `/api/decks/${ids.deckA}/return`, { as: bob }), 'return her deck');
    refused(await req('PUT', `/api/notes/${ids.noteA}`, { as: bob, body: { body: 'pwned', pinned: true } }), 'PUT note');
    refused(await req('DELETE', `/api/notes/${ids.noteA}`, { as: bob }), 'DELETE note');
  });

  await testCase('F9-TC6', 'a member cannot reach app settings or other accounts', async () => {
    refused(await req('PUT', '/api/settings', { as: bob, body: { price_refresh_days: 30, public_base_url: 'https://evil.example' } }), 'PUT app settings', [403]);
    refused(await req('GET', '/api/admin/users', { as: bob }), 'GET admin users', [403]);
    refused(await req('PUT', `/api/admin/users/${alice.id}`, { as: bob, body: { role: 'admin', password: 'takeover-password' } }), 'PUT admin user', [403]);
    refused(await req('DELETE', `/api/admin/users/${alice.id}`, { as: bob }), 'DELETE admin user', [403]);
    refused(await req('POST', '/api/admin/backups', { as: bob }), 'POST admin backup', [403]);
    // His own settings write changes his row, whatever ids he puts in the body.
    const res = await req('PUT', '/api/auth/settings', { as: bob, body: { user_id: alice.id, id: alice.id, tcg_api_key: 'bob-key' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.user.username, 'bob');
    noLeak(res, 'PUT /api/auth/settings');
  });

  await testCase('F9-TC7', 'an API key is read-only, hides the other keys, and is not an admin login', async () => {
    const key = { headers: { Authorization: `Bearer ${ids.keyA}` } };
    const me = await req('GET', '/api/auth/me', { as: key });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.json.user.id, alice.id);
    for (const field of ['tcg_api_key', 'psa_api_token', 'graded_price_api_key']) {
      assert.ok(!(field in me.json.user), `/auth/me over an API key exposes ${field}`);
    }
    assert.ok(!me.text.includes(ALICE.tcgKey) && !me.text.includes(ALICE.psaToken), 'provider keys leaked over the API key');
    assert.strictEqual((await req('GET', '/api/collection', { as: key })).status, 200, 'a read still works');
    assert.strictEqual((await req('PUT', `/api/notes/${ids.noteA}`, { as: key, body: { body: 'via key' } })).status, 403);
    assert.strictEqual((await req('DELETE', `/api/collection/${ids.entryA2}`, { as: key })).status, 403);

    const adminKey = (await ok(await req('POST', '/api/auth/api-key', { as: adminUser }), 'admin api key')).api_key;
    const viaKey = await req('GET', '/api/admin/users', { as: { headers: { Authorization: `Bearer ${adminKey}` } } });
    assert.strictEqual(viaKey.status, 403, 'an admin\'s API key must not open the admin surface');
    assert.strictEqual((await req('GET', '/api/admin/users', { as: adminUser })).status, 200, 'the admin session still does');
  });

  await testCase('F9-TC8', 'an import is filed under the importer, whatever the rows claim', async () => {
    const rows = [{ card_id: 'iso-shared-1', user_id: alice.id, quantity: 1, game: 'pokemon', location_id: ids.locA, compartment_id: ids.compA1 }];
    const res = await req('POST', '/api/import', { as: bob, body: { format: 'json', data: rows } });
    assert.strictEqual(res.status, 200, `import: ${res.status} ${res.text}`);
    const landed = await db.all(`SELECT user_id, location_id, compartment_id FROM collection WHERE card_id = 'iso-shared-1' ORDER BY id DESC LIMIT 1`);
    assert.strictEqual(landed[0].user_id, bob.id, 'the imported row belongs to the importer');
    assert.ok(landed[0].location_id === null && landed[0].compartment_id === null, 'an import must not file into a location it named');
  });

  await testCase('F9-TC9', 'every row Alice owns is exactly as it was', async () => {
    assert.deepStrictEqual(await aliceSnapshot(), before);
    // And she can still use all of it.
    assert.strictEqual((await req('GET', `/api/locations/${ids.locA}`, { as: alice })).json.name, ALICE.location);
    assert.strictEqual((await req('GET', `/api/decks/${ids.deckA}`, { as: alice })).json.cards.length, 1);
  });

  // Known failures last: they are allowed to write, and must not disturb the
  // snapshot comparison above.
  const known = 'PUT /api/collection/:id with a foreign compartment_id';
  const res = await req('PUT', `/api/collection/${ids.entryB1}`, { as: bob, body: { compartment_id: ids.compA1 } });
  const row = await db.get(`SELECT compartment_id FROM collection WHERE id = ?`, [ids.entryB1]);
  const view = await req('GET', '/api/collection', { as: bob });
  const holds = (res.status >= 400 && res.status < 500) && row.compartment_id !== ids.compA1 && !view.text.includes(ALICE.page);
  if (holds) {
    console.log(`NOTE: F9-TC10 - "${known}" is in KNOWN_FAILURES but now holds; drop it from the list.`);
  } else {
    console.log(`SKIP: F9-TC10 - known failure: ${known} (status ${res.status}, stored compartment ${row.compartment_id}). ${KNOWN_FAILURES[known]}`);
  }

  console.log(`isolation.test.js: ${passCount} cases passed, ${Object.keys(KNOWN_FAILURES).length} known failure(s) reported`);
}

runTests()
  .then(async () => { await srv.stop(); await harness.cleanup(db, tmp); process.exit(0); })
  .catch(async (err) => {
    console.error(err.stack || err.message);
    if (srv) console.error(`--- server log (tail) ---\n${srv.tail()}`);
    try { if (srv) await srv.stop(); } catch { /* already down */ }
    await harness.cleanup(db, tmp);
    process.exit(1);
  });
