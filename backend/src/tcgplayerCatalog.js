// TCGplayer's product catalogue, so the READY-MADE Pokémon scan catalog can name
// what it matches.
//
// The published catalog (milo-pokemon.npz) stores TCGplayer product ids and
// nothing else — verified: its `card_ids` are strings like "42346" and its
// `source` is "tcgplayer". Turning one into a card used to go product id ->
// tcgplayer_product -> card_cache, and both of those tables are filled by work an
// install may never have done: card_cache by a set walk, tcgplayer_product as a
// side effect of the Pokémon price sweep over already-cached sets. On a fresh
// install both are empty, so every scan matched a product id it could not name and
// the user was told "no confident match".
//
// This walks TCGCSV's whole Pokémon catalogue once and records product id ->
// (set, number, name). A scan can then hand the client a set and a number, which
// resolves through the ordinary search path — including fetching and caching the
// card from the provider, exactly like a manual search would.
//
// One request per group, ~400 groups across the two Pokémon categories, and the
// result is a few tens of thousands of rows. Re-runnable: rows are replaced, never
// deleted, so a rebuild after a new set release is additive.
const db = require('./db');
const tcgcsv = require('./tcgcsvApi');
const setCatalogueMatch = require('./utils/setCatalogueMatch');

// One build at a time, for the same reason catalog.js and modelAssets say so: this
// is a few hundred requests against somebody else's free mirror.
let current = null;
const state = () => (current ? { ...current } : null);
let last = null;

// TCGplayer category ids to walk per game. Pokémon keeps its own two-category
// split (English/Japanese); MTG and Lorcana are each one category. Confirmed
// against the live TCGCSV catalogue, not guessed — Lorcana's id doubles as the
// category already used for its TCGplayer product linkage in lorcastApi.js.
const SEALED_CATEGORIES = {
  pokemon: Object.values(tcgcsv.CATEGORY),
  mtg: [1],
  lorcana: [71],
};

// A rough shelf category for a sealed product, from its TCGplayer name. Order
// matters: more specific phrases are checked before the generic ones they'd
// otherwise be swallowed by ('Elite Trainer Box' before 'Box').
const SEALED_TYPE_RULES = [
  [/elite trainer box|\betb\b/i, 'Elite Trainer Box'],
  [/booster box/i, 'Booster Box'],
  [/booster pack|\bbooster\b/i, 'Booster Pack'],
  [/bundle/i, 'Bundle'],
  [/collector'?s?\s*box|collection box/i, 'Collection Box'],
  [/commander deck/i, 'Commander Deck'],
  [/starter deck/i, 'Starter Deck'],
  [/theme deck/i, 'Theme Deck'],
  [/precon(structed)?/i, 'Commander Deck'],
  [/fat pack/i, 'Fat Pack'],
  [/blister/i, 'Blister'],
  [/\btin\b/i, 'Tin'],
  [/\bcase\b/i, 'Case'],
];

function classifySealedType(name) {
  const s = String(name || '');
  for (const [re, label] of SEALED_TYPE_RULES) {
    if (re.test(s)) return label;
  }
  return 'Other';
}

// The collector number as the card APIs write it.
//
// TCGplayer writes '004/165' where pokemontcg.io writes '4', so take the part
// before the slash and drop leading zeros from the digit run. Letters keep their
// case, unlike tcgcsvApi.normNumber which lowercases for key comparison: this
// value goes into a `number:"TG12"` provider query, not into a Map key.
function displayNumber(raw) {
  const head = String(raw == null ? '' : raw).split('/')[0].trim();
  return head.replace(/^0+(?=\d)/, '');
}

// TCGplayer group -> the set id this install's provider uses.
//
// Reuses the matcher the price sweep already trusts (tcgcsvApi.buildGroupMatcher),
// run over the `sets` table rather than over card_cache: the whole point is to work
// before any card has been cached, and the set list is fetched at startup.
//
// Nullable on purpose. A group with no match still gets its row, and the scan falls
// back to the group's own name — which the card APIs accept as `set.name` — so an
// unmatched group degrades to a slightly looser lookup instead of no answer.
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Non-Pokémon games: one TCGCSV category, no English/Japanese split, so none of
// buildGroupMatcher's language-preferred-category logic applies (it is wired to
// Pokémon's own two category ids). A plain id/name join is enough here, and
// leaves a group unmatched rather than guessing when nothing lines up.
async function groupToSetSimple(groupsByCategory, game) {
  const sets = await db.all(`SELECT id, name FROM sets WHERE game = ?`, [game]).catch(() => []);
  const match = setCatalogueMatch.matcher(sets);
  const out = new Map();
  for (const groups of Object.values(groupsByCategory)) {
    for (const g of groups) {
      const hit = match(g.abbreviation, g.name);
      if (hit) out.set(g.groupId, hit.id);
    }
  }
  return out;
}

async function groupToSet(groupsByCategory, game) {
  if (game && game !== 'pokemon') return groupToSetSimple(groupsByCategory, game);
  const match = tcgcsv.buildGroupMatcher(groupsByCategory);
  const sets = await db.all(
    `SELECT id, name FROM sets WHERE game = 'pokemon' AND COALESCE(total, 0) > 0`
  ).catch(() => []);
  const out = new Map();
  for (const s of sets) {
    const hit = match(s.id, s.name, 'English');
    // First match wins: the `sets` table is ordered and two sets claiming one
    // group means the second is a reprint/variant, which would overwrite a good
    // mapping with a worse one.
    if (hit && !out.has(hit.group.groupId)) out.set(hit.group.groupId, s.id);
  }

  // Pass two: TCGplayer's ' Base Set' suffix, which the shared matcher cannot take.
  //
  // It strips a trailing 'baseset' so 'SV01: Scarlet & Violet Base Set' reaches
  // 'Scarlet & Violet' — correct, but it leaves the 1999 group literally called
  // 'Base Set' with an empty key, and that group is 102 cards nobody could name.
  // Turning the suffix into 'base' instead recovers exactly that case. Unique keys
  // only: an ambiguous guess here files a card under the wrong set.
  const byName = new Map();
  for (const s of sets) {
    const k = normName(s.name);
    byName.set(k, byName.has(k) ? null : s.id);   // null marks 'more than one'
  }
  for (const groups of Object.values(groupsByCategory)) {
    for (const g of groups) {
      if (out.has(g.groupId)) continue;
      const k = normName(tcgcsv.stripGroupCode(g.name)).replace(/baseset$/, 'base');
      const id = byName.get(k);
      if (id) out.set(g.groupId, id);
    }
  }

  // Pass three: the Japanese catalogue, which the `sets` table cannot answer at all
  // — it holds pokemontcg.io's 174 Western releases, and pokemontcg.io has no
  // Japanese sets. That left 461 of 606 groups unmapped, most of them Japanese.
  //
  // TCGplayer prefixes those group names with the set's own code ('SV2a: Pokemon
  // Card 151', 'S12a: VSTAR Universe'), and that code IS TCGdex's set id. So the
  // mapping is the prefix, lowercased — validated against TCGdex's real set list so
  // a code it does not publish is left unmapped rather than invented.
  const jaCategory = tcgcsv.CATEGORY.japanese;
  if (groupsByCategory[jaCategory]) {
    let known = new Set();
    try {
      known = new Set((await require('./tcgdexApi').listSets('ja')).map(s => String(s.id).toLowerCase()));
    } catch (e) {
      console.warn(`product map: no TCGdex set list for Japanese (${e.message})`);
    }
    for (const g of groupsByCategory[jaCategory]) {
      if (out.has(g.groupId)) continue;
      const code = String(g.name || '').split(':')[0].trim().toLowerCase();
      if (code && known.has(code)) out.set(g.groupId, code);
    }
  }
  return out;
}

// How many products are mapped for a game, and whether a build is running or has
// just run. `game` defaults to 'pokemon' for callers that predate multi-game
// support; each game's rows are counted separately since one product_id space is
// shared across all of them.
async function summary(game = 'pokemon') {
  let rows = 0, groups = 0, at = null;
  try {
    const r = await db.get(
      `SELECT COUNT(*) n, COUNT(DISTINCT group_id) g, MAX(built_at) at FROM tcgplayer_catalog WHERE game = ?`,
      [game]
    );
    rows = r?.n || 0;
    groups = r?.g || 0;
    at = r?.at || null;
  } catch { /* table not created yet — reports as empty, which it is */ }
  return { game, rows, groups, builtAt: at, progress: state(), last };
}

function start(game = 'pokemon') {
  if (current) throw new Error('the product map is already building');
  const categoryIds = SEALED_CATEGORIES[game];
  if (!categoryIds) throw new Error(`no TCGplayer category known for game '${game}'`);
  const job = { game, phase: 'groups', done: 0, total: 0, rows: 0, message: '', startedAt: Date.now() };
  current = job;
  (async () => {
    try {
      const groupsByCategory = {};
      for (const categoryId of categoryIds) {
        groupsByCategory[categoryId] = await tcgcsv.getGroups(categoryId);
      }
      const setOf = await groupToSet(groupsByCategory, game);
      const work = Object.entries(groupsByCategory)
        .flatMap(([categoryId, groups]) => groups.map(g => ({ categoryId: Number(categoryId), g })));
      job.total = work.length;
      job.phase = 'products';

      for (const { categoryId, g } of work) {
        if (job.cancelled) break;
        job.message = g.name;
        try {
          const products = await tcgcsv.getProducts(categoryId, g.groupId);
          // One transaction per group. Row-at-a-time inserts across 400 groups is
          // the difference between seconds and minutes on the same data.
          await db.run('BEGIN');
          try {
            for (const p of products) {
              const number = displayNumber(tcgcsv.numberOf(p));
              // A product with no collector number is sealed product (a box, pack,
              // ETB, ...) rather than a card. Both get a row now: `number IS NULL`
              // is how a reader tells the two apart.
              const sealedType = number ? null : classifySealedType(p.name);
              await db.run(
                `INSERT OR REPLACE INTO tcgplayer_catalog
                   (product_id, category_id, group_id, group_name, set_id, name, number, game, image_url, sealed_type, built_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [p.productId, categoryId, g.groupId, g.name, setOf.get(g.groupId) || null,
                  p.name || '', number || null, game, p.imageUrl || null, sealedType]
              );
              job.rows++;
            }
            await db.run('COMMIT');
          } catch (e) {
            await db.run('ROLLBACK').catch(() => {});
            throw e;
          }
        } catch (e) {
          // One unreachable group must not abandon the other 399.
          console.warn(`product map: ${g.name} failed (${e.message})`);
        }
        job.done++;
      }
      job.phase = job.cancelled ? 'stopped' : 'done';
      job.message = `${job.rows.toLocaleString()} products mapped from ${job.done} groups`;
      console.log(`product map: ${job.message}`);
    } catch (e) {
      job.phase = 'error';
      job.message = e.message;
      console.error('product map build failed:', e.message);
    } finally {
      last = { ...job, finishedAt: Date.now() };
      current = null;
    }
  })();
  return state();
}

function stop() {
  if (!current) return false;
  current.cancelled = true;
  current.message = 'stopping…';
  return true;
}

// What card is this product? Null when the map has never been built, which the
// caller reports as such rather than as "card not recognised".
async function lookup(productId) {
  try {
    return await db.get(
      `SELECT product_id, group_name, set_id, name, number FROM tcgplayer_catalog WHERE product_id = ?`,
      [Number(productId)]
    );
  } catch {
    return null;
  }
}

module.exports = { start, stop, state, summary, lookup, displayNumber, SEALED_CATEGORIES, classifySealedType };
