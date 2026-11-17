// The mirror's per-category bundles, and the games served from them.
//
// An install used to sync TCGCSV one file at a time: a groups list per category,
// then products and prices for every group — ~1,367 requests a day for Pokémon
// alone, most of them for product lists that had not changed. The mirror now
// publishes one slim bundle per category and kind plus an index of their hashes
// (scripts/tcgcsv-mirror/sync.mjs), and an install reads those
// (tcgcsvApi.syncCategoryFromBundles): at most three requests a category, none
// for a bundle whose hash it already holds. Pinned here:
//
//   · a new version costs last-updated.txt, the index, and the CHANGED bundles
//   · unchanged bundles are carried into the new version, readable as before
//   · an index that lags last-updated.txt (the CDN caches each file) waits
//   · the TCGplayer-catalogue games (tcgcsvGameApi) write card_cache and `sets`
//     from the cache, rewrite only what changed, and price every finish
//
// Offline: axios's adapter is replaced, nothing leaves the process.
// No framework — plain node + assert. Run: `node test/tcgcsvbundles.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-tcgcsvbundles-${process.pid}.db`);
process.env.TCGCSV_BASE_URL = 'https://mirror.example.test';
delete process.env.BINDARR_DISABLE_TCGCSV_SYNC;
const tcgcsv = require('../src/tcgcsvApi');
const db = require('../src/db');
const slim = require('../src/utils/tcgcsvSlim');
const tcgcsvGames = require('../src/tcgcsvGameApi');
const { tcgplayerCardName } = require('../../shared/deckRules.mjs');

const V1 = '2026-11-07T20:05:50+0000';
const V2 = '2026-11-08T20:05:50+0000';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 20);

// What the mirror serves. `files` is mutated between syncs.
let lastUpdated = V1;
let indexVersion = V1;
const files = new Map();
// A CDN copy that lags the index: served instead of the real file when set.
const stale = new Map();
const bundle = (categoryId, kind, results) =>
  JSON.stringify({ success: true, errors: [], slim: slim.SLIM_VERSION, categoryId, kind, results });
function publish(categoryId, { groups, products, prices }) {
  for (const [kind, results] of [['groups', groups], ['products', products], ['prices', prices]]) {
    files.set(slim.bundlePath(categoryId, kind), bundle(categoryId, kind, results));
  }
}
const index = () => JSON.stringify({
  version: indexVersion, slim: slim.SLIM_VERSION,
  files: Object.fromEntries([...files].filter(([p]) => p.startsWith('/bindarr/v')).map(([p, body]) => [p, hash(body)])),
});

const requests = [];
tcgcsv.client.defaults.adapter = async (config) => {
  requests.push(config.url);
  let data;
  if (config.url === '/last-updated.txt') data = lastUpdated;
  else if (config.url === slim.INDEX_PATH) data = index();
  else if (stale.has(config.url)) data = stale.get(config.url);
  else if (files.has(config.url)) data = files.get(config.url);
  else data = { success: true, errors: [], results: [] };   // per-group walk of an unbundled category
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};

const POKEMON_GROUPS = [{ groupId: 101, name: 'Base Set', abbreviation: 'BS' }];
const POKEMON_PRODUCTS = { 101: [{ productId: 1010, name: 'Charizard', number: '4/102' }] };
const YGO_GROUPS = [
  { groupId: 501, name: 'Legend of Blue Eyes White Dragon', abbreviation: 'LOB', publishedOn: '2002-03-08T00:00:00' },
  { groupId: 777, name: 'LOB promo reprint', abbreviation: 'LOB', publishedOn: '2010-01-01T00:00:00' },
];
const YGO_PRODUCTS = {
  501: [{
    productId: 5011, name: 'Dark Magician', number: 'LOB-005', groupId: 501, rarity: 'Ultra Rare',
    ext: { 'Card Type': 'Normal Monster', Attribute: 'DARK', 'Monster Type': 'Spellcaster' },
  }],
  777: [{ productId: 7771, name: 'Dark Magician (Alternate Art)', number: 'LOB-005', groupId: 777, rarity: 'Secret Rare', imageUrl: null }],
};
const ygoPrices = (unlimited) => ({
  501: [
    { productId: 5011, subTypeName: 'Unlimited', marketPrice: unlimited, midPrice: null },
    { productId: 5011, subTypeName: '1st Edition', marketPrice: 120, midPrice: null },
  ],
  777: [],
});

const rowsFor = async (version, like) => db.all(
  `SELECT path FROM tcgcsv_cache WHERE data_version = ? AND path LIKE ? ORDER BY path`, [version, like]);

(async () => {
  await db.initDb();

  // --- the catalogue games' slim shapes and names -------------------------------
  assert.strictEqual(slim.CATALOGUE_CATEGORY.get(2), 'yugioh', 'the registry drives which categories are catalogues');
  assert.strictEqual(tcgplayerCardName('Dark Magician (Alternate Art)'), tcgplayerCardName('Dark Magician'),
    'a TCGplayer printing suffix is the same card for the copy limit');
  assert.notStrictEqual(tcgplayerCardName('Snatch (Red)'), tcgplayerCardName('Snatch (Blue)'),
    "a Flesh and Blood pitch colour is a different card");
  assert.deepStrictEqual([...tcgcsvGames.setCodes(YGO_GROUPS)], [[501, 'lob'], [777, 'g777']],
    'the older group keeps a shared abbreviation');
  assert.strictEqual(tcgcsvGames.displayNumber('004/165'), '4');
  assert.strictEqual(tcgcsvGames.displayNumber('LOB-005'), 'LOB-005');
  assert.strictEqual(tcgcsvGames.finishOf('1st Edition'), 'first');
  assert.strictEqual(tcgcsvGames.finishOf('Rainbow Foil'), 'foil');
  assert.strictEqual(tcgcsvGames.finishOf('Unlimited'), 'normal');

  // --- first version: every bundle fetched once -------------------------------
  publish(3, { groups: POKEMON_GROUPS, products: POKEMON_PRODUCTS, prices: { 101: [{ productId: 1010, subTypeName: 'Holofoil', marketPrice: 300, midPrice: null }] } });
  publish(2, { groups: YGO_GROUPS, products: YGO_PRODUCTS, prices: ygoPrices(30) });
  // Using the game activates it, which is what brings category 2 into the sync.
  await db.run(`INSERT INTO tcgcsv_catalogues (game) VALUES ('yugioh')`);
  assert.ok((await tcgcsv.syncCategories()).includes(2), 'an activated catalogue game is synced');

  let r = await tcgcsv.syncIfUpdated({ explicit: true });
  assert.strictEqual(r.updated, true, JSON.stringify(r));
  assert.deepStrictEqual(r.bundled.sort(), [2, 3], 'bundled categories');
  const bundleRequests = requests.filter(u => u.startsWith('/bindarr/v'));
  assert.strictEqual(bundleRequests.length, 6, 'three bundles per bundled category');
  assert.ok(!requests.some(u => /^\/tcgplayer\/(2|3)\/\d+\//.test(u)), 'no per-group request for a bundled category');
  assert.deepStrictEqual(await tcgcsv.getProducts(3, 101), POKEMON_PRODUCTS[101], 'readers see the same per-group rows');
  assert.deepStrictEqual((await rowsFor(V1, '/tcgplayer/2/%/products')).map(x => x.path),
    ['/tcgplayer/2/501/products', '/tcgplayer/2/777/products']);

  // --- the catalogue: cards, sets, prices ------------------------------------------
  let cat = await tcgcsvGames.refreshCatalogue('yugioh');
  assert.strictEqual(cat.cards, 2);
  const dm = await db.get(`SELECT * FROM card_cache WHERE id = 'yugioh-5011'`);
  assert.strictEqual(dm.game, 'yugioh');
  assert.strictEqual(dm.set_id, 'yugioh-lob');
  assert.strictEqual(dm.rarity, 'Ultra Rare');
  assert.strictEqual(dm.supertype, 'Normal Monster');
  assert.deepStrictEqual(JSON.parse(dm.types), ['DARK']);
  assert.strictEqual(dm.tcgplayer_product_id, 5011);
  assert.strictEqual(dm.image_url, 'https://tcgplayer-cdn.tcgplayer.com/product/5011_200w.jpg', 'the standard image, rebuilt from the id');
  assert.strictEqual(dm.price_normal, 30, 'Unlimited is the plain printing');
  assert.strictEqual(dm.price_1st_edition, 120, '1st Edition has its own column');
  assert.strictEqual(dm.price_trend, 30);
  const promo = await db.get(`SELECT set_id, image_url FROM card_cache WHERE id = 'yugioh-7771'`);
  assert.strictEqual(promo.set_id, 'yugioh-g777');
  assert.strictEqual(promo.image_url, '', 'a product with no image has none, not a guessed url');
  const set = await db.get(`SELECT * FROM sets WHERE id = 'yugioh-lob'`);
  assert.strictEqual(set.game, 'yugioh');
  assert.strictEqual(set.release_date, '2002-03-08');
  assert.strictEqual(set.ptcgo_code, 'LOB');
  assert.strictEqual((await db.get(`SELECT ptcgo_code FROM sets WHERE id = 'yugioh-g777'`)).ptcgo_code, 'G777',
    'a group whose abbreviation an older one holds is picked by its own code, not the shared one');
  const found = await tcgcsvGames.searchCards('yugioh', { name: 'Dark Magician' });
  assert.strictEqual(found.total, 2, 'searchable at once');
  assert.strictEqual((await tcgcsvGames.forGame('yugioh').getCardById('yugioh-5011')).name, 'Dark Magician');
  assert.deepStrictEqual(await tcgcsvGames.listSetCodes('yugioh'), ['lob', 'g777']);
  assert.strictEqual((await tcgcsvGames.refreshCatalogue('yugioh')).unchanged, true, 'the same version writes nothing');
  assert.strictEqual(tcgcsvGames.embedImageUrl(dm.image_url), 'https://tcgplayer-cdn.tcgplayer.com/product/5011_in_600x600.jpg');

  // --- next version: only prices moved ---------------------------------------------
  lastUpdated = V2;
  publish(2, { groups: YGO_GROUPS, products: YGO_PRODUCTS, prices: ygoPrices(32.5) });
  publish(3, { groups: POKEMON_GROUPS, products: POKEMON_PRODUCTS, prices: { 101: [{ productId: 1010, subTypeName: 'Holofoil', marketPrice: 310, midPrice: null }] } });
  // The index still says V1: the CDN has not caught up with last-updated.txt.
  indexVersion = V1;
  await db.run(`UPDATE app_settings SET tcgcsv_last_checked_at = NULL WHERE id = 1`);
  requests.length = 0;
  r = await tcgcsv.syncIfUpdated({ explicit: true });
  assert.strictEqual(r.updated, false, 'an index behind last-updated.txt waits');
  assert.ok(!requests.some(u => u.startsWith('/bindarr/v')), 'and fetches no bundle meanwhile');

  // The index has caught up but one bundle's CDN copy has not: refused, retried.
  indexVersion = V2;
  stale.set(slim.bundlePath(2, 'prices'), bundle(2, 'prices', ygoPrices(30)));
  await assert.rejects(tcgcsv.syncIfUpdated({ explicit: true }), /does not match the mirror's index/,
    'a bundle that disagrees with the index is never stored');
  stale.clear();

  requests.length = 0;
  r = await tcgcsv.syncIfUpdated({ explicit: true });
  assert.strictEqual(r.updated, true, JSON.stringify(r));
  // Groups and products did not change, so their bundles are byte-identical and
  // carried forward; only prices come down. (Pokémon's may already be stored by
  // the attempt the stale copy interrupted, so one or both prices bundles.)
  const fetched = requests.filter(u => u.startsWith('/bindarr/v')).sort();
  assert.ok(fetched.length >= 1 && fetched.every(u => u.endsWith('/prices')),
    `only prices bundles are fetched: ${fetched.join(', ')}`);
  assert.ok(fetched.includes(slim.bundlePath(2, 'prices')), "the bundle the stale copy blocked is fetched now");
  assert.deepStrictEqual(await tcgcsv.getProducts(3, 101), POKEMON_PRODUCTS[101], 'copied forward and readable');
  assert.deepStrictEqual(await tcgcsv.getProducts(2, 777), YGO_PRODUCTS[777]);
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM tcgcsv_cache WHERE data_version = ?`, [V1])).n, 0,
    'the previous version is gone once the new one completes');

  // A version where nothing moved at all costs no bundle request.
  lastUpdated = '2026-11-09T20:05:50+0000';
  indexVersion = lastUpdated;
  await db.run(`UPDATE app_settings SET tcgcsv_last_checked_at = NULL WHERE id = 1`);
  requests.length = 0;
  r = await tcgcsv.syncIfUpdated({ explicit: true });
  assert.strictEqual(r.updated, true);
  assert.strictEqual(requests.filter(u => u.startsWith('/bindarr/v')).length, 0, 'every bundle unchanged: none fetched');
  assert.deepStrictEqual(await tcgcsv.getPrices(2, 501), ygoPrices(32.5)[501], 'and every row still readable');

  // The catalogue follows: prices rewritten, products untouched.
  cat = await tcgcsvGames.refreshCatalogue('yugioh');
  assert.strictEqual(cat.cards, 0, 'no product changed, so no card row is rewritten');
  assert.strictEqual((await db.get(`SELECT price_normal FROM card_cache WHERE id = 'yugioh-5011'`)).price_normal, 32.5);

  // --- a game's first use on a server: the search that asks waits for it ---------
  // (A phone answers from the cache instead and writes in the background; see
  // devicejobs.test.js.) Its category is not in the cached version yet, so the
  // first search syncs it in, writes the catalogue, and answers with the cards.
  publish(68, {
    groups: [{ groupId: 680, name: 'Romance Dawn', abbreviation: 'OP01', publishedOn: '2022-12-02T00:00:00' }],
    products: { 680: [{ productId: 6801, name: 'Monkey.D.Luffy', number: 'OP01-024', groupId: 680 }] },
    prices: { 680: [{ productId: 6801, subTypeName: 'Normal', marketPrice: 1.5, midPrice: null }] },
  });
  assert.strictEqual(await db.get(`SELECT game FROM tcgcsv_catalogues WHERE game = 'onepiece'`), undefined, 'not activated yet');
  const luffy = await tcgcsvGames.searchCards('onepiece', { name: 'Luffy' });
  assert.strictEqual(luffy.total, 1, 'answered with the cards it waited for');
  assert.strictEqual(luffy.cards[0].id, 'onepiece-6801');
  assert.strictEqual(luffy.pending, undefined, 'never pending on a server');

  console.log('tcgcsvbundles.test.js: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
