// Device mode: the backend running inside the phone app (src/embedded).
//
// Loads the real route modules the way the app bundle does — every bare module
// in src/embedded/aliases.js swapped for its device stand-in — and drives them
// through embedded.handle(), the same entry point the app's fetch shim calls.
// The one thing that differs from a phone is the SQLite underneath: the shim is
// handed a driver over node-sqlite3 here, where the app hands it the Capacitor
// plugin (frontend/src/utils/deviceSqlite.js, tested on its own).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const sqlite3 = require('sqlite3');

const tmpDb = path.join(os.tmpdir(), `bindarr-embedded-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

// Swap modules only for code under src/, which is what the bundler does: the
// test itself keeps the real sqlite3 to build its driver from.
const SRC = path.join(__dirname, '..', 'src') + path.sep;
const aliases = require('../src/embedded/aliases');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const fromSrc = parent && parent.filename && parent.filename.startsWith(SRC);
  if (fromSrc && Object.prototype.hasOwnProperty.call(aliases, request)) {
    return resolve.call(this, aliases[request], parent, ...rest);
  }
  return resolve.call(this, request, parent, ...rest);
};

function nodeDriver() {
  let conn;
  return {
    open: (name) => new Promise((ok, fail) => { conn = new sqlite3.Database(name, err => (err ? fail(err) : ok())); }),
    run: (sql, params) => new Promise((ok, fail) => conn.run(sql, params, function (err) {
      if (err) fail(err); else ok({ lastID: this.lastID, changes: this.changes });
    })),
    all: (sql, params) => new Promise((ok, fail) => conn.all(sql, params, (err, rows) => (err ? fail(err) : ok(rows)))),
    close: () => new Promise((ok, fail) => conn.close(err => (err ? fail(err) : ok()))),
  };
}

const embedded = require('../src/embedded');
const db = require('../src/db');
embedded.setDriver(nodeDriver());

let token;
async function call(method, url, { body, auth = true, raw } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await embedded.handle({ method, url, headers, body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)) });
  const isJson = /json/.test(res.headers['content-type'] || '');
  return { ...res, json: isJson && res.body ? JSON.parse(res.body) : null };
}

function testRouterMatching() {
  const { compile } = require('../src/embedded/router');
  const route = compile('/locations/:id/compartments/:comp_id', true);
  const m = route.re.exec('/LOCATIONS/7/compartments/3/');
  assert.ok(m, 'routes match case-insensitively, with an optional trailing slash');
  assert.deepStrictEqual([route.keys, m.slice(1)], [['id', 'comp_id'], ['7', '3']]);
  assert.ok(compile('/:cardId.png', true).re.test('/abc.png'), 'a param may be followed by a literal suffix');
  assert.ok(!compile('/:cardId.png', true).re.test('/abc.jpg'));
  const mount = compile('/api', false);
  assert.ok(mount.re.test('/api/notes') && mount.re.test('/api'), 'a mount matches its own path and below');
  assert.ok(!mount.re.test('/apikeys'), 'a mount prefix stops at a segment boundary');

  const { parseQuery } = require('../src/embedded/dispatch');
  assert.deepStrictEqual(parseQuery('a=1&a=2&b=x+y&c=%2F'), { a: ['1', '2'], b: 'x y', c: '/' },
    'repeated keys become arrays and values decode the way qs decodes them');
}

async function testBootAndSession() {
  ({ token } = await embedded.start({ background: false }));
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.strictEqual((await embedded.start()).token, token, 'start() is idempotent');

  const me = await call('GET', '/api/auth/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.user.username, 'admin');
  assert.strictEqual(me.json.user.role, 'admin', 'the phone owner administers their own install');

  const anon = await call('GET', '/api/notes', { auth: false });
  assert.strictEqual(anon.status, 401, 'the auth gate is the server one, unchanged');

  // A second launch finds the owner and the session already there. The session
  // is stored as the token's hash, never the token.
  const owners = await db.all(`SELECT id FROM users`);
  assert.strictEqual(owners.length, 1);
  const sessions = await db.all(`SELECT token FROM sessions`);
  assert.deepStrictEqual(sessions.map(s => s.token), [require('../src/utils/authHelpers').hashSessionToken(token)]);
  // The gate hashes every bearer token, so the device's SHA-256 (the crypto shim;
  // WebCrypto's digest is async) must be the same function as Node's.
  const shim = require('../src/embedded/shims/crypto');
  for (const input of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000), token]) {
    assert.strictEqual(shim.createHash('sha256').update(input).digest('hex'),
      require('crypto').createHash('sha256').update(input).digest('hex'), `sha256 of ${input.length} chars`);
  }
}

async function testStarterStorage() {
  const res = await call('GET', '/api/locations');
  assert.strictEqual(res.status, 200);
  const names = res.json.map(l => l.name).sort();
  assert.deepStrictEqual(names, ['Bulk Storage Box 1', 'Main Binder'], 'a new device gets the server\'s starter binder and box');

  const binder = res.json.find(l => l.name === 'Main Binder');
  const one = await call('GET', `/api/locations/${binder.id}`);
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.json.name, 'Main Binder', ':id params route through');

  // withTransaction through the shim: BEGIN, inserts, renumbering, COMMIT.
  const before = (await db.get(`SELECT COUNT(*) n FROM compartments WHERE location_id = ?`, [binder.id])).n;
  const added = await call('POST', `/api/locations/${binder.id}/compartments`, { body: {} });
  assert.strictEqual(added.status, 201);
  const after = (await db.get(`SELECT COUNT(*) n FROM compartments WHERE location_id = ?`, [binder.id])).n;
  assert.strictEqual(after, before + 1);
}

async function testTransactionRollsBack() {
  await assert.rejects(db.withTransaction(async () => {
    await db.run(`INSERT INTO notes (user_id, title) VALUES (1, 'never committed')`);
    throw new Error('boom');
  }), /boom/);
  const row = await db.get(`SELECT COUNT(*) n FROM notes WHERE title = 'never committed'`);
  assert.strictEqual(row.n, 0, 'a throw inside withTransaction rolls back');
}

async function testNotesRoundTrip() {
  const created = await call('POST', '/api/notes', { body: { title: 'Trade binder', body: 'Bring the Charizard' } });
  assert.strictEqual(created.status, 201);
  const id = created.json.note.id;
  assert.ok(id > 0, 'lastID comes back through the shim');

  const list = await call('GET', '/api/notes');
  assert.ok(list.json.notes.some(n => n.id === id));

  const updated = await call('PUT', `/api/notes/${id}`, { body: { title: 'Trade binder', body: 'Bring both', pinned: true } });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual((await db.get(`SELECT pinned FROM notes WHERE id = ?`, [id])).pinned, 1, 'a boolean binds as 1, as node-sqlite3 binds it');

  assert.strictEqual((await call('DELETE', `/api/notes/${id}`)).status, 200);
  assert.strictEqual((await call('DELETE', `/api/notes/${id}`)).status, 404, 'changes === 0 still reads as not found');

  const malformed = await call('POST', '/api/notes', { raw: '{not json' });
  assert.strictEqual(malformed.status, 400);
}

async function testCollectionAndExport() {
  await db.run(
    `INSERT INTO card_cache (id, name, set_id, set_name, number, game, language, price_trend)
     VALUES ('mtg-embedded-1', 'Llanowar Elves', 'mtg-m19', 'Core Set 2019', '314', 'mtg', 'English', 0.25)`
  );
  const added = await call('POST', '/api/collection', { body: { card_id: 'mtg-embedded-1', game: 'mtg' } });
  assert.strictEqual(added.status, 200, JSON.stringify(added.json));
  assert.ok(added.json.id > 0);

  const list = await call('GET', '/api/collection?game=mtg');
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.includes('Llanowar Elves'));

  const csv = await call('GET', '/api/export?format=csv');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(csv.body.includes('Llanowar Elves'), 'export reads the device collection');
}

// A full backup restores the account as it was: storage, placement, decks, notes,
// and the card data behind them, with every reference renumbered consistently.
async function testBackupRoundTrip() {
  const binder = (await call('GET', '/api/locations')).json.find(l => l.name === 'Main Binder');
  const comp = await db.get(`SELECT id FROM compartments WHERE location_id = ? ORDER BY idx LIMIT 1`, [binder.id]);
  await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = 1000 WHERE card_id = 'mtg-embedded-1'`, [binder.id, comp.id]);
  await db.run(`INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, 'mtg-m19')`, [comp.id]);
  const deck = await call('POST', '/api/decks', { body: { name: 'Elves', game: 'mtg' } });
  assert.ok([200, 201].includes(deck.status), JSON.stringify(deck.json));
  const deckId = (await db.get(`SELECT id FROM decks WHERE name = 'Elves'`)).id;
  await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'mtg-embedded-1', 4)`, [deckId]);
  await call('POST', '/api/notes', { body: { title: 'Keep', body: 'this note' } });
  // A sealed box, one unit opened, the copy filed as coming out of it.
  const purchase = await db.run(`INSERT INTO sealed_purchases (user_id, product_name, quantity) VALUES (1, 'Booster Box', 1)`);
  const unit = await db.run(`INSERT INTO sealed_units (purchase_id, opened_at) VALUES (?, CURRENT_TIMESTAMP)`, [purchase.lastID]);
  await db.run(`UPDATE collection SET sealed_unit_id = ? WHERE card_id = 'mtg-embedded-1'`, [unit.lastID]);
  // The deck's missing-cards list, with one wanted card.
  const wish = await db.run(`INSERT INTO card_lists (user_id, name, kind, deck_id) VALUES (1, 'Elves wants', 'missing', ?)`, [deckId]);
  await db.run(`INSERT INTO card_list_items (list_id, card_id, quantity_wanted) VALUES (?, 'mtg-embedded-1', 2)`, [wish.lastID]);
  const lists = await call('GET', '/api/lists');
  assert.strictEqual(lists.status, 200, 'lists are mounted on the device');

  const backup = await call('GET', '/api/backup');
  assert.strictEqual(backup.status, 200);
  assert.strictEqual(backup.json.format, 'bindarr-backup');
  assert.ok(backup.json.data.card_cache.some(c => c.id === 'mtg-embedded-1'), 'the cards a backup names travel with it');

  // Change everything, including dropping the card data, as on a fresh install.
  await call('POST', '/api/notes', { body: { title: 'Throwaway' } });
  await db.run(`DELETE FROM deck_cards`);
  await db.run(`DELETE FROM decks`);
  await db.run(`DELETE FROM collection`);
  await db.run(`DELETE FROM sealed_purchases`);
  await db.run(`DELETE FROM card_lists`);
  await db.run(`DELETE FROM price_history`);
  await db.run(`DELETE FROM card_cache WHERE id = 'mtg-embedded-1'`);

  const restored = await call('POST', '/api/backup/restore', { body: { backup: backup.json } });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  assert.deepStrictEqual([restored.json.cards, restored.json.skipped, restored.json.decks], [1, 0, 1]);

  const copy = await db.get(
    `SELECT c.position, l.name AS loc, cp.idx FROM collection c
       JOIN locations l ON l.id = c.location_id JOIN compartments cp ON cp.id = c.compartment_id
      WHERE c.card_id = 'mtg-embedded-1'`
  );
  assert.deepStrictEqual(copy, { position: 1000, loc: 'Main Binder', idx: 1 }, 'the copy is back in the same pocket');
  const rule = await db.get(
    `SELECT a.filter_value FROM compartment_assignments a JOIN compartments cp ON cp.id = a.compartment_id
       JOIN locations l ON l.id = cp.location_id WHERE l.name = 'Main Binder'`
  );
  assert.strictEqual(rule.filter_value, 'mtg-m19', 'filing rules follow their renumbered pages');
  const dc = await db.get(`SELECT d.name, dc.quantity FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id`);
  assert.deepStrictEqual(dc, { name: 'Elves', quantity: 4 });
  const opened = await db.get(
    `SELECT p.product_name FROM collection c JOIN sealed_units u ON u.id = c.sealed_unit_id
       JOIN sealed_purchases p ON p.id = u.purchase_id WHERE c.card_id = 'mtg-embedded-1'`
  );
  assert.strictEqual(opened && opened.product_name, 'Booster Box', 'sealed product and the copy opened from it come back linked');
  const wanted = await db.get(
    `SELECT l.name, d.name AS deck, i.quantity_wanted FROM card_list_items i JOIN card_lists l ON l.id = i.list_id
       JOIN decks d ON d.id = l.deck_id WHERE i.card_id = 'mtg-embedded-1'`
  );
  assert.deepStrictEqual(wanted, { name: 'Elves wants', deck: 'Elves', quantity_wanted: 2 }, 'lists come back tied to their renumbered deck');
  const titles = (await db.all(`SELECT title FROM notes ORDER BY title`)).map(n => n.title);
  assert.ok(titles.includes('Keep') && !titles.includes('Throwaway'), 'restore replaces, it does not merge');

  const bad = await call('POST', '/api/backup/restore', { body: { backup: { format: 'something-else' } } });
  assert.strictEqual(bad.status, 400);
}

async function testServerOnlyRoutes() {
  for (const url of ['/api/admin/users', '/api/shared/abc123', '/api/card-art/index']) {
    const res = await call('GET', url);
    assert.strictEqual(res.status, 501, `${url} is not on the device`);
    assert.strictEqual(res.json.deviceMode, true);
  }
  const missing = await call('GET', '/api/no-such-route');
  assert.strictEqual(missing.status, 404);
  assert.ok(missing.json.error);

  // The scan pipeline is bundled but has no models or catalog: the documented
  // 503 notBuilt, never a guessed match.
  const scan = await call('POST', '/api/scan-match', { body: { game: 'mtg', image: `data:image/jpeg;base64,${'A'.repeat(400)}` } });
  assert.strictEqual(scan.status, 503);
  assert.strictEqual(scan.json.notBuilt, true);
  assert.strictEqual(scan.json.deviceMode, true, 'answered before the route reaches for Buffer');
  assert.deepStrictEqual(scan.json.candidates, []);
  // The route's own check agrees: the fs stand-in reports no models.
  assert.strictEqual(require('../src/cvScan').isBuilt('mtg'), false);

  const loaded = Object.keys(require.cache).map(f => f.replace(/\\/g, '/'));
  for (const pkg of ['sharp', 'onnxruntime-node', 'express', 'express-rate-limit']) {
    assert.ok(!loaded.some(f => f.includes(`/node_modules/${pkg}/`)), `${pkg} must not load in device mode`);
  }
}

// Scanning on the device: the app supplies a catalog through setScanSource and
// sends milo's embedding instead of a photo; the route resolves the hit as usual.
async function testDeviceScan() {
  const unit = (k) => Array.from({ length: 128 }, (_, d) => (d === k ? 1 : 0));
  const ids = ['scan-a', 'scan-b', 'scan-c'];
  for (const [i, id] of ids.entries()) {
    await db.run(
      `INSERT INTO card_cache (id, name, set_id, number, game, language, image_url, last_updated)
       VALUES (?, ?, 'mtg-tst', ?, 'mtg', 'English', 'https://example.test/a.jpg', CURRENT_TIMESTAMP)`,
      [`mtg-${id}`, `Scan Card ${i}`, String(i + 1)]
    );
  }
  const body = { game: 'mtg', embedding: unit(1), thumb: 'data:image/jpeg;base64,AAAA' };

  const before = await call('POST', '/api/scan-match', { body });
  assert.strictEqual(before.status, 503, 'no scan data on the device yet');
  assert.strictEqual(before.json.notBuilt, true);

  let loads = 0;
  embedded.setScanSource({
    hasModels: () => true,
    hasCatalog: (game) => game === 'mtg',
    loadCatalog: async () => {
      loads++;
      return { cat: Float32Array.from(ids.flatMap((_, i) => unit(i))), ids, n: ids.length, dim: 128 };
    },
  });
  const res = await call('POST', '/api/scan-match', { body });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.strictEqual(res.json.candidates[0].cardId, 'mtg-scan-b', 'the embedding finds its own card');
  assert.strictEqual(res.json.candidates[0].card.name, 'Scan Card 1', 'and the route names it from card_cache');
  assert.strictEqual(res.json.crop, body.thumb, 'the thumbnail the app sent comes back as the crop');
  assert.strictEqual(res.json.notInCatalog, false);
  await call('POST', '/api/scan-match', { body });
  assert.strictEqual(loads, 1, 'a catalog is loaded once, not per scan');

  const sets = await call('GET', '/api/scan-sets?game=mtg');
  assert.deepStrictEqual(sets.json.builtLangs, ['English'], 'the scanner offers the downloaded catalog');
  const lorcana = await call('POST', '/api/scan-match', { body: { ...body, game: 'lorcana' } });
  assert.strictEqual(lorcana.status, 503);
  assert.match(lorcana.json.error, /Lorcana/);
}

async function main() {
  try {
    testRouterMatching();
    await testBootAndSession();
    await testStarterStorage();
    await testTransactionRollsBack();
    await testNotesRoundTrip();
    await testCollectionAndExport();
    await testBackupRoundTrip();
    await testServerOnlyRoutes();
    await testDeviceScan();
  } finally {
    try { await new Promise(ok => db.dbConnection.close(ok)); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

main()
  .then(() => console.log('Embedded (device mode) backend self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
