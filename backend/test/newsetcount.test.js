// newSetCount is the number behind the Admin panel's "N sets not downloaded yet"
// warning, and it used to be a correlated NOT EXISTS over card_cache: one full
// scan of the table per set in `sets`, because LOWER() on both sides of the
// comparison makes idx_card_cache_set_num unusable. With an MTG catalog built
// (1,047 sets, 126k cached rows) that measured 9.6s with 50 sets uncached and 28s
// with 400 — on the app's single sqlite3 connection, so every other request
// queued behind it and the Admin page 504'd, taking Users and the dashboard with
// it. That is #49.
//
// Two things are checked here. The counting rules, which are fiddly enough to
// break silently while still returning a plausible number: the `sets` table
// prefixes ids ("mtg-fdn") and card_cache holds the bare code ("fdn"), the
// comparison is case-insensitive, sets with no printed total do not count, and
// sets already known to have no upstream data (set_data_gaps) are excluded. And
// the cost, with a budget generous enough not to be flaky on a slow runner but
// far below the seconds the old shape took.
//
// And the denominator (PROV-03): the sets a build actually walks
// (cardSets.listAllSets), not every set the provider knows. The `sets` table holds
// ~100 digital Magic sets and every child set, which builds skip on purpose, and a
// pokemontcg.io install was measured against TCGdex's ids — so the count never
// reached 0 and the weekly auto-update rebuilt a game every week. Providers are
// stubbed; nothing here touches the network.
//
// No framework — plain node + assert. Run: `node test/newsetcount.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-newsetcount-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const db = require('../src/db');
const { newSetCount, nextAutoUpdate } = require('../src/catalog');
const scryfallApi = require('../src/scryfallApi');
const lorcastApi = require('../src/lorcastApi');
const { tcgClient } = require('../src/tcgApi');

const reply = (data) => async (config) => ({ data, status: 200, statusText: 'OK', headers: {}, config, request: {} });
// Scryfall's /sets: what the stub below fills in. Lorcast lists nothing.
const scryfallSets = [];
scryfallApi.client.defaults.adapter = async (config) => reply({ data: scryfallSets })(config);
lorcastApi.client.defaults.adapter = reply({ results: [] });

// Big enough that a per-set scan of card_cache is unmistakably slower than one
// pass, small enough to seed in a second. The real install is 1,047 x 104k.
const NSETS = 300;
const UNCACHED = 60;          // sets with no cards at all -> the answer
const GAPPED = 5;             // of those, known-empty upstream -> excluded
const CARDS = 20000;

async function main() {
  await db.initDb();

  const codes = Array.from({ length: NSETS }, (_, i) => `s${i.toString(36)}`);
  const covered = codes.slice(0, NSETS - UNCACHED);

  // Mixed case from Scryfall, because its codes are not all lower and the
  // comparison has to survive that.
  for (const c of codes) scryfallSets.push({ code: c.toUpperCase(), name: `Set ${c}`, card_count: 250 });
  // A set with no cards is not a set anyone can download; it must not be counted
  // as missing. Nor are the sets a build skips on purpose: digital-only ones, and
  // child sets, which the build folds into their parent.
  scryfallSets.push({ code: 'empty', name: 'No total', card_count: 0 });
  for (let i = 0; i < 100; i++) scryfallSets.push({ code: `ya${i}`, name: `Alchemy ${i}`, card_count: 30, digital: true });
  for (const c of codes.slice(0, 50)) {
    scryfallSets.push({ code: `t${c}`, name: `Tokens ${c}`, card_count: 12, parent_set_code: c, set_type: 'token' });
  }

  await db.withTransaction(async () => {
    // The `sets` table holds every one of them, as fetchAndCacheSets writes it.
    for (const s of scryfallSets) {
      await db.run(`INSERT INTO sets (id, name, total, game) VALUES (?, ?, ?, ?)`,
        [`mtg-${s.code}`, s.name, s.card_count, 'mtg']);
    }

    for (let i = 0; i < CARDS; i++) {
      await db.run(
        `INSERT INTO card_cache (id, name, set_id, number, game, language) VALUES (?, ?, ?, ?, ?, ?)`,
        [`mtg-c${i}`, `Card ${i}`, covered[i % covered.length], String(i % 250), 'mtg', 'English']
      );
    }
    // Another game and another language in the same table: neither may be counted,
    // and both are rows the old query scanned on every single set.
    for (let i = 0; i < 2000; i++) {
      await db.run(
        `INSERT INTO card_cache (id, name, set_id, number, game, language) VALUES (?, ?, ?, ?, ?, ?)`,
        [`tcgdex-c${i}`, `Card ${i}`, `A${i % 50}`, String(i), 'pokemon', 'English']
      );
    }
    for (const c of codes.slice(NSETS - UNCACHED)) {
      await db.run(
        `INSERT INTO card_cache (id, name, set_id, number, game, language) VALUES (?, ?, ?, ?, ?, ?)`,
        [`mtg-es-${c}`, `Carta ${c}`, c, '1', 'mtg', 'Spanish']
      );
    }
  });

  // 1. The count itself: every set a build walks that has no English cards. Not the
  //    100 digital sets, not the 50 child sets, not the empty one.
  await newSetCount('mtg', 'English');   // the set list is fetched (and cached) once
  const t0 = Date.now();
  assert.strictEqual(await newSetCount('mtg', 'English'), UNCACHED,
    'a set with no cards cached in this language is a set not downloaded yet');
  const ms = Date.now() - t0;

  // 2. Cost, which is the actual regression guard: every assertion here passes
  //    against the old query too, because the rewrite changed only how the answer
  //    is computed. On this fixture the old shape measured 1,305ms and the new one
  //    12ms. 500ms sits between them with 40x of slack for a slow runner, and a
  //    real install is 3x the sets and 6x the rows, where the gap is 9.6s vs 80ms.
  assert.ok(ms < 500, `newSetCount took ${ms}ms — the per-set scan of card_cache is back`);

  // 3. Spanish has one card in each of the sets English is missing, and nothing in
  //    the rest. Scoping to the language is the whole reason this takes a `lang`:
  //    measuring Spanish against the English cache reported English's gaps.
  assert.strictEqual(await newSetCount('mtg', 'Spanish'), NSETS - UNCACHED,
    'each language is measured against its own cached cards');

  // 4. Sets a build already found to have no data upstream are not "not downloaded
  //    yet" — they are sets that cannot be downloaded, and counting them told the
  //    user to rebuild forever. Stored lower case; the set table has them upper.
  await db.withTransaction(async () => {
    for (const c of codes.slice(NSETS - UNCACHED, NSETS - UNCACHED + GAPPED)) {
      await db.run(
        `INSERT INTO set_data_gaps (game, language, set_id) VALUES (?, ?, ?)`,
        ['mtg', 'English', c]
      );
    }
  });
  assert.strictEqual(await newSetCount('mtg', 'English'), UNCACHED - GAPPED,
    'a set with no upstream data must not be reported as missing');

  // 5. A game whose provider lists no sets cannot say what is missing: null (not
  //    known), never "everything", and never a number the auto-update would chase.
  assert.strictEqual(await newSetCount('lorcana', 'English'), null);

  // 6. A scoped catalog is behind only on its own sets: a set released since is
  //    not one of them. Two of these are uncached, one is cached.
  const scope = [codes[NSETS - 1], codes[NSETS - 2], codes[0]];
  assert.strictEqual(await newSetCount('mtg', 'English', { scope }), 2);
  assert.strictEqual(await newSetCount('mtg', 'English', { scope: [codes[0]] }), 0);

  // 7. A pokemontcg.io install is measured in pokemontcg.io's own ids (sv1), the
  //    ones its builds cache, never TCGdex's (sv01).
  await db.run(`UPDATE app_settings SET pokemon_provider = 'pokemontcg' WHERE id = 1`);
  tcgClient.defaults.adapter = reply({ data: [{ id: 'sv1', total: 258 }, { id: 'sv2', total: 279 }] });
  await db.run(`INSERT INTO card_cache (id, name, set_id, number, game, language) VALUES ('sv1-1', 'x', 'sv1', '1', 'pokemon', 'English')`);
  assert.strictEqual(await newSetCount('pokemon', 'English'), 1, 'sv2 is new; sv1 is cached under its own id');

  // 8. The auto-update rebuilds one catalog at a time, the one built longest ago
  //    first (so the games take turns), and a scoped one as its own sets.
  const at = (d) => ({ builtAt: `2026-11-${d}T00:00:00.000Z`, scope: null });
  const listed = [
    { game: 'pokemon', lang: 'English', newSets: 3, built: at('10') },
    { game: 'mtg', lang: 'English', newSets: 1, built: { ...at('02'), scope: ['fdn'] } },
    { game: 'lorcana', lang: 'English', newSets: 0, built: at('01') },
    { game: 'riftbound', lang: 'English', newSets: 2, built: null },
  ];
  assert.deepStrictEqual(nextAutoUpdate(listed), { game: 'mtg', lang: 'English', newSets: 1, sets: ['fdn'] });
  listed[1].built.builtAt = '2026-11-15T00:00:00.000Z';   // just rebuilt: Pokémon's turn
  assert.deepStrictEqual(nextAutoUpdate(listed), { game: 'pokemon', lang: 'English', newSets: 3, sets: null });
  assert.strictEqual(nextAutoUpdate([listed[2], listed[3]]), null, 'nothing behind, nothing built');

  console.log(`newsetcount.test.js: all assertions passed (count took ${ms}ms)`);
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
