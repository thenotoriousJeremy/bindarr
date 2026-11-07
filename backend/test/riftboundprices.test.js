// Runnable checks for Riftbound prices (riftboundPrices.js): TCGplayer category 89
// through TCGCSV's daily sync and cache.
//
// Offline. TCGCSV is served by an axios adapter from
// test/fixtures/riftbound/tcgcsv-89.json, and the cards are the real RiftCodex
// fixtures normalized the way the provider caches them.
//
// The ways this goes wrong are all quiet, so they are what is pinned:
//   * a match on anything but the product id — an OPP promo and its Metal share a
//     number and differ ~100x, so a number match is a collection that reads high;
//   * 'Foil' unmapped — most Riftbound singles are listed Foil only;
//   * a missing quote written as 0 or null over a real price;
//   * a catalogue re-cache erasing what the sweep wrote;
//   * category 89 fetched for an install with no Riftbound cards, or NOT fetched
//     for the day after one gets its first (the cached version predates it);
//   * a 403 from TCGCSV stopping prices that are already cached.
//
// No framework — plain node + assert. Run: `node test/riftboundprices.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-riftboundprices-${process.pid}.db`);
process.env.TCGCSV_BASE_URL = 'https://tcgcsv.example.test';
process.env.RIFTCODEX_GAP_MS = '0';

const FIX = require('./fixtures/riftbound/tcgcsv-89.json');
const db = require('../src/db');
const tcgcsv = require('../src/tcgcsvApi');
const rc = require('../src/riftcodexApi');
const prices = require('../src/riftboundPrices');
const { shouldSweepPrices } = require('../src/utils/priceHelpers');

const CARDS = rc.normalizeCatalogue(require('./fixtures/riftbound/cards.json'));
const VERSION = '2026-11-06T20:05:50+0000';

const requests = [];
let forbidden = false;
tcgcsv.client.defaults.adapter = async (config) => {
  requests.push(config.url);
  if (forbidden) {
    const err = new Error('Request failed with status code 403');
    err.config = config;
    err.response = { status: 403, statusText: 'Forbidden', headers: {}, data: 'blocked' };
    throw err;
  }
  const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
  if (config.url === '/last-updated.txt') return ok(VERSION);
  let m = config.url.match(/^\/tcgplayer\/(\d+)\/groups$/);
  if (m) return ok({ success: true, results: m[1] === '89' ? FIX.groups : [] });
  m = config.url.match(/^\/tcgplayer\/89\/(\d+)\/(products|prices)$/);
  if (m) return ok({ success: true, results: m[2] === 'prices' ? (FIX.prices[m[1]] || []) : [] });
  throw new Error(`unexpected TCGCSV request ${config.url}`);
};

const price = (id) => db.get(
  `SELECT price_trend, price_normal, price_holofoil, price_source, price_currency FROM card_cache WHERE id = ?`, [id]);

(async () => {
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  try {
    await db.initDb();

    // --- 1. No Riftbound cards: category 89 is not asked for -----------------
    assert.deepStrictEqual(await tcgcsv.syncCategories(), [3, 85]);
    await tcgcsv.syncIfUpdated();
    assert.ok(!requests.some(u => u.startsWith('/tcgplayer/89')), `nothing reads 89 yet (saw ${requests})`);
    assert.deepStrictEqual(await prices.updateCollectionPrices(true), { priced: 0, skipped: 'no Riftbound cards' });

    // --- 2. The first Riftbound cards: 89 is filled into the cached version ----
    await rc.cacheCards(CARDS);
    const owned = CARDS.find(c => c.number === '229').id;   // Vi, Overnumbered
    const user = await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('u', 'x', 't')`);
    await db.run(`INSERT INTO collection (card_id, user_id, game) VALUES (?, ?, 'riftbound')`, [owned, user.lastID]);
    assert.deepStrictEqual(await tcgcsv.syncCategories(), [3, 85, 89]);
    requests.length = 0;
    await tcgcsv.syncIfUpdated();
    assert.ok(!requests.includes('/last-updated.txt'), 'the version is current, so it is not re-checked');
    assert.deepStrictEqual(requests.filter(u => u.startsWith('/tcgplayer/89')).length, 1 + FIX.groups.length * 2,
      `category 89 is backfilled into the current version (saw ${requests})`);
    requests.length = 0;
    await tcgcsv.syncIfUpdated();
    assert.deepStrictEqual(requests, [], 'once backfilled, nothing more is asked');

    // --- 3. Prices land by product id, in the right finish columns ------------
    const result = await prices.updateCollectionPrices(true);
    assert.ok(result.priced >= 6, `priced ${JSON.stringify(result)}`);
    const sig = CARDS.find(c => c.number === '229*').id;
    assert.deepStrictEqual(await price(sig),
      { price_trend: 641, price_normal: null, price_holofoil: 641, price_source: 'tcgcsv', price_currency: 'USD' },
      'a Foil-only listing is the foil price and the trend');
    assert.deepStrictEqual(await price(owned),
      { price_trend: 90.88, price_normal: null, price_holofoil: 90.88, price_source: 'tcgcsv', price_currency: 'USD' },
      'its twin on the same number keeps its own, far lower, price');
    const peacekeeper = CARDS.find(c => c.number === '176').id;
    assert.deepStrictEqual(await price(peacekeeper),
      { price_trend: 0.18, price_normal: 0.18, price_holofoil: 0.96, price_source: 'tcgcsv', price_currency: 'USD' },
      'Normal and Foil both kept; the trend prefers the ordinary printing');
    const alt = CARDS.find(c => c.number === '176a').id;
    assert.strictEqual((await price(alt)).price_holofoil, 24.5, 'no market price falls back to the listing midpoint');
    const yasuo = await price('riftbound-opp-259-298');
    const metal = await price('riftbound-opp-259-298~69bc5bf1d308c64675ca89f7');
    assert.strictEqual(yasuo.price_trend, 12.89, 'the plain promo');
    assert.strictEqual(metal.price_trend, 1286.93, 'the Metal on the same number, priced off its own product');
    // Listed on TCGplayer, but not quoted today: left exactly as it was.
    const neophyte = CARDS.find(c => c.tcgplayer_product_id === 685537).id;
    assert.deepStrictEqual(await price(neophyte),
      { price_trend: null, price_normal: null, price_holofoil: null, price_source: null, price_currency: 'USD' },
      'no quote is no price — never 0');
    // History: the owned card gets a point, a browsed one does not.
    assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM price_history WHERE card_id = ?`, [owned])).n, 1);
    assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM price_history WHERE card_id = ?`, [sig])).n, 0);
    assert.strictEqual(await shouldSweepPrices('riftbound'), false, 'the sweep marks its own clock');
    const cols = (await db.all(`PRAGMA table_info(app_settings)`)).map(c => c.name);
    assert.ok(cols.includes('riftbound_prices_swept_at'), 'the clock has a column');

    // A quote already stored survives a day with no quote.
    await db.run(`UPDATE card_cache SET price_trend = 3.5, price_normal = 3.5 WHERE id = ?`, [neophyte]);
    await prices.updateCollectionPrices(true);
    assert.strictEqual((await price(neophyte)).price_trend, 3.5, 'a missing quote does not erase a stored price');

    // --- 4. The catalogue re-cache keeps what the sweep wrote --------------------
    await rc.cacheCards(rc.normalizeCatalogue(require('./fixtures/riftbound/cards.json')));
    assert.strictEqual((await price(sig)).price_holofoil, 641, 'a RiftCodex re-cache carries no prices and erases none');

    // --- 5. A 403 from TCGCSV: the cooldown starts, cached prices still apply -------
    await db.run(`UPDATE app_settings SET tcgcsv_last_checked_at = datetime('now', '-25 hours') WHERE id = 1`);
    await db.run(`UPDATE card_cache SET price_trend = NULL, price_holofoil = NULL WHERE id = ?`, [sig]);
    forbidden = true;
    requests.length = 0;
    await prices.updateCollectionPrices(true);
    assert.deepStrictEqual(requests, ['/last-updated.txt'], 'one 403, then nothing');
    assert.ok((await db.get(`SELECT tcgcsv_403_cooldown_until AS c FROM app_settings WHERE id = 1`)).c, 'the 403 cooldown is set');
    assert.strictEqual((await price(sig)).price_holofoil, 641, 'prices come from the cache while TCGCSV refuses');
    requests.length = 0;
    await prices.updateCollectionPrices(true);
    assert.deepStrictEqual(requests, [], 'inside the cooldown TCGCSV is not asked at all');

    // --- 6. Nothing cached at all: skip, and do not mark the sweep done -------------
    await db.run(`UPDATE app_settings SET tcgcsv_data_version = NULL, riftbound_prices_swept_at = NULL WHERE id = 1`);
    await db.run(`UPDATE card_cache SET price_trend = NULL, price_holofoil = NULL WHERE id = ?`, [sig]);
    assert.deepStrictEqual(await prices.updateCollectionPrices(true), { priced: 0, skipped: 'not cached' });
    assert.strictEqual((await price(sig)).price_trend, null);
    assert.strictEqual(await shouldSweepPrices('riftbound'), true, 'an unpriced sweep is retried, not recorded as done');
  } finally {
    console.log = quiet.log;
    console.warn = quiet.warn;
  }

  // --- 7. The finish map in isolation -------------------------------------------------
  const q = prices.quotesByProduct([
    { productId: 1, subTypeName: 'Foil', marketPrice: 2, midPrice: 3 },
    { productId: 1, subTypeName: 'Normal', marketPrice: 0, midPrice: 1 },
    { productId: 2, subTypeName: 'Holofoil', marketPrice: 9 },
    { productId: 3, subTypeName: 'Normal', marketPrice: null, midPrice: null },
  ]);
  assert.deepStrictEqual(q.get(1), { price_normal: 1, price_holofoil: 2 });
  assert.strictEqual(q.has(2), false, "Pokémon's finish names mean nothing here");
  assert.strictEqual(q.has(3), false, 'a row with no price is no quote');

  console.log('riftboundprices self-check passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
