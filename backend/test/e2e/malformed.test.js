// Wrong-typed and malformed bodies against every authenticated POST/PUT/PATCH
// route. The property: a client can send anything and the answer is never a 5xx,
// never a request left hanging, and the server is still up afterwards.
//
// Each route gets its body-level cases (missing fields, a JSON array, a JSON
// string/number/null, broken JSON) and then, field by field, every value in
// FIELD_VARIANTS laid over a body that is otherwise valid for that route, against
// resources the caller owns — so the handler gets past its ownership check and
// really reads the field. Routes with required fields must answer 4xx to a body
// without them; a wrong-typed optional field may be coerced (2xx) or refused (4xx),
// and the coerced ones are listed at the end for whoever tightens validation next.
//
// The public auth routes are covered by server.test.js. Not swept: admin routes
// that start network jobs when the body happens to be acceptable (seed-cards,
// models/download, models/product-map), and DELETEs, which take no body.
//
// Also pins that /api/scan-match answers 503 notBuilt on an install with no scan
// catalog, which is the state of every CI runner and every fresh container.
const assert = require('assert');
const harness = require('./harness');

const tmp = harness.tempDatabase('malformed');
const db = require('../../src/db');

const nested = (depth) => (depth === 0 ? { leaf: [1, 'two', null] } : { deeper: nested(depth - 1), list: [depth] });
const FIELD_VARIANTS = [
  ['number', 123],
  ['negative', -1],
  ['float', 1.5],
  ['true', true],
  ['false', false],
  ['null', null],
  ['empty array', []],
  ['array', ['x', 1, null]],
  ['object', {}],
  ['nested object', nested(40)],
  ['empty string', ''],
  ['long string', 'x'.repeat(100 * 1024)],
  ['numeric string', '42'],
  ['markup', '<script>alert(1)</script>'],
];
// Rate-limited routes share a small budget (searchLimiter 300 per 15 min,
// importLimiter 20 per hour), so they get the variants most likely to break code.
const SHORT_VARIANTS = FIELD_VARIANTS.filter(([name]) => ['number', 'null', 'array', 'object', 'long string'].includes(name));

const BODY_CASES = [
  ['no body', undefined],
  ['empty object', {}],
  ['empty array', []],
  ['array body', [1, 'two', { three: 3 }]],
  ['JSON string', '"just a string"'],
  ['JSON number', '42'],
  ['JSON null', 'null'],
  ['broken JSON', '{"name": "unterminated'],
  ['JSON with trailing comma', '{"a": 1,}'],
];

let srv;
let admin;
const ids = {};
const results = [];

async function setup() {
  admin = await harness.admin(db);
  ids.target = (await harness.member(db, 'mf-target')).id;
  for (const id of ['mf-card-1', 'mf-card-2']) {
    await db.run(
      `INSERT INTO card_cache (id, name, game, language, set_id, set_name, number, price_trend, last_updated)
       VALUES (?, ?, 'pokemon', 'English', 'mf', 'Malformed Set', '1', 1.0, datetime('now'))`,
      [id, `Card ${id}`]
    );
  }
  const call = async (method, url, body) => {
    const res = await srv.request(method, url, { as: admin, body });
    assert.ok(res.status >= 200 && res.status < 300, `setup ${method} ${url}: ${res.status} ${res.text.slice(0, 200)}`);
    return res.json;
  };
  ids.loc = (await call('POST', '/api/locations', { name: 'MF Binder', type: 'Binder', sort_order: 'custom', compartmentPlan: { count: 3, capacity: 9 } })).id;
  ids.comps = (await call('GET', `/api/locations/${ids.loc}/compartments`)).map(c => c.id);
  ids.entry = (await call('POST', '/api/collection', { card_id: 'mf-card-1', location_id: ids.loc })).id;
  ids.entry2 = (await call('POST', '/api/collection', { card_id: 'mf-card-2' })).id;
  ids.deck = (await call('POST', '/api/decks', { name: 'MF Deck' })).id;
  ids.note = (await call('POST', '/api/notes', { title: 'MF', body: 'note' })).note.id;
  const purchase = await call('POST', '/api/sealed/purchases', { product_name: 'MF Booster Box', quantity: 1 });
  ids.purchase = purchase.id || (purchase.purchase && purchase.purchase.id);
}

// One entry per route. `fields` are what the handler destructures; `base` makes
// the rest of the body valid; `required` means a body without fields is invalid.
function routes() {
  const c = ids.comps;
  return [
    // collection.js
    { method: 'POST', path: '/api/search', allow503: true, fields: ['name', 'number', 'set', 'scope', 'game', 'lang', 'prints', 'q', 'image', 'cropped', 'page', 'limit'], variants: SHORT_VARIANTS },
    { method: 'POST', path: '/api/scan-match', allow503: true, base: { game: 'pokemon', image: 'A'.repeat(400) }, fields: ['game', 'image', 'set', 'lang', 'cropped'], required: true, variants: SHORT_VARIANTS },
    { method: 'POST', path: '/api/collection', base: { card_id: 'mf-card-2' }, required: true,
      fields: ['card_id', 'quantity', 'condition', 'printing', 'language', 'purchase_price', 'location_id', 'list_type', 'is_trade', 'game', 'stackable', 'grader', 'grade', 'cert_number'] },
    { method: 'POST', path: '/api/collection/bulk-add', base: { card_ids: ['mf-card-2'] }, required: true,
      fields: ['card_ids', 'quantity', 'condition', 'printing', 'language', 'location_id', 'grader', 'grade'] },
    { method: 'PUT', path: `/api/collection/${ids.entry2}`,
      fields: ['quantity', 'condition', 'printing', 'language', 'purchase_price', 'location_id', 'compartment_id', 'list_type', 'is_trade', 'favorite', 'game', 'notes', 'grader', 'grade', 'cert_number', 'market_value', 'card_id'] },
    { method: 'POST', path: `/api/collection/${ids.entry}/market-value/fetch`, fields: ['grader'], variants: SHORT_VARIANTS.slice(0, 2) },
    { method: 'POST', path: `/api/collection/${ids.entry}/place`, base: { compartment_id: c[0], slot: 1 }, required: true, fields: ['compartment_id', 'slot', 'swap_with'] },
    { method: 'POST', path: '/api/collection/bulk', base: { entry_ids: [ids.entry2], action: 'trade' }, required: true, fields: ['entry_ids', 'action', 'value'] },
    { method: 'POST', path: '/api/collection/bulk', base: { entry_ids: [ids.entry2], action: 'purchase_split', value: { total: 1, method: 'equal' } }, fields: ['value'], label: 'bulk purchase_split' },
    // storage.js
    { method: 'POST', path: '/api/locations', base: { name: 'MF Location', type: 'Box' }, required: true,
      fields: ['name', 'type', 'sort_order', 'foil_sorting', 'rule_type', 'rule_config', 'compartmentPlan', 'game', 'fixed_slots', 'page_columns'] },
    { method: 'PUT', path: `/api/locations/${ids.loc}`,
      fields: ['name', 'type', 'sort_order', 'foil_sorting', 'rule_type', 'rule_config', 'game', 'locked', 'allow_stacking', 'fixed_slots', 'page_columns'] },
    { method: 'POST', path: `/api/locations/${ids.loc}/compartments`, fields: ['before_id', 'after_id', 'idx', 'capacity'] },
    { method: 'PATCH', path: `/api/compartments/${c[1]}/reorder`, fields: ['location_id', 'idx', 'before_id', 'after_id'] },
    { method: 'PUT', path: `/api/locations/${ids.loc}/compartments/${c[2]}`, fields: ['label', 'capacity', 'rule_config', 'assignedFilters', 'locked'] },
    { method: 'PATCH', path: `/api/compartments/${c[2]}`, fields: ['label', 'capacity', 'rule_config', 'locked'] },
    { method: 'PUT', path: `/api/compartments/${c[2]}/filters`, fields: ['filters'] },
    { method: 'POST', path: `/api/locations/${ids.loc}/recommend`, base: { card_id: 'mf-card-1' }, required: true, fields: ['card_id', 'printing', 'language'] },
    { method: 'POST', path: `/api/locations/${ids.loc}/recommend-batch`, base: { entry_ids: [ids.entry2] }, required: true, fields: ['entry_ids'] },
    { method: 'POST', path: `/api/locations/${ids.loc}/apply-all`, base: { entry_ids: [ids.entry2] }, required: true, fields: ['entry_ids'] },
    { method: 'POST', path: `/api/locations/${ids.loc}/resort`, fields: [] },
    // decks.js
    { method: 'POST', path: '/api/decks', base: { name: 'MF Deck 2' }, required: true,
      fields: ['name', 'description', 'game', 'format', 'category', 'accent_color', 'target_size', 'decklist_text', 'decklist_format'] },
    { method: 'PUT', path: `/api/decks/${ids.deck}`, base: { name: 'MF Deck' }, required: true, fields: ['name', 'description', 'format', 'category', 'accent_color', 'target_size'] },
    { method: 'POST', path: `/api/decks/${ids.deck}/cards`, base: { card_id: 'mf-card-1', quantity: 1 }, required: true, fields: ['card_id', 'quantity'] },
    { method: 'PUT', path: `/api/decks/${ids.deck}/checkout`, fields: [] },
    { method: 'PUT', path: `/api/decks/${ids.deck}/return`, fields: [] },
    // notes.js
    { method: 'POST', path: '/api/notes', base: { title: 'MF note' }, required: true, fields: ['title', 'body'] },
    { method: 'PUT', path: `/api/notes/${ids.note}`, required: true, fields: ['title', 'body', 'pinned'] },
    // importExport.js — 20 imports an hour between the two routes
    { method: 'POST', path: '/api/import', base: { format: 'json', data: [] }, required: true, fields: ['format', 'data'], variants: SHORT_VARIANTS, bodyCases: ['empty object', 'array body'] },
    { method: 'POST', path: '/api/import-container', base: { name: 'MF Import', data: '1 Card (abc) 1' }, required: true, fields: ['data', 'name'], variants: SHORT_VARIANTS.slice(0, 3), bodyCases: ['empty object'] },
    // settings.js (admin)
    { method: 'PUT', path: '/api/settings',
      fields: ['public_base_url', 'pokemon_provider', 'mtg_price_source', 'price_refresh_days', 'scan_exclude_tokens', 'scan_exclude_art_cards', 'scan_exclude_jumpstart', 'scan_exclude_promos', 'scan_exclude_digital', 'setup_complete'] },
    // auth.js, the authenticated half
    { method: 'PUT', path: '/api/auth/settings', base: { current_password: 'wrong-password' },
      fields: ['current_password', 'password', 'share_enabled', 'share_locations', 'regenerate_share_token', 'tcg_api_key', 'psa_api_token', 'graded_price_api_key'] },
    { method: 'POST', path: '/api/auth/api-key', fields: [] },
    { method: 'POST', path: '/api/auth/logout', fields: [], freshSession: true },
    // admin.js
    { method: 'POST', path: '/api/admin/users', base: { username: 'mfuser', password: 'long-enough-password' }, required: true, fields: ['username', 'password', 'role'] },
    { method: 'PUT', path: `/api/admin/users/${ids.target}`, fields: ['password', 'role'] },
    { method: 'POST', path: '/api/admin/catalogs/build', fields: ['game', 'lang', 'skipCache', 'sets'] },
    { method: 'POST', path: '/api/admin/catalogs/stop', fields: [] },
    // sealed.js (body fields only: a purchase is created first, below the sweep's own ids)
    { method: 'POST', path: '/api/sealed/purchases', base: { product_name: 'MF Booster' }, required: true,
      fields: ['product_id', 'product_name', 'set_name', 'sealed_type', 'game', 'image_url', 'store', 'purchase_date', 'unit_price', 'quantity', 'notes', 'expected_packs', 'expected_cards', 'contents_note', 'market_value'] },
    { method: 'PUT', path: `/api/sealed/purchases/${ids.purchase}`,
      fields: ['store', 'purchase_date', 'unit_price', 'notes', 'quantity', 'expected_packs', 'expected_cards', 'contents_note', 'market_value'] },
    { method: 'POST', path: '/api/sealed/templates', base: { product_name: 'MF Template' }, fields: ['product_id', 'product_name', 'game', 'components'] },
    // cardArt.js (admin writes)
    { method: 'POST', path: '/api/card-art/mf-card-1', base: { image: 'data:image/png;base64,AAAA' }, fields: ['image'] },
  ];
}

// Uniquifies the values that must not collide between cases (location and deck
// names, usernames), so a 400 for "already exists" cannot hide what the variant did.
let seq = 0;
function withUniqueBase(route) {
  const base = { ...(route.base || {}) };
  seq++;
  if (route.path === '/api/locations') base.name = `MF Location ${seq}`;
  if (route.path === '/api/admin/users') base.username = `mfuser${seq}`;
  if (route.path === '/api/import-container') base.name = `MF Import ${seq}`;
  return base;
}

async function send(route, label, body) {
  const as = route.freshSession ? { headers: await harness.sessionHeaders(db, admin.id) } : admin;
  const res = await srv.request(route.method, route.path, { as, body, timeoutMs: 10000 });
  const record = { route: `${route.method} ${route.label || route.path}`, label, status: res.status, error: res.error, text: res.text.slice(0, 160) };
  results.push(record);
  return record;
}

const isClientError = (s) => s >= 400 && s < 500;
const isOk = (s) => s >= 200 && s < 300;

async function sweep(route) {
  const failures = [];
  const check = (r, mustRefuse) => {
    if (r.status === 0) failures.push(`${r.label}: ${r.error}`);
    // 503 is the documented answer where an upstream is missing: no scan catalog,
    // or (offline here) no card provider. Anything else 5xx is a bug.
    else if (r.status >= 500 && !(route.allow503 && r.status === 503)) failures.push(`${r.label}: ${r.status} ${r.text}`);
    else if (mustRefuse && !isClientError(r.status)) failures.push(`${r.label}: expected 4xx, got ${r.status}`);
  };

  const bodyCases = route.bodyCases ? BODY_CASES.filter(([name]) => route.bodyCases.includes(name)) : BODY_CASES;
  for (const [label, body] of bodyCases) {
    const r = await send(route, `body: ${label}`, body);
    const broken = typeof body === 'string' && !['"just a string"', '42', 'null'].includes(body);
    // Broken JSON and a scalar JSON body are refused by the parser itself; a body
    // with no fields at all must be refused by any route that requires some.
    const mustRefuse = broken || (typeof body === 'string') || (route.required && ['no body', 'empty object', 'empty array', 'array body'].includes(label));
    check(r, mustRefuse);
  }
  for (const field of route.fields) {
    for (const [label, value] of route.variants || FIELD_VARIANTS) {
      check(await send(route, `${field}: ${label}`, { ...withUniqueBase(route), [field]: value }), false);
    }
  }
  return failures;
}

async function runTests() {
  srv = await harness.startServer(tmp);
  await setup();

  // F10-TC1: no catalog, no guess — the documented 503, with the flag the client reads.
  const scan = await srv.request('POST', '/api/scan-match', { as: admin, body: { game: 'pokemon', image: `data:image/jpeg;base64,${'A'.repeat(400)}` } });
  assert.strictEqual(scan.status, 503, `scan-match without a catalog should be 503, got ${scan.status} ${scan.text}`);
  assert.strictEqual(scan.json.notBuilt, true, 'the 503 must carry notBuilt so the client can say what is missing');
  assert.deepStrictEqual(scan.json.candidates, [], 'no catalog means no candidates, not a guess');
  console.log('PASS: F10-TC1 - /api/scan-match answers 503 notBuilt without a catalog');

  let n = 1;
  const failedRoutes = [];
  for (const route of routes()) {
    n++;
    const failures = await sweep(route);
    const name = `${route.method} ${route.label || route.path}`;
    if (failures.length) {
      failedRoutes.push(name);
      console.error(`FAIL: F10-TC${n} - ${name}: ${failures.length} malformed request(s) mishandled`);
      for (const f of failures.slice(0, 12)) console.error(`    ${f}`);
      if (failures.length > 12) console.error(`    ... and ${failures.length - 12} more`);
    } else {
      console.log(`PASS: F10-TC${n} - ${name}`);
    }
  }

  // The last word: after all of that, still serving, and nothing it did escaped a
  // handler as an unhandled rejection (which leaves a request hanging forever).
  n++;
  const alive = await srv.alive();
  const escaped = (srv.tail(100000).match(/Unhandled promise rejection/g) || []).length;
  if (!alive) console.error(`FAIL: F10-TC${n} - the server is down after the sweep`);
  else if (escaped) console.error(`FAIL: F10-TC${n} - ${escaped} unhandled rejection(s) in the server log`);
  else console.log(`PASS: F10-TC${n} - server still healthy, no unhandled rejections`);

  const coerced = results.filter(r => isOk(r.status) && r.label.includes(': ') && !r.label.startsWith('body:'));
  const byRoute = {};
  for (const r of coerced) (byRoute[r.route] = byRoute[r.route] || new Set()).add(r.label.split(':')[0]);
  console.log(`\n${results.length} malformed requests sent. Wrong-typed fields accepted with a 2xx (coerced, not refused):`);
  for (const [route, fields] of Object.entries(byRoute)) console.log(`  ${route}: ${[...fields].join(', ')}`);

  if (failedRoutes.length || !alive || escaped) {
    throw new Error(`${failedRoutes.length} route(s) mishandled malformed input${alive ? '' : '; server down'}${escaped ? `; ${escaped} unhandled rejection(s)` : ''}`);
  }
}

runTests()
  .then(async () => { await srv.stop(); await harness.cleanup(db, tmp); process.exit(0); })
  .catch(async (err) => {
    console.error(err.stack || err.message);
    if (srv) console.error(`--- server log (tail) ---\n${srv.tail(60)}`);
    try { if (srv) await srv.stop(); } catch { /* already down */ }
    await harness.cleanup(db, tmp);
    process.exit(1);
  });
