// The TCGplayer/TCGCSV product-map builder, extended to games beyond Pokémon and
// to sealed product (previously skipped outright). Offline: getGroups/getProducts
// are stubbed rather than hitting tcgcsv.com, because the point is to pin what the
// build DOES with a response, not to depend on somebody else's free mirror.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-sealedcatalog-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const tcgcsv = require('../src/tcgcsvApi');
const productMap = require('../src/tcgplayerCatalog');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function waitUntilIdle() {
  return new Promise(resolve => {
    const check = () => (productMap.state() ? setTimeout(check, 10) : resolve());
    check();
  });
}

// A group + two products for whichever category is asked: one card (carries a
// collector number) and one sealed product (does not).
function fixtureFor(cardName, sealedName) {
  return {
    getGroups: async () => [{ groupId: 1, name: 'Fixture Set', abbreviation: 'FIX' }],
    getProducts: async () => [
      { productId: 101, name: cardName, imageUrl: 'https://example.com/card.png', extendedData: [{ name: 'Number', value: '4' }] },
      { productId: 102, name: sealedName, imageUrl: 'https://example.com/box.png', extendedData: [] },
    ],
  };
}

async function main() {
  await db.initDb();

  assert.deepStrictEqual(productMap.SEALED_CATEGORIES.pokemon, Object.values(tcgcsv.CATEGORY));
  assert.deepStrictEqual(productMap.SEALED_CATEGORIES.mtg, [1]);
  assert.deepStrictEqual(productMap.SEALED_CATEGORIES.lorcana, [71]);
  console.log('PASS: sealed category ids match the user/code-confirmed TCGplayer categories');

  assert.strictEqual(productMap.classifySealedType('Scarlet & Violet Elite Trainer Box'), 'Elite Trainer Box');
  assert.strictEqual(productMap.classifySealedType('Foundations Booster Box'), 'Booster Box');
  assert.strictEqual(productMap.classifySealedType('Foundations Booster Pack'), 'Booster Pack');
  assert.strictEqual(productMap.classifySealedType('The First Chapter Bundle'), 'Bundle');
  assert.strictEqual(productMap.classifySealedType('Surging Sparks Booster Bundle'), 'Bundle',
    "'Booster Bundle' is a bundle of packs, not one booster pack");
  assert.strictEqual(productMap.classifySealedType('Surging Sparks Booster'), 'Booster Pack');
  assert.strictEqual(productMap.classifySealedType('A Completely Unknown Thing'), 'Other');
  console.log('PASS: sealed_type classification recognises common product names');

  const realGetGroups = tcgcsv.getGroups;
  const realGetProducts = tcgcsv.getProducts;
  // The Pokémon build asks TCGdex for its Japanese set list; offline, it is empty.
  const tcgdexApi = require('../src/tcgdexApi');
  const realListSets = tcgdexApi.listSets;
  tcgdexApi.listSets = async () => [];
  try {
    // MTG: single category, a card and a sealed Bundle.
    ({ getGroups: tcgcsv.getGroups, getProducts: tcgcsv.getProducts } = fixtureFor('Fixture Card', 'Fixture Bundle'));
    productMap.start('mtg');
    await waitUntilIdle();

    const mtgCard = await db.get(`SELECT * FROM tcgplayer_catalog WHERE product_id = 101`);
    assert.strictEqual(mtgCard, undefined,
      'a non-Pokémon build must not store carded rows: nothing reads them, and MTG alone is ~100k');

    const mtgSealed = await db.get(`SELECT * FROM tcgplayer_catalog WHERE product_id = 102`);
    assert.strictEqual(mtgSealed.game, 'mtg');
    assert.strictEqual(mtgSealed.number, null, 'a product with no collector number is sealed product');
    assert.strictEqual(mtgSealed.sealed_type, 'Bundle');
    assert.strictEqual(mtgSealed.image_url, 'https://example.com/box.png');
    console.log('PASS: MTG build writes only the sealed row, correctly typed');

    // Pokémon keeps its carded rows: the scan catalog names matches through them.
    ({ getGroups: tcgcsv.getGroups, getProducts: tcgcsv.getProducts } = fixtureFor('Fixture Pikachu', 'Fixture Booster Bundle'));
    productMap.start('pokemon');
    await waitUntilIdle();
    const pokeCard = await db.get(`SELECT * FROM tcgplayer_catalog WHERE product_id = 101 AND game = 'pokemon'`);
    assert.ok(pokeCard, 'a Pokémon build must still store carded rows');
    assert.strictEqual(pokeCard.number, '4');
    assert.strictEqual(pokeCard.sealed_type, null, 'a carded row must not get a sealed_type');
    console.log('PASS: Pokémon build still writes carded rows alongside sealed ones');

    // Lorcana: same fixture shape, different game/category.
    ({ getGroups: tcgcsv.getGroups, getProducts: tcgcsv.getProducts } = fixtureFor('Fixture Card 2', 'Fixture Elite Trainer Box'));
    productMap.start('lorcana');
    await waitUntilIdle();

    const lorSealed = await db.get(`SELECT * FROM tcgplayer_catalog WHERE product_id = 102 AND game = 'lorcana'`);
    assert.strictEqual(lorSealed.sealed_type, 'Elite Trainer Box');
    console.log('PASS: Lorcana build also reaches sealed rows, unaffected by the MTG build before it');

    // An unsupported game must fail loudly rather than silently building nothing.
    assert.throws(() => productMap.start('yugioh'), /no TCGplayer category known/);
    console.log('PASS: starting a build for an unmapped game is rejected, not silently ignored');
  } finally {
    tcgcsv.getGroups = realGetGroups;
    tcgcsv.getProducts = realGetProducts;
    tcgdexApi.listSets = realListSets;
  }

  // An install upgraded from before `game` existed has Pokémon rows with game
  // NULL; summary() counts by game, so it reported an empty map until a rebuild.
  await db.run(
    `INSERT OR REPLACE INTO tcgplayer_catalog (product_id, category_id, group_id, group_name, name, number, game)
     VALUES (9001, 3, 7, 'Old Set', 'Old Card', '1', NULL), (9002, 85, 8, 'Old JP Set', 'Old JP Card', '2', NULL),
            (9003, 1, 9, 'Old MTG', 'Not Pokemon', NULL, NULL)`
  );
  await db.initDb();
  await db.initDb();
  const upgraded = await db.all(`SELECT product_id, game FROM tcgplayer_catalog WHERE product_id IN (9001, 9002, 9003) ORDER BY product_id`);
  assert.deepStrictEqual(upgraded.map(r => r.game), ['pokemon', 'pokemon', null],
    'legacy NULL-game rows in the Pokémon categories must be backfilled, and only those');
  console.log('PASS: upgrade migration backfills game for legacy Pokémon product-map rows, idempotently');
}

main()
  .then(() => cleanup())
  .catch(async err => {
    console.error('FAIL:', err.stack || err.message);
    await cleanup();
    process.exitCode = 1;
  });
