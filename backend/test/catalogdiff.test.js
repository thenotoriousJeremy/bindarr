// What the weekly scan-catalog build removes from the published catalog, and what
// it carries over (utils/catalogDiff.js, used by scripts/scan-catalogs/build.mjs).
// The rule protects every install's scanner: a row published as removed is gone
// from all of them until the next build, so only a card that is provably gone may
// be removed — never one whose set merely failed to download this week.
//
// No framework — plain node + assert. Run: `node test/catalogdiff.test.js`
const assert = require('assert');
const { diffPublished, removalLimit, baseId } = require('../src/utils/catalogDiff');

const ids = (prevIds, carried) => carried.map(j => prevIds[j]);

// Last week: three sets, one Magic card with a back face, two TCGplayer-only
// Pokémon cards in two groups.
const prevIds = ['a-1', 'a-2', 'b-1', 'b-2', 'm-1', 'm-1_back', 'tcgplayer-21', 'tcgplayer-31'];
const prevSets = {
  'a-1': 'a', 'a-2': 'a', 'b-1': 'b', 'b-2': 'b', 'm-1': 'm',
  'tcgplayer-21': 'tcgp-en-wcd', 'tcgplayer-31': 'tcgp-en-g300',
};

// 1. Nothing changed: everything rebuilt, nothing removed or carried.
let r = diffPublished({ prevIds, prevSets, built: prevIds, listed: new Set(prevIds.map(baseId)), known: new Set(['a', 'b', 'm']) });
assert.deepStrictEqual(r, { removes: [], carried: [] });

// 2. Set b failed to download this week: its cards are not in this run's cache and
//    were not embedded, and are carried as they were — not removed.
r = diffPublished({
  prevIds, prevSets,
  built: ['a-1', 'a-2', 'm-1', 'm-1_back', 'tcgplayer-21', 'tcgplayer-31'],
  listed: new Set(['a-1', 'a-2', 'm-1', 'tcgplayer-21', 'tcgplayer-31']),
  known: new Set(['a', 'm', 'tcgp-en-wcd', 'tcgp-en-g300']),
});
assert.deepStrictEqual(r.removes, [], 'a failed set removes nothing');
assert.deepStrictEqual(ids(prevIds, r.carried), ['b-1', 'b-2'], 'its cards are carried');

// 3. Set a was fetched and no longer lists a-2: removed. A card still listed but not
//    embedded this week (its image would not download) is carried.
r = diffPublished({
  prevIds, prevSets,
  built: ['a-1', 'b-1', 'm-1', 'm-1_back', 'tcgplayer-21', 'tcgplayer-31'],
  listed: new Set(['a-1', 'b-1', 'b-2', 'm-1', 'tcgplayer-21', 'tcgplayer-31']),
  known: new Set(['a', 'b', 'm', 'tcgp-en-wcd', 'tcgp-en-g300']),
});
assert.deepStrictEqual(r.removes, ['a-2'], 'a card its fetched set no longer lists is removed');
assert.deepStrictEqual(ids(prevIds, r.carried), ['b-2'], 'a listed card whose art did not embed is kept');

// 4. A double-faced card that left its set goes with its back; one whose back alone
//    failed to embed keeps the back.
r = diffPublished({
  prevIds, prevSets,
  built: ['a-1', 'a-2', 'b-1', 'b-2', 'tcgplayer-21', 'tcgplayer-31'],
  listed: new Set(['a-1', 'a-2', 'b-1', 'b-2', 'tcgplayer-21', 'tcgplayer-31']),
  known: new Set(['a', 'b', 'm', 'tcgp-en-wcd', 'tcgp-en-g300']),
});
assert.deepStrictEqual(r.removes, ['m-1', 'm-1_back']);
r = diffPublished({
  prevIds, prevSets,
  built: prevIds.filter(id => id !== 'm-1_back'),
  listed: new Set(prevIds.map(baseId)),
  known: new Set(['a', 'b', 'm']),
});
assert.deepStrictEqual([r.removes, ids(prevIds, r.carried)], [[], ['m-1_back']]);

// 5. TCGplayer-only Pokémon cards follow the same rule, their set known when the
//    group's product list came back today: a group TCGCSV had no data for keeps
//    its cards; one with data that no longer has a card (or left the fallback
//    coverage) loses it.
r = diffPublished({
  prevIds, prevSets,
  built: ['a-1', 'a-2', 'b-1', 'b-2', 'm-1', 'm-1_back'],
  listed: new Set(['a-1', 'a-2', 'b-1', 'b-2', 'm-1']),
  known: new Set(['a', 'b', 'm', 'tcgp-en-g300']),   // wcd: no product list today
});
assert.deepStrictEqual(r.removes, ['tcgplayer-31']);
assert.deepStrictEqual(ids(prevIds, r.carried), ['tcgplayer-21'], 'a group with no data today keeps its cards');

// 6. A state file from before rows recorded their set: nothing can be shown gone,
//    so nothing is removed, however much is missing.
r = diffPublished({ prevIds, prevSets: null, built: [], listed: new Set(), known: new Set(['a', 'b', 'm']) });
assert.deepStrictEqual(r.removes, []);
assert.strictEqual(r.carried.length, prevIds.length, 'every row carried');
// A row the state file does not name is carried the same way.
r = diffPublished({ prevIds: ['x-1'], prevSets: {}, built: [], listed: new Set(), known: new Set(['x']) });
assert.deepStrictEqual([r.removes, r.carried], [[], [0]]);

// 7. The cap counts real removals only: a week where most of a big catalog is
//    carried (a provider half down) is not a week of removals.
const big = Array.from({ length: 2000 }, (_, i) => `c-${i}`);
const bigSets = Object.fromEntries(big.map((id, i) => [id, i < 1500 ? 'down' : 'up']));
r = diffPublished({
  prevIds: big, prevSets: bigSets,
  built: big.slice(1500, 1990),
  listed: new Set(big.slice(1500, 1990)),
  known: new Set(['up']),   // the 'down' set failed
});
assert.strictEqual(r.carried.length, 1500, 'the failed set is carried');
assert.strictEqual(r.removes.length, 10, 'ten cards really left');
assert.strictEqual(removalLimit(big.length), 60, '3% of 2,000');
assert.ok(r.removes.length <= removalLimit(big.length), 'so the build publishes');
assert.strictEqual(removalLimit(100), 50, 'a small catalog may still lose a set of 50');

console.log('catalogdiff.test.js: all assertions passed');
