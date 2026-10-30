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
  assert.strictEqual(productMap.classifySealedType('A Completely Unknown Thing'), 'Other');
  console.log('PASS: sealed_type classification recognises common product names');

  const realGetGroups = tcgcsv.getGroups;
  const realGetProducts = tcgcsv.getProducts;
  try {
    // MTG: single category, a card and a sealed Bundle.
    ({ getGroups: tcgcsv.getGroups, getProducts: tcgcsv.getProducts } = fixtureFor('Fixture Card', 'Fixture Bundle'));
    productMap.start('mtg');
    await waitUntilIdle();

    const mtgCard = await db.get(`SELECT * FROM tcgplayer_catalog WHERE product_id = 101`);
    assert.strictEqual(mtgCard.game, 'mtg');
    assert.strictEqual(mtgCard.number, '4');
    assert.strictEqual(mtgCard.sealed_type, null, 'a carded row must not get a sealed_type');

    const mtgSealed = await db.get(`SELECT * FROM tcgplayer_catalog WHERE product_id = 102`);
    assert.strictEqual(mtgSealed.game, 'mtg');
    assert.strictEqual(mtgSealed.number, null, 'a product with no collector number is sealed product');
    assert.strictEqual(mtgSealed.sealed_type, 'Bundle');
    assert.strictEqual(mtgSealed.image_url, 'https://example.com/box.png');
    console.log('PASS: MTG build writes both a carded row and a sealed row, correctly typed');

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
  }
}

main()
  .then(() => cleanup())
  .catch(async err => {
    console.error('FAIL:', err.stack || err.message);
    await cleanup();
    process.exitCode = 1;
  });
