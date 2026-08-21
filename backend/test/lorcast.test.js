// Test suite for Disney Lorcana / Lorcast API integration.
// No framework — plain node + assert. Run: `node test/lorcast.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

// Point the db module at a temporary database before loading modules.
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-lorcast-test-${process.pid}.db`);
const db = require('../src/db');
const lorcastApi = require('../src/lorcastApi');
const cardApi = require('../src/utils/cardApi');

const SAMPLE_LORCAST_CARD = {
  id: 'crd_3a299da6bf864690a188f07aeb55ffdf',
  name: 'A Whole New World',
  version: undefined,
  collector_number: '195',
  rarity: 'Super_rare',
  cost: 5,
  ink: 'Steel',
  inks: ['Steel'],
  type: ['Action', 'Song'],
  classifications: null,
  prices: { usd: 2.32, usd_foil: 10.34 },
  tcgplayer_id: 506088,
  image_uris: {
    digital: {
      normal: 'https://cards.lorcast.io/card/digital/normal/crd_3a299da6bf864690a188f07aeb55ffdf.avif?1709690747'
    }
  },
  set: {
    id: 'set_7ecb0e0c71af496a9e0110e23824e0a5',
    code: '1',
    name: 'The First Chapter'
  }
};

const SAMPLE_MICKEY = {
  id: 'crd_mickey_1',
  name: 'Mickey Mouse',
  version: 'Brave Little Tailor',
  collector_number: '115',
  rarity: 'Legendary',
  cost: 8,
  ink: 'Ruby',
  inks: ['Ruby'],
  type: ['Character'],
  classifications: ['Dreamborn', 'Hero'],
  prices: { usd: 4.50, usd_foil: 18.00 },
  tcgplayer_id: 506100,
  image_uris: {
    digital: {
      normal: 'https://cards.lorcast.io/card/digital/normal/crd_mickey_1.avif'
    }
  },
  set: {
    id: 'set_7ecb0e0c71af496a9e0110e23824e0a5',
    code: '1',
    name: 'The First Chapter'
  }
};

const SAMPLE_SETS = [
  {
    id: 'set_7ecb0e0c71af496a9e0110e23824e0a5',
    name: 'The First Chapter',
    code: '1',
    released_at: '2023-08-18'
  },
  {
    id: 'set_142d2dfb5d4b4b739a1017dc4bb0fcd2',
    name: 'Rise of the Floodborn',
    code: '2',
    released_at: '2023-11-17'
  }
];

function setupAdapter() {
  lorcastApi.client.defaults.adapter = async (config) => {
    const url = config.url || '';
    if (url.includes('/sets')) {
      return { status: 200, statusText: 'OK', headers: {}, config, data: { results: SAMPLE_SETS } };
    }
    if (url.includes('/cards/crd_mickey_1')) {
      return { status: 200, statusText: 'OK', headers: {}, config, data: SAMPLE_MICKEY };
    }
    if (url.includes('/cards/search')) {
      const q = config.params?.q || '';
      if (q.includes('Mickey')) {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { results: [SAMPLE_MICKEY] } };
      }
      if (q.includes('set:1')) {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { results: [SAMPLE_LORCAST_CARD, SAMPLE_MICKEY] } };
      }
      if (q.includes('nonexistent')) {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { results: [] } };
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data: { results: [SAMPLE_LORCAST_CARD] } };
    }
    return { status: 404, statusText: 'Not Found', headers: {}, config, data: { error: 'Not found' } };
  };
}

async function testNormalization() {
  const norm1 = lorcastApi.normalizeCard(SAMPLE_LORCAST_CARD);
  assert.strictEqual(norm1.id, 'lorcana-crd_3a299da6bf864690a188f07aeb55ffdf');
  assert.strictEqual(norm1.name, 'A Whole New World');
  assert.strictEqual(norm1.supertype, 'Action');
  assert.deepStrictEqual(norm1.subtypes, ['Song']);
  assert.deepStrictEqual(norm1.types, ['Steel']);
  assert.strictEqual(norm1.rarity, 'Super Rare');
  assert.strictEqual(norm1.set_id, 'lorcana-1');
  assert.strictEqual(norm1.number, '195');
  assert.strictEqual(norm1.cmc, 5);
  assert.strictEqual(norm1.game, 'lorcana');
  assert.strictEqual(norm1.price_trend, 2.32);
  assert.strictEqual(norm1.price_normal, 2.32);
  assert.strictEqual(norm1.price_holofoil, 10.34);
  assert.strictEqual(norm1.tcgplayer_product_id, 506088);

  const norm2 = lorcastApi.normalizeCard(SAMPLE_MICKEY);
  assert.strictEqual(norm2.id, 'lorcana-crd_mickey_1');
  assert.strictEqual(norm2.name, 'Mickey Mouse - Brave Little Tailor');
  assert.strictEqual(norm2.supertype, 'Character');
  assert.deepStrictEqual(norm2.subtypes, ['Dreamborn', 'Hero']);
  assert.deepStrictEqual(norm2.types, ['Ruby']);
  assert.strictEqual(norm2.rarity, 'Legendary');
  assert.strictEqual(norm2.set_id, 'lorcana-1');
  assert.strictEqual(norm2.number, '115');
  assert.strictEqual(norm2.cmc, 8);
  assert.strictEqual(norm2.game, 'lorcana');
}

async function testCardApiDispatch() {
  assert.strictEqual(cardApi.isLorcanaId('lorcana-crd_123'), true);
  assert.strictEqual(cardApi.isLorcanaId('mtg-123'), false);
  assert.strictEqual(cardApi.isLorcanaId('sv01-001'), false);

  assert.strictEqual(cardApi.gameOf('lorcana-crd_123'), 'lorcana');
  assert.strictEqual(cardApi.gameOf('anything', 'lorcana'), 'lorcana');
  assert.strictEqual(cardApi.gameOf('mtg-123'), 'mtg');
  assert.strictEqual(cardApi.gameOf('sv01-001'), 'pokemon');

  const card = await cardApi.getCardById('lorcana-crd_mickey_1');
  assert.ok(card);
  assert.strictEqual(card.name, 'Mickey Mouse - Brave Little Tailor');
  assert.strictEqual(card.game, 'lorcana');
}

async function testSetsAndSearch() {
  await lorcastApi.fetchAndCacheSets(true);
  const sets = await db.all(`SELECT * FROM sets WHERE game = 'lorcana' ORDER BY id ASC`);
  assert.strictEqual(sets.length, 2);
  assert.strictEqual(sets[0].id, 'lorcana-1');
  assert.strictEqual(sets[0].name, 'The First Chapter');
  assert.strictEqual(sets[1].id, 'lorcana-2');

  const search1 = await lorcastApi.searchCards({ name: 'Mickey', scope: 'internet' });
  assert.strictEqual(search1.cards.length, 1);
  assert.strictEqual(search1.cards[0].id, 'lorcana-crd_mickey_1');

  const search2 = await lorcastApi.searchCards({ set: 'lorcana-1', scope: 'internet' });
  assert.strictEqual(search2.cards.length, 2);

  // Local cache lookup
  const searchLocal = await lorcastApi.searchCards({ name: 'Mickey', scope: 'database' });
  assert.strictEqual(searchLocal.cards.length, 1);
  assert.strictEqual(searchLocal.cards[0].id, 'lorcana-crd_mickey_1');
}

async function main() {
  await db.initDb();
  setupAdapter();
  await testNormalization();
  await testCardApiDispatch();
  await testSetsAndSearch();
  console.log('lorcast.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
