// GET /api/stats/history on a collection with more distinct cards than SQLite
// has bind variables. The timeline used to look up price history with one `?`
// per card, so past 32,766 cards the whole request failed with "too many SQL
// variables" and the dashboard chart was a 500. It names the cards with a
// subquery on the collection now, which binds the same two values for any size.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-statshistory-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const express = require('express');
const db = require('../src/db');

const CARDS = 33000;
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
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/stats'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function main() {
  await db.initDb();
  const { id: userId } = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  const otherId = (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('other', 'x', 'other-share')`)).lastID;

  // 33,000 Pokémon cards at 1.00, one copy each, owned since 2020.
  await db.withTransaction(async () => {
    await db.run(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${CARDS})
      INSERT INTO card_cache (id, name, game, price_trend) SELECT 'card-' || i, 'Card ' || i, 'pokemon', 1 FROM n`);
    await db.run(`
      INSERT INTO collection (card_id, user_id, quantity, game, added_at)
      SELECT id, ?, 1, 'pokemon', '2020-01-01 00:00:00' FROM card_cache WHERE id LIKE 'card-%'`, [userId]);
  });
  // card-1 has a recorded price of 5, from before the chart's window.
  await db.run(`INSERT INTO price_history (card_id, price, recorded_at, currency) VALUES ('card-1', 5, '2021-06-01 00:00:00', 'USD')`);
  // A Magic card worth 100, to see the game filter reach the history query too.
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend) VALUES ('mtg-x', 'Magic Card', 'mtg', 100)`);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, game, added_at) VALUES ('mtg-x', ?, 1, 'mtg', '2020-01-01 00:00:00')`, [userId]);
  // Somebody else's history for a card this user does not own must not matter.
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend) VALUES ('theirs', 'Their Card', 'pokemon', 1)`);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, game, added_at) VALUES ('theirs', ?, 1, 'pokemon', '2020-01-01 00:00:00')`, [otherId]);
  await db.run(`INSERT INTO price_history (card_id, price, recorded_at, currency) VALUES ('theirs', 999, '2021-06-01 00:00:00', 'USD')`);

  const base = await startApp(userId);

  let res = await fetch(`${base}/api/stats/history?period=7d`);
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.length, 7);
  // 32,999 cards at 1 + card-1 at its recorded 5 + the Magic card at 100.
  assert.ok(body.every(p => p.value === CARDS - 1 + 5 + 100), JSON.stringify(body.slice(-2)));

  res = await fetch(`${base}/api/stats/history?period=7d&game=pokemon`);
  const pokemon = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(pokemon));
  assert.ok(pokemon.every(p => p.value === CARDS - 1 + 5), 'the game filter applies to the history lookup as well');

  // The (user_id, card_id) index exists and is what a per-card lookup uses.
  const indexes = (await db.all(`PRAGMA index_list(collection)`)).map(i => i.name);
  assert.ok(indexes.includes('idx_collection_user_card'), indexes.join(', '));
  const plan = (await db.all(`EXPLAIN QUERY PLAN SELECT SUM(quantity) FROM collection WHERE user_id = ? AND card_id = ?`, [userId, 'card-1']))
    .map(r => r.detail).join(' | ');
  assert.ok(plan.includes('idx_collection_user_card'), plan);

  console.log('statshistory ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
