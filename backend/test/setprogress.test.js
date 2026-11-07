// The Dashboard's set completion must measure every game's sets, Magic included.
//
// card_cache stores a Magic set as Scryfall's bare code ("mh3") and the `sets`
// table as "mtg-mh3", so the size lookup never matched and no Magic set ever
// appeared in the panel, however many of its cards were owned. Pokémon and
// Lorcana spell the id the same way in both tables and must keep working. The
// Magic sets arrive the way a real install gets them, through
// scryfallApi.fetchAndCacheSets, with Scryfall's /sets answered by an axios
// adapter. Run: `node test/setprogress.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-setprogress-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
process.env.SCRYFALL_GAP_SCALE = '0';

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const statsRouter = require('../src/routes/stats');

// Modern Horizons 3 prints "/303" on its cards and has 560 entries counting its
// showcase and borderless variants; Alpha prints no total at all.
scryfallApi.client.defaults.adapter = async (config) => {
  if (config.url !== '/sets') throw new Error(`Unexpected Scryfall request: ${config.url}`);
  return {
    data: { object: 'list', data: [
      { code: 'mh3', name: 'Modern Horizons 3', set_type: 'draft_innovation', card_count: 560, printed_size: 303, released_at: '2024-06-14' },
      { code: 'lea', name: 'Limited Edition Alpha', set_type: 'core', card_count: 295, released_at: '1993-08-05' },
    ] },
    status: 200, statusText: 'OK', headers: {}, config,
  };
};

const handler = statsRouter.stack.find(layer => layer.route?.path === '/stats').route.stack.at(-1).handle;
async function stats(query = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ query, user: { id: 1 } }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.setProgress;
}

async function main() {
  await db.initDb();
  await scryfallApi.fetchAndCacheSets(true);
  const mh3 = await db.get(`SELECT printed_total, total FROM sets WHERE id = 'mtg-mh3'`);
  assert.deepStrictEqual({ ...mh3 }, { printed_total: 303, total: 560 }, 'completion counts to the printed size');

  await db.run(`INSERT INTO sets (id, name, printed_total, total, game) VALUES ('sv1', 'Scarlet & Violet', 198, 258, 'pokemon')`);
  await db.run(`INSERT INTO sets (id, name, printed_total, total, game) VALUES ('lorcana-1', 'The First Chapter', 204, 204, 'lorcana')`);

  const cards = [
    ['sv1-1', 'Sprigatito', 'sv1', 'Scarlet & Violet', '1', 'pokemon', 'English'],
    ['sv1-2', 'Floragato', 'sv1', 'Scarlet & Violet', '2', 'pokemon', 'English'],
    ['mtg-breaker-en', 'Breaker of Creation', 'mh3', 'Modern Horizons 3', '1', 'mtg', 'English'],
    ['mtg-breaker-ja', 'Breaker of Creation', 'mh3', 'Modern Horizons 3', '1', 'mtg', 'Japanese'],
    ['mtg-emrakul', 'Emrakul, the World Anew', 'mh3', 'Modern Horizons 3', '6', 'mtg', 'English'],
    ['mtg-bolt', 'Lightning Bolt', 'lea', 'Limited Edition Alpha', '161', 'mtg', 'English'],
    ['lorcana-ariel', 'Ariel - On Human Legs', 'lorcana-1', 'The First Chapter', '1', 'lorcana', 'English'],
  ];
  for (const [id, name, setId, setName, number, game, language] of cards) {
    await db.run(`INSERT INTO card_cache (id, name, set_id, set_name, number, game, language) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, setId, setName, number, game, language]);
  }
  // One row per copy, as the app stores them: two English Breakers, one Japanese.
  for (const id of ['sv1-1', 'sv1-2', 'mtg-breaker-en', 'mtg-breaker-en', 'mtg-breaker-ja', 'mtg-emrakul', 'mtg-bolt', 'lorcana-ariel']) {
    await db.run(`INSERT INTO collection (card_id, user_id, quantity, condition, printing, language, list_type, game)
      VALUES (?, 1, 1, 'Near Mint', 'Normal', 'English', 'collection', ?)`, [id, cards.find(c => c[0] === id)[5]]);
  }

  const bySet = (rows) => Object.fromEntries(rows.map(r => [r.setId, [r.setName, r.ownedUnique, r.totalCards]]));
  assert.deepStrictEqual(bySet(await stats()), {
    sv1: ['Scarlet & Violet', 2, 198],
    // The Japanese Breaker is the same card of the set as the English one.
    mh3: ['Modern Horizons 3', 2, 303],
    lea: ['Limited Edition Alpha', 1, 295],
    'lorcana-1': ['The First Chapter', 1, 204],
  });

  // The per-game view keeps to its game.
  assert.deepStrictEqual(Object.keys(bySet(await stats({ game: 'mtg' }))).sort(), ['lea', 'mh3']);
  assert.deepStrictEqual(Object.keys(bySet(await stats({ game: 'lorcana' }))), ['lorcana-1']);
}

main()
  .then(() => console.log('Set progress self-check passed'))
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  });
