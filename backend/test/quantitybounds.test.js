// Quantity is bounded everywhere it decides how many rows get written. A copy is
// a row, and every route used to read the number with parseInt, floored at 1 and
// no ceiling: 1e9 asked for a billion INSERTs, and -3, 2.5 and "abc" were quietly
// turned into one or two copies. Requests now get a 400 for anything but a whole
// number from 1 to 9,999; an imported row is clamped into that range instead and
// counted in the summary, so one odd cell does not sink a whole file.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-quantitybounds-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const { MAX_QUANTITY, readQuantity, clampImportQuantity } = require('../src/utils/requestBounds');

let server;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp(userId) {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/collection'));
  app.use('/api', require('../src/routes/importExport'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function call(base, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const copiesOf = async (cardId) => (await db.get(`SELECT COALESCE(SUM(quantity), 0) AS n FROM collection WHERE card_id = ?`, [cardId])).n;

async function main() {
  // --- the two readers -------------------------------------------------------------
  assert.strictEqual(MAX_QUANTITY, 9999);
  for (const ok of [[1, 1], ['3', 3], [' 12 ', 12], [9999, 9999], [4.0, 4]]) {
    assert.deepStrictEqual(readQuantity(ok[0]), { value: ok[1] }, `accepts ${JSON.stringify(ok[0])}`);
  }
  for (const bad of [0, -1, 2.5, '2.5', 'abc', '', null, true, 1e9, 10000, '1e3', [], {}, NaN, Infinity]) {
    assert.ok(readQuantity(bad).error, `refuses ${JSON.stringify(bad)}`);
  }
  assert.deepStrictEqual(readQuantity(undefined, { fallback: 1 }), { value: 1 }, 'an absent field takes the fallback');
  assert.deepStrictEqual(readQuantity(undefined, { fallback: null }), { value: null });

  const clamp = (raw) => clampImportQuantity(raw);
  assert.deepStrictEqual(clamp(undefined), { copies: 1, clamped: false });
  assert.deepStrictEqual(clamp(''), { copies: 1, clamped: false });
  assert.deepStrictEqual(clamp('3'), { copies: 3, clamped: false });
  assert.deepStrictEqual(clamp('3x'), { copies: 3, clamped: false }, 'a number with junk after it still reads');
  assert.deepStrictEqual(clamp('abc'), { copies: 1, clamped: false }, 'no number at all is one copy, as before');
  assert.deepStrictEqual(clamp(2.7), { copies: 2, clamped: false });
  assert.deepStrictEqual(clamp(0), { copies: 1, clamped: true });
  assert.deepStrictEqual(clamp(-4), { copies: 1, clamped: true });
  assert.deepStrictEqual(clamp(1e9), { copies: 9999, clamped: true });
  assert.deepStrictEqual(clamp('20000'), { copies: 9999, clamped: true });

  // --- the routes --------------------------------------------------------------------
  scryfallApi.client.get = async (url) => { throw new Error(`no network in this test (${url})`); };
  await db.initDb();
  const userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('owner', 'x', 'admin', 'tok')`)).lastID;
  for (const id of ['mtg-a', 'mtg-b', 'mtg-c', 'mtg-d']) {
    await db.run(`INSERT INTO card_cache (id, name, game, language, price_trend) VALUES (?, ?, 'mtg', 'English', 1)`, [id, id]);
  }
  const base = await startApp(userId);

  // POST /collection
  for (const quantity of [-1, 0, 2.5, 'abc', null, 1e9, 10000]) {
    const res = await call(base, 'POST', '/api/collection', { card_id: 'mtg-a', quantity, game: 'mtg' });
    assert.strictEqual(res.status, 400, `POST quantity ${JSON.stringify(quantity)}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /whole number from 1 to 9999/);
  }
  assert.strictEqual(await copiesOf('mtg-a'), 0, 'nothing was added by a refused request');
  let res = await call(base, 'POST', '/api/collection', { card_id: 'mtg-a', quantity: '3', game: 'mtg' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.ids.length, 3, 'a form-field string still works');
  res = await call(base, 'POST', '/api/collection', { card_id: 'mtg-b', game: 'mtg' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await copiesOf('mtg-b'), 1, 'no quantity is one copy');

  // bulk-add: checked once, and the product too
  res = await call(base, 'POST', '/api/collection/bulk-add', { card_ids: ['mtg-c'], quantity: 0 });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  res = await call(base, 'POST', '/api/collection/bulk-add', { card_ids: Array.from({ length: 250 }, () => 'mtg-c'), quantity: 20 });
  assert.strictEqual(res.status, 400, '250 cards x 20 is more copies than one bulk add makes');
  assert.match(res.body.error, /5000 copies/);
  assert.strictEqual(await copiesOf('mtg-c'), 0);
  res = await call(base, 'POST', '/api/collection/bulk-add', { card_ids: ['mtg-c', 'mtg-d'], quantity: 2, game: 'mtg' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(await copiesOf('mtg-c') + await copiesOf('mtg-d'), 4);

  // PUT /collection/:id: refused before anything is written
  const entry = res.body && (await db.get(`SELECT id FROM collection WHERE card_id = 'mtg-b'`)).id;
  for (const quantity of [0, -2, 10000, '1.5', null]) {
    res = await call(base, 'PUT', `/api/collection/${entry}`, { quantity, condition: 'Damaged' });
    assert.strictEqual(res.status, 400, `PUT quantity ${JSON.stringify(quantity)}: ${JSON.stringify(res.body)}`);
  }
  assert.strictEqual((await db.get(`SELECT condition FROM collection WHERE id = ?`, [entry])).condition, 'Near Mint', 'the rest of a refused edit was not applied');
  res = await call(base, 'PUT', `/api/collection/${entry}`, { quantity: '2' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(await copiesOf('mtg-b'), 2);

  // --- import: rows are clamped and counted, the file is bounded ---------------------
  await db.run(`DELETE FROM collection`);
  res = await call(base, 'POST', '/api/import', {
    format: 'json',
    data: [
      { card_id: 'mtg-a', quantity: 100000, game: 'mtg' },
      { card_id: 'mtg-b', quantity: -2, game: 'mtg' },
      { card_id: 'mtg-c', quantity: 2, game: 'mtg' },
    ]
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.count, 9999 + 1 + 2);
  assert.strictEqual(res.body.clamped, 2);
  assert.match(res.body.message, /2 rows had a quantity outside 1–9999/);
  assert.strictEqual(await copiesOf('mtg-a'), 9999, 'a huge count is cut to the most one row may ask for');
  assert.strictEqual(await copiesOf('mtg-b'), 1, 'a negative one is one copy');

  await db.run(`DELETE FROM collection`);
  res = await call(base, 'POST', '/api/import', {
    format: 'json',
    data: Array.from({ length: 6 }, () => ({ card_id: 'mtg-d', quantity: 9999, game: 'mtg' }))
  });
  assert.strictEqual(res.status, 413, 'six rows of 9,999 is more copies than one import writes');
  assert.match(res.body.error, /Too many copies \(59994\)/);
  assert.strictEqual(await copiesOf('mtg-d'), 0, 'and nothing was written');

  console.log('quantitybounds ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
