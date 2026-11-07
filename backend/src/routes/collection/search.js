// Finding cards: the provider search, a slab's cert lookup, and a card's
// printing in another language. Registered on the collection router (see
// routes/collection.js), which mounts at /api — every path is spelled in full.
const db = require('../../db');
const tcgdexApi = require('../../tcgdexApi');
const cvScan = require('../../cvScan');
const languages = require('../../utils/languages');
const psaApi = require('../../psaApi');
const cardApi = require('../../utils/cardApi');
const scryfallSyntax = require('../../utils/scryfallSyntax');
const games = require('../../utils/games');
const { searchLimiter } = require('../../middleware/auth');
const { toEmbedding } = require('../../scanCandidates');
const { attachOwnedQty } = require('./shared');

// 1. Search cards (proxies to Pokémon TCG, Scryfall, Lorcast or TCGdex + database cache).
// `game` and the PROVIDER route the request; all return the same card shape.
// Pokémon's provider choice by language lives in utils/pokemonProvider, which
// cardApi.apiForGame consults; see scanCandidates.pokemonApiFor for why.

// Normalize search inputs so combined queries (e.g. "Kangaskhan 5/64", "5/64",
// "Kangaskhan #5", "FDN 540") decompose cleanly into name, number, and set.
function normalizeSearchParams({ name = '', number = '', set = '', q = '' }) {
  let cleanName = String(name || '').trim();
  let cleanNumber = String(number || '').trim();
  let cleanSet = String(set || '').trim();
  const rawQuery = String(q || '').trim();

  const input = (!cleanName && !cleanNumber && !cleanSet && rawQuery) ? rawQuery : cleanName;

  if (input && !cleanNumber) {
    const pureFrac = input.match(/^#?([A-Z0-9★\-]+)\s*\/\s*[A-Z0-9★\-]+$/i);
    if (pureFrac) {
      cleanNumber = pureFrac[1];
      if (input === cleanName) cleanName = '';
    } else if (/^#?\d+$/i.test(input) || /^#[A-Z0-9★\-]+$/i.test(input)) {
      cleanNumber = input.replace(/^#/, '');
      if (input === cleanName) cleanName = '';
    } else {
      const fracMatch = input.match(/^(.+?)\s+#?([A-Z0-9★\-]+)\s*\/\s*[A-Z0-9★\-]+$/i);
      if (fracMatch) {
        cleanName = fracMatch[1].trim();
        cleanNumber = fracMatch[2].trim();
      } else {
        const hashMatch = input.match(/^(.+?)\s+#([A-Z0-9★\-]+)$/i);
        if (hashMatch) {
          cleanName = hashMatch[1].trim();
          cleanNumber = hashMatch[2].trim();
        } else {
          const numMatch = input.match(/^(.+?)\s+(\d+[A-Z★]?)$/i);
          if (numMatch) {
            cleanName = numMatch[1].trim();
            cleanNumber = numMatch[2].trim();
          }
        }
      }
    }
  }

  if (cleanNumber) {
    cleanNumber = cleanNumber.replace(/^#/, '').split('/')[0].trim();
  }

  return { name: cleanName, number: cleanNumber, set: cleanSet };
}

// Search filters a provider can apply itself. Only Riftbound's does today
// (domain, card type, rarity, supertype); the others ignore the option.
const pickFilters = (query) => {
  const out = {};
  for (const key of ['domain', 'type', 'rarity', 'supertype']) {
    const v = query[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 40);
  }
  return out;
};

async function searchCards(req, res) {
  const query = req.method === 'POST' ? { ...req.query, ...req.body } : req.query;
  const { name: rawName, number: rawNumber, set: rawSet, scope = 'database', game = 'pokemon', lang, prints, q, image, cropped, embedding } = query;
  const { name, number, set } = normalizeSearchParams({ name: rawName, number: rawNumber, set: rawSet, q });
  // 1-based page over `limit`-sized pages. 250 is the pokemontcg.io ceiling and
  // a sane cap on how much one Scryfall search will page through per request.
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(query.limit, 10) || 60));
  // An unknown game used to fall through to a Pokémon search.
  if (!games.isGame(game)) return res.status(400).json({ error: 'Invalid game' });
  try {
    // Every provider takes the same options object and ignores what does not
    // apply to it, so there is one call here rather than a branch per provider.
    const api = await cardApi.apiForGame(game, lang);
    // Magic takes Scryfall syntax in the name box (t:creature c:g cmc<=3). It is
    // searched intact, so the name/number splitting above is for plain names only;
    // the number and set fields still apply.
    const syntax = game === 'mtg' ? await scryfallSyntax.forSearch(rawName || q, { prints, image }) : null;
    const fields = syntax ? { ...normalizeSearchParams({ number: rawNumber, set: rawSet }), syntax } : { name, number, set };
    let { cards, total } = await api.searchCards({
      ...fields, scope, userId: req.user.id, lang,
      apiKey: req.user.tcg_api_key, allPrints: prints === '1', page, limit,
      filters: pickFilters(query),
    });

    // When an image from a camera scan is attached, score each candidate card
    // against the scan's visual embedding and sort by similarity descending.
    // Or with the embedding itself, when the client ran milo on the photo (see
    // scan-match below).
    const scanEmbedding = toEmbedding(embedding);
    if (scanEmbedding && Array.isArray(cards) && cards.length > 0) {
      const langName = languages.toName(lang);
      if (cvScan.isBuilt(game, langName)) {
        cards = await cvScan.scoreCards(null, game, cards, { lang: langName, embedding: scanEmbedding });
      }
    } else if (image && Array.isArray(cards) && cards.length > 0) {
      const base64 = typeof image === 'string' ? image.replace(/^data:image\/\w+;base64,/, '') : '';
      if (base64) {
        const buf = Buffer.from(base64, 'base64');
        const langName = languages.toName(lang);
        if (cvScan.isBuilt(game, langName)) {
          cards = await cvScan.scoreCards(buf, game, cards, { lang: langName, cropped: !!cropped });
        }
      }
    }

    await attachOwnedQty(cards, req.user.id);
    // Header, not the body: every existing caller expects a bare array here.
    if (total != null) {
      res.set('X-Total-Count', String(total));
      res.set('Access-Control-Expose-Headers', 'X-Total-Count');
    }
    res.json(cards);
  } catch (error) {
    // A query that cannot be read (or that Scryfall refused) is the user's to
    // fix: say what is wrong with it rather than "Search failed".
    const syntaxProblem = scryfallSyntax.errorBody(error);
    if (syntaxProblem) return res.status(400).json(syntaxProblem);
    console.error(error);
    if (error.message === 'INVALID_API_KEY') {
      return res.status(403).json({ error: 'Invalid API Key' });
    }
    if (error.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Rate limit exceeded', code: 'rate_limited' });
    }
    if (['POKEMONTCGAPI_KEY_REQUIRED', 'POKEMONTCGAPI_KEY_INVALID'].includes(error.message)) {
      return res.status(503).json({ error: 'The administrator needs to configure a valid POKEMONTCGAPI_KEY on the server.' });
    }
    if (error.message === 'UPSTREAM_UNAVAILABLE') {
      return res.status(503).json({ error: 'Card API is having trouble. Try again in a moment.', code: 'provider_unavailable' });
    }
    res.status(500).json({ error: 'Search failed' });
  }
}

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
async function lookupCert(req, res) {
  try {
    const cert = await psaApi.lookupCert(req.params.certNumber, req.user.psa_api_token || '');
    // Which game to search is read off PSA's own brand/category text. Unknown means
    // unknown — PSA grades sports cards and tickets too, and guessing 'pokemon' for
    // a 1986 Fleer basketball card would return nonsense candidates rather than an
    // honest empty list.
    const game = games.gameOfPsaBrand(`${cert.brand || ''} ${cert.category || ''}`);
    let candidates = [];
    if (game) {
      const name = psaApi.searchableName(cert.subject);
      if (name) {
        // Number included when PSA gave one: it is the single strongest
        // discriminator between printings of the same name, and the search treats
        // it as optional so a label without one still returns something.
        const number = cert.card_number || '';
        const api = await cardApi.apiForGame(game, null);
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
}

// 2b. Localize card to a specific language printing
async function cardPrinting(req, res) {
  try {
    const cardId = req.params.id;
    const targetLang = req.query.lang;
    const game = req.query.game;
    if (!targetLang) {
      return res.status(400).json({ error: 'lang query parameter is required' });
    }

    let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
    if (!card) {
      card = await cardApi.getCardById(cardId, { game, tcgApiKey: req.user?.tcg_api_key });
    }
    if (!card) {
      return res.status(404).json({ error: `Card ID ${cardId} not found.` });
    }

    const localized = await cardApi.printingInLanguage(card, targetLang);
    if (localized) {
      const learned = await tcgdexApi.learnEnglishName(localized);
      return res.status(200).json(learned || localized);
    }

    // Fallback: if no distinct localized printing exists, return the card with the target language tag
    res.status(200).json({ ...card, language: languages.toName(targetLang) });
  } catch (error) {
    console.error('Error fetching card localized printing:', error);
    res.status(500).json({ error: 'Failed to fetch card printing' });
  }
}

function register(router) {
  router.all('/search', searchLimiter, searchCards);
  router.get('/collection/cert/:certNumber', searchLimiter, lookupCert);
  router.get('/cards/:id/printing', cardPrinting);
}

module.exports = { register, normalizeSearchParams };
