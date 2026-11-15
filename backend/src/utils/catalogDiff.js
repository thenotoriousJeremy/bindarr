// What a weekly scan-catalog build publishes against last week's catalog
// (scripts/scan-catalogs/build.mjs): which published rows go, and which are
// carried over as they were.
//
// A published row the build did not embed is REMOVED only when its card is
// provably gone: no longer listed in this run's card cache, and from a set this run
// knows the whole of — a set it fetched, or, for Pokémon's TCGplayer-only cards, a
// TCGplayer group whose product list came back (pokemonTcgplayer.knownSetIds).
// Everything else keeps last week's vector: a set that failed to download, a group
// TCGCSV had no data for that day, an image that would not download, art missing
// this week. Published as removals, those would take the cards out of every
// install's scanner until the next build.
//
// Each row's set comes from last week's state file (`sets`). A state file written
// before rows recorded their set has none, and then nothing is removed.
'use strict';

// A build may remove at most this share of the published rows (and at least 50, so
// a small catalog can still lose a set): more is a provider failing, not cards
// leaving, and the build refuses to publish it.
const MAX_REMOVED_SHARE = 0.03;
const MIN_REMOVED_LIMIT = 50;

// A double-faced Magic card's back is its own row, `<id>_back`; its card is <id>.
const baseId = (id) => String(id).replace(/_back$/, '');

// prevIds: last week's row ids, in order. prevSets: { card id: set } from last
// week's state file, or null. built: the row ids this build embedded. listed: the
// card ids in this run's card cache. known: the sets this run knows the whole of.
// Returns { removes: row ids, carried: indices into prevIds }.
function diffPublished({ prevIds, prevSets, built, listed, known }) {
  const now = new Set(built);
  const removes = [];
  const carried = [];
  prevIds.forEach((id, j) => {
    if (now.has(id)) return;
    const card = baseId(id);
    const set = prevSets ? prevSets[card] : undefined;
    if (!listed.has(card) && set != null && known.has(set)) removes.push(id);
    else carried.push(j);
  });
  return { removes, carried };
}

// How many removals a catalog of `published` rows may take in one build. Carried
// rows are not removals and do not count.
const removalLimit = (published) => Math.max(MIN_REMOVED_LIMIT, Math.ceil(published * MAX_REMOVED_SHARE));

module.exports = { diffPublished, removalLimit, baseId, MAX_REMOVED_SHARE, MIN_REMOVED_LIMIT };
