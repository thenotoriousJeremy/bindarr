// Currency conversion (review item 9): ECB rates parsed from a checked-in
// fixture, the conversion math, the daily fetch guard, GET /api/fx, and the
// dashboard totals over a collection quoted in both USD and EUR.
//
// Never reaches the ECB: refreshIfDue takes its fetch as a parameter here.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-fxrates-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const express = require('express');
const db = require('../src/db');
const fxRates = require('../src/fxRates');
const { convert, roundMoney, pickUnit, rateFor, parseCurrencyParam } = require('../src/utils/fx');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ecb', 'eurofxref-daily.xml'), 'utf8');
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
  app.use('/api/fx', require('../src/routes/fx'));
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/stats'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

const getJson = async (url) => {
  const res = await fetch(url);
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  return body;
};

function testParsing() {
  const parsed = fxRates.parseEcbXml(FIXTURE);
  assert.strictEqual(parsed.date, '2026-11-06');
  assert.strictEqual(parsed.rates.USD, 1.1165);
  assert.strictEqual(parsed.rates.JPY, 176.77);
  assert.strictEqual(parsed.rates.GBP, 0.83415);
  assert.strictEqual(Object.keys(parsed.rates).length, 29);
  assert.ok(!('EUR' in parsed.rates), 'the base is implicit in the file');
  assert.throws(() => fxRates.parseEcbXml('<html>maintenance</html>'), /no rate date/);
  assert.throws(() => fxRates.parseEcbXml(`<Cube time='2026-11-06'></Cube>`), /no rates/);
}

function testMath() {
  const fx = { base: 'EUR', date: '2026-11-06', rates: fxRates.parseEcbXml(FIXTURE).rates };
  // EUR is the base: one rate, no division.
  assert.strictEqual(rateFor(fx, 'EUR'), 1);
  assert.strictEqual(roundMoney(convert(10, 'EUR', 'USD', fx), 'USD'), 11.17);   // 11.165
  assert.strictEqual(roundMoney(convert(11.165, 'USD', 'EUR', fx), 'EUR'), 10);
  // Cross rate through the euro: 4.50 USD -> EUR -> JPY = 4.50 / 1.1165 * 176.77.
  assert.strictEqual(roundMoney(convert(4.5, 'USD', 'JPY', fx), 'JPY'), 712);    // 712.46, no minor unit
  assert.strictEqual(roundMoney(convert(4.5, 'USD', 'GBP', fx), 'GBP'), 3.36);   // 3.3620
  // Rounding: half-up on the cent, not binary-float half-down (1.005 -> 1.01).
  assert.strictEqual(roundMoney(1.005, 'USD'), 1.01);
  // Same currency is the identity, rates or not.
  assert.strictEqual(convert(7.25, 'USD', 'USD', null), 7.25);
  assert.strictEqual(convert(7.25, null, 'USD', null), 7.25, 'a row with no currency is USD');
  // Missing rates: null, never a guess.
  assert.strictEqual(convert(5, 'USD', 'JPY', null), null);
  assert.strictEqual(convert(5, 'USD', 'XYZ', fx), null);
  // Reporting unit: target when convertible, else the one shared currency, else none.
  assert.strictEqual(pickUnit(new Set(['USD', 'EUR']), 'JPY', fx), 'JPY');
  assert.strictEqual(pickUnit(new Set(['EUR']), 'JPY', null), 'EUR');
  assert.strictEqual(pickUnit(new Set(['USD', 'EUR']), 'USD', null), null);
  assert.strictEqual(pickUnit(new Set(), 'GBP', null), 'GBP');
  assert.strictEqual(parseCurrencyParam('jpy'), 'JPY');
  assert.strictEqual(parseCurrencyParam('US D'), null);
}

async function testRefreshGuard() {
  const t0 = Date.parse('2026-11-07T10:00:00Z');
  let calls = 0;
  const fetchXml = async () => { calls++; return FIXTURE; };

  assert.deepStrictEqual(await fxRates.refreshIfDue({ fetchXml, now: t0 }), { fetched: '2026-11-06' });
  assert.strictEqual(calls, 1);
  // Within the day: no request at all.
  assert.deepStrictEqual(await fxRates.refreshIfDue({ fetchXml, now: t0 + 23 * 3600e3 }), { skipped: 'fresh' });
  assert.strictEqual(calls, 1);
  // A day later it asks again. Same publication date: stored once, not twice.
  await fxRates.refreshIfDue({ fetchXml, now: t0 + 25 * 3600e3 });
  assert.strictEqual(calls, 2);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM fx_rates`)).n, 29);

  // A failure is reported (the scheduler job throws it) and stores nothing, so
  // the rates on record stay the last good ones.
  const broken = async () => { throw new Error('ECB down'); };
  assert.strictEqual((await fxRates.refreshIfDue({ fetchXml: broken, now: t0 + 60 * 3600e3 })).error, 'ECB down');
  // Garbage from the network is a failure too, not an empty rate table.
  assert.ok((await fxRates.refreshIfDue({ fetchXml: async () => '<html/>', now: t0 + 61 * 3600e3 })).error);

  const latest = await fxRates.latestRates();
  assert.strictEqual(latest.date, '2026-11-06');
  assert.strictEqual(latest.base, 'EUR');
  assert.strictEqual(latest.rates.EUR, 1);
  assert.strictEqual(latest.rates.USD, 1.1165);
}

async function main() {
  testParsing();
  testMath();

  await db.initDb();
  const { id: userId } = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  const base = await startApp(userId);

  // Before any fetch: 200 with null rates, which the client reads as "as quoted".
  assert.deepStrictEqual(await getJson(`${base}/api/fx`), { base: 'EUR', date: null, rates: null });

  // A $10 Pokémon card (x2, bought for $5 each) and a 10 EUR Magic card.
  await db.run(`INSERT INTO card_cache (id, name, game, set_id, set_name, price_trend, price_currency) VALUES ('p1', 'Pika', 'pokemon', 's1', 'Set One', 10, 'USD')`);
  await db.run(`INSERT INTO card_cache (id, name, game, set_id, set_name, price_trend, price_currency) VALUES ('m1', 'Bolt', 'mtg', 's2', 'Set Two', 10, 'EUR')`);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, game, purchase_price, added_at) VALUES ('p1', ?, 2, 'pokemon', 5, '2020-01-01 00:00:00')`, [userId]);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, game, added_at) VALUES ('m1', ?, 1, 'mtg', '2020-01-01 00:00:00')`, [userId]);

  // --- No rates yet: subtotals only, never 30 of anything. ---
  let stats = await getJson(`${base}/api/stats?currency=USD`);
  assert.deepStrictEqual(stats.summary.valueByCurrency, { EUR: 10, USD: 20 });
  assert.strictEqual(stats.summary.totalValue, null, 'USD and EUR are not added without a rate');
  assert.strictEqual(stats.summary.valueCurrency, null);
  assert.strictEqual(stats.summary.converted, false);
  assert.strictEqual(stats.summary.roi.abs, null);
  let history = await getJson(`${base}/api/stats/history?period=7d&currency=USD`);
  assert.ok(history.every(p => p.value === null), JSON.stringify(history.slice(-1)));
  let net = await getJson(`${base}/api/stats/networth?currency=USD`);
  assert.strictEqual(net.totalValue, null);
  assert.deepStrictEqual(net.currencies, ['EUR', 'USD']);

  // One game alone is a single currency: reported as quoted, even asked for JPY.
  stats = await getJson(`${base}/api/stats?currency=JPY&game=mtg`);
  assert.strictEqual(stats.summary.totalValue, 10);
  assert.strictEqual(stats.summary.valueCurrency, 'EUR');
  assert.strictEqual(stats.summary.converted, false);

  await testRefreshGuard();

  // --- Rates known: converted grand total, subtotals unchanged. ---
  assert.strictEqual((await getJson(`${base}/api/fx`)).date, '2026-11-06');

  stats = await getJson(`${base}/api/stats?currency=USD`);
  assert.deepStrictEqual(stats.summary.valueByCurrency, { EUR: 10, USD: 20 });
  assert.strictEqual(stats.summary.totalValue, 31.17);   // 20 + 10 * 1.1165
  assert.strictEqual(stats.summary.valueCurrency, 'USD');
  assert.strictEqual(stats.summary.converted, true);
  assert.strictEqual(stats.summary.fxDate, '2026-11-06');
  assert.deepStrictEqual(stats.summary.roi, { abs: 21.17, pct: 211.6 });
  // The EUR card is worth more than a $10 card at this rate, so it ranks first.
  assert.strictEqual(stats.topValuable[0].card_id, 'm1');
  assert.deepStrictEqual(stats.sets.map(s => [s.id, s.value]), [['s1', 20], ['s2', 11.17]]);

  stats = await getJson(`${base}/api/stats?currency=EUR`);
  assert.strictEqual(stats.summary.totalValue, 27.91);   // 20 / 1.1165 + 10
  assert.strictEqual(stats.summary.valueCurrency, 'EUR');

  stats = await getJson(`${base}/api/stats?currency=JPY`);
  assert.strictEqual(stats.summary.totalValue, 4934);    // 3166.5 + 1767.7, whole yen
  assert.strictEqual(stats.summary.valueCurrency, 'JPY');

  history = await getJson(`${base}/api/stats/history?period=7d&currency=USD`);
  assert.ok(history.every(p => p.value === 31.17), JSON.stringify(history.slice(-1)));

  net = await getJson(`${base}/api/stats/networth?currency=GBP`);
  assert.strictEqual(net.currency, 'GBP');
  assert.strictEqual(net.totalValue, 23.28);             // 20 / 1.1165 * 0.83415 + 10 * 0.83415
  assert.deepStrictEqual(net.byGame, { mtg: { cards: 1, value: 8.34 }, pokemon: { cards: 2, value: 14.94 } });
  assert.strictEqual(net.converted, true);
  // No currency asked for: USD, as the dashboard always assumed.
  net = await getJson(`${base}/api/stats/networth`);
  assert.strictEqual(net.currency, 'USD');
  assert.strictEqual(net.totalValue, 31.17);

  console.log('fxrates: all assertions passed');
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error(err);
    await cleanup();
    process.exit(1);
  });
