// Turning what the scan catalog matched into cards the client can show.
//
// cvScan.match answers with ids: a card id for a catalog drawn from card_cache or
// Scryfall, a TCGplayer product id for the ready-made Pokémon catalog. Neither is
// something the picker can draw. This names each candidate — the cached row, a
// provider fetch, or the product's set and number for the client to resolve —
// and re-expresses it in the language being scanned. POST /scan-match
// (routes/collection/scan.js) is the only caller; it was split out of the route
// so the resolution rules can be read, and tested, without the HTTP around them.
const db = require('./db');
const scryfallApi = require('./scryfallApi');
const lorcastApi = require('./lorcastApi');
const tcgdexApi = require('./tcgdexApi');
const tcgplayerCatalog = require('./tcgplayerCatalog');
const languages = require('./utils/languages');
const pokemonProvider = require('./utils/pokemonProvider');
const { parseCardRow } = require('./utils/priceHelpers');
const { normName } = require('./utils/setCatalogueMatch');

// Which Pokémon provider answers a scan's language.
//
// Language alone is not enough, and getting that wrong is not cosmetic. TCGdex can
// serve English too, and when it is the selected provider the scan indexes are
// built from its catalogue — so a match hands back TCGdex set ids (swsh10.5,
// sv01, me01). Routing those to pokemontcg.io, which numbers the same sets pgo,
// sv1 and me1, finds nothing; the client then retries by name alone and gets some
// unrelated printing of the right card. On screen that is a card with the correct
// name, the wrong set and number, and frequently no art at all.
//
// So: non-English always goes to TCGdex (pokemontcg.io is English-only), and
// English follows whichever provider actually built the data being searched.
// That rule lives in utils/pokemonProvider — this only maps its answer to a module.
async function pokemonApiFor(lang) {
  return pokemonProvider.apiFor(lang);
}

// A client-supplied milo embedding, or null. 128 finite numbers is the only shape
// milo produces; anything else is refused rather than swept.
function toEmbedding(value) {
  if (!Array.isArray(value) || value.length !== 128 || !value.every(Number.isFinite)) return null;
  return Float32Array.from(value);
}

// Collector numbers as both providers can agree on. TCGdex zero-pads ('013')
// where pokemontcg.io and TCGplayer do not ('13'), and letters have to survive
// ('TG12', 'SWSH284') or every promo in a set collides into one key. The rule is
// shared (utils/setCatalogueMatch.numberKey).
const { sameNumber } = require('./utils/setCatalogueMatch');

// A scanned Pokémon card, expressed in the language being scanned.
//
// Returns the card unchanged when it is already in that language (a catalog built
// in it returns localised ids, so this is the normal case) or when no localised
// row can be reached — see tcgdexApi.getPrintingInLang for which cases those are
// and why guessing at them would be worse than answering in English.
//
// When no localised row can be reached the English card comes back carrying
// `langFallback`, the language that was asked for and could not be served. The
// unmarked English card was indistinguishable from a genuine English printing, so
// the picker showed English art and an English name with nothing to say why —
// which for Korean, Japanese and Chinese (their sets are their own releases, not
// localised editions, so there is no id to swap to) is EVERY scan. The client
// prints a disclaimer on it; the copy is still filed in the scanned language.
async function localizedPokemon(card, langName) {
  if (!card || languages.isEnglish(langName)) return card;
  if (card.language === langName) return card;
  const localized = await tcgdexApi.getPrintingInLang(card.id, langName).catch(() => null);
  return localized || { ...card, langFallback: langName };
}

// The card a TCGplayer product is, found by set + collector number.
//
// `setId` comes from the TCGplayer catalogue and is therefore always an ENGLISH
// set id, which is why this is asked twice on a non-English scan (see the call
// site): once in the scanned language, then in English.
async function pokemonBySetNumber(langName, number, setId, tcgApiKey) {
  const provider = await pokemonApiFor(langName);
  const { cards } = await provider.searchCards({
    number, set: setId, lang: languages.toCode(langName), apiKey: tcgApiKey, limit: 5,
  }).catch(() => ({ cards: [] }));
  // Leading zeros, not string equality: TCGdex writes '013' where
  // pokemontcg.io writes '13', so an exact compare silently rejected every
  // TCGdex answer and reported the card as unresolvable.
  return (cards || []).find(c => sameNumber(c.number, number)) || null;
}

// One candidate from cvScan.match, named. `i` is its rank: only the top few
// product-id candidates are resolved here (see below), the rest go back as a
// set + number hint. Never throws for a card it cannot name — the bare
// candidate is returned and the client decides what to do with it.
async function resolveCandidate(cand, i, { game, langName, tcgApiKey }) {
  // MTG goes through getCardById because it can fetch and cache a printing
  // this install has never seen. A locally built catalog is drawn FROM
  // card_cache, so a primary-key read is both sufficient and the only thing
  // that works for Pokemon, whose ids Scryfall knows nothing about.
  if (cand.cardId) {
    if (game === 'mtg') {
      const card = await scryfallApi.getCardById(cand.cardId).catch(() => null);
      if (!card) return cand;
      // The catalog that answered is whichever one exists, and for most
      // installs that is the English one — the artwork is identical across
      // languages, so an English catalog identifies a Japanese card perfectly
      // well and then hands back the ENGLISH printing. Re-express it in the
      // scanned language here (cvScan.load defers to the route for exactly
      // this), or the picker shows English names and art, and the copy gets
      // filed as the English printing.
      //
      // Same set and collector number, different Scryfall id: the localized
      // card IS a different printing row, which is the one the collection
      // should reference.
      const localized = await scryfallApi
        .getPrintingInLang(card.set_id, card.number, langName)
        .catch(() => null);
      const use = localized || card;
      return { ...cand, name: use.name, set: use.set_id, number: use.number, card: use };
    }
    if (game === 'lorcana') {
      let row = await db.get(
        `SELECT * FROM card_cache WHERE id = ? AND image_url IS NOT NULL AND image_url != '' LIMIT 1`,
        [cand.cardId]
      );
      if (!row) {
        const card = await lorcastApi.getCardById(cand.cardId).catch(() => null);
        if (card) return { ...cand, name: card.name, set: card.set_id, number: card.number, card };
        return cand;
      }
      const card = parseCardRow(row);
      return { ...cand, name: card.name, set: card.set_id, number: card.number, card };
    }
    const row = await db.get(
      `SELECT * FROM card_cache WHERE id = ? AND image_url IS NOT NULL AND image_url != '' LIMIT 1`,
      [cand.cardId]
    );
    if (!row) return cand;
    const card = parseCardRow(row);
    // Same re-expression as MTG above. A catalog built in the scanned language
    // returns localised ids already, so this is a no-op then; it matters when
    // the match fell back to the English catalog (no catalog in that language,
    // or a card the localised one does not cover). Pokémon only: any other
    // game reaching this branch has a local catalog and nothing to re-express.
    const use = game === 'pokemon' ? await localizedPokemon(card, langName) : card;
    return { ...cand, name: use.name, set: use.set_id, number: use.number, card: use };
  }
  if (game === 'lorcana') {
    const row = await db.get(
      `SELECT c.* FROM tcgplayer_product t
         JOIN card_cache c ON c.id = t.card_id
        WHERE t.product_id = ? AND c.game = 'lorcana'
          AND c.image_url IS NOT NULL AND c.image_url != ''
        LIMIT 1`,
      [cand.productId]
    );
    if (row) {
      const card = parseCardRow(row);
      return { ...cand, name: card.name, set: card.set_id, number: card.number, card };
    }
    const directRow = await db.get(
      `SELECT * FROM card_cache WHERE tcgplayer_product_id = ? AND game = 'lorcana' AND image_url IS NOT NULL AND image_url != '' LIMIT 1`,
      [cand.productId]
    );
    if (directRow) {
      const card = parseCardRow(directRow);
      return { ...cand, name: card.name, set: card.set_id, number: card.number, card };
    }
    const p = await tcgplayerCatalog.lookup(cand.productId);
    if (!p) return cand;
    const hint = { ...cand, name: p.name, set: p.set_id || p.group_name, number: p.number };
    if (p.name) {
      const { cards } = await lorcastApi.searchCards({ name: p.name, number: p.number, limit: 5 }).catch(() => ({ cards: [] }));
      // The card with the product's number, or none. Falling back to the first
      // result named it with full confidence, which is a guess; no published
      // Lorcana catalog exists today, so this path waits for one, and it must
      // refuse rather than file a wrong card when it does run.
      const card = (cards || []).find(c => sameNumber(c.number, p.number));
      if (card) {
        await db.run(
          `INSERT OR REPLACE INTO tcgplayer_product (card_id, product_id, category_id, confidence, matched_at)
           VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`,
          [card.id, cand.productId, 71]
        ).catch(() => {});
        return { ...hint, name: card.name, set: card.set_id, number: card.number, card };
      }
    }
    return hint;
  }
  // The published Pokemon catalog is keyed by TCGplayer product id.
  // tcgplayer_product is the authoritative mapping — card_cache's own column
  // is a denormalised copy written only when the card also had a price, so
  // joining on it silently drops every unpriced card.
  const row = await db.get(
    `SELECT c.* FROM tcgplayer_product t
       JOIN card_cache c ON c.id = t.card_id
      WHERE t.product_id = ? AND c.game = 'pokemon'
        AND c.image_url IS NOT NULL AND c.image_url != ''
      LIMIT 1`,
    [cand.productId]
  );
  if (row) {
    const card = parseCardRow(row);
    const use = await localizedPokemon(card, langName);
    return { ...cand, name: use.name, set: use.set_id, number: use.number, card: use };
  }
  // Nothing cached under that product id. Ask TCGplayer's own catalogue what
  // the product IS, and hand back a set and a number — which is all the client
  // needs to resolve it through /api/search, provider fetch and cache included.
  //
  // This is what makes the ready-made Pokémon catalog work on an install with
  // an empty card_cache. The join above can only ever answer for cards already
  // downloaded AND priced, so before this every such scan named nothing.
  const p = await tcgplayerCatalog.lookup(cand.productId);
  if (!p) return cand;
  const hint = { ...cand, name: p.name, set: p.set_id || p.group_name, number: p.number };
  if (!p.set_id) return hint;
  // The TOP candidate is resolved here whatever the language; the rest are left
  // to the client on an English scan.
  //
  // Not a speed fix — the same provider round trip happens either way, it just
  // happens before the response instead of after. What it buys is the product
  // id -> card id row written below, and one less HTTP hop on the auto-add
  // path, which fires on the top candidate alone.
  //
  // Measured, first sight of a card: 971-1963 ms to resolve a Pokémon candidate
  // (set+number search against pokemontcg.io, which answers 5xx often enough to
  // carry its own retry policy) against 164 ms for an MTG candidate (one
  // Scryfall by-id fetch, because the MTG catalog stores card ids and the
  // Pokémon one stores TCGplayer product ids). Both are ~1 ms once card_cache
  // holds the row. That gap is why Pokémon feels slow and Magic feels instant,
  // and it is the provider and the key shape, not this code path.
  if (i > (languages.isEnglish(langName) ? 0 : 2)) return hint;

  // Non-English, and this is where a correct match used to die. The published
  // catalog is TCGplayer's ENGLISH products, so what it hands back is an
  // English set id — and a non-English search goes to TCGdex, which has never
  // heard of 'base6'. Verified: tcgdex(ja, set=base6, number=96) returns 0
  // cards, so all eight candidates resolved to null and a scan that had
  // identified the card correctly reported "no confident match".
  //
  // So resolve it here, the same way the cached branch does: find the English
  // printing, then re-express it in the scanned language. Capped above at the
  // first three candidates for a non-English scan — each costs a provider round
  // trip, and the picker only needs the alternatives a person will look at.
  // Through the configured provider, not hardcoded pokemontcg.io: a TCGdex
  // install has no pokemontcg.io rows and its set ids are different, so asking
  // the wrong one returns nothing at all.
  //
  // And when THAT finds nothing, ask in English — because for Korean,
  // Japanese and Chinese it never finds anything. Those regions get their own
  // releases (SM1M, S12, SV2a) rather than localised editions of the English
  // sets, so TCGdex's ko/ja/zh catalogues share no set id with the English
  // 'base6' the TCGplayer product carries: verified 0 results for every
  // candidate, so a Korean scan that had identified the card correctly
  // resolved nothing at all and reported "no confident match" — while the same
  // photo scanned as English named the card immediately.
  //
  // The English card IS the right answer to "which card is this"; only its
  // language is wrong, and localizedPokemon below marks that so the client can
  // say so rather than passing it off as an English printing.
  let card = await pokemonBySetNumber(langName, p.number, p.set_id, tcgApiKey);
  if (!card && !languages.isEnglish(langName)) {
    card = await pokemonBySetNumber('English', p.number, p.set_id, tcgApiKey);
  }
  if (!card) return hint;
  // Remember the mapping the price sweep would eventually have written. The
  // next scan of this product then takes the indexed join above instead of a
  // set+number search — both are ~1 ms once cached, so this is tidiness rather
  // than a speed-up, but it is also the row the marketplace link and the price
  // sweep want and it costs one insert to have it.
  await db.run(
    `INSERT OR REPLACE INTO tcgplayer_product (card_id, product_id, category_id, confidence, matched_at)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`,
    [card.id, cand.productId, 3]
  ).catch(() => {});
  const use = await localizedPokemon(card, langName);
  return { ...hint, name: use.name, set: use.set_id, number: use.number, card: use };
}

function resolveCandidates(candidates, ctx) {
  return Promise.all(candidates.map((cand, i) => resolveCandidate(cand, i, ctx)));
}

// Which artwork a named candidate is, as far as card_cache can say: Scryfall's
// oracle id when there is one (every printing of the card), else the game and the
// normalized name. Reprints that share their art embed to near-identical vectors,
// so between two of them the cosine score is noise. Null when nothing names it.
function artworkKey(cand, game) {
  const card = cand.card || null;
  if (card && card.illustration_id) return `ill:${card.illustration_id}`;
  if (card && card.oracle_id) return `oracle:${card.oracle_id}`;
  const name = card ? (card.name || card.printed_name) : cand.name;
  return name ? `${game}:${normName(name)}` : null;
}

// Break ties between reprints with the same art (PROV-10).
//
// The scanner ranks by cosine alone, and printings that share an illustration
// score within noise of each other, so which one came first was close to random:
// exact-printing accuracy sat near 76% while the right CARD was found far more
// often. When the top candidate is a confident identification (STRONG_SIM) and
// others of the same artwork sit within STRONG_MARGIN of it, those are re-ordered
// by what is likely to be in the user's hand:
//
//   1. a printing the user already owns,
//   2. then one in the language being scanned,
//   3. then the newest set,
//
// and the original score order after that. Candidates of other artwork keep their
// places after the group. `ambiguousPrinting` says the printing, not the card, is
// what is uncertain, so the client can offer the alternatives instead of filing
// the first. Scores are left as they were.
async function breakPrintingTies(candidates, { game, langName, userId, strongSim = 0.55, strongMargin = 0.04 } = {}) {
  const list = candidates || [];
  const top = list[0];
  if (!top || !(top.score >= strongSim)) return { candidates: list, ambiguousPrinting: false };
  const key = artworkKey(top, game);
  if (!key) return { candidates: list, ambiguousPrinting: false };
  const group = list.filter(c => c.score >= top.score - strongMargin && artworkKey(c, game) === key);
  if (group.length < 2) return { candidates: list, ambiguousPrinting: false };

  const ids = group.map(c => (c.card && c.card.id) || c.cardId).filter(Boolean);
  const owned = new Set();
  const released = new Map();
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    if (userId) {
      for (const r of await db.all(
        `SELECT DISTINCT card_id FROM collection WHERE user_id = ? AND card_id IN (${marks})`, [userId, ...ids]
      )) owned.add(r.card_id);
    }
    const setIds = [...new Set(group.flatMap(c => {
      const sid = String((c.card && c.card.set_id) || c.set || '').toLowerCase();
      return sid ? [sid, `${game}-${sid}`] : [];
    }))];
    if (setIds.length) {
      for (const r of await db.all(
        `SELECT LOWER(id) AS id, release_date FROM sets WHERE LOWER(id) IN (${setIds.map(() => '?').join(',')})`, setIds
      )) released.set(r.id, String(r.release_date || '').replace(/-/g, '/'));
    }
  }
  const wantLang = languages.toName(langName);
  const facts = (c) => {
    const id = (c.card && c.card.id) || c.cardId;
    const sid = String((c.card && c.card.set_id) || c.set || '').toLowerCase();
    return {
      owned: owned.has(id) ? 1 : 0,
      lang: c.card && languages.toName(c.card.language) === wantLang ? 1 : 0,
      date: released.get(sid) || released.get(`${game}-${sid}`) || '',
    };
  };
  const order = new Map(list.map((c, i) => [c, i]));
  const ranked = group.map(c => ({ c, f: facts(c) })).sort((a, b) =>
    (b.f.owned - a.f.owned)
    || (b.f.lang - a.f.lang)
    || (b.f.date.localeCompare(a.f.date))
    || (order.get(a.c) - order.get(b.c))
  ).map(x => x.c);
  const inGroup = new Set(group);
  return { candidates: [...ranked, ...list.filter(c => !inGroup.has(c))], ambiguousPrinting: true };
}

// The ready-made Pokémon catalog identified something and NONE of it could be
// named. That is a install-state problem, not a bad photo, and it has to say so.
//
// Its ids are TCGplayer product ids, which reach a card only through
// tcgplayer_product -> card_cache. Both tables are filled by work this install
// may never have done: card_cache by a set walk, tcgplayer_product as a side
// effect of the Pokémon price sweep over already-cached sets. On a fresh install
// both are empty, every candidate came back bare, the client dropped all eight
// (resolveCandidates needs a set+number or a name) and the user was told "no
// confident match" — while the panel had just promised scanning would work.
//
// MTG has no such gap: its published ids ARE Scryfall ids, so getCardById above
// fetches and caches a printing this install has never seen.
// `!c.set` matters: with the product map built, a bare candidate still carries
// a set and a number for the client to resolve, and that is a working scan.
// This fires only when nothing could be said about the product at all.
function isUnresolvedPublished(game, candidates) {
  return game === 'pokemon'
    && candidates.length > 0
    && candidates.every(c => !c.card && !c.set && c.productId != null);
}

module.exports = {
  toEmbedding,
  sameNumber,
  localizedPokemon,
  pokemonBySetNumber,
  resolveCandidate,
  resolveCandidates,
  isUnresolvedPublished,
  breakPrintingTies,
};
