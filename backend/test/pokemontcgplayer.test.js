// The Pokémon cards TCGdex does not have, served from TCGplayer's catalogue
// (pokemonTcgplayer.js): which groups the weekly build finds TCGdex lacking, and
// what an install writes from them — cards, sets, prices, borrowed art — and that
// it rewrites only what changed.
//
// Offline: the TCGCSV cache, TCGdex's set list and the release download are
// stubbed on the modules the code reads them through.
//
// No framework — plain node + assert. Run: `node test/pokemontcgplayer.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-pokemontcgplayer-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';

const db = require('../src/db');
const tcgcsv = require('../src/tcgcsvApi');
const tcgdexApi = require('../src/tcgdexApi');
const releaseAssets = require('../src/utils/releaseAssets');
const { cacheNormalizedCards } = require('../src/utils/cardCache');

// The TCGCSV cache as the slim format keeps it: imageUrl absent is the standard
// CDN picture, null is none.
const GROUPS = {
  3: [
    { groupId: 100, name: 'Scarlet & Violet', abbreviation: 'SVI' },
    { groupId: 200, name: 'World Championship Decks', abbreviation: 'WCD' },
    { groupId: 300, name: 'Trainer Kit', abbreviation: '' },
    { groupId: 400, name: 'Sealed Only', abbreviation: 'SO' },
  ],
};
const PRODUCTS = {
  100: [
    { productId: 1, name: 'Sprigatito', number: '001/198' },
    { productId: 2, name: 'Floragato', number: '002/198' },
    { productId: 3, name: 'Booster Box', number: null, imageUrl: null, groupId: 100 },
  ],
  200: [
    { productId: 21, name: 'Pikachu', number: '1', rarity: 'Promo' },
    { productId: 22, name: 'Raichu', number: '2', imageUrl: null },
  ],
  300: [{ productId: 31, name: 'Energy', number: '5' }],
  400: [{ productId: 41, name: 'Tin', number: null, imageUrl: null, groupId: 400 }],
};
let PRICES = {
  200: [
    { productId: 21, subTypeName: 'Holofoil', marketPrice: 3.5, midPrice: 4 },
    { productId: 21, subTypeName: '1st Edition Holofoil', marketPrice: 9, midPrice: 10 },
    { productId: 22, subTypeName: 'Normal', marketPrice: 0, midPrice: 0.25 },
  ],
};
let version = 'v1';
tcgcsv.getGroups = async (cat) => GROUPS[cat] || [];
tcgcsv.getProducts = async (cat, gid) => PRODUCTS[gid] || [];
tcgcsv.getPrices = async (cat, gid) => PRICES[gid] || [];
tcgcsv.currentVersion = async () => version;
tcgdexApi.listSets = async () => [{ id: 'sv01', name: 'Scarlet & Violet' }, { id: 'sv02', name: 'Paldea Evolved' }];
let published = null;
releaseAssets.fetchJson = async (name) => (name === 'pokemon-tcgplayer.en.json' ? published : null);

const tcgplayer = require('../src/pokemonTcgplayer');

async function main() {
  await db.initDb();
  // A TCGdex walk of sv01: one card with art, one without. sv02 is listed by TCGdex
  // but served without cards, so its TCGplayer group would count as uncovered.
  await cacheNormalizedCards([
    { id: 'tcgdex-en-sv01-001', name: 'Sprigatito', set_id: 'sv01', set_name: 'Scarlet & Violet', number: '1',
      image_url: 'https://assets.tcgdex.net/en/sv/sv01/001/low.webp', language: 'English' },
    { id: 'tcgdex-en-sv01-002', name: 'Floragato', set_id: 'sv01', set_name: 'Scarlet & Violet', number: '2',
      image_url: '', language: 'English' },
  ], 'pokemon');

  // --- the build's side ---
  const coverage = await tcgplayer.computeCoverage('English');
  assert.strictEqual(coverage.format, 1);
  assert.deepStrictEqual(coverage.fallbackGroups, [200, 300], 'groups with cards and no TCGdex set; sealed-only groups are not cards');
  assert.deepStrictEqual(coverage.artFill, { 'tcgdex-en-sv01-002': 2 }, 'the art-less TCGdex card borrows its TCGplayer picture');
  assert.strictEqual(await tcgplayer.computeCoverage('French'), null, 'no TCGplayer catalogue for French');

  // --- an install's side ---
  const first = await tcgplayer.materialize('English', coverage);
  assert.deepStrictEqual(first, { cards: 3, art: 1 });

  const pikachu = await tcgplayer.getCardById('tcgplayer-21');
  assert.strictEqual(pikachu.name, 'Pikachu');
  assert.strictEqual(pikachu.set_id, 'tcgp-en-wcd', "set ids carry the group's abbreviation");
  assert.strictEqual(pikachu.number, '1');
  assert.strictEqual(pikachu.rarity, 'Promo');
  assert.strictEqual(pikachu.language, 'English');
  assert.strictEqual(pikachu.image_url, 'https://tcgplayer-cdn.tcgplayer.com/product/21_200w.jpg');
  const row21 = await db.get(`SELECT * FROM card_cache WHERE id = 'tcgplayer-21'`);
  assert.strictEqual(row21.price_holofoil, 3.5);
  assert.strictEqual(row21.price_1st_edition, 9, '1st Edition has a column of its own');
  assert.strictEqual(row21.price_trend, 3.5);
  const row22 = await db.get(`SELECT * FROM card_cache WHERE id = 'tcgplayer-22'`);
  assert.strictEqual(row22.image_url, '', 'no TCGplayer picture: no image, not a url that answers 403');
  assert.strictEqual(row22.price_normal, 0.25, 'the mid price when there is no market price');
  const energy = await db.get(`SELECT set_id FROM card_cache WHERE id = 'tcgplayer-31'`);
  assert.strictEqual(energy.set_id, 'tcgp-en-g300', 'a group with no abbreviation is named by its id');
  assert.strictEqual(await db.get(`SELECT id FROM card_cache WHERE id = 'tcgplayer-3'`), undefined, 'sealed product is not a card');

  const set = await db.get(`SELECT * FROM sets WHERE id = 'tcgp-en-wcd'`);
  assert.strictEqual(set.name, 'World Championship Decks');
  assert.strictEqual(set.series, 'TCGplayer');
  assert.strictEqual(set.ptcgo_code, 'WCD');
  assert.strictEqual(set.game, 'pokemon');

  const art = await db.get(`SELECT image_url FROM card_cache WHERE id = 'tcgdex-en-sv01-002'`);
  assert.strictEqual(art.image_url, 'https://tcgplayer-cdn.tcgplayer.com/product/2_200w.jpg');
  const kept = await db.get(`SELECT image_url FROM card_cache WHERE id = 'tcgdex-en-sv01-001'`);
  assert.match(kept.image_url, /assets\.tcgdex\.net/, "TCGdex's own art is never replaced");

  // Nothing changed: one comparison, no writes.
  assert.deepStrictEqual(await tcgplayer.materialize('English', coverage), { unchanged: true });
  // A new TCGCSV day with the same data rewrites nothing...
  version = 'v2';
  assert.deepStrictEqual(await tcgplayer.materialize('English', coverage), { cards: 0, art: 0 });
  // ...and one where a group's prices moved rewrites that group only.
  version = 'v3';
  PRICES = { ...PRICES, 200: PRICES[200].map(p => (p.productId === 22 ? { ...p, midPrice: 0.5 } : p)) };
  assert.deepStrictEqual(await tcgplayer.materialize('English', coverage), { cards: 2, art: 0 });
  assert.strictEqual((await db.get(`SELECT price_normal FROM card_cache WHERE id = 'tcgplayer-22'`)).price_normal, 0.5);

  // The card lookups every caller goes through.
  const viaCardApi = await require('../src/utils/cardApi').getCardById('tcgplayer-31', { game: 'pokemon' });
  assert.strictEqual(viaCardApi && viaCardApi.name, 'Energy');
  assert.strictEqual(await tcgplayer.getCardById('tcgdex-en-sv01-001'), null, 'only its own ids');
  assert.deepStrictEqual(await tcgplayer.fallbackSets('English'), [], 'English sets live in the sets table');
  assert.deepStrictEqual(await tcgplayer.activeLanguages(), ['English']);

  // ensure() on an install: the published coverage, downloaded and kept.
  published = coverage;
  await tcgplayer.ensure('English');
  const stored = await db.get(`SELECT product_hashes FROM tcgcsv_catalogues WHERE game = 'pokemon-fallback-en-coverage'`);
  assert.deepStrictEqual(JSON.parse(stored.product_hashes).fallbackGroups, [200, 300], 'the last good coverage survives a restart');
  assert.strictEqual(await tcgplayer.ensure('French'), null);

  // Ids and set ids.
  assert.strictEqual(tcgplayer.isFallbackId('tcgplayer-5'), true);
  assert.strictEqual(tcgplayer.isFallbackId('tcgdex-en-sv01-001'), false);
  assert.strictEqual(tcgplayer.productIdOf('tcgplayer-123'), 123);
  assert.strictEqual(tcgplayer.productIdOf('tcgplayer-x'), null);
  assert.strictEqual(tcgplayer.setIdFor('ja', 'sv2a'), 'tcgp-ja-sv2a');
}

main().then(() => {
  console.log('pokemontcgplayer.test.js: all assertions passed');
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await new Promise(ok => db.dbConnection.close(ok)); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
});
