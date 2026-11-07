// What the TCGCSV cache keeps per category: Pokémon keeps cards and sealed
// product; Magic (1) and Lorcana (71) keep ONLY sealed product and its prices,
// so syncing them for the sealed inventory does not cache ~100k MTG cards.
// No network; tcgcsvApi is required at the end only for its constants, and it
// opens the db module, so DB_PATH points at a throwaway file first.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-tcgcsvslim-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const { slimResults, SEALED_ONLY_CATEGORY, SEALED_ONLY_CATEGORIES } = require('../src/utils/tcgcsvSlim');

assert.deepStrictEqual(SEALED_ONLY_CATEGORY, { mtg: 1, lorcana: 71 });
assert.deepStrictEqual([...SEALED_ONLY_CATEGORIES].sort((a, b) => a - b), [1, 71]);
console.log('PASS: Magic (1) and Lorcana (71) are the sealed-only categories');

const raw = (groupId) => [
  { productId: 1, name: 'A Card', imageUrl: 'https://img/1.jpg', groupId, url: 'x', cleanName: 'A Card',
    extendedData: [{ name: 'Number', value: '004/165' }, { name: 'Rarity', value: 'Rare' }] },
  { productId: 2, name: 'Foundations Booster Bundle', imageUrl: 'https://img/2.jpg', groupId, url: 'y',
    extendedData: [{ name: 'Description', value: 'long text' }] },
  { productId: 3, name: 'Play Booster Box', imageUrl: 'https://img/3.jpg', groupId, extendedData: [] },
];
const rawPrices = [
  { productId: 1, subTypeName: 'Normal', marketPrice: 0.5, midPrice: 0.6, lowPrice: 0.1 },
  { productId: 1, subTypeName: 'Foil', marketPrice: 2, midPrice: 3 },
  { productId: 2, subTypeName: 'Normal', marketPrice: 54.99, midPrice: 60, highPrice: 99 },
  { productId: 3, subTypeName: 'Normal', marketPrice: null, midPrice: 140 },
];

const sealedRows = (groupId) => [
  { productId: 2, name: 'Foundations Booster Bundle', number: null, imageUrl: 'https://img/2.jpg', groupId },
  { productId: 3, name: 'Play Booster Box', number: null, imageUrl: 'https://img/3.jpg', groupId },
];

for (const categoryId of [1, 71]) {
  const products = slimResults(`/tcgplayer/${categoryId}/500/products`, raw(500));
  assert.deepStrictEqual(products, sealedRows(500),
    `category ${categoryId} keeps only sealed product (name, image, group), never a card`);
  const keepProductIds = new Set(products.map(p => p.productId));
  const prices = slimResults(`/tcgplayer/${categoryId}/500/prices`, rawPrices, { keepProductIds });
  assert.deepStrictEqual(prices, [
    { productId: 2, subTypeName: 'Normal', marketPrice: 54.99, midPrice: 60 },
    { productId: 3, subTypeName: 'Normal', marketPrice: null, midPrice: 140 },
  ], `category ${categoryId} keeps the sealed products' Normal prices and drops every card price`);
  assert.deepStrictEqual(slimResults(`/tcgplayer/${categoryId}/500/prices`, rawPrices), [],
    'a sealed-only prices path with no kept products keeps nothing, never every card price');
}
console.log('PASS: Magic and Lorcana keep sealed products and their prices, and drop card rows');

for (const categoryId of [3, 85]) {
  const products = slimResults(`/tcgplayer/${categoryId}/30/products`, raw(30));
  assert.deepStrictEqual(products, [
    { productId: 1, name: 'A Card', number: '004/165' },
    ...sealedRows(30),
  ], `Pokémon category ${categoryId} keeps cards (slim) and sealed product`);
  const prices = slimResults(`/tcgplayer/${categoryId}/30/prices`, rawPrices);
  assert.deepStrictEqual(prices.map(p => p.productId), [1, 2, 3],
    'Pokémon keeps every priced product, sealed included; Foil has no column and is dropped');
}
console.log('PASS: Pokémon keeps cards and sealed product, with their prices');

// The two card readers skip sealed rows exactly as before.
const tcgcsv = require('../src/tcgcsvApi');
const sealed = slimResults('/tcgplayer/3/30/products', raw(30)).filter(p => p.number == null);
for (const p of sealed) {
  assert.strictEqual(tcgcsv.normNumber(tcgcsv.numberOf(p)), '', 'the price sweep keys products by number; sealed has none');
}
assert.deepStrictEqual(tcgcsv.SYNC_CATEGORIES, [3, 85, 1, 71]);
console.log('PASS: sealed rows carry no number for the price sweep to match, and 1/71 are synced');

const db = require('../src/db');
db.dbConnection.close(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
});
