// GET /collection paging and the grid's slim column set.
//
// A 20,000-row collection used to come back as one response of every row with
// every column. The grid now asks for ?fields=grid&limit&offset and stitches the
// pages together, so the pages have to be exactly the unpaged list cut into
// pieces: same order, nothing repeated, nothing skipped — including rows that
// share an added_at second, which a bulk add produces by the hundred. The
// filters have to hold across every page, and the slim rows have to keep what
// the grid reads while dropping what it does not.
//
// Real temporary SQLite; no provider is reachable from these routes.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-collectionpaging-${process.pid}.db`);
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

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.headers['x-user-id']), role: 'member' }; next(); });
  app.use('/api', require('../src/routes/collection'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function main() {
  await db.initDb();
  const mkUser = async (name) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [name, db.hashPassword('x'), `share-${name}-${process.pid}`]
  )).lastID;
  const alice = await mkUser('page-alice');
  const bob = await mkUser('page-bob');

  await db.run(
    `INSERT INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url,
       price_trend, price_holofoil, tcgplayer_url, game)
     VALUES ('pk-1', 'Pika', 'Pokémon', '["Basic"]', '["Lightning"]', 'Rare', 'base', 'Base', '1', 'p.png',
       2, 9, 'https://example.test/pk-1', 'pokemon')`
  );
  await db.run(`INSERT INTO card_cache (id, name, set_name, number, price_trend, game) VALUES ('mtg-1', 'Bolt', 'Alpha', '1', 5, 'mtg')`);
  // Cached before multi-game support: no game at all, which means Pokémon.
  await db.run(`INSERT INTO card_cache (id, name, set_name, number, price_trend) VALUES ('old-1', 'Oldie', 'Jungle', '7', 1)`);

  // 230 rows for Alice in four timestamps, so most rows tie on added_at and only
  // the id tie-break orders them. Every fifth is Magic, every seventh a trade.
  const stamps = ['2026-01-01 10:00:00', '2026-02-01 10:00:00', '2026-02-01 10:00:00', '2026-03-01 10:00:00'];
  await db.withTransaction(async () => {
    for (let i = 0; i < 230; i++) {
      const card = i % 5 === 0 ? 'mtg-1' : (i % 11 === 0 ? 'old-1' : 'pk-1');
      await db.run(
        `INSERT INTO collection (card_id, user_id, quantity, condition, printing, is_trade, list_type, notes, cert_number, grader, grade, added_at, game)
         VALUES (?, ?, 1, 'Near Mint', ?, ?, ?, 'private note', ?, ?, ?, ?, ?)`,
        [card, alice, i % 3 === 0 ? 'Holofoil' : 'Normal', i % 7 === 0 ? 1 : 0, i % 23 === 0 ? 'wishlist' : 'collection',
          i === 4 ? 'CERT-4' : null, i === 4 ? 'PSA' : 'Raw', i === 4 ? 10 : null,
          stamps[i % stamps.length], card === 'mtg-1' ? 'mtg' : 'pokemon']
      );
    }
    // Bob's rows must never show up in Alice's pages.
    for (let i = 0; i < 15; i++) {
      await db.run(`INSERT INTO collection (card_id, user_id, quantity, added_at, game) VALUES ('pk-1', ?, 1, '2026-02-01 10:00:00', 'pokemon')`, [bob]);
    }
  });

  const base = await startApp();
  const get = (url, userId = alice) => fetch(`${base}/api${url}`, { headers: { 'x-user-id': String(userId) } });
  const pagesOf = async (query, size) => {
    const rows = [];
    let total = null;
    for (let offset = 0; ; offset += size) {
      const res = await get(`/collection?${query}${query ? '&' : ''}limit=${size}&offset=${offset}`);
      assert.strictEqual(res.status, 200);
      const n = Number(res.headers.get('x-total-count'));
      if (total == null) total = n;
      assert.strictEqual(n, total, 'every page reports the same unpaged total');
      const page = await res.json();
      rows.push(...page);
      if (page.length < size) break;
    }
    return { rows, total };
  };
  const ids = (rows) => rows.map(r => r.entry_id);

  // --- 1. Pages concatenate to exactly the unpaged list. ---
  const full = await (await get('/collection')).json();
  assert.strictEqual(full.length, 220, 'the 230 rows minus the 10 on the wishlist');
  assert.ok(!full.some(r => r.entry_id > 230), 'none of Bob\'s rows');
  for (let i = 1; i < full.length; i++) {
    const [a, b] = [full[i - 1], full[i]];
    assert.ok(a.added_at > b.added_at || (a.added_at === b.added_at && a.entry_id > b.entry_id),
      `rows ${a.entry_id} and ${b.entry_id} are out of order`);
  }
  for (const size of [1, 7, 50, 219, 220, 5000]) {
    const { rows, total } = await pagesOf('', size);
    assert.strictEqual(total, 220);
    assert.deepStrictEqual(ids(rows), ids(full), `pages of ${size} must equal the unpaged list`);
  }
  console.log('PASS: pages of any size concatenate to the unpaged order, ties on added_at included');

  // --- 2. Filters hold on every page, and the total counts the filtered rows. ---
  const cases = [
    ['list_type=wishlist', r => r.list_type === 'wishlist'],
    ['is_trade=1', r => r.is_trade === 1 && r.list_type === 'collection'],
    ['game=mtg', r => r.game === 'mtg'],
    ['game=pokemon', r => (r.game || 'pokemon') === 'pokemon'],
    ['game=mtg&is_trade=1', r => r.game === 'mtg' && r.is_trade === 1],
  ];
  for (const [query, keep] of cases) {
    const expected = ids((await (await get(`/collection?${query}`)).json()));
    const { rows, total } = await pagesOf(query, 9);
    assert.ok(expected.length > 0, `${query} matches something`);
    assert.strictEqual(total, expected.length, `${query}: X-Total-Count is the filtered total`);
    assert.deepStrictEqual(ids(rows), expected, `${query}: paged equals unpaged`);
    assert.ok(rows.every(keep), `${query}: every paged row matches the filter`);
  }
  const oldCards = (await (await get('/collection?game=pokemon')).json()).filter(r => r.card_id === 'old-1');
  assert.ok(oldCards.length > 0, 'a card cached with no game counts as Pokémon');
  console.log('PASS: list_type, is_trade and game filter every page, and the total follows them');

  // --- 3. fields=grid keeps what the grid reads and drops the rest. ---
  const slim = await (await get('/collection?fields=grid&limit=5000&offset=0')).json();
  assert.deepStrictEqual(ids(slim), ids(full), 'slim rows are the same rows in the same order');
  const holo = slim.find(r => r.card_id === 'pk-1' && r.printing === 'Holofoil');
  assert.strictEqual(holo.price_trend, 9, 'price_trend is still resolved for the printing');
  for (const key of ['name', 'set_name', 'number', 'image_url', 'rarity', 'game', 'condition', 'grader',
    'location_id', 'added_at', 'favorite', 'checked_out_qty', 'sealed_unit_id']) {
    assert.ok(key in holo, `grid row keeps ${key}`);
  }
  assert.deepStrictEqual(holo.types, ['Lightning'], 'JSON columns are parsed as before');
  for (const key of ['notes', 'cert_number', 'tcgplayer_url', 'purchase_price', 'price_holofoil', 'market_value',
    'location_name', 'compartment_label', 'sealed_product_notes']) {
    assert.ok(!(key in holo), `grid row drops ${key}`);
  }
  const fullBytes = JSON.stringify(full).length;
  const slimBytes = JSON.stringify(slim).length;
  assert.ok(slimBytes < fullBytes * 0.75, `slim rows are much smaller (${slimBytes} vs ${fullBytes} bytes)`);
  console.log(`PASS: fields=grid keeps the grid's columns and drops the rest (${slimBytes} vs ${fullBytes} bytes)`);

  // --- 4. One full entry by id, for the popup; nobody else's. ---
  let res = await get('/collection/5');
  assert.strictEqual(res.status, 200);
  const one = await res.json();
  assert.strictEqual(one.entry_id, 5);
  assert.strictEqual(one.cert_number, 'CERT-4');
  assert.strictEqual(one.notes, 'private note');
  assert.deepStrictEqual(one, full.find(r => r.entry_id === 5), 'the single entry is the full row, unchanged');
  res = await get('/collection/5', bob);
  assert.strictEqual(res.status, 404, 'another user\'s entry is not found');
  assert.deepStrictEqual(Object.keys(await res.json()), ['error']);
  res = await get('/collection/notanumber');
  assert.strictEqual(res.status, 404, 'a non-numeric id is passed on to other routes, not looked up');
  console.log('PASS: GET /collection/:id returns the full row to its owner only');

  // --- 5. Bad paging is a 400, not a silent full dump. ---
  for (const query of ['limit=0', 'limit=-1', 'limit=abc', 'limit=5001', 'offset=-3', 'offset=1.5', 'fields=everything']) {
    res = await get(`/collection?${query}`);
    assert.strictEqual(res.status, 400, `${query} is rejected`);
    assert.deepStrictEqual(Object.keys(await res.json()), ['error']);
  }
  res = await get('/collection?limit=10&offset=100000');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), [], 'an offset past the end is an empty page');
  assert.strictEqual(res.headers.get('x-total-count'), '220');
  console.log('PASS: invalid limit/offset/fields are 400s; an offset past the end is an empty page');
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('FAIL:', err);
    await cleanup();
    process.exit(1);
  });
