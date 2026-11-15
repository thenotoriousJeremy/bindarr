// Charts and graded values do not mix currencies (PROV-07).
//
// 1. The 30-day price chart plotted Cardmarket's 1/7/30-day averages (always EUR)
//    next to a price_trend that for most English Pokémon cards is TCGplayer's
//    USD: €13 of average and $20 of quote drawn as one line. The averages are now
//    plotted only when they are in the line's own currency.
// 2. A graded value is eBay US sales, in dollars, and was stored as a copy's
//    market_value — which is read in the card's own currency. fetchGradedPrice now
//    says which currency its price is in, and converts to the card's currency when
//    asked, refusing when there is no rate rather than filing $120 as €120.
//
// Offline: the graded-price client is stubbed and the ECB rates are seeded.
// Run: `node test/pricecurrency.test.js`
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-pricecurrency-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const gradedPrices = require('../src/gradedPrices');

let server;

async function chartPoints(base, id) {
  const r = await fetch(`${base}/api/cards/${id}/price-history?range=30d`);
  assert.strictEqual(r.status, 200);
  return r.json();
}

async function main() {
  await db.initDb();
  const row = (id, fields) => db.run(
    `INSERT INTO card_cache (id, name, game, language, price_trend, price_avg1, price_avg7, price_avg30, price_currency, price_source)
     VALUES (?, 'Card', 'pokemon', 'English', ?, 15, 14, 13, ?, ?)`,
    [id, fields.trend, fields.currency, fields.source]
  );
  // TCGplayer USD price (TCGCSV) with Cardmarket's EUR averages beside it.
  await row('sv3-4', { trend: 20, currency: 'USD', source: 'tcgcsv' });
  // A TCGdex row priced off Cardmarket: averages and quote are both EUR.
  await row('tcgdex-de-sv03-004', { trend: 16, currency: 'EUR', source: 'tcgdex' });
  // pokemontcgapi.com's TCGplayer averages are in dollars, like its quote.
  await row('pokemontcgapi-x-1', { trend: 21, currency: 'USD', source: 'pokemontcgapi-tcgplayer' });

  const app = express();
  app.use((req, res, next) => { req.user = { id: 1, role: 'member' }; next(); });
  app.use('/api', require('../src/routes/stats'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  const usd = await chartPoints(base, 'sv3-4');
  assert.strictEqual(usd.marketCount, 0, 'EUR averages are not drawn on a USD line');
  assert.deepStrictEqual(usd.data.map(p => p.price), [20], 'just the current price');

  const eur = await chartPoints(base, 'tcgdex-de-sv03-004');
  assert.strictEqual(eur.marketCount, 3, 'averages in the line\'s own currency are drawn');
  assert.deepStrictEqual(eur.data.map(p => p.price), [13, 14, 15, 16]);

  const tcgplayerAverages = await chartPoints(base, 'pokemontcgapi-x-1');
  assert.strictEqual(tcgplayerAverages.marketCount, 3, 'TCGplayer averages sit on a TCGplayer line');

  // --- graded values --------------------------------------------------------------
  gradedPrices.client.get = async () => ({
    data: { data: { name: 'Charizard', cardNumber: '4', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 120 }, count: 3 } } } } },
  });
  const ask = (currency) => gradedPrices.fetchGradedPrice({
    game: 'pokemon', name: 'Charizard', number: '4', grader: 'PSA', grade: 10, tcgPlayerId: 1, apiKey: 'k', currency,
  });

  const dollars = await ask();
  assert.strictEqual(dollars.price, 120);
  assert.strictEqual(dollars.currency, 'USD', 'the value says it is in dollars');

  await assert.rejects(ask('EUR'), (e) => e.status === 409 && /no exchange rate/.test(e.message),
    'with no rate it refuses rather than storing dollars as euros');

  await db.run(`INSERT INTO fx_rates (rate_date, currency, rate, fetched_at) VALUES ('2026-11-14', 'USD', 1.2, '2026-11-14T16:00:00Z')`);
  const euros = await ask('EUR');
  assert.strictEqual(euros.currency, 'EUR');
  assert.strictEqual(euros.price, 100, '$120 at 1.20 USD per EUR');
  assert.deepStrictEqual(euros.quoted, { price: 120, currency: 'USD' }, 'and it keeps what eBay quoted');
  assert.strictEqual((await ask('USD')).price, 120, 'no conversion for a dollar-priced card');

  console.log('pricecurrency.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (server && server.listening) await new Promise(r => server.close(r));
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
