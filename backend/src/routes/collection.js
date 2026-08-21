const express = require('express');
const db = require('../db');
const tcgApi = require('../tcgApi');
const tcgdexApi = require('../tcgdexApi');
const scryfallApi = require('../scryfallApi');
const lorcastApi = require('../lorcastApi');
const cvScan = require('../cvScan');
const tcgplayerCatalog = require('../tcgplayerCatalog');
const languages = require('../utils/languages');
const pokemonProvider = require('../utils/pokemonProvider');
const psaApi = require('../psaApi');
const gradedPrices = require('../gradedPrices');
const cardApi = require('../utils/cardApi');
const { searchLimiter } = require('../middleware/auth');
const { resolveCardPrice, parseCardRow, recordPrice } = require('../utils/priceHelpers');
const { parseSetList } = require('../utils/setQuery');
const { compartmentLabel, isBinderType, rebalanceCompartmentByScheme, stackKey, STACK_KEY_SQL } = require('../utils/compartmentSort');
const { checkedOutAllocation, resolveCompartmentAndPosition, describePlacement, setStackQuantity } = require('../utils/collectionHelpers');
const { validateDeckAddition } = require('../utils/deckRules');
const { splitPrice } = require('../utils/splitPrice');

const router = express.Router();

// Stamp each result with how many copies the user already owns, so browsing a
// set shows what is already in the binder instead of inviting duplicate adds.
// A collection-scope search already reports owned_qty from its own join.
async function attachOwnedQty(cards, userId) {
  if (!Array.isArray(cards) || cards.length === 0 || !userId) return;
  const ids = cards.map(c => c.id).filter(Boolean);
  if (ids.length === 0) return;
  const rows = await db.all(
    `SELECT card_id, SUM(quantity) AS qty FROM collection
     WHERE user_id = ? AND list_type = 'collection' AND card_id IN (${ids.map(() => '?').join(',')})
     GROUP BY card_id`,
    [userId, ...ids]
  );
  const owned = new Map(rows.map(r => [r.card_id, r.qty]));
  for (const c of cards) c.owned_qty = owned.get(c.id) || 0;
}

// 1. Search cards (proxies to Pokémon TCG, Scryfall, Lorcast or TCGdex + database cache).
// `game` and the PROVIDER route the request; all return the same card shape.
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
  return (await pokemonProvider.usesTcgdex(lang)) ? tcgdexApi : tcgApi;
}

// Collector numbers as both providers can agree on. TCGdex zero-pads ('013')
// where pokemontcg.io and TCGplayer do not ('13'), and letters have to survive
// ('TG12', 'SWSH284') or every promo in a set collides into one key.
const sameNumber = (a, b) => {
  const norm = (n) => String(n == null ? '' : n).trim().toLowerCase().replace(/^0+(?=\d)/, '');
  return !!norm(a) && norm(a) === norm(b);
};
router.get('/search', searchLimiter, async (req, res) => {
  const { name, number, set, scope = 'database', game = 'pokemon', lang, prints } = req.query;
  // 1-based page over `limit`-sized pages. 250 is the pokemontcg.io ceiling and
  // a sane cap on how much one Scryfall search will page through per request.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(req.query.limit, 10) || 60));
  try {
    // Every provider takes the same options object and ignores what does not
    // apply to it, so there is one call here rather than a branch per provider.
    const api = game === 'mtg' ? scryfallApi : (game === 'lorcana' ? lorcastApi : await pokemonApiFor(lang));
    const { cards, total } = await api.searchCards({
      name, number, set, scope, userId: req.user.id, lang,
      apiKey: req.user.tcg_api_key, allPrints: prints === '1', page, limit,
    });
    await attachOwnedQty(cards, req.user.id);
    // Header, not the body: every existing caller expects a bare array here.
    if (total != null) {
      res.set('X-Total-Count', String(total));
      res.set('Access-Control-Expose-Headers', 'X-Total-Count');
    }
    res.json(cards);
  } catch (error) {
    console.error(error);
    if (error.message === 'INVALID_API_KEY') {
      return res.status(403).json({ error: 'Invalid API Key' });
    }
    if (error.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    if (error.message === 'UPSTREAM_UNAVAILABLE') {
      return res.status(503).json({ error: 'Card API is having trouble. Try again in a moment.' });
    }
    res.status(500).json({ error: 'Search failed' });
  }
});

// 1a2. Identify a graded slab from the cert number printed on its label.
//
// Returns the cert AND a list of candidate cards — it does not pick one. PSA
// labels a card as 'CHARIZARD-HOLO' with year 1999 and brand 'POKEMON GAME',
// which names a card without identifying a printing: that name+number exists in
// Base Set, Base Set 2 and a dozen reprints, and PSA's label does not distinguish
// them. Auto-picking would file the wrong printing silently and confidently, so
// the user picks and the client then adds through POST /collection as usual with
// grader/grade/cert_number filled in.
//
// GET, and cheap on a repeat: psaApi caches every cert permanently, so re-checking
// a number costs no quota and works with no token configured.
// Path is spelled in full because this router mounts at /api, not at /api/collection
// — every route here carries its own complete path (see '/search' above).
router.get('/collection/cert/:certNumber', searchLimiter, async (req, res) => {
  try {
    const cert = await psaApi.lookupCert(req.params.certNumber, req.user.psa_api_token || '');
    // Which game to search is read off PSA's own brand/category text. Unknown means
    // unknown — PSA grades sports cards and tickets too, and guessing 'pokemon' for
    // a 1986 Fleer basketball card would return nonsense candidates rather than an
    // honest empty list.
    const brand = `${cert.brand || ''} ${cert.category || ''}`.toUpperCase();
    const game = /POKEMON/.test(brand) ? 'pokemon' : (/MAGIC|GATHERING/.test(brand) ? 'mtg' : (/LORCANA/.test(brand) ? 'lorcana' : null));
    let candidates = [];
    if (game) {
      const name = psaApi.searchableName(cert.subject);
      if (name) {
        // Number included when PSA gave one: it is the single strongest
        // discriminator between printings of the same name, and the search treats
        // it as optional so a label without one still returns something.
        const number = cert.card_number || '';
        const api = game === 'mtg' ? scryfallApi : (game === 'lorcana' ? lorcastApi : await pokemonApiFor(null));
        ({ cards: candidates } = await api.searchCards({
          name, number, userId: req.user.id, apiKey: req.user.tcg_api_key,
          allPrints: true, limit: 24,
        }));
        await attachOwnedQty(candidates, req.user.id);
      }
    }
    res.json({ cert, game, candidates });
  } catch (error) {
    // psaApi puts a caller-visible status on everything it throws; anything without
    // one is a genuine bug here rather than a bad cert number.
    const status = error.status || 500;
    if (status >= 500) console.error('cert lookup failed:', error.message);
    res.status(status).json({ error: status >= 500 ? 'Certification lookup failed' : error.message });
  }
});

// 1b. Identify a scanned card image by visual-feature match.
// Which sets the scanner can actually answer for, and how completely.
//
// Not admin-only: this is what the set filter needs to stop offering sets that
// match nothing. Read-only counts, no build controls.
router.get('/scan-sets', async (req, res) => {
  const { game = 'pokemon', lang } = req.query;
  if (game !== 'mtg' && game !== 'pokemon' && game !== 'lorcana') return res.status(400).json({ error: 'Invalid game' });
  try {
    // `builtLangs` rides along because the scanner's language picker has no other
    // way to know: it offered all eleven languages, and for ten of them a Pokémon
    // scan is answered by the English catalog and filed as an English printing.
    // Offering a choice without its consequence is what made that a surprise.
    res.json({
      ...await require('../catalog').setCounts(game, languages.toName(lang)),
      builtLangs: cvScan.builtLangs(game),
    });
  } catch (e) {
    console.error('scan-sets failed:', e.message);
    res.status(500).json({ error: 'Could not read catalog set counts' });
  }
});

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

router.post('/scan-match', searchLimiter, async (req, res) => {
  try {
    const { game = 'pokemon', image, set = '', lang, cropped = false } = req.body || {};
    if (game !== 'mtg' && game !== 'pokemon' && game !== 'lorcana') return res.status(400).json({ error: 'Invalid game' });
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Missing image' });
    const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 100) return res.status(400).json({ error: 'Invalid image data' });

    const langName = languages.toName(lang);

    // Set scoping is a FILTER over the catalog, not a different pipeline. The ORB
    // path needed a per-set index built before it could scope a scan (that was the
    // client's "preparing set" wait); a cosine sweep just skips rows that do not
    // belong. A scoped scan is the same scan over fewer candidates — cheaper and
    // more accurate, with nothing to build.
    //
    // Language is not a gate either. A card's artwork is the same in every
    // language, so the English catalog answers "which card is this" for a Spanish
    // or Japanese photo; when a catalog exists in the scanned language cvScan uses
    // it instead. Measured 100% right-card on Spanish/Japanese/French/Italian MTG
    // off the English catalog.
    if (!cvScan.isBuilt(game, langName)) {
      // There is no second matcher to fall back to. Say what is missing and what
      // fixes it, rather than an empty candidate list that reads to the user as
      // "your card could not be identified".
      return res.status(503).json({
        game, lang: langName, candidates: [], verified: false, notBuilt: true,
        error: 'No scan catalog is built for this game and language yet. An admin can build one from Admin → Catalogs.',
      });
    }

    const result = await cvScan.match(buf, game, 8, { sets: parseSetList(set), lang: langName, cropped: !!cropped });

    result.candidates = await Promise.all(result.candidates.map(async (cand, i) => {
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
        const row = await db.get(
          `SELECT * FROM card_cache WHERE id = ? AND image_url IS NOT NULL AND image_url != '' LIMIT 1`,
          [cand.cardId]
        );
        if (!row) return cand;
        const card = parseCardRow(row);
        // Same re-expression as MTG above. A catalog built in the scanned language
        // returns localised ids already, so this is a no-op then; it matters when
        // the match fell back to the English catalog (no catalog in that language,
        // or a card the localised one does not cover).
        const use = await localizedPokemon(card, langName);
        return { ...cand, name: use.name, set: use.set_id, number: use.number, card: use };
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
      let card = await pokemonBySetNumber(langName, p.number, p.set_id, req.user.tcg_api_key);
      if (!card && !languages.isEnglish(langName)) {
        card = await pokemonBySetNumber('English', p.number, p.set_id, req.user.tcg_api_key);
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
    }));

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
    const unresolvedPublished = game === 'pokemon'
      && result.candidates.length > 0
      && result.candidates.every(c => !c.card && !c.set && c.productId != null);
    if (unresolvedPublished) {
      const map = await tcgplayerCatalog.summary();
      console.log('scan-match: ready-made Pokemon catalog hit but no product id could be named'
        + ` — product map holds ${map.rows} rows${map.progress ? ' (building)' : ''}`);
      return res.json({
        ...result,
        unresolvedPublished: true,
        productMapRows: map.rows,
        error: map.progress
          ? 'The TCGplayer product map is still building — the ready-made Pokémon catalog cannot name'
            + ' its matches until it finishes.'
          : 'The ready-made Pokémon catalog recognises cards by TCGplayer product id, and this install'
            + ' has no product map to look them up in. An admin can build it in Admin → Scan catalogs.',
      });
    }

    return res.json(result);
  } catch (error) {
    console.error('scan-match failed:', error.message);
    res.status(500).json({ error: 'Scan match failed' });
  }
});

// 2. Get User's Collection
router.get('/collection', async (req, res) => {
  try {
    const listType = req.query.list_type || 'collection';
    const isTrade = req.query.is_trade;
    const compId = req.query.compartment_id;

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ?`;
    let filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }
    if (compId !== undefined) {
      filterSql += ` AND c.compartment_id = ?`;
      filterParams.push(compId);
    }

    const query = `
      SELECT
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.compartment_id,
        c.position,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        c.notes,
        c.grader,
        c.grade,
        c.cert_number,
        c.market_value,
        c.market_value_source,
        c.market_value_at,
        cc.name,
        -- The localized name for a non-English printing, so every view that
        -- renders a collection card can show it as the card actually reads.
        cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.cmc,
        cc.color_identity,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        cc.price_1st_edition,
        cc.price_currency,
        cc.price_source,
        cc.game,
        cc.tcgplayer_url,
        cc.cardmarket_url,
        cc.tcgplayer_product_id,
        l.id as location_id,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label,
        cp.capacity as compartment_capacity
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    const alloc = await checkedOutAllocation(req.user.id);

    const formatted = rows.map(row => ({
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
      checked_out_qty: alloc.get(row.entry_id) || 0,
      compartment_display_label: row.compartment_id
        ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type)
        : null,
      sub_location: row.compartment_id
        ? `${row.location_type === 'Binder' ? 'Page' : 'Row'} ${row.compartment_idx}`
        : ''
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
});

// Shared by the single add below and the bulk add after it, so one card and two
// hundred cards travel exactly the same path (cache lookup, compartment
// resolution, rebalance, price history). Throws AddCardError for caller-visible
// failures; anything else is a genuine 500.
class AddCardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Mirrors the collection.grader CHECK constraint in db.js. 'Raw' is the default
// and means an ungraded card, not a missing value.
const GRADERS = ['Raw', 'PSA', 'BGS', 'CGC', 'SGC', 'TAG'];

async function addCardToCollection(user, body) {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    printing = 'Normal',
    language = 'English',
    purchase_price = 0,
    location_id = null,
    list_type = 'collection',
    is_trade = 0,
    game = 'pokemon',
    stackable = false,
    grader = 'Raw',
    grade = null,
    cert_number = null
  } = body;
  const req = { user, body };

  if (!card_id) {
    throw new AddCardError(400, 'card_id is required');
  }

  // Grading, validated here rather than at the two call sites, so the single add
  // and the bulk add cannot disagree about what a slab is.
  if (!GRADERS.includes(grader)) {
    throw new AddCardError(400, `Invalid grader. One of: ${GRADERS.join(', ')}`);
  }
  const gradeNum = grade == null || grade === '' ? null : Number(grade);
  if (gradeNum != null && !(gradeNum > 0 && gradeNum <= 10)) {
    throw new AddCardError(400, 'grade must be between 0 and 10');
  }
  const cert = cert_number ? String(cert_number).trim() : null;
  // A raw card has no grade and no cert by definition. Silently keeping either
  // would leave a row that reads as raw in one column and graded in another, and
  // every downstream check would then depend on which column it happened to read.
  const isGraded = grader !== 'Raw';
  const certValue = isGraded ? cert : null;
  const gradeValue = isGraded ? gradeNum : null;

  // Checked before the insert purely for the message: the unique index in db.js is
  // what actually enforces this, and still catches a race between two requests.
  // Without the check the user gets 'Failed to add card' and no idea why.
  if (certValue) {
    const dup = await db.get(
      `SELECT c.id, cc.name FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.grader = ? AND c.cert_number = ?`,
      [user.id, grader, certValue]
    );
    if (dup) {
      throw new AddCardError(409, `${grader} cert ${certValue} is already in your collection as ${dup.name}.`);
    }
  }

  {
    // A card matched by a set-scoped scan was cached from a TCGdex set brief:
    // name, number and art only. Fill it in before it enters the collection, or it
    // is stored with no price, no marketplace link and a defaulted rarity — which
    // is what it then shows in the inspector forever.
    await cardApi.hydrate(card_id);

    let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      card = await cardApi.getCardById(card_id, { game, tcgApiKey: req.user.tcg_api_key });
      if (!card) {
        throw new AddCardError(404, `Card ID ${card_id} not found.`);
      }
    }

    // File the copy against the printing it actually IS. The card was picked in
    // whatever language the search ran in, but `language` is set separately — Quick
    // Add's dropdown, a scan the English catalog answered — so a Japanese copy
    // routinely arrived pointing at the English row, and then showed the English
    // name, art and price in every view. Null (never printed in that language, or a
    // pokemontcg.io id that cannot be localized) keeps the row that was picked.
    let cardId = card_id;
    const localized = await cardApi.printingInLanguage(card, language);
    if (localized) {
      card = localized;
      cardId = localized.id;
    }
    // A localized row can be short an English name (TCGdex publishes only one name
    // per language). Learn it here so the collection stays searchable in English
    // while displaying the name the card is actually printed with.
    card = await tcgdexApi.learnEnglishName(card);

    const effectiveGame = (req.body.game && req.body.game !== 'pokemon')
      ? req.body.game
      : (card.game || cardApi.gameOf(cardId));

    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        throw new AddCardError(400, 'Invalid location ID');
      }
    }

    const resolved = await resolveCompartmentAndPosition({
      locationId: location_id,
      userId: req.user.id,
      cardId,
      printing,
      language
    });

    const targetLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;

    let lastInsertedId = null;
    // A cert number names ONE physical slab, so a quantity above 1 is not a
    // request for more of them — it is a mistake that the per-user unique index on
    // (grader, cert_number) would reject on the second insert anyway, after the
    // first had already been written. Collapse it here so the request succeeds with
    // the row the user actually meant.
    const count = certValue ? 1 : Math.max(1, parseInt(quantity, 10) || 1);
    // Stacking is quantity-on-one-row, which is meaningful only for interchangeable
    // copies. Two slabs are never interchangeable: they have different certs, and
    // usually different grades.
    const stack = stackable && !isGraded;

    if (stack) {
      const result = await db.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, language, purchase_price,
          location_id, compartment_id, position, is_trade, list_type, game,
          grader, grade, cert_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        cardId, req.user.id, count, condition, printing, language, purchase_price || 0,
        targetLocationId, resolved.compartment_id, resolved.position, is_trade ? 1 : 0, list_type, effectiveGame,
        grader, gradeValue, certValue
      ]);
      lastInsertedId = result.lastID;
    } else {
      for (let i = 0; i < count; i++) {
        const result = await db.run(`
          INSERT INTO collection (
            card_id, user_id, quantity, condition, printing, language, purchase_price,
            location_id, compartment_id, position, is_trade, list_type, game,
            grader, grade, cert_number
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          cardId, req.user.id, condition, printing, language, purchase_price || 0,
          targetLocationId, resolved.compartment_id, resolved.position + (i * 0.001), is_trade ? 1 : 0, list_type, effectiveGame,
          grader, gradeValue, certValue
        ]);
        lastInsertedId = result.lastID;
      }
    }

    if (resolved.compartment_id && targetLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [targetLocationId, req.user.id]);
      if (loc) {
        await rebalanceCompartmentByScheme(db, resolved.compartment_id, loc.sort_order, loc.foil_sorting);
      }
    }

    await recordPrice(cardId, card.price_trend);

    return {
      message: 'Card added to collection',
      id: lastInsertedId,
      placement: resolved.compartment_id
        ? await describePlacement(db, lastInsertedId, req.user.id)
        : null,
      container_full: !!resolved.full,
      rule_rejected: !!resolved.rejected
    };
  }
}

// 3. Add Card to Collection
router.post('/collection', async (req, res) => {
  try {
    res.status(200).json(await addCardToCollection(req.user, req.body));
  } catch (error) {
    if (error instanceof AddCardError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// 3b. Bulk add: one shared condition/printing/quantity across many cards, so a
// set browse can be added in one action instead of one drawer per card.
const BULK_ADD_MAX = 250;
router.post('/collection/bulk-add', async (req, res) => {
  const { card_ids = [], ...shared } = req.body;
  if (!Array.isArray(card_ids) || card_ids.length === 0) {
    return res.status(400).json({ error: 'card_ids is required' });
  }
  if (card_ids.length > BULK_ADD_MAX) {
    return res.status(400).json({ error: `Cannot add more than ${BULK_ADD_MAX} cards at once.` });
  }
  // Every field in `shared` is applied to every card, which a cert number cannot
  // survive: it identifies one slab. Rejected rather than dropped, because silently
  // discarding it would add the cards ungraded and look like it worked.
  if (shared.cert_number) {
    return res.status(400).json({ error: 'A certification number applies to a single card. Add graded cards one at a time.' });
  }
  // Sequential on purpose: placement resolves against the rows already inserted,
  // so adds must not race each other for the same compartment slot.
  const added = [];
  const failed = [];
  for (const card_id of card_ids) {
    try {
      const result = await addCardToCollection(req.user, { ...shared, card_id });
      added.push({ card_id, id: result.id });
    } catch (error) {
      if (!(error instanceof AddCardError)) console.error(error);
      failed.push({ card_id, error: error instanceof AddCardError ? error.message : 'Failed to add card' });
    }
  }
  const qty = Math.max(1, parseInt(shared.quantity, 10) || 1);
  res.status(failed.length && !added.length ? 500 : 200).json({
    message: failed.length
      ? `Added ${added.length} of ${card_ids.length} cards; ${failed.length} failed.`
      : `Added ${added.length} card${added.length === 1 ? '' : 's'}${qty > 1 ? ` (x${qty} each)` : ''} to collection.`,
    added: added.length,
    failed
  });
});

// 4. Update Collection Entry
router.put('/collection/:id', async (req, res) => {
  const { id } = req.params;
  const {
    quantity, condition, printing, language, purchase_price,
    location_id, compartment_id, list_type, is_trade, favorite, game, notes,
    grader, grade, cert_number, market_value
  } = req.body;

  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });

    const isMoving = location_id !== undefined && location_id !== entry.location_id;
    let finalCompartmentId = entry.compartment_id;
    let finalLocationId = entry.location_id;
    let finalPosition = entry.position;
    let resolvedFull = false;
    let resolvedRejected = false;

    if (isMoving) {
      if (location_id === null || location_id === '') {
        finalLocationId = null;
        finalCompartmentId = null;
        finalPosition = 0;
      } else {
        const resolved = await resolveCompartmentAndPosition({
          locationId: location_id,
          userId: req.user.id,
          cardId: entry.card_id,
          printing: printing !== undefined ? printing : entry.printing,
          language: language !== undefined ? language : entry.language
        });
        finalCompartmentId = resolved.compartment_id;
        finalLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;
        finalPosition = resolved.position;
        resolvedFull = !!resolved.full;
        resolvedRejected = !!resolved.rejected;
      }
    } else if (compartment_id !== undefined) {
      finalCompartmentId = compartment_id;
    }

    const updates = [];
    const params = [];

    // Absolute, not additive: see the reconcile below. Deliberately NOT part of
    // the UPDATE — setStackQuantity owns the quantity column so the two can
    // never disagree about how many copies the row stands for.
    const requestedQty = quantity !== undefined ? Math.max(1, parseInt(quantity, 10) || 1) : null;
    if (condition !== undefined) { updates.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { updates.push('printing = ?'); params.push(printing); }
    if (language !== undefined) { updates.push('language = ?'); params.push(language); }
    if (purchase_price !== undefined) { updates.push('purchase_price = ?'); params.push(purchase_price); }
    if (isMoving || compartment_id !== undefined) {
      updates.push('location_id = ?', 'compartment_id = ?', 'position = ?');
      params.push(finalLocationId, finalCompartmentId, finalPosition);
    }
    if (list_type !== undefined) { updates.push('list_type = ?'); params.push(list_type); }
    if (is_trade !== undefined) { updates.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
    if (favorite !== undefined) { updates.push('favorite = ?'); params.push(favorite ? 1 : 0); }
    if (game !== undefined) { updates.push('game = ?'); params.push(game); }
    if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
    // Grading. The three columns move together on purpose: sending grader:'Raw'
    // must clear the grade and cert in the same statement, or the row keeps a grade
    // it no longer claims to have. Cracking a slab is a real thing people do.
    if (grader !== undefined) {
      if (!GRADERS.includes(grader)) return res.status(400).json({ error: `Invalid grader. One of: ${GRADERS.join(', ')}` });
      const raw = grader === 'Raw';
      const g = raw || grade == null || grade === '' ? null : Number(grade);
      if (g != null && !(g > 0 && g <= 10)) return res.status(400).json({ error: 'grade must be between 0 and 10' });
      const cert = raw || !cert_number ? null : String(cert_number).trim();
      if (cert) {
        const dup = await db.get(
          `SELECT id FROM collection WHERE user_id = ? AND grader = ? AND cert_number = ? AND id != ?`,
          [req.user.id, grader, cert, id]
        );
        if (dup) return res.status(409).json({ error: `${grader} cert ${cert} is already in your collection.` });
      }
      updates.push('grader = ?', 'grade = ?', 'cert_number = ?');
      params.push(grader, g, cert);
    }
    // What this copy is worth, typed by the owner. Empty string and null both mean
    // "drop it and go back to the provider price" — the field is a text input, and
    // clearing it has to be possible or a mistyped 10000 is permanent.
    if (market_value !== undefined) {
      if (market_value === null || market_value === '') {
        updates.push('market_value = ?', 'market_value_source = ?', 'market_value_at = ?');
        params.push(null, null, null);
      } else {
        const value = Number(market_value);
        if (!Number.isFinite(value) || value < 0) {
          return res.status(400).json({ error: 'market_value must be a number of 0 or more' });
        }
        updates.push('market_value = ?', 'market_value_source = ?', "market_value_at = CURRENT_TIMESTAMP");
        params.push(value, 'manual');
      }
    }

    if (updates.length > 0) {
      params.push(id, req.user.id);
      await db.run(`UPDATE collection SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
    }

    if (isMoving && finalCompartmentId && finalLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [finalLocationId, req.user.id]);
      if (loc) await rebalanceCompartmentByScheme(db, finalCompartmentId, loc.sort_order, loc.foil_sorting);
    }
    if (isMoving && entry.compartment_id && entry.compartment_id !== finalCompartmentId) {
      const oldLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [entry.location_id, req.user.id]);
      if (oldLoc) await rebalanceCompartmentByScheme(db, entry.compartment_id, oldLoc.sort_order, oldLoc.foil_sorting);
    }

    // Quantity is absolute — it is how many copies the user says they own, and
    // in the stacked collection view the number in the form is the total across
    // the identical rows, not this row alone. So reconcile the whole stack to
    // it, up or down. It used to only ever insert (quantity - 1) extra rows,
    // which made lowering the number a no-op and made every save duplicate the
    // entry instead of editing it.
    if (requestedQty !== null) {
      const changed = await setStackQuantity(db, req.user.id, id, requestedQty);
      if (changed !== 0) {
        const row = await db.get(`SELECT compartment_id, location_id FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (row && row.compartment_id && row.location_id) {
          const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [row.location_id, req.user.id]);
          if (loc) await rebalanceCompartmentByScheme(db, row.compartment_id, loc.sort_order, loc.foil_sorting);
        }
      }
    }

    const finalPlacement = isMoving && finalCompartmentId ? await describePlacement(db, id, req.user.id) : null;
    res.json({ message: 'Collection entry updated successfully', placement: finalPlacement, container_full: resolvedFull, rule_rejected: resolvedRejected });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// 4a. Fetch this copy's graded value from the price provider and store it.
//
// Deliberately one entry per request and never automatic: the free tier of the
// only provider that publishes slab prices is metered per day, and a sweep over a
// collection would spend a week's allowance in one boot. The button is the budget.
router.post('/collection/:id/market-value/fetch', searchLimiter, async (req, res) => {
  try {
    const entry = await db.get(`
      SELECT c.id, c.grade, c.grader, cc.name, cc.set_name, cc.number, cc.game, cc.tcgplayer_product_id
      FROM collection c JOIN card_cache cc ON cc.id = c.card_id
      WHERE c.id = ? AND c.user_id = ?`, [req.params.id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });
    if (!entry.grader || entry.grader === 'Raw') {
      return res.status(400).json({ error: 'This copy is not graded. Graded prices apply to slabs only.' });
    }

    const result = await gradedPrices.fetchGradedPrice({
      game: entry.game,
      name: entry.name,
      setName: entry.set_name,
      number: entry.number,
      grader: entry.grader,
      grade: entry.grade,
      // The exact-card lookup: one card returned instead of a page of them, which
      // is the difference between 2 credits and a hundred.
      tcgPlayerId: entry.tcgplayer_product_id,
      apiKey: req.user.graded_price_api_key,
    });

    await db.run(
      `UPDATE collection SET market_value = ?, market_value_source = ?, market_value_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [result.price, result.source, req.params.id, req.user.id]
    );
    res.json({ market_value: result.price, source: result.source, basis: result.basis });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('graded price fetch failed:', error.message);
    res.status(status).json({ error: error.message || 'Failed to fetch graded price' });
  }
});

// 4b. Manual tap-to-place (Custom order)
router.post('/collection/:id/place', async (req, res) => {
  const { id } = req.params;
  const { compartment_id, slot, swap_with } = req.body;
  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });

    const comp = await db.get(`
      SELECT c.id, c.capacity, l.id AS loc_id, l.type AS loc_type, l.sort_order, l.allow_stacking
      FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?`, [compartment_id, req.user.id]);
    if (!comp) return res.status(400).json({ error: 'Invalid compartment' });
    if (comp.sort_order !== 'custom') return res.status(400).json({ error: 'Manual placement is only available in Custom order' });

    const isBinder = isBinderType(comp.loc_type);

    if (swap_with) {
      const other = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [swap_with, req.user.id]);
      if (!other) return res.status(400).json({ error: 'Swap target not found' });
      // Stacking container: dropping a copy onto its own twin joins that pocket
      // rather than trading places with it — trading two identical cards is a
      // no-op the user can see no result from.
      if (comp.allow_stacking && stackKey(entry) === stackKey(other)) {
        await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [other.compartment_id, other.location_id, other.position, id, req.user.id]);
        const stackedPlacement = await describePlacement(db, id, req.user.id);
        return res.json({ message: 'Card stacked', placement: stackedPlacement });
      }
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [other.compartment_id, other.location_id, other.position, id, req.user.id]);
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [entry.compartment_id, entry.location_id, entry.position, swap_with, req.user.id]);
      const placement = await describePlacement(db, id, req.user.id);
      return res.json({ message: 'Cards swapped', placement });
    }

    if (!Number.isInteger(slot) || slot < 1) return res.status(400).json({ error: 'Invalid slot' });

    if (entry.compartment_id !== compartment_id) {
      // Slots used, not cards held, once copies are allowed to share a pocket.
      const cnt = await db.get(
        `SELECT ${comp.allow_stacking ? `COUNT(DISTINCT ${STACK_KEY_SQL})` : 'COUNT(*)'} AS n
         FROM collection WHERE compartment_id = ? AND user_id = ?`, [compartment_id, req.user.id]);
      if (cnt.n >= comp.capacity) return res.status(400).json({ error: 'COMPARTMENT_FULL' });
    }

    const sourceComp = entry.compartment_id;
    if (isBinder) {
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000, id, req.user.id]);
    } else {
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000 - 500, id, req.user.id]);
      await rebalanceCompartmentByScheme(db, compartment_id, req.user.id, { sort_order: 'custom' });
    }

    if (sourceComp && sourceComp !== compartment_id) {
      const src = await db.get(`SELECT l.type AS loc_type FROM compartments c JOIN locations l ON c.location_id = l.id WHERE c.id = ?`, [sourceComp]);
      if (src && !isBinderType(src.loc_type)) {
        await rebalanceCompartmentByScheme(db, sourceComp, req.user.id, { sort_order: 'custom' });
      }
    }

    const placement = await describePlacement(db, id, req.user.id);
    res.json({ message: 'Card placed', placement });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to place card' });
  }
});

// 5. Delete Card from Collection
router.delete('/collection/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }
    res.json({ message: 'Card removed from collection' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card' });
  }
});

// 5b. Bulk actions
const BULK_ACTIONS = ['delete', 'move', 'trade', 'untrade', 'list_type', 'condition', 'printing', 'purchase_split', 'add_to_deck'];
// Allowed field values mirror the collection table CHECK constraints in db.js.
const BULK_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const BULK_PRINTINGS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'];
router.post('/collection/bulk', async (req, res) => {
  const { entry_ids = [], action, value } = req.body;
  if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
    return res.status(400).json({ error: 'entry_ids is required' });
  }
  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const ids = entry_ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (ids.length === 0) return res.status(400).json({ error: 'No valid entry_ids' });
  const placeholders = ids.map(() => '?').join(',');

  try {
    if (action === 'add_to_deck') {
      const deckId = parseInt(value, 10);
      if (!deckId) return res.status(400).json({ error: 'Invalid deck_id' });
      const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [deckId, req.user.id]);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });

      const rows = await db.all(
        `SELECT card_id, SUM(quantity) as total_qty FROM collection WHERE id IN (${placeholders}) AND user_id = ? GROUP BY card_id`,
        [...ids, req.user.id]
      );

      let added = 0;
      const rejected = [];
      for (const row of rows) {
        const existing = await db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deckId, row.card_id]);
        const current = existing ? existing.quantity : 0;
        const newQty = current + row.total_qty;
        // Enforce deck rules (owned cap + max 4 per name) so this path can't
        // bypass the limits the deck builder enforces.
        const check = await validateDeckAddition({ deckId, userId: req.user.id, cardId: row.card_id, newQty });
        if (!check.ok) { rejected.push(check.error); continue; }
        await db.run(
          `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
          [deckId, row.card_id, newQty]
        );
        added += row.total_qty;
      }
      const msg = rejected.length
        ? (added ? `Added ${added} card(s). ${rejected[0]}` : rejected[0])
        : `Added ${added} card(s) to deck`;
      return res.json({ message: msg, affected: added, rejected: rejected.length });
    }

    if (action === 'delete') {
      const result = await db.run(`DELETE FROM collection WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, req.user.id]);
      return res.json({ message: `Deleted ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'trade' || action === 'untrade') {
      const result = await db.run(`UPDATE collection SET is_trade = ? WHERE id IN (${placeholders}) AND user_id = ?`, [action === 'trade' ? 1 : 0, ...ids, req.user.id]);
      return res.json({ message: `Updated ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'list_type') {
      if (!['collection', 'wishlist'].includes(value)) return res.status(400).json({ error: 'Invalid list_type' });
      const result = await db.run(`UPDATE collection SET list_type = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Moved ${result.changes} card(s) to ${value}`, affected: result.changes });
    }

    if (action === 'condition' || action === 'printing') {
      const allowed = action === 'condition' ? BULK_CONDITIONS : BULK_PRINTINGS;
      if (!allowed.includes(value)) return res.status(400).json({ error: `Invalid ${action}` });
      // Column name is action, drawn from the BULK_ACTIONS whitelist (not user
      // input), so it is safe to interpolate.
      const result = await db.run(`UPDATE collection SET ${action} = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Set ${action} on ${result.changes} card(s)`, affected: result.changes });
    }

    // Distribute a total price paid (a pack/deck) across the selected entries,
    // writing each entry's per-card purchase_price. method 'weighted' splits
    // proportional to market value (price_trend); 'equal' splits evenly. Weighted
    // falls back to equal when no selected card has a market price.
    if (action === 'purchase_split') {
      const total = parseFloat(value && value.total);
      const method = value && value.method === 'equal' ? 'equal' : 'weighted';
      if (!(total >= 0)) return res.status(400).json({ error: 'total must be a non-negative number' });
      const rows = await db.all(
        `SELECT c.id, COALESCE(cc.price_trend, 0) AS price FROM collection c
         LEFT JOIN card_cache cc ON cc.id = c.card_id
         WHERE c.id IN (${placeholders}) AND c.user_id = ?`,
        [...ids, req.user.id]
      );
      if (rows.length === 0) return res.status(400).json({ error: 'No valid entries' });
      const sum = rows.reduce((s, r) => s + (r.price || 0), 0);
      const weighted = method === 'weighted' && sum > 0;
      const shares = splitPrice(rows.map(r => r.price || 0), total, method);
      for (let i = 0; i < rows.length; i++) {
        await db.run(`UPDATE collection SET purchase_price = ? WHERE id = ? AND user_id = ?`, [shares[i], rows[i].id, req.user.id]);
      }
      return res.json({ message: `Split $${total.toFixed(2)} across ${rows.length} card(s) (${weighted ? 'by value' : 'evenly'})`, affected: rows.length });
    }

    const locationId = value ? parseInt(value, 10) : null;
    if (locationId) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
      if (!loc) return res.status(400).json({ error: 'Invalid location ID' });
    }
    let moved = 0;
    const touched = new Map();
    for (const id of ids) {
      const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) continue;
      if (!locationId) {
        await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        moved++;
        continue;
      }
      const resolved = await resolveCompartmentAndPosition({
        locationId, userId: req.user.id, cardId: entry.card_id, printing: entry.printing, language: entry.language
      });
      const finalLoc = resolved.compartment_id ? (resolved.location_id ?? locationId) : null;
      await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [finalLoc, resolved.compartment_id, resolved.position, id, req.user.id]);
      if (resolved.compartment_id) touched.set(resolved.compartment_id, finalLoc);
      moved++;
    }
    for (const [compId, locId] of touched) {
      const rbLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [locId, req.user.id]);
      if (rbLoc) await rebalanceCompartmentByScheme(db, compId, rbLoc.sort_order, rbLoc.foil_sorting);
    }
    return res.json({ message: `Moved ${moved} card(s)`, affected: moved });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

module.exports = router;
