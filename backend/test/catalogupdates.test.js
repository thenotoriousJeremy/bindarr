// The weekly catalog update and sets a catalog already has (catalog.js grownSets).
//
// setsBehind counts a set as fetched once any card of it is cached, but a set is
// often not finished then: TCGdex publishes a set in parts over weeks, Scryfall's
// promo sets keep growing, and cards reach card_cache by other roads without
// reaching the catalog. Those sets have to come back to the update — and a set
// that will never finish (a provider claiming more cards than it serves) must stop
// coming back, or the update rebuilds it every week forever.
//
// Builds run with a stub embedder, as in catalogbuild.test.js: no model, no network.
//
// No framework — plain node + assert. Run: `node test/catalogupdates.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-catalogupdates-${process.pid}.db`);
const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-catalogupdates-models-'));
process.env.DB_PATH = tmpDb;
process.env.CV_MODEL_DIR = modelDir;

const db = require('../src/db');
const catalog = require('../src/catalog');
// Offline: the set lists list() and behindCatalogs read come from these stubs, on
// the module objects catalog.js calls them through.
const cardSets = require('../src/cardSets');
cardSets.listAllSets = async (game) => (game === 'mtg' ? ['aaa', 'bbb', 'ccc', 'zzz'] : []);
cardSets.mtgFamilyCodes = async (code) => [code];
require('../src/utils/pokemonProvider').providerFor = async () => 'pokemontcg';   // claimedFor: no TCGdex call
let outbound = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { outbound++; return realFetch(...a); };

const DIM = 4;
const embedder = () => ({
  async fetch(u) { return Buffer.from(u); },
  async embed() { return new Float32Array(DIM).fill(1); },
});
async function build(opts = {}) {
  catalog.start('mtg', 'English', { skipCache: true, embedder: embedder(), ...opts });
  for (let i = 0; i < 2000 && catalog.state(); i++) await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(catalog.state(), null, 'the build finished');
  const r = catalog.lastResult();
  assert.strictEqual(r.phase, 'done', r.message);
  return r;
}
const card = (id, set, image = `https://img.test/${id}.jpg`) => db.run(
  `INSERT INTO card_cache (id, name, set_id, number, game, language, image_url) VALUES (?, ?, ?, ?, 'mtg', 'English', ?)`,
  [id, id, set, id.replace(/\D/g, ''), image]
);
const claim = (set, total) => db.run(
  `INSERT INTO sets (id, name, total, game) VALUES (?, ?, ?, 'mtg')
   ON CONFLICT(id) DO UPDATE SET total = excluded.total`, [`mtg-${set}`, set, total]
);
const grown = () => catalog.grownSets('mtg', 'English');

async function main() {
  await db.initDb();
  const quiet = console.log;
  console.log = () => {};
  try {
    // A whole-game catalog of two finished sets.
    for (let i = 1; i <= 3; i++) await card(`mtg-a${i}`, 'aaa');
    for (let i = 1; i <= 3; i++) await card(`mtg-b${i}`, 'bbb');
    await claim('aaa', 3);
    await claim('bbb', 3);
    await build();
    assert.deepStrictEqual(await grown(), [], 'a finished catalog has nothing to re-walk');

    // 1. A card cached since (a search, a catalogue refresh) and not in the catalog.
    await card('mtg-a4', 'aaa');
    await claim('aaa', 4);
    assert.deepStrictEqual(await grown(), ['aaa'], 'a set with cached art the catalog lacks has grown');

    // 2. A provider claiming more than is cached: the set is still being published.
    await claim('bbb', 5);
    assert.deepStrictEqual((await grown()).sort(), ['aaa', 'bbb']);

    // A card with no art cannot be embedded, so it never makes its set unfinished.
    await card('mtg-c1', 'ccc', '');
    await claim('ccc', 1);
    assert.ok(!(await grown()).includes('ccc'), 'a card without art is not something to embed');

    // 3. The update builds them; the one that got its card is finished.
    await build({ sets: ['aaa', 'bbb'] });
    assert.deepStrictEqual(await grown(), ['bbb'], 'aaa is done; bbb still claims two more than it has');

    // 4. A set that will not finish stops coming back after GROWTH_GIVE_UP builds
    //    that change nothing...
    let rounds = 0;
    while ((await grown()).includes('bbb') && rounds < 20) { await build({ sets: ['bbb'] }); rounds++; }
    assert.ok(rounds >= 7 && rounds <= 8, `given up on after ${rounds} more builds`);
    assert.deepStrictEqual(await grown(), []);
    // ...until something about it changes: here, its provider claims more again.
    await claim('bbb', 6);
    assert.deepStrictEqual(await grown(), ['bbb'], 'new information re-arms the check');
    // And it finishes when the cards arrive.
    for (let i = 4; i <= 6; i++) await card(`mtg-b${i}`, 'bbb');
    await build({ sets: ['bbb'] });
    assert.deepStrictEqual(await grown(), []);

    // 5. A scoped catalog looks only at its own sets.
    await card('mtg-z1', 'zzz');
    await claim('zzz', 1);
    assert.deepStrictEqual(await catalog.grownSets('mtg', 'English', { scope: ['aaa', 'bbb'] }), [],
      'a set outside the scope is never this catalog\'s to grow');
    assert.ok((await grown()).includes('zzz'), 'while a whole-game catalog picks it up');

    // 6. The update's work lists grown sets alongside missing ones, as one build.
    const behind = await catalog.behindCatalogs();
    const mtg = behind.find(c => c.game === 'mtg' && c.lang === 'English');
    assert.ok(mtg && mtg.sets.includes('zzz'), 'behindCatalogs carries the grown set');
    assert.strictEqual(outbound, 0, 'nothing here went to the network');
  } finally {
    console.log = quiet;
  }
  console.log('catalogupdates.test.js: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await new Promise(ok => db.dbConnection.close(ok)); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
  fs.rmSync(modelDir, { recursive: true, force: true });
});
