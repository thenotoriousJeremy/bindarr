// TCGplayer prices for Pokémon, via TCGCSV (https://tcgcsv.com).
//
// Why not TCGplayer directly: their API has been closed to new applicants since
// late 2024 (eBay owns them now), and it was a seller/affiliate API before that —
// gated on running a TCGplayer store. There is no key to apply for. TCGCSV mirrors
// the same catalogue and price endpoints daily, with the same field names and the
// same productIds, and needs no key at all.
//
// Why this exists when there are already two Pokémon providers: neither prices the
// cards. Measured against the real cache before this was written:
//
//   pokemontcg.io   1 row in the entire card_cache. The provider is effectively
//                   dead here, and its sweep still cost a key and a rate limiter.
//   TCGdex          9,670 English rows, 758 priced (7.8%);
//                   3,297 Japanese rows, 0 priced (0%).
//                   Its prices come from Cardmarket, which blocks automated
//                   requests, so that ceiling is not going to move.
//   TCGdex links    tcgplayer_url is hardcoded null, so every Pokémon marketplace
//                   link fell through to a name search.
//
// TCGCSV covers both — categories 3 (Pokemon) and 85 (Pokemon Japan) — in USD, and
// hands back a productId, which is what turns a link into the actual card.
//
// TCGdex is NOT replaced: it still supplies names, localized art and set structure,
// which it is good at. This module supplies prices and product ids only.
const axios = require('axios');
const db = require('./db');
const { recordPrice, shouldSweepPrices, markPricesSwept } = require('./utils/priceHelpers');
const { normId, normName, fold } = require('./utils/setCatalogueMatch');

const API_BASE_URL = 'https://tcgcsv.com';

// TCGCSV rejects a request with no identifying User-Agent — a 401 with a note
// asking you to say who you are. That is a reasonable ask of a free mirror, so the
// header names the app and links the project rather than impersonating a browser.
// Version read from package.json rather than typed here: the literal said 1.6.1
// through two releases, which is exactly what a hardcoded version does.
const USER_AGENT = `Bindarr/${require('../package.json').version} (self-hosted TCG collection manager; https://github.com/thenotoriousJeremy/bindarr)`;

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
});

// Verified against the live endpoint, not guessed.
const CATEGORY = { english: 3, japanese: 85 };

// Which TCGplayer category serves a card_cache language. TCGplayer splits Pokémon
// into the Western releases (3) and the Japanese ones (85); every other language
// TCGdex carries (French, German, ...) is a Western release, so it belongs to 3.
const categoryFor = (language) => (language === 'Japanese' ? CATEGORY.japanese : CATEGORY.english);

// Every response is wrapped: { totalItems, success, errors, results }.
async function fetchResults(path) {
  const { data } = await client.get(path);
  if (!data || data.success === false) {
    const why = (data && data.errors && data.errors.join('; ')) || 'unknown error';
    throw new Error(`TCGCSV ${path} failed: ${why}`);
  }
  return data.results || [];
}

const getGroups = (categoryId) => fetchResults(`/tcgplayer/${categoryId}/groups`);
const getProducts = (categoryId, groupId) => fetchResults(`/tcgplayer/${categoryId}/${groupId}/products`);
const getPrices = (categoryId, groupId) => fetchResults(`/tcgplayer/${categoryId}/${groupId}/prices`);

// Pokémon TCG Pocket sets (A1, A1a, A2b, B1, ...). Cards that exist only in the
// phone game, so TCGplayer has never sold one and no amount of matching will find
// a product. Skipped rather than counted as failures — 2,248 of the cached rows are
// these, and letting them look like misses hides the real ones.
//
// db.js already defaults scan_exclude_digital ON for the same reason.
const isPocketSet = (setId) => /^[ab]\d/i.test(String(setId || ''));

// TCGplayer group names carry a code the set's own name does not:
//   'SV01: Scarlet & Violet Base Set'   vs TCGdex 'Scarlet & Violet'
//   'XY - BREAKthrough'                 vs TCGdex 'BREAKthrough'
// Strip the code so the remainder can be compared to the plain name. The trailing
// ' Base Set' goes too: TCGplayer appends it to the first set of an era, and the
// providers disagree about whether it is part of the name.
const stripGroupCode = (name) => String(name || '')
  .replace(/^[^:]{1,12}:\s*/, '')
  .replace(/^[A-Za-z0-9]{1,6}\s*[-–—]\s*/, '');
const groupTail = (name) => normName(stripGroupCode(name)).replace(/baseset$/, '');

// Match a cached set to a TCGplayer group.
//
// Two passes, and the order is the whole safety argument:
//
//   1. EXACT on any of three keys — the set's id against the group's abbreviation,
//      or either side's normalized name, or the group name with its code stripped.
//      Tried inside the language's own category first, then the other, because
//      'Charizard ex 151' exists in both English and Japanese.
//   2. SUFFIX, only for sets pass 1 could not place. TCGplayer prepends the era
//      to older set names ('EX Delta Species', 'EX Team Rocket Returns'), which no
//      exact key recovers. Restricted to the preferred category and REFUSED when
//      more than one group ends that way — 'Base Set' is a suffix of 'SV01:
//      Scarlet & Violet Base Set', and letting that win would price all 102 Base
//      Set cards off a 2023 release. An ambiguous suffix is worse than no match:
//      no match leaves the existing price alone, a wrong one overwrites it.
//
// Measured on the real cache: 148 sets exact, 13 by suffix, 13 unmatched —
// 97% of non-Pocket cards.
function buildGroupMatcher(groupsByCategory) {
  const entries = [];
  for (const [categoryId, groups] of Object.entries(groupsByCategory)) {
    for (const g of groups) {
      entries.push({
        categoryId: Number(categoryId),
        group: g,
        keys: new Set([normId(g.abbreviation), normName(g.name), groupTail(g.name)].filter(Boolean)),
        nameKey: normName(g.name),
      });
    }
  }
  return function match(setId, setName, language) {
    const preferred = categoryFor(language);
    const wanted = [normId(setId), normName(setName), groupTail(setName)].filter(Boolean);

    // 1. Exact, in the card's own catalogue.
    const sameCat = entries.find(e => e.categoryId === preferred && wanted.some(w => e.keys.has(w)));
    if (sameCat) return { ...sameCat, confidence: 1 };

    // 2. Suffix, still in the card's own catalogue. This comes BEFORE looking in
    //    the other catalogue: an exact name match in the wrong language is worse
    //    than a good match in the right one. '151' names a set in both, and pricing
    //    an English 151 off the Japanese catalogue would be confidently wrong.
    //
    //    The length floor keeps a two-character name from matching half the
    //    catalogue; 151 is the shortest real set name and normalizes to 3.
    const nameKey = normName(setName);
    if (nameKey.length >= 3) {
      const cand = entries.filter(e => e.categoryId === preferred && e.nameKey.endsWith(nameKey));
      if (cand.length === 1) return { ...cand[0], confidence: 0.8 };
    }

    // 3. Exact, in the other catalogue — but ONLY when the language guess could
    //    actually have been wrong. categoryFor sends Japanese to the Japanese
    //    catalogue and everything else to the English one, so for a card that IS
    //    English or Japanese the guess is definitionally right and there is
    //    nothing to fall back to.
    //
    //    Without this the id keys walk straight past the language guard above:
    //    English `dp1` (Diamond & Pearl) exact-matches the Japanese group `DP1:
    //    Space-Time Creation` on its abbreviation, and `bw1` matches `BW1: Black
    //    Collection`. Both scored 0.9 and would price — and, now, IDENTIFY —
    //    English cards off Japanese products. The step-2 comment already says an
    //    exact name match in the wrong language is worse than a good match in the
    //    right one; an exact ID match in the wrong language is worse still,
    //    because ids are short and collide by design across catalogues.
    if (language !== 'English' && language !== 'Japanese') {
      const otherCat = entries.find(e => wanted.some(w => e.keys.has(w)));
      if (otherCat) return { ...otherCat, confidence: 0.9 };
    }

    // No suffix pass across catalogues: loose key plus wrong language is how a set
    // gets priced off an unrelated release.
    return null;
  };
}

// A card number as both sides can agree on.
//
// TCGplayer writes '004/102' where TCGdex writes '4', and TCGplayer's own newer
// sets use bare numbers with letter suffixes ('TG12', 'SV107'). So: take the part
// before the slash, then drop leading zeros from the digit run while KEEPING any
// letters — 'TG12' and 'SWSH284' are numbers too, and stripping their letters
// would collide every promo in a set into one key.
function normNumber(n) {
  const head = String(n == null ? '' : n).split('/')[0].trim();
  return fold(head).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+(?=\d)/, '');
}

const numberOf = (product) => {
  const ext = product.extendedData || [];
  const f = ext.find(e => e && String(e.name).toLowerCase() === 'number');
  return f ? f.value : null;
};

// TCGplayer's finish names -> the price column each belongs in.
//
// Two eras, measured across real groups rather than assumed:
//   modern  (151)            Normal / Holofoil / Reverse Holofoil
//   vintage (Base, Gym)      1st Edition / Unlimited, and the Holofoil variants
//                            of both. Each product carries ONE of the pair, never
//                            both, so there is no conflict to resolve.
//
// 1st Edition gets its own column instead of being folded into Normal. Folding it
// was the first attempt and it was visibly wrong: Blaine's Charizard came out with
// price_normal $699.99 (a 1st Edition HOLO) above price_holofoil $597.59 (the
// Unlimited holo), so the 'Normal' printing displayed a 1st Edition holo's price.
// collection.printing has allowed '1st Edition' since v1.0 with no price column
// behind it, which is the gap this closes.
//
// Unmapped finishes are dropped rather than guessed at — a wrong number presented
// as a right one is worse than a blank.
const SUBTYPE_TO_COLUMN = {
  'Normal': 'price_normal',
  'Unlimited': 'price_normal',
  'Holofoil': 'price_holofoil',
  'Unlimited Holofoil': 'price_holofoil',
  'Reverse Holofoil': 'price_reverse_holofoil',
  '1st Edition': 'price_1st_edition',
  '1st Edition Normal': 'price_1st_edition',
  '1st Edition Holofoil': 'price_1st_edition',
};

// When both names in a pair are present, the plain one wins: 'Normal' is a modern
// set's own word for the finish, 'Unlimited' is the vintage print run. Ordering by
// preference means the fill loop never has to know which era it is in.
const SUBTYPE_PRIORITY = {
  'Normal': 0, 'Unlimited': 1,
  'Holofoil': 0, 'Unlimited Holofoil': 1,
  'Reverse Holofoil': 0,
  // Holo first within 1st Edition for the same reason price_trend prefers holo:
  // a 1st Edition Charizard means the holo.
  '1st Edition Holofoil': 0, '1st Edition Normal': 1, '1st Edition': 2,
};

// marketPrice is the real signal — TCGplayer's computed market value from actual
// sales. midPrice is the midpoint of current LISTINGS, which is a sellers' asking
// price and runs high, so it is only a fallback.
const priceOf = (row) => (row.marketPrice > 0 ? row.marketPrice : (row.midPrice > 0 ? row.midPrice : null));

// Collapse a group's price rows into one per product, in the column shape
// card_cache uses.
function pricesByProduct(rows) {
  const out = new Map();
  // Sorted so the preferred name in each pair is seen first and the fill can be a
  // plain "only if empty".
  const ordered = (rows || [])
    .filter(r => SUBTYPE_TO_COLUMN[r.subTypeName] && priceOf(r) != null)
    .sort((a, b) => (SUBTYPE_PRIORITY[a.subTypeName] ?? 9) - (SUBTYPE_PRIORITY[b.subTypeName] ?? 9));

  for (const r of ordered) {
    const col = SUBTYPE_TO_COLUMN[r.subTypeName];
    const cur = out.get(r.productId)
      || { price_normal: null, price_holofoil: null, price_reverse_holofoil: null, price_1st_edition: null };
    if (cur[col] == null) cur[col] = priceOf(r);
    out.set(r.productId, cur);
  }

  // price_trend is what the app reads when it has no printing to go on. Holofoil
  // first for Pokémon: the cards anyone looks up the price of are holos, and a
  // Charizard's 'Normal' row (when it exists at all) is not the card they mean.
  //
  // 1st Edition is last. It is the priciest number on a vintage card and the least
  // likely thing to be holding — quoting it as the default would inflate every
  // Base Set common's headline price.
  for (const [, p] of out) {
    p.price_trend = p.price_holofoil ?? p.price_normal ?? p.price_reverse_holofoil ?? p.price_1st_edition ?? 0;
  }
  return out;
}

// The (set, language) pairs to price, newest-largest first.
//
// `scope` decides how much of the cache is worth a request:
//   'owned' — sets the user actually holds cards from, which is what the daily
//             sweep needs. One TCGCSV request per set, so this is the difference
//             between ~30 requests and ~670.
//   'all'   — every cached set. For the one-off backfill.
async function setsToPrice(scope = 'owned') {
  const owned = `
    WHERE cc.game = 'pokemon' AND cc.id IN (
      SELECT card_id FROM collection UNION SELECT card_id FROM deck_cards
    )`;
  const rows = await db.all(`
    SELECT cc.set_id, cc.set_name, cc.language, COUNT(*) AS n
      FROM card_cache cc
     ${scope === 'owned' ? owned : `WHERE cc.game = 'pokemon'`}
     GROUP BY cc.set_id, cc.language
     ORDER BY n DESC
  `);
  return rows.filter(r => r.set_id && !isPocketSet(r.set_id));
}

// Price one matched set: fetch its products and prices, join them to the cached
// rows by card number, and write both the prices and the productId.
//
// Returns counts rather than throwing on a partial result — one set failing to
// resolve must not abandon the other 200.
async function priceSet({ set_id, set_name, language }, match) {
  const hit = match(set_id, set_name, language);
  if (!hit) return { set_id, language, matched: false, priced: 0 };

  const { categoryId, group, confidence } = hit;
  const [products, prices] = await Promise.all([
    getProducts(categoryId, group.groupId),
    getPrices(categoryId, group.groupId),
  ]);
  const priceFor = pricesByProduct(prices);

  // Number -> product. A number claimed by two products is dropped: TCGplayer
  // lists sealed product and the occasional duplicate inside a group, and picking
  // by insertion order would price a card off whichever came first in the JSON.
  const byNumber = new Map();
  for (const p of products) {
    const key = normNumber(numberOf(p));
    if (!key) continue;
    if (byNumber.has(key)) byNumber.set(key, null);
    else byNumber.set(key, p);
  }

  const cached = await db.all(
    `SELECT id, number FROM card_cache WHERE game = 'pokemon' AND set_id = ? AND language = ?`,
    [set_id, language]
  );

  // Whose printing this price actually is. TCGplayer has two Pokémon catalogues,
  // English (3) and Japanese (85), and nothing else — so a German, French, Korean or
  // Chinese card is priced off the ENGLISH product for the same set and number
  // (categoryFor sends it there). That is the closest real number available and much
  // better than $0.00, but it is not the price of the card the user owns: a German
  // printing usually trades below the English one, and a Korean one is often not
  // listed at all. Recorded as its own source so the UI can say so instead of
  // presenting a proxy as a quote for this printing.
  const source = (language === 'English' || language === 'Japanese') ? 'tcgcsv' : 'tcgcsv-en';

  let priced = 0;
  for (const row of cached) {
    const product = byNumber.get(normNumber(row.number));
    if (!product) continue;
    const p = priceFor.get(product.productId);
    // The product id is worth storing even with no price attached — it is what
    // makes the marketplace link point at the card instead of at a search.
    await db.run(
      `INSERT OR REPLACE INTO tcgplayer_product (card_id, product_id, category_id, confidence, matched_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [row.id, product.productId, categoryId, confidence]
    );
    if (!p || !(p.price_trend > 0)) continue;
    await db.run(
      `UPDATE card_cache
          SET price_trend = ?, price_normal = ?, price_holofoil = ?, price_reverse_holofoil = ?,
              price_1st_edition = ?, tcgplayer_product_id = ?, price_source = ?, price_currency = 'USD'
        WHERE id = ?`,
      [p.price_trend, p.price_normal, p.price_holofoil, p.price_reverse_holofoil,
       p.price_1st_edition, product.productId, source, row.id]
    );
    await recordPrice(row.id, p.price_trend);
    priced++;
  }
  return { set_id, language, matched: true, group: group.name, confidence, priced, cached: cached.length };
}

// Refresh Pokémon prices from TCGCSV. `force` bypasses the once-a-day gate, the
// same way the other providers' sweeps do — without it the boot sweep re-runs on
// every restart, which under nodemon means every code edit.
async function updateCollectionPrices(force = false, scope = 'owned') {
  try {
    if (!force && !(await shouldSweepPrices('tcgcsv'))) {
      console.log('Skipping TCGCSV price update: already swept within the last 24h.');
      return;
    }
    const sets = await setsToPrice(scope);
    if (!sets.length) return;

    const groups = {};
    for (const categoryId of Object.values(CATEGORY)) {
      groups[categoryId] = await getGroups(categoryId);
    }
    const match = buildGroupMatcher(groups);

    console.log(`Starting TCGCSV price update for ${sets.length} Pokémon sets (${scope})...`);
    let priced = 0, unmatched = [];
    // Sequential: this is one request per set against somebody else's free mirror,
    // and the sweep has all day to finish.
    for (const s of sets) {
      try {
        const r = await priceSet(s, match);
        if (!r.matched) unmatched.push(`${s.set_id} (${s.language})`);
        priced += r.priced;
      } catch (e) {
        console.warn(`TCGCSV: ${s.set_id} (${s.language}) failed: ${e.message}`);
      }
    }
    await markPricesSwept('tcgcsv');
    console.log(`TCGCSV price update complete: ${priced} cards priced.`);
    // Named, not just counted. An unmatched set is a silent price gap otherwise,
    // and the list is what makes the matcher improvable.
    if (unmatched.length) {
      console.log(`TCGCSV: no TCGplayer group for ${unmatched.length} set(s): ${unmatched.slice(0, 20).join(', ')}${unmatched.length > 20 ? ', …' : ''}`);
    }
  } catch (err) {
    console.error('Error during TCGCSV price update:', err.message);
  }
}

module.exports = {
  CATEGORY,
  categoryFor,
  setsToPrice,
  priceSet,
  updateCollectionPrices,
  client,
  getGroups,
  getProducts,
  getPrices,
  buildGroupMatcher,
  groupTail,
  stripGroupCode,
  isPocketSet,
  normNumber,
  numberOf,
  pricesByProduct,
  SUBTYPE_TO_COLUMN,
  USER_AGENT,
};
