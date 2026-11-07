// Double-faced Magic cards keep their back face (#103).
//
// A transform / modal DFC / reversible card has no top-level image_uris — each face
// carries its own — and normalizeCard used to keep only card_faces[0], so the back
// was thrown away and could never be shown. Split, flip and adventure cards also
// have card_faces, but they are one printed side with one top-level image, and must
// NOT get a back. Fixtures are inline; no request leaves the process.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-mtgbackface-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const scryfall = require('../src/scryfallApi');
const { cacheNormalizedCards } = require('../src/utils/cardCache');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

// Shaped like Scryfall's response for a transform card ("Avatar Aang", TLA #207).
const TRANSFORM = {
  id: '00000000-0000-4000-8000-0000000000d1', lang: 'en', layout: 'transform',
  name: 'Avatar Aang // Aang, Master of Elements', set: 'tla', set_name: 'Avatar: The Last Airbender',
  collector_number: '207', rarity: 'mythic', cmc: 4, color_identity: ['W', 'U', 'B', 'R', 'G'],
  prices: { usd: '10.00' },
  card_faces: [
    { name: 'Avatar Aang', type_line: 'Legendary Creature — Human Avatar Ally', colors: ['G', 'R', 'U', 'W'],
      image_uris: { small: 'https://cards.scryfall.io/small/front/aang.jpg', normal: 'https://cards.scryfall.io/normal/front/aang.jpg' } },
    { name: 'Aang, Master of Elements', type_line: 'Legendary Creature — Avatar Ally', colors: ['G', 'R', 'U', 'W'],
      image_uris: { small: 'https://cards.scryfall.io/small/back/aang.jpg', large: 'https://cards.scryfall.io/large/back/aang.jpg' } },
  ],
};

const NORMAL = {
  id: '00000000-0000-4000-8000-0000000000d2', lang: 'en', layout: 'normal',
  name: 'Lightning Bolt', set: 'm11', set_name: 'Magic 2011', collector_number: '149', rarity: 'common',
  image_uris: { normal: 'https://cards.scryfall.io/normal/front/bolt.jpg' }, prices: { usd: '2.00' },
};

// card_faces WITH a top-level image: one printed side, so no back.
const ADVENTURE = {
  id: '00000000-0000-4000-8000-0000000000d3', lang: 'en', layout: 'adventure',
  name: 'Bonecrusher Giant // Stomp', set: 'eld', set_name: 'Throne of Eldraine', collector_number: '115', rarity: 'rare',
  image_uris: { normal: 'https://cards.scryfall.io/normal/front/giant.jpg' }, prices: { usd: '1.00' },
  card_faces: [
    { name: 'Bonecrusher Giant', type_line: 'Creature — Giant' },
    { name: 'Stomp', type_line: 'Instant — Adventure' },
  ],
};

function normalization() {
  const dfc = scryfall.normalizeCard(TRANSFORM);
  assert.strictEqual(dfc.image_url, 'https://cards.scryfall.io/normal/front/aang.jpg', 'front face is the main image');
  assert.strictEqual(dfc.image_url_back, 'https://cards.scryfall.io/large/back/aang.jpg',
    'back face kept, falling back normal → large when the face has no normal');
  assert.strictEqual(dfc.name, 'Avatar Aang');

  assert.strictEqual(scryfall.normalizeCard(NORMAL).image_url_back, null, 'single-faced card has no back');
  const adv = scryfall.normalizeCard(ADVENTURE);
  assert.strictEqual(adv.image_url, 'https://cards.scryfall.io/normal/front/giant.jpg');
  assert.strictEqual(adv.image_url_back, null, 'adventure faces share one printed side');
}

async function caching() {
  // An install from before the column existed: initDb must add it, not assume it.
  await db.run(`CREATE TABLE card_cache (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, supertype TEXT, subtypes TEXT, types TEXT, rarity TEXT,
    set_id TEXT, set_name TEXT, number TEXT, image_url TEXT, price_trend REAL, price_normal REAL,
    price_holofoil REAL, price_reverse_holofoil REAL, price_avg1 REAL, price_avg7 REAL, price_avg30 REAL,
    cmc REAL, color_identity TEXT, game TEXT DEFAULT 'pokemon', last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.initDb();
  const cols = await db.all(`PRAGMA table_info(card_cache)`);
  assert.ok(cols.some(c => c.name === 'image_url_back'), 'migration adds image_url_back');

  await scryfall.cacheCards([TRANSFORM, NORMAL].map(c => scryfall.normalizeCard(c)));
  const dfc = await db.get(`SELECT image_url, image_url_back FROM card_cache WHERE id = ?`, [`mtg-${TRANSFORM.id}`]);
  assert.deepStrictEqual(dfc, {
    image_url: 'https://cards.scryfall.io/normal/front/aang.jpg',
    image_url_back: 'https://cards.scryfall.io/large/back/aang.jpg',
  }, 'both faces reach card_cache in their own columns');
  const bolt = await db.get(`SELECT image_url_back FROM card_cache WHERE id = ?`, [`mtg-${NORMAL.id}`]);
  assert.strictEqual(bolt.image_url_back, null);

  // Providers that never set the field (Pokémon, Lorcana) still write, with no back.
  await cacheNormalizedCards([{ id: 'base1-4', name: 'Charizard', image_url: 'https://images.example/4.png' }], 'pokemon');
  const zard = await db.get(`SELECT image_url, image_url_back FROM card_cache WHERE id = 'base1-4'`);
  assert.deepStrictEqual(zard, { image_url: 'https://images.example/4.png', image_url_back: null });
}

async function main() {
  normalization();
  await caching();
  console.log('mtgbackface.test.js: all assertions passed');
}

main()
  .then(async () => { await cleanup(); process.exit(0); })
  .catch(async (err) => { console.error(err); await cleanup(); process.exit(1); });
