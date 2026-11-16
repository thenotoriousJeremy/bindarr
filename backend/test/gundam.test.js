// The Gundam Card Game (#60) is a TCGplayer-catalogue game like Yu-Gi-Oh!: one
// registry entry (shared/games.json) on TCGplayer category 86, served by
// tcgcsvGameApi. Pinned here: the entry, the category the sync reads once the
// game is activated, the id dispatch, PSA's brand, and a Gundam-shaped product
// (TCGplayer's own extendedData names) through the shared normalizer.
//
// Offline and pure: no request, no sync. Run: `node test/gundam.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-gundam-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';

const games = require('../src/utils/games');
const tcgcsv = require('../src/tcgcsvApi');
const tcgcsvGames = require('../src/tcgcsvGameApi');
const cardApi = require('../src/utils/cardApi');
const db = require('../src/db');

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not there */ }
  }
}

async function main() {
  // --- the registry entry -----------------------------------------------------
  const g = games.get('gundam');
  assert.ok(g, 'gundam is a registered game');
  assert.strictEqual(g.provider, 'tcgcsv');
  assert.deepStrictEqual(g.tcgplayerCategories, [86]);
  assert.strictEqual(g.defaultEnabled, false, 'off until someone turns it on, like the other catalogue games');
  assert.ok(games.hasFeature('gundam', 'scan') && games.hasFeature('gundam', 'decks') && games.hasFeature('gundam', 'prices'));
  assert.strictEqual(g.scan.publishedIds, null, 'no published snapshot: scans need Bindarr\'s or a local catalog');

  // --- the category and the ids -----------------------------------------------
  assert.strictEqual(tcgcsvGames.categoryOf('gundam'), 86);
  assert.ok(tcgcsvGames.isTcgcsvGame('gundam'));
  assert.ok(tcgcsv.OPTIONAL_SYNC_CATEGORIES.some(o => o.categoryId === 86 && o.game === 'gundam' && o.catalogue),
    'category 86 is synced once the game is activated');
  assert.strictEqual(tcgcsvGames.cardIdFor('gundam', 643150), 'gundam-643150');
  assert.strictEqual(games.gameOfId('gundam-643150'), 'gundam');
  assert.strictEqual(cardApi.gameOf('gundam-643150'), 'gundam');
  assert.strictEqual(await cardApi.apiForGame('gundam', 'English'), tcgcsvGames.forGame('gundam'),
    'searches go to the TCGplayer catalogue, bound to Gundam');
  assert.strictEqual(games.gameOfPsaBrand('BANDAI GUNDAM CARD GAME'), 'gundam');

  // --- a product as TCGplayer lists it ----------------------------------------
  const card = tcgcsvGames.normalizeProduct('gundam', {
    productId: 643150,
    name: 'Gundam',
    number: 'GD01-001',
    rarity: 'Legend Rare',
    ext: { Number: 'GD01-001', Rarity: 'LR', 'Card Type': 'Unit', Color: 'Blue', Trait: 'Earth Federation; White Base Team', Level: '5', Cost: '3', AP: '4', HP: '4' },
  }, 'gundam-gd01', 'Newtype Rising');
  assert.strictEqual(card.id, 'gundam-643150');
  assert.strictEqual(card.number, 'GD01-001', 'the card number is kept whole');
  assert.strictEqual(card.supertype, 'Unit', 'the card type, which the deck builder groups by');
  assert.deepStrictEqual(card.types, ['Blue']);
  assert.deepStrictEqual(card.subtypes, ['Earth Federation', 'White Base Team']);
  assert.strictEqual(card.set_id, 'gundam-gd01');
  assert.strictEqual(card.tcgplayer_url, 'https://www.tcgplayer.com/product/643150');
  assert.strictEqual(card.price_source, 'tcgcsv');

  console.log('gundam.test.js: all assertions passed');
}

// The connection is closed before the files are removed: Windows will not unlink
// a database SQLite still holds open.
const closeDb = () => new Promise(ok => db.dbConnection.close(() => ok()));

main()
  .then(async () => { await closeDb(); cleanup(); process.exit(0); })
  .catch(async (err) => { console.error(err); await closeDb(); cleanup(); process.exit(1); });
