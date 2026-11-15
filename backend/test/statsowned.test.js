// What the dashboard and the metrics count as owned, and how they add it up:
//
//   - /stats and /stats/history count the collection, not the wishlist. They used
//     to filter by user only, so a $10 card plus a $100 wishlisted one read $110,
//     with the wishlisted card as "most valuable" (/stats/networth already did it
//     right, and all three share one condition now);
//   - the Prometheus value converts EUR to USD at the day's rate instead of
//     adding the two as if they were one currency, and skips the wishlist too;
//   - the dashboard's set progress counts a set the way the set page does: one card
//     per collector number ("7" and "007" are the same card), wishlist excluded,
//     out of the set's listing when the set page has listed it.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-statsowned-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const getCollectionMetrics = require('../src/utils/collectionMetrics');
const { buildCompletion } = require('../src/utils/setCompletion');

let server;
let userId;

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
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/stats'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api`));
  });
}

let base;
const get = async (url) => {
  const res = await fetch(base + url);
  return { status: res.status, body: await res.json() };
};

async function wishlistIsNotOwned() {
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend, price_currency) VALUES ('own', 'Owned Card', 'pokemon', 10, 'USD')`);
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend, price_currency) VALUES ('want', 'Wanted Card', 'pokemon', 100, 'USD')`);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game, added_at) VALUES ('own', ?, 'collection', 'pokemon', '2025-01-01 00:00:00')`, [userId]);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game, added_at) VALUES ('want', ?, 'wishlist', 'pokemon', '2025-01-01 00:00:00')`, [userId]);

  const stats = await get('/stats');
  assert.strictEqual(stats.status, 200);
  assert.strictEqual(stats.body.summary.totalValue, 10, 'the wishlisted card is not part of the collection value');
  assert.strictEqual(stats.body.summary.totalCards, 1);
  assert.strictEqual(stats.body.summary.uniqueCards, 1);
  assert.deepStrictEqual(stats.body.topValuable.map(c => c.name), ['Owned Card'], 'nor the most valuable card');
  assert.deepStrictEqual(stats.body.recentAdditions.map(c => c.name), ['Owned Card']);

  const history = await get('/stats/history?period=7d');
  assert.strictEqual(history.status, 200);
  assert.strictEqual(history.body.at(-1).value, 10, 'the value timeline counts the same copies');

  const networth = await get('/stats/networth');
  assert.strictEqual(networth.body.totalValue, stats.body.summary.totalValue, 'the dashboard and net worth agree');
  console.log('PASS: the dashboard, its timeline and net worth count the collection, not the wishlist');
}

async function metricsConvertCurrencies() {
  const metricUser = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('metrics', 'x', 'member', 'tok-m')`)).lastID;
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend, price_currency) VALUES ('usd', 'Dollar Card', 'mtg', 10, 'USD')`);
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend, price_currency) VALUES ('eur', 'Euro Card', 'pokemon', 10, 'EUR')`);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game) VALUES ('usd', ?, 'collection', 'mtg')`, [metricUser]);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game) VALUES ('eur', ?, 'collection', 'pokemon')`, [metricUser]);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game) VALUES ('usd', ?, 'wishlist', 'mtg')`, [metricUser]);
  // 1 EUR = 1.10 USD.
  await db.run(`INSERT INTO fx_rates (rate_date, currency, rate) VALUES ('2026-11-13', 'USD', 1.1)`);

  const metrics = await getCollectionMetrics(db);
  const user = metrics.users.find(u => u.username === 'metrics');
  assert.strictEqual(user.total_cards, 2, 'the wishlisted copy is not counted');
  assert.strictEqual(user.total_value, 21, '10 USD and 10 EUR (11 USD) are 21 USD, not 20');
  assert.strictEqual(metrics.valueCurrency, 'USD');
  // The first user owns one $10 card (its $100 wishlisted card is left out).
  assert.strictEqual(metrics.totalValue, 31);
  const types = metrics.types.filter(t => t.username === 'metrics').map(t => t.cards).reduce((a, b) => a + b, 0);
  assert.strictEqual(types, 2, 'the type breakdown leaves the wishlist out too');
  console.log('PASS: the metrics convert EUR to USD and leave the wishlist out');
}

async function setProgressLikeTheSetPage() {
  await db.run(`INSERT INTO sets (id, name, printed_total, total, game) VALUES ('sp1', 'Progress Set', 10, 12, 'pokemon')`);
  const cards = [['sp1-7', '7'], ['sp1-007', '007'], ['sp1-8', '8']];
  for (const [id, number] of cards) {
    await db.run(`INSERT INTO card_cache (id, name, set_id, set_name, number, game, language, price_trend) VALUES (?, ?, 'sp1', 'Progress Set', ?, 'pokemon', 'English', 1)`,
      [id, `Card ${number}`, number]);
  }
  // The same card of the set under two spellings of its number, and a wishlisted one.
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game, language) VALUES ('sp1-7', ?, 'collection', 'pokemon', 'English')`, [userId]);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game, language) VALUES ('sp1-007', ?, 'collection', 'pokemon', 'English')`, [userId]);
  await db.run(`INSERT INTO collection (card_id, user_id, list_type, game, language) VALUES ('sp1-8', ?, 'wishlist', 'pokemon', 'English')`, [userId]);

  const progress = async () => (await get('/stats')).body.setProgress.find(p => p.setId === 'sp1');
  let p = await progress();
  assert.strictEqual(p.ownedUnique, 1, '"7" and "007" are one card, and the wishlisted card is not owned');
  assert.strictEqual(p.totalCards, 10, 'out of the printed size while the set page has not listed the set');
  assert.strictEqual(p.percent, 10);

  // What the set page computes from the same copies.
  const owned = await db.all(`SELECT c.quantity, c.printing, c.list_type, cc.set_id, cc.set_name, cc.number
                                FROM collection c JOIN card_cache cc ON cc.id = c.card_id WHERE c.user_id = ? AND cc.game = 'pokemon'`, [userId]);
  // A set's listing names each card once.
  const listing = ['sp1-7', 'sp1-8', 'sp1-9', 'sp1-10', 'sp1-11'];
  const page = buildCompletion({ game: 'pokemon', set: { id: 'sp1', name: 'Progress Set' }, cards: listing.map(id => ({ id, number: id.split('-')[1], set_id: 'sp1' })), owned });
  assert.strictEqual(page.summary.cards.owned, p.ownedUnique, 'the dashboard owns what the set page owns');

  // Once the set page has listed the set, the dashboard counts against that listing.
  await db.run(`INSERT INTO set_listings (game, language, set_id, source, card_ids, meta) VALUES ('pokemon', 'en', 'sp1', 'test', ?, '{}')`,
    [JSON.stringify(listing)]);
  p = await progress();
  assert.strictEqual(p.totalCards, listing.length, 'the listing is the size');
  assert.strictEqual(p.percent, page.summary.cards.percent, 'and the percentage is the set page\'s');
  console.log('PASS: dashboard set progress uses the set page\'s rules');
}

async function main() {
  await db.initDb();
  userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('stats', 'x', 'admin', 'tok')`)).lastID;
  base = await startApp();
  await wishlistIsNotOwned();
  await metricsConvertCurrencies();
  await setProgressLikeTheSetPage();
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
