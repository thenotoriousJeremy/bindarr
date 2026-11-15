// Public share links are rate-limited and briefly cached (SEC-09).
//
// /api/shared needs no account, and each view built the owner's whole collection
// and its stats on the one database connection everyone shares, as often as
// anyone asked. Now: a per-address limit on the share routes (binder artwork
// images excepted, a page can show dozens), and the collection view is reused for
// a few seconds -- while turning sharing off still takes effect at once.
//
// The real shared router in this process. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-sharedlimit-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');

let server;
async function cleanup() {
  if (server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function main() {
  await db.initDb();
  const owner = (await db.run(
    `INSERT INTO users (username, password_hash, share_token, share_enabled, share_locations) VALUES ('sharer', 'x', 'share-tok', 1, 1)`
  )).lastID;
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend) VALUES ('mtg-shared-1', 'Shared Card', 'mtg', 2)`);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, game) VALUES ('mtg-shared-1', ?, 1, 'mtg')`, [owner]);

  const app = express();
  app.use('/api/shared', require('../src/routes/shared'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  // --- a short cache, which never outlives turning sharing off ------------------------
  let r = await get('/api/shared/share-tok');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.stats.summary.totalCards, 1);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, game) VALUES ('mtg-shared-1', ?, 1, 'mtg')`, [owner]);
  r = await get('/api/shared/share-tok');
  assert.strictEqual(r.json.stats.summary.totalCards, 1, 'a view seconds later is the same one, not rebuilt');
  r = await get('/api/shared/share-tok?list=wishlist');
  assert.strictEqual(r.status, 200, 'another list is its own view');
  await db.run(`UPDATE users SET share_enabled = 0 WHERE id = ?`, [owner]);
  r = await get('/api/shared/share-tok');
  assert.strictEqual(r.status, 404, 'turning sharing off takes effect at once, cache or not');
  await db.run(`UPDATE users SET share_enabled = 1 WHERE id = ?`, [owner]);
  console.log('PASS: the shared view is reused briefly, and never past turning sharing off');

  // --- a per-address limit ------------------------------------------------------------
  // Four requests so far. Binder artwork is not counted.
  for (let i = 0; i < 70; i++) {
    assert.strictEqual((await get(`/api/shared/share-tok/containers/1/art/${i + 1}`)).status, 404, 'art requests are answered');
  }
  for (let i = 0; i < 56; i++) {
    assert.notStrictEqual((await get('/api/shared/share-tok')).status, 429, `view ${i + 5} is within the limit`);
  }
  r = await get('/api/shared/share-tok');
  assert.strictEqual(r.status, 429, 'the sixty-first share request in a minute is refused');
  assert.ok(r.json && r.json.error, 'with a JSON error');
  assert.strictEqual((await get('/api/shared/share-tok/containers/1/art/1')).status, 404, 'artwork still answers');
  console.log('PASS: share links are rate-limited per address');

  console.log('PASS: sharedlimit.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
