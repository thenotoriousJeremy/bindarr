// "Sets released since this catalog was built": the number behind the Admin
// panel's "N sets not downloaded yet" warning, and the list the weekly update
// builds (catalog.setsBehind / recordBuild, cardSets.mtgRootIndex).
//
// The old count compared the provider's set list against card_cache, and could
// never reach zero. Replayed against Scryfall's live list on 2026-11-15, a
// complete English Magic build still left 114 sets "new": 62 digital-only sets
// no paper build fetches, and 51 sets nested two levels under a release that no
// build ever reached. So the weekly update rebuilt the whole game every week,
// forever, and a catalog scoped to a few owned sets was read as missing every
// other set and grown into a whole-game build. What is pinned here:
//
//   · nesting: a grandchild set belongs to its root's family; digital sets and
//     the children of excluded or digital sets belong to none
//   · a catalog seen for the first time (built before this was tracked) is
//     baselined, never mass-built
//   · only sets that appear afterwards are pending; gaps are retried a few times
//     and then dropped; failures are retried; a first scoped build's scope sticks
//   · the cost stays one pass, whatever the size
//
// No framework — plain node + assert. Run: `node test/newsetcount.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-newsetcount-${process.pid}.db`);
const db = require('../src/db');
const catalog = require('../src/catalog');
const cardSets = require('../src/cardSets');

const NONE = { tokens: false, artCards: false, jumpstart: false, promos: false, digital: true };

function testMtgNesting() {
  const sets = [
    { code: 'tdm', card_count: 290 },
    { code: 'tdc', parent_set_code: 'tdm', set_type: 'commander', card_count: 413 },
    { code: 'ttdc', parent_set_code: 'tdc', set_type: 'token', card_count: 34 },        // the grandchild
    { code: 'ptdm', parent_set_code: 'tdm', set_type: 'promo', card_count: 20 },
    { code: 'tptdm', parent_set_code: 'ptdm', set_type: 'token', card_count: 2 },
    { code: 'ytdm', parent_set_code: 'tdm', digital: true, set_type: 'alchemy', card_count: 30 },
    { code: 'yfoo', digital: true, set_type: 'alchemy', card_count: 40 },              // a digital root
    { code: 'tyfoo', parent_set_code: 'yfoo', set_type: 'token', card_count: 3 },
    { code: 'loop', parent_set_code: 'loop2', card_count: 1 },                          // a cycle
    { code: 'loop2', parent_set_code: 'loop', card_count: 1 },
  ];
  const { rootOf } = cardSets.mtgRootIndex(sets, NONE);
  assert.strictEqual(rootOf.get('tdm'), 'tdm', 'a root is its own family');
  assert.strictEqual(rootOf.get('tdc'), 'tdm');
  assert.strictEqual(rootOf.get('ttdc'), 'tdm', 'a grandchild belongs to its root — it was never fetched before');
  assert.strictEqual(rootOf.get('tptdm'), 'tdm');
  assert.strictEqual(rootOf.get('ytdm'), null, 'a digital child is in no family');
  assert.strictEqual(rootOf.get('yfoo'), null, 'a digital root is in no family');
  assert.strictEqual(rootOf.get('tyfoo'), null, 'nor is the child of a digital root');
  assert.strictEqual(rootOf.get('loop'), null, 'a parent cycle terminates and joins nothing');

  // Excluding promos drops the promo set AND everything under it.
  const noPromos = cardSets.mtgRootIndex(sets, { ...NONE, promos: true }).rootOf;
  assert.strictEqual(noPromos.get('ptdm'), null);
  assert.strictEqual(noPromos.get('tptdm'), null, "an excluded set's children go with it");
  assert.strictEqual(noPromos.get('ttdc'), 'tdm', 'other branches are untouched');
  // Excluding tokens drops the grandchild token set, not the Commander set above it.
  const noTokens = cardSets.mtgRootIndex(sets, { ...NONE, tokens: true }).rootOf;
  assert.strictEqual(noTokens.get('ttdc'), null);
  assert.strictEqual(noTokens.get('tdc'), 'tdm');
}

const outcome = (o) => ({
  ok: new Set(o.ok || []), gapIds: new Set(o.gapIds || []), failedIds: new Set(o.failedIds || []),
  attempted: new Set(o.attempted || []), universe: o.universe || null,
});

async function testBehind() {
  const job = { game: 'mtg', lang: 'English' };
  const universe = Array.from({ length: 300 }, (_, i) => `s${i.toString(36)}`);

  // 1. A catalog seen for the first time is baselined: nothing pending, and above
  //    all no mass build of every set it happens not to hold.
  assert.deepStrictEqual(await catalog.setsBehind('mtg', 'English', { universe }), { pending: [], newSets: 0 },
    'a catalog built before this was tracked must not be read as missing every set');

  // 2. Sets released since then are pending; the panel counts them.
  const grown = [...universe, 'new1', 'new2', 'new3'];
  let behind = await catalog.setsBehind('mtg', 'English', { universe: grown });
  assert.deepStrictEqual(behind.pending, ['new1', 'new2', 'new3']);
  assert.strictEqual(behind.newSets, 3);
  assert.strictEqual(await catalog.newSetCount('mtg', 'English', { universe: grown }), 3, 'the panel number');

  // 3. Each language keeps its own record.
  assert.deepStrictEqual((await catalog.setsBehind('mtg', 'Spanish', { universe: grown })).pending, [],
    'Spanish is baselined on its own first look');

  // 4. A build: new1 fetched, new2 empty upstream (announced before its cards),
  //    new3 failed on the network.
  await catalog.recordBuild(job, outcome({
    ok: ['new1'], gapIds: ['new2'], failedIds: ['new3'], attempted: ['new1', 'new2', 'new3'], universe: grown,
  }));
  await db.run(`INSERT INTO set_data_gaps (game, language, set_id) VALUES ('mtg', 'English', 'new2')`);
  behind = await catalog.setsBehind('mtg', 'English', { universe: grown });
  assert.deepStrictEqual(behind.pending, ['new2', 'new3'], 'the gap is retried, and so is the failure');
  assert.strictEqual(behind.newSets, 1, 'but only the failure counts as buildable today');

  // 5. A gap that stays empty is given up on after a few builds, not chased forever.
  for (let i = 0; i < 3; i++) {
    await catalog.recordBuild(job, outcome({ gapIds: ['new2'], ok: ['new3'], attempted: ['new2', 'new3'] }));
  }
  behind = await catalog.setsBehind('mtg', 'English', { universe: grown });
  assert.deepStrictEqual(behind.pending, [], 'four empty tries and the set stops counting');

  // 6. A first SCOPED build defines the scope: the sets it left out are not "new".
  const lorcana = { game: 'lorcana', lang: 'English' };
  const lUniverse = ['tfc', 'rof', 'itk', 'urs'];
  await catalog.recordBuild(lorcana, outcome({ ok: ['itk'], attempted: ['itk'], universe: lUniverse }));
  assert.deepStrictEqual((await catalog.setsBehind('lorcana', 'English', { universe: lUniverse })).pending, [],
    'a catalog built for one set does not grow into the whole game');
  assert.deepStrictEqual((await catalog.setsBehind('lorcana', 'English', { universe: [...lUniverse, 'azs'] })).pending,
    ['azs'], 'but a release after it is offered');

  // 7. Cost: one pass over a real-sized list. Magic has ~950 reachable codes.
  const big = Array.from({ length: 5000 }, (_, i) => `b${i}`);
  await catalog.setsBehind('riftbound', 'English', { universe: big });
  const t0 = Date.now();
  behind = await catalog.setsBehind('riftbound', 'English', { universe: [...big, 'x1'] });
  const ms = Date.now() - t0;
  assert.deepStrictEqual(behind.pending, ['x1']);
  assert.ok(ms < 500, `setsBehind took ${ms}ms over 5,000 sets`);
  return ms;
}

async function main() {
  await db.initDb();
  testMtgNesting();
  const ms = await testBehind();
  console.log(`newsetcount.test.js: all assertions passed (5,000-set check took ${ms}ms)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
