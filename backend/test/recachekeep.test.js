// A re-cache must never make a card worse than it was (PROV-01).
//
// A catalog build caches TCGdex set BRIEFS (name, number and art, nothing else),
// and searches, adds and the background refresh re-cache full TCGdex cards whose
// only price is Cardmarket's. All of them went through an upsert that rewrote
// every column, so a priced card came back from a catalog build with its rarity
// reset to Common, its types emptied, its $20 TCGplayer price at 0, its product id
// gone and its currency flipped to EUR — and a search did the same to the price.
//
// The guard lives in utils/cardCache.cacheNormalizedCards, so this drives the real
// callers (cardSets.cacheSetCards, tcgdexApi's search, getCardById, hydrateCard and
// background refresh, tcgApi.cacheCards) against a stubbed HTTP layer and checks
// the stored row after each.
//
// Offline: axios's default adapter is replaced before any provider module creates
// its client, so nothing leaves the process. Run: `node test/recachekeep.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-recachekeep-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const axios = require('axios');
const requests = [];
let respond = () => { throw new Error('no route'); };
axios.defaults.adapter = async (config) => {
  const url = /^https?:/.test(config.url) ? config.url : `${String(config.baseURL || '').replace(/\/+$/, '')}${config.url}`;
  requests.push(url);
  const data = await respond(url, config);
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};
const notFound = (config) => Object.assign(new Error('Request failed with status code 404'),
  { response: { status: 404, data: {}, headers: {} }, config });

const db = require('../src/db');
const cardSets = require('../src/cardSets');
const tcgdexApi = require('../src/tcgdexApi');
const tcgApi = require('../src/tcgApi');

const ID = 'tcgdex-en-sv03-004';
const SET = { id: 'sv03', name: 'Obsidian Flames' };
const BRIEFS = [
  { id: 'sv03-004', localId: '004', name: 'Charizard ex', image: 'https://assets.tcgdex.net/en/sv/sv03/004' },
  { id: 'sv03-005', localId: '005', name: 'Charmander', image: 'https://assets.tcgdex.net/en/sv/sv03/005' },
];
// What TCGdex serves for the full card: Cardmarket only, in euros.
const FULL = {
  id: 'sv03-004', localId: '004', name: 'Charizard ex', category: 'Pokemon', stage: 'Stage2', types: ['Darkness'],
  rarity: 'Double rare', set: SET, image: 'https://assets.tcgdex.net/en/sv/sv03/004',
  pricing: { cardmarket: { avg: 15.5, trend: 16, avg1: 15, avg7: 14, avg30: 13, idProduct: 7777 } },
};

// The row as the TCGCSV sweep left it: priced in USD off TCGplayer, product id known.
async function seedPriced() {
  await db.run(`DELETE FROM card_cache`);
  await db.run(`DELETE FROM price_history`);
  await db.run(
    `INSERT INTO card_cache (id, name, printed_name, supertype, subtypes, types, rarity, set_id, set_name, number,
       image_url, price_trend, price_normal, price_holofoil, price_1st_edition, price_currency, price_source,
       tcgplayer_product_id, tcgplayer_url, cardmarket_url, game, language, last_updated)
     VALUES (?, 'Charizard ex', 'Charizard ex', 'Pokémon', '["Stage 2"]', '["Darkness"]', 'Double rare', 'sv03',
       'Obsidian Flames', '004', 'https://assets.tcgdex.net/en/sv/sv03/004/low.png', 20, NULL, 20, NULL, 'USD',
       'tcgcsv', 509999, 'https://www.tcgplayer.com/product/509999', NULL, 'pokemon', 'English', CURRENT_TIMESTAMP)`,
    [ID]
  );
  await db.run(
    `INSERT INTO price_history (card_id, price, currency, recorded_at) VALUES (?, 20, 'USD', datetime('now', '-1 day'))`,
    [ID]
  );
}

const row = (id = ID) => db.get(`SELECT * FROM card_cache WHERE id = ?`, [id]);

function assertTcgcsvKept(r, where) {
  assert.strictEqual(r.price_trend, 20, `${where}: the TCGCSV price stays`);
  assert.strictEqual(r.price_holofoil, 20, `${where}: every finish TCGCSV wrote stays`);
  assert.strictEqual(r.price_normal, null, `${where}: no Cardmarket number is mixed into the row`);
  assert.strictEqual(r.price_currency, 'USD', `${where}: the currency stays USD`);
  assert.strictEqual(r.price_source, 'tcgcsv', `${where}: the source stays TCGCSV`);
  assert.strictEqual(r.tcgplayer_product_id, 509999, `${where}: the product id stays`);
  assert.strictEqual(r.tcgplayer_url, 'https://www.tcgplayer.com/product/509999', `${where}: the TCGplayer link stays`);
}

const settle = () => new Promise(r => setTimeout(r, 50));

async function main() {
  await db.initDb();
  await db.run(`UPDATE app_settings SET pokemon_provider = 'tcgdex' WHERE id = 1`);

  // --- 1. A catalog build caches set briefs: an existing row is left alone. -----
  await seedPriced();
  respond = (url) => {
    if (url.endsWith('/v2/en/sets/sv03')) return { ...SET, cards: BRIEFS };
    throw new Error(`unexpected ${url}`);
  };
  const got = await cardSets.cacheSetCards('pokemon', 'sv03', 'en');
  assert.strictEqual(got.length, 2, 'both briefs fetched');
  const built = await row();
  assertTcgcsvKept(built, 'catalog build');
  assert.strictEqual(built.rarity, 'Double rare', 'a brief does not reset the rarity to Common');
  assert.strictEqual(built.types, '["Darkness"]', 'a brief does not empty the types');
  assert.strictEqual(built.supertype, 'Pokémon', 'a brief does not blank the supertype');
  assert.notStrictEqual(built.last_updated, '1970-01-01 00:00:00', 'a brief does not mark a full row stale');
  // A card the install never had is still cached from its brief, thin and stale.
  const fresh = await row('tcgdex-en-sv03-005');
  assert.ok(fresh, 'a new card is cached from its brief');
  assert.strictEqual(fresh.last_updated, '1970-01-01 00:00:00', 'and stamped stale so it gets hydrated');
  // Nor does a second brief overwrite the first one.
  await db.run(`UPDATE card_cache SET image_url = 'kept' WHERE id = 'tcgdex-en-sv03-005'`);
  await cardSets.cacheSetCards('pokemon', 'sv03', 'en');
  assert.strictEqual((await row('tcgdex-en-sv03-005')).image_url, 'kept', 'an incomplete write never overwrites');

  // --- 2. A TCGdex search re-caches the full card: TCGCSV's price survives. ------
  await seedPriced();
  respond = (url) => {
    if (url.includes('/v2/en/cards?') || url.endsWith('/v2/en/cards')) return [BRIEFS[0]];
    if (url.endsWith('/v2/en/cards/sv03-004')) return FULL;
    throw new Error(`unexpected ${url}`);
  };
  const { cards } = await tcgdexApi.searchCards({ name: 'Charizard', scope: 'internet', lang: 'en' });
  const searched = await row();
  assertTcgcsvKept(searched, 'search');
  assert.strictEqual(searched.price_avg30, 13, "Cardmarket's own averages still refresh");
  assert.strictEqual(searched.cardmarket_url, 'https://www.cardmarket.com/en/Pokemon/Products?idProduct=7777',
    'a link the provider does send is written');
  assert.strictEqual(cards[0].price_trend, 20, 'the search answers with the stored price, not the one it fetched');
  assert.strictEqual(cards[0].price_currency, 'USD');

  // --- 3. getCardById and hydrateCard refetch a stale row: same rule. ---------------
  await seedPriced();
  await db.run(`UPDATE card_cache SET last_updated = '2000-01-01 00:00:00' WHERE id = ?`, [ID]);
  const byId = await tcgdexApi.getCardById(ID);
  assertTcgcsvKept(await row(), 'getCardById');
  assert.strictEqual(byId.price_trend, 20, 'getCardById returns the stored row');

  await seedPriced();
  await db.run(`UPDATE card_cache SET last_updated = '2000-01-01 00:00:00' WHERE id = ?`, [ID]);
  const hydrated = await tcgdexApi.hydrateCard(ID);
  assertTcgcsvKept(await row(), 'hydrateCard');
  assert.strictEqual(hydrated.price_currency, 'USD', 'hydrateCard returns the stored row');

  // --- 4. The background refresh records the stored price, not a EUR point. ------
  await seedPriced();
  await db.run(`UPDATE card_cache SET last_updated = '2000-01-01 00:00:00' WHERE id = ?`, [ID]);
  requests.length = 0;
  await tcgdexApi.searchCards({ name: 'Charizard', scope: 'database', lang: 'en' });
  for (let i = 0; i < 40 && !requests.some(u => u.endsWith('/cards/sv03-004')); i++) await settle();
  await settle();
  assertTcgcsvKept(await row(), 'background refresh');
  const points = await db.all(`SELECT price, currency FROM price_history WHERE card_id = ?`, [ID]);
  assert.deepStrictEqual(points, [{ price: 20, currency: 'USD' }], 'no Cardmarket point in a TCGplayer series');

  // --- 5. pokemontcg.io pages go through the same guard. -----------------------------
  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, set_id, number, game, language, price_trend, price_holofoil,
       price_currency, price_source, tcgplayer_product_id) VALUES
     ('sv1-1', 'Pineco', 'sv1', '1', 'pokemon', 'English', 0.25, NULL, 'USD', 'tcgcsv', 497000)`
  );
  await tcgApi.cacheCards([{
    id: 'sv1-1', name: 'Pineco', number: '1', set: { id: 'sv1', name: 'Scarlet & Violet' },
    cardmarket: { prices: { trendPrice: 0.1 } },
  }]);
  const pineco = await row('sv1-1');
  assert.strictEqual(pineco.price_trend, 0.25, 'a pokemontcg.io page keeps the TCGCSV price');
  assert.strictEqual(pineco.price_currency, 'USD');
  assert.strictEqual(pineco.tcgplayer_product_id, 497000);

  // --- 6. Product ids and links survive any re-cache that does not carry them. ---
  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, set_id, number, game, language, price_trend, price_currency,
       price_source, tcgplayer_product_id, tcgplayer_url) VALUES
     ('tcgdex-en-sv03-006', 'Charmeleon', 'sv03', '006', 'pokemon', 'English', 0.5, 'EUR', 'tcgdex', 42,
      'https://www.tcgplayer.com/product/42')`
  );
  await tcgdexApi.cacheCards([tcgdexApi.normalizeCard({ ...FULL, id: 'sv03-006', localId: '006', name: 'Charmeleon' }, 'en')]);
  const charmeleon = await row('tcgdex-en-sv03-006');
  assert.strictEqual(charmeleon.tcgplayer_product_id, 42, 'an incoming null product id keeps the stored one');
  assert.strictEqual(charmeleon.tcgplayer_url, 'https://www.tcgplayer.com/product/42', 'and the stored link');
  assert.strictEqual(charmeleon.price_trend, 15.5, "a row TCGCSV never priced takes the provider's price");
  assert.strictEqual(charmeleon.price_currency, 'EUR');

  // --- 7. A TCGCSV-sourced write may replace a TCGCSV price (a migration copies one). --
  await seedPriced();
  await tcgdexApi.cacheCards([{ ...tcgdexApi.normalizeCard(FULL, 'en'), price_trend: 25, price_holofoil: 25,
    price_source: 'tcgcsv-en', price_currency: 'USD' }]);
  assert.strictEqual((await row()).price_trend, 25, 'TCGCSV-sourced data still updates a TCGCSV row');

  console.log('recachekeep.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
