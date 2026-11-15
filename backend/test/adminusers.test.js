// Admin → Users showed each account's collection value with its own copy of the
// price CASE: no graded market_value, wishlist rows counted as owned, and USD and
// EUR prices added together, one query per user. It now reads the same figures as
// the dashboard and /metrics (utils/collectionMetrics).
// Run: `node test/adminusers.test.js`
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-adminusers-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.BINDARR_DISABLE_FX_SYNC = '1';

const express = require('express');
const db = require('../src/db');
const { generateSession } = require('../src/utils/authHelpers');

let server;

async function main() {
  await db.initDb();
  const admin = await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('boss', 'x', 'admin', 'share-boss')`);
  const member = await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('ash', 'x', 'member', 'share-ash')`);
  const token = await generateSession(admin.lastID);

  await db.run(`INSERT INTO card_cache (id, name, game, price_trend, price_currency) VALUES ('own', 'Owned', 'pokemon', 10, 'USD')`);
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend, price_currency) VALUES ('want', 'Wanted', 'pokemon', 100, 'USD')`);
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend, price_currency) VALUES ('slab', 'Slab', 'pokemon', 5, 'USD')`);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game, quantity) VALUES ('own', ?, 'collection', 'pokemon', 1)`, [member.lastID]);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game, quantity) VALUES ('want', ?, 'wishlist', 'pokemon', 1)`, [member.lastID]);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game, quantity, grader, grade, market_value) VALUES ('slab', ?, 'collection', 'pokemon', 1, 'PSA', '10', 50)`, [member.lastID]);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../src/routes/admin'));
  const base = await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  const res = await fetch(`${base}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const users = await res.json();
  const ash = users.find(u => u.username === 'ash');
  assert.ok(ash, 'the member is listed');
  assert.strictEqual(ash.unique_cards, 2, 'the wishlisted card is not counted as owned');
  assert.strictEqual(ash.total_cards, 2);
  assert.strictEqual(ash.total_value, 60, 'owned card ($10) plus the slab at its graded value ($50), no wishlist ($100)');
  assert.strictEqual(ash.value_currency, 'USD');
  const boss = users.find(u => u.username === 'boss');
  assert.strictEqual(boss.total_value, 0, 'an account with no cards is listed at zero');
  assert.deepStrictEqual(users.map(u => u.username), ['ash', 'boss'], 'still ordered by username');

  console.log('adminusers.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (server) await new Promise(r => server.close(r));
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
