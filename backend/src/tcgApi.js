const axios = require('axios');
const db = require('./db');
const { parseCardRow, recordPrice, shouldSweepPrices, markPricesSwept } = require('./utils/priceHelpers');
const { parseSetList } = require('./utils/setQuery');
const cardSearchSql = require('./utils/cardSearchSql');
const { cacheNormalizedCards } = require('./utils/cardCache');

const API_BASE_URL = 'https://api.pokemontcg.io/v2';
const API_KEY = process.env.POKEMON_TCG_API_KEY || ''; // Optional user key

// Axios instance with rate limit handling headers if key is available
const tcgClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 6000,
  headers: API_KEY ? { 'X-Api-Key': API_KEY } : {}
});

// api.pokemontcg.io answers 5xx (and occasionally stalls past the timeout) often
// enough that a single failed GET made searches look broken most of the time —
// the same name searched again usually works. Retry transient failures in the
// client so every call site (search, by-id, by-set, set index) gets it. 429 and
// 401/403 are real answers, not transients: pass them through untouched so the
// existing RATE_LIMIT_EXCEEDED / INVALID_API_KEY handling still fires.
const TCG_MAX_RETRIES = 2;
function isTransient(error) {
  if (error.response) return error.response.status >= 500;
  return error.code !== 'ERR_CANCELED'; // timeout / socket error / DNS
}
tcgClient.interceptors.response.use(null, async (error) => {
  const cfg = error.config;
  if (!cfg || !isTransient(error) || (cfg.__tcgRetries || 0) >= TCG_MAX_RETRIES) throw error;
  cfg.__tcgRetries = (cfg.__tcgRetries || 0) + 1;
  await new Promise(r => setTimeout(r, 400 * cfg.__tcgRetries));
  return tcgClient.request(cfg);
});

// Helper: Extract a single representative price from card data
function extractPrice(card) {
  if (card.tcgplayer && card.tcgplayer.prices) {
    const pricesObj = card.tcgplayer.prices;
    // Check normal, then holofoil, then reverseHolofoil, then others
    const types = ['normal', 'holofoil', 'reverseHolofoil', '1stEditionNormal', '1stEditionHolofoil'];
    for (const t of types) {
      if (pricesObj[t] && pricesObj[t].market) {
        return pricesObj[t].market;
      }
      if (pricesObj[t] && pricesObj[t].mid) {
        return pricesObj[t].mid;
      }
    }
  }
  
  if (card.cardmarket && card.cardmarket.prices) {
    return card.cardmarket.prices.trendPrice || card.cardmarket.prices.averageSellPrice || 0;
  }
  
  return 0;
}

function extractDetailedPrices(card) {
  let normal = null;
  let holofoil = null;
  let reverseHolofoil = null;

  if (card.tcgplayer && card.tcgplayer.prices) {
    const prices = card.tcgplayer.prices;
    if (prices.normal && (prices.normal.market || prices.normal.mid)) {
      normal = prices.normal.market || prices.normal.mid;
    }
    if (prices['1stEditionNormal'] && !normal) {
      normal = prices['1stEditionNormal'].market || prices['1stEditionNormal'].mid;
    }

    if (prices.holofoil && (prices.holofoil.market || prices.holofoil.mid)) {
      holofoil = prices.holofoil.market || prices.holofoil.mid;
    }
    if (prices['1stEditionHolofoil'] && !holofoil) {
      holofoil = prices['1stEditionHolofoil'].market || prices['1stEditionHolofoil'].mid;
    }

    if (prices.reverseHolofoil && (prices.reverseHolofoil.market || prices.reverseHolofoil.mid)) {
      reverseHolofoil = prices.reverseHolofoil.market || prices.reverseHolofoil.mid;
    }
  }

  // Cardmarket's avg1/avg7/avg30 are real rolling averages it computes from
  // actual sales — the only genuine historical price data available anywhere
  // in this API (no source here goes back further than 30 days). avg1 (its
  // own "now") is kept so trend comparisons stay within Cardmarket instead of
  // mixing in price_trend, which is usually sourced from TCGPlayer — a
  // different marketplace with a structurally different price.
  let avg1 = null;
  let avg7 = null;
  let avg30 = null;
  if (card.cardmarket && card.cardmarket.prices) {
    const cm = card.cardmarket.prices;
    if (cm.avg1 > 0) avg1 = cm.avg1;
    if (cm.avg7 > 0) avg7 = cm.avg7;
    if (cm.avg30 > 0) avg30 = cm.avg30;
  }

  return { normal, holofoil, reverseHolofoil, avg1, avg7, avg30 };
}

// Raw pokemontcg.io card -> the shape the app (and the MTG path) speaks.
function formatCard(c) {
  const detailed = extractDetailedPrices(c);
  return {
    id: c.id,
    name: c.name,
    supertype: c.supertype,
    subtypes: c.subtypes || [],
    types: c.types || [],
    rarity: c.rarity,
    set_id: c.set ? c.set.id : '',
    set_name: c.set ? c.set.name : '',
    number: c.number,
    image_url: c.images ? (c.images.small || c.images.large) : '',
    price_trend: extractPrice(c),
    price_normal: detailed.normal,
    price_holofoil: detailed.holofoil,
    price_reverse_holofoil: detailed.reverseHolofoil,
    price_avg1: detailed.avg1,
    price_avg7: detailed.avg7,
    price_avg30: detailed.avg30,
    // pokemontcg.io ships the marketplace links the prices came from.
    tcgplayer_url: c.tcgplayer ? c.tcgplayer.url || null : null,
    cardmarket_url: c.cardmarket ? c.cardmarket.url || null : null,
    // extractPrice reads tcgplayer.prices first and falls back to Cardmarket's
    // trendPrice, so the currency follows whichever answered.
    price_source: 'pokemontcg',
    price_currency: (c.tcgplayer && c.tcgplayer.prices) ? 'USD' : 'EUR'
  };
}

// Fetch and cache all sets. Pass force=true to re-fetch even when the table is
// already populated — used by the weekly refresh so newly released sets show up
// without a restart (INSERT OR REPLACE below upserts, so this is idempotent).
async function fetchAndCacheSets(force = false) {
  try {
    const existingSets = await db.get(`SELECT COUNT(*) as count FROM sets WHERE game = 'pokemon' OR game IS NULL`);
    if (!force && existingSets && existingSets.count > 0) {
      console.log(`Pokemon sets already populated (${existingSets.count} sets). Skipping fetch.`);
      return;
    }

    console.log('Fetching sets from Pokemon TCG API...');
    let sets = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const response = await tcgClient.get(`/sets`, { params: { page, pageSize: 250 } });
      const data = response.data.data;
      if (data && data.length > 0) {
        sets = sets.concat(data);
        page++;
      } else {
        hasMore = false;
      }
    }
    
    console.log(`Fetched ${sets.length} Pokemon sets. Saving to database...`);
    
    for (const s of sets) {
      await db.run(
        `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pokemon')`,
        [
          s.id,
          s.name,
          s.series || '',
          s.printedTotal || 0,
          s.total || 0,
          s.releaseDate || '',
          s.ptcgoCode || '',
          s.images ? s.images.symbol : '',
          s.images ? s.images.logo : ''
        ]
      );
    }
    console.log(`Cached ${sets.length} Pokemon sets.`);
    // Same prune as the TCGdex path: switching back must not leave TCGdex ids
    // beside pokemontcg.io ones in every set picker.
    await require('./utils/setCatalogue').pruneStaleSets(sets.map(s => s.id), 'pokemontcg.io');
  } catch (error) {
    const detail = error.response
      ? `HTTP ${error.response.status}${error.response.data ? ': ' + JSON.stringify(error.response.data).slice(0, 200) : ''}`
      : error.message;
    console.error('Error fetching Pokemon sets:', detail);
  }
}

// Save a list of RAW pokemontcg.io cards to the SQLite cache. formatCard already
// produces exactly the shape card_cache stores, so this just normalizes and hands
// off to the shared writer — the column list lives in utils/cardCache.js.
// Everything here is English by definition: pokemontcg.io has no other language
// (see utils/languages.js), which is what tcgdexApi.js exists for.
const cacheCards = (cards) => cacheNormalizedCards((cards || []).map(formatCard), 'pokemon');

// Helper: Levenshtein distance similarity (0.0 to 1.0)
function getLevenshteinDistance(a, b) {
  const tmp = [];
  let i, j, val;
  for (i = 0; i <= a.length; i++) {
    tmp.push([i]);
  }
  for (j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      val = a[i - 1] === b[j - 1] ? 0 : 1;
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1, // deletion
        tmp[i][j - 1] + 1, // insertion
        tmp[i - 1][j - 1] + val // substitution
      );
    }
  }
  return tmp[a.length][b.length];
}

function getStringSimilarity(str1, str2) {
  const s1 = (str1 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = (str2 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s1 && !s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  const distance = getLevenshteinDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  return 1.0 - distance / maxLength;
}

// Search cards locally first, then hit API if not found or empty
// Public entry point. Returns { cards, total } — `total` is how many matches
// exist upstream in all (null when the answer came from cache, which has no
// such count). Wrapping keeps the many early returns in the body unchanged.
// One options object, identical across tcgApi / tcgdexApi / scryfallApi, so the
// route can call whichever provider it resolved without knowing which one it got.
// Each provider reads the options that apply to it and ignores the rest: only
// pokemontcg.io takes an apiKey, only TCGdex needs the language it is searching in,
// only Scryfall has allPrints. As three positional signatures these had already
// drifted into different argument ORDERS for the same values, which the caller was
// papering over with a ternary picking one call shape or the other.
async function searchCards({
  name = '', number = '', set = '', scope = 'database', userId = null,
  apiKey = '', page = 1, limit = 60,
} = {}) {
  const meta = { total: null };
  const cards = await runSearch(meta, name, number, set, apiKey, scope, userId, page, limit);
  return { cards, total: meta.total };
}

// `page` is 1-based over `limit`-sized pages; the caller keeps asking for the
// next page while a full page comes back.
async function runSearch(meta, nameQuery = '', numberQuery = '', setQuery = '', apiKey = '', scope = 'database', userId = null, page = 1, limit = 60) {
  const offset = (page - 1) * limit;
  // Sanitize the name query: drop pure-noise tokens (junk with no letters)
  // and normalize everything else to Title Case, so typed-lowercase input like
  // "pikachu" is treated the same as "Pikachu" instead of being silently dropped.
  let cleanName = '';
  if (nameQuery) {
    const ALLOWED_UPPER = new Set(['EX', 'GX', 'V', 'VMAX', 'VSTAR', 'BREAK', 'PROMO', 'V-UNION']);
    const words = nameQuery.split(/\s+/);
    const normalized = words.map(w => {
      const cleanWord = w.replace(/[^\p{L}\d\-]/gu, ''); // keep letters (including unicode/japanese), numbers, and hyphens
      if (!cleanWord) return '';

      const upper = cleanWord.toUpperCase();
      if (ALLOWED_UPPER.has(upper)) return upper;

      // Normalize to Title Case per hyphen segment (e.g. "mr-mime" -> "Mr-Mime")
      return cleanWord.split('-').map(seg =>
        seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase()
      ).join('-');
    }).filter(Boolean);
    cleanName = normalized.join(' ');
  }

  // Leading zeros are preserved here; utils/cardSearchSql matches the stripped
  // form as well, so "004" and "4" find each other. Fractional totals (5/64) and hash prefixes are stripped.
  const cleanNumber = numberQuery ? numberQuery.trim().replace(/^#/, '').split('/')[0].trim() : '';
  // Set field may list several sets ("ltr, ltc") — match any of them.
  const setList = parseSetList(setQuery);

  // 1. Collection-only search. Every language the user owns — see the note in
  // utils/cardSearchSql on why collection scope does not filter by language.
  if (scope === 'collection') {
    if (!userId) return [];
    const { sql, params } = cardSearchSql.collectionQuery('pokemon', {
      userId, name: cleanName, number: cleanNumber, setList, limit, offset,
    });
    return (await db.all(sql, params)).map(parseCardRow);
  }

  // 2. Try local search first (if not forcing internet)
  // Kept as a closure because an internet-scope search skips it here but still
  // needs it as a fallback when the upstream API is unreachable.
  const queryLocal = async () => {
    // English only: non-English Pokémon rows share this table (they come from
    // TCGdex, since pokemontcg.io has no other language) and must not surface in
    // an English search just because they are cached next to each other.
    const { sql, params } = cardSearchSql.localCacheQuery('pokemon', {
      language: 'English', name: cleanName, number: cleanNumber, setList, limit, offset,
    });
    return db.all(sql, params);
  };

  let localResults = [];
  if (scope !== 'internet') {
    localResults = await queryLocal();

    // If we found local results and they are not empty, return them instantly.
    // Stale prices (older than 3 days) are updated asynchronously in the background.
    if (localResults.length > 0) {
      const cacheAgeLimit = 1000 * 60 * 60 * 24 * 3; // 3 days
      const staleCards = localResults.filter(r => (new Date() - new Date(r.last_updated) > cacheAgeLimit));
      const hasKey = apiKey || process.env.POKEMON_TCG_API_KEY;
      if (staleCards.length > 0 && hasKey) {
        (async () => {
          try {
            for (const card of staleCards) {
              await getCardById(card.id, hasKey);
              await new Promise(r => setTimeout(r, 1000)); // Respect rate limits
            }
          } catch (e) {
            console.error('Background price refresh failed:', e.message);
          }
        })();
      }

      return localResults.map(parseCardRow);
    }
  }

  // 2. Fetch from external API
  let upstreamFailed = false;
  const fetchCardsFromAPI = async (queryStr, orderBy = 'releaseDate') => {
    try {
      const response = await tcgClient.get('/cards', {
        params: {
          q: queryStr || undefined,
          page,
          pageSize: limit,
          orderBy
        },
        headers: apiKey ? { 'X-Api-Key': apiKey } : {}
      });
      if (response.data.totalCount != null) meta.total = response.data.totalCount;
      return response.data.data || [];
    } catch (err) {
      if (err.response) {
        if (err.response.status === 429) {
          throw new Error('RATE_LIMIT_EXCEEDED');
        }
        if (err.response.status === 401 || err.response.status === 403) {
          throw new Error('INVALID_API_KEY');
        }
      }
      // Retries are already exhausted here, so the upstream is genuinely down for
      // this request. Remember it: returning [] alone is indistinguishable from
      // "no such card", which is what made this look like a silent empty search.
      upstreamFailed = true;
      const status = err.response ? ` (HTTP ${err.response.status})` : '';
      console.error(`API query failed for q='${queryStr}'${status}:`, err.message);
      return [];
    }
  };

  try {
    let cards = [];

    // 1. Name-first query: fetch by name tokens to make API requests extremely fast and simple.
    // We format multiple words as top-level OR (e.g. name:"BASICude" OR name:"Numel") to avoid Lucene query syntax errors.
    const words = cleanName ? cleanName.split(/\s+/).filter(w => w.length > 2) : [];
    if (words.length > 0) {
      let queryStr = words.map(w => `name:"${w}"`).join(' OR ');
      if (setList.length) {
        const setClause = setList.map(s => `set.name:"${s}" OR set.id:"${s}"`).join(' OR ');
        queryStr = `(${queryStr}) AND (${setClause})`;
      }
      
      console.log(`Querying Pokémon TCG API (Name-first): q='${queryStr}'`);
      cards = await fetchCardsFromAPI(queryStr);
    }

    // 1b. Set browse: no usable name, just "show me this set". Without this a
    // set-only search fell through every branch and came back empty.
    let browsedWithNumber = false;
    if (cards.length === 0 && words.length === 0 && setList.length) {
      const setClause = setList.map(s => `set.name:"${s}" OR set.id:"${s}"`).join(' OR ');
      const queryStr = `(${setClause})` + (cleanNumber ? ` AND number:"${cleanNumber}"` : '');
      console.log(`Querying Pokémon TCG API (Set browse): q='${queryStr}'`);
      cards = await fetchCardsFromAPI(queryStr, 'number');
      browsedWithNumber = !!cleanNumber;
    }

    // 2. Number+set fallback: only when name was garbled but we have a set.
    // Pure number-only search returns every set's card with that number (~50 junk
    // results), so skip it — a number without a set almost never finds the right card.
    //
    // Skipped outright when the set browse above already asked set+number: the two
    // queries differ only in clause order, so re-asking is a second round trip to a
    // provider that answers 5xx often enough to have its own retry policy. It only
    // ever fired when the first query found nothing, which on the scan path — every
    // candidate arrives as set+number with no name — is exactly the candidates that
    // cannot resolve at all (promos, jumbo cards, groups with no provider set). So
    // this does not speed up a successful scan; it stops the failing ones costing
    // twice as much as the ones that work.
    const isNumNoise = !cleanNumber || cleanNumber === '0' || cleanNumber === '00' || cleanNumber === '000';
    if (cards.length === 0 && !browsedWithNumber && cleanNumber && !isNumNoise && setList.length) {
      const setClause = setList.map(s => `set.name:"${s}" OR set.id:"${s}"`).join(' OR ');
      const queryStr = `number:"${cleanNumber}" AND (${setClause})`;
      console.log(`No name results. Querying TCG API (Number+set): q='${queryStr}'`);
      cards = await fetchCardsFromAPI(queryStr);
    }
    
    // Nothing found AND the upstream errored. Serve whatever the cache already
    // knows before giving up: a card cached from an earlier search is still a
    // correct answer, and failing a search for a card we already hold is the
    // worst outcome. An internet-scope search skipped the local query above, so
    // run it now. Only a genuinely empty cache reports the outage — the user sees
    // "try again" rather than a wrong "no such card".
    // Checked after both queries so the number+set fallback still gets its turn.
    if (cards.length === 0 && upstreamFailed) {
      const cached = scope === 'internet' ? await queryLocal() : localResults;
      if (cached.length > 0) {
        console.warn(`Upstream unavailable — serving ${cached.length} cached match(es) for '${cleanName || cleanNumber}'.`);
        return cached.map(parseCardRow);
      }
      throw new Error('UPSTREAM_UNAVAILABLE');
    }

    // Save to cache in background
    if (cards.length > 0) {
      await cacheCards(cards);
    }

    // A set browse has nothing to rank against — keep the API's set/number order
    // rather than scoring every card against an empty name.
    if (!cleanName && !cleanNumber) {
      return cards.map(formatCard);
    }

    // Fuzzy rank cards by similarity to name and number in memory
    const scoredCards = cards.map(c => {
      const nameSim = getStringSimilarity(c.name, cleanName);
      const numberSim = getStringSimilarity(c.number, cleanNumber);
      
      // Add exact/numeric value match bonus for numbers (handles '017' vs '17')
      const cleanNumInt = parseInt(cleanNumber, 10);
      const cardNumInt = parseInt(c.number, 10);
      const numberMatchBonus = (!isNaN(cleanNumInt) && !isNaN(cardNumInt) && cleanNumInt === cardNumInt) ? 0.15 : 0.0;
      
      const score = nameSim * 0.85 + numberSim * 0.15 + numberMatchBonus;
      return { card: c, score };
    });
    scoredCards.sort((a, b) => b.score - a.score);

    // Apply Confidence Filter:
    // If we have a single very high confidence match and others are low,
    // narrow results down so the scanner auto-adds/selects it instantly.
    let finalCards = scoredCards.map(sc => sc.card);
    if (scoredCards.length > 1 && scoredCards[0].score >= 0.7 && (scoredCards[0].score - scoredCards[1].score) >= 0.3) {
      console.log(`High confidence match: ${scoredCards[0].card.name} (score: ${scoredCards[0].score.toFixed(2)} vs next: ${scoredCards[1].score.toFixed(2)})`);
      finalCards = [scoredCards[0].card];
    }

    // Return the fetched cards formatted
    return finalCards.map(formatCard);
  } catch (error) {
    if (error.message === 'INVALID_API_KEY' || error.message === 'RATE_LIMIT_EXCEEDED' || error.message === 'UPSTREAM_UNAVAILABLE') {
      throw error;
    }
    console.error('Error fetching cards from Pokémon TCG API:', error.message);
    // Return whatever local matches we have if API fails
    return localResults.map(parseCardRow);
  }
}

// Fetch single card by ID (with caching)
async function getCardById(id, apiKey = '') {
  const cached = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [id]);

  // MTG cards live under the "mtg-" prefix and are served by Scryfall, and
  // non-English Pokémon cards under "tcgdex-" — neither exists on pokemontcg.io,
  // so querying it for them would just 404. Return whatever is cached (Scryfall
  // refreshes MTG prices on search; tcgdexApi refreshes its own).
  if (id && (id.startsWith('mtg-') || id.startsWith('tcgdex-'))) {
    return cached ? parseCardRow(cached) : null;
  }

  // If cached and fresh (e.g. within 3 days), return it
  const cacheAgeLimit = 1000 * 60 * 60 * 24 * 3; // 3 days
  if (cached && (new Date() - new Date(cached.last_updated) < cacheAgeLimit)) {
    return parseCardRow(cached);
  }

  try {
    console.log(`Querying Pokémon TCG API for card ID: ${id}`);
    const response = await tcgClient.get(`/cards/${id}`, {
      headers: apiKey ? { 'X-Api-Key': apiKey } : {}
    });
    const card = response.data.data;
    
    if (card) {
      await cacheCards([card]);
      const detailed = extractDetailedPrices(card);
      return {
        id: card.id,
        name: card.name,
        supertype: card.supertype,
        subtypes: card.subtypes || [],
        types: card.types || [],
        rarity: card.rarity,
        set_id: card.set ? card.set.id : '',
        set_name: card.set ? card.set.name : '',
        number: card.number,
        image_url: card.images ? (card.images.small || card.images.large) : '',
        price_trend: extractPrice(card),
        price_normal: detailed.normal,
        price_holofoil: detailed.holofoil,
        price_reverse_holofoil: detailed.reverseHolofoil,
        price_avg1: detailed.avg1,
        price_avg7: detailed.avg7,
        price_avg30: detailed.avg30
      };
    }
  } catch (error) {
    if (error.response) {
      if (error.response.status === 429) {
        throw new Error('RATE_LIMIT_EXCEEDED');
      }
      if (error.response.status === 401 || error.response.status === 403) {
        throw new Error('INVALID_API_KEY');
      }
    }
    console.error(`Error fetching card ${id} from API:`, error.message);
  }

  // Fallback to cached if available
  if (cached) {
    return parseCardRow(cached);
  }
  return null;
}

// Fetch every card in a set (dev seed helper). Caches them like any other
// lookup and returns them formatted the same way getCardById does, so callers
// get a large, varied pool (all types/rarities/trainers/energies in the set)
// from one API request instead of N per-ID fetches.
async function getCardsBySet(setId, apiKey = '') {
  try {
    console.log(`Querying Pokémon TCG API for full set: ${setId}`);
    const response = await tcgClient.get('/cards', {
      params: { q: `set.id:${setId}`, pageSize: 250, orderBy: 'number' },
      headers: apiKey ? { 'X-Api-Key': apiKey } : {},
      timeout: 30000 // full-set payloads are large; the 6s default isn't enough
    });
    const cards = response.data.data || [];
    if (cards.length > 0) await cacheCards(cards);
    return cards.map(card => {
      const detailed = extractDetailedPrices(card);
      return {
        id: card.id,
        name: card.name,
        supertype: card.supertype,
        subtypes: card.subtypes || [],
        types: card.types || [],
        rarity: card.rarity,
        set_id: card.set ? card.set.id : '',
        set_name: card.set ? card.set.name : '',
        number: card.number,
        image_url: card.images ? (card.images.small || card.images.large) : '',
        price_trend: extractPrice(card),
        price_normal: detailed.normal,
        price_holofoil: detailed.holofoil,
        price_reverse_holofoil: detailed.reverseHolofoil,
        price_avg1: detailed.avg1,
        price_avg7: detailed.avg7,
        price_avg30: detailed.avg30
      };
    });
  } catch (error) {
    if (error.response && error.response.status === 429) throw new Error('RATE_LIMIT_EXCEEDED');
    if (error.response && (error.response.status === 401 || error.response.status === 403)) throw new Error('INVALID_API_KEY');
    console.error(`Error fetching set ${setId} from API:`, error.message);
    return [];
  }
}

// Periodic function to update pricing for all cards in the collection
// `force` bypasses the once-a-day gate (used by the scheduled daily run, which
// is already on the right cadence by construction).
async function updateCollectionPrices(force = false) {
  if (!process.env.POKEMON_TCG_API_KEY) {
    console.log('Skipping background price update: No global POKEMON_TCG_API_KEY configured to protect rate limits.');
    return;
  }
  if (!force && !(await shouldSweepPrices('pokemon'))) {
    console.log('Skipping Pokémon price update: already swept within the last 24h.');
    return;
  }

  try {
    // Select unique Pokémon card IDs from both collections (owned and wishlist)
    // and decks. MTG cards are excluded — they refresh via Scryfall on search,
    // and hitting the Pokémon API for an "mtg-" id would just 404.
    // English only — non-English Pokémon rows come from TCGdex and are swept by
    // tcgdexApi.updateCollectionPrices, so asking pokemontcg.io about them would
    // burn a second of rate limit per card to get a 404.
    const cardsInUse = await db.all(`
      SELECT DISTINCT c.card_id FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id WHERE cc.game = 'pokemon' AND cc.language = 'English'
      UNION
      SELECT DISTINCT d.card_id FROM deck_cards d
      JOIN card_cache cc ON d.card_id = cc.id WHERE cc.game = 'pokemon' AND cc.language = 'English'
    `);
    
    console.log(`Starting background price update for ${cardsInUse.length} unique cards...`);
    for (const item of cardsInUse) {
      try {
        // Fetching will force update the cache and price
        const updatedCard = await getCardById(item.card_id, process.env.POKEMON_TCG_API_KEY);
        // Record the new price, but only if it actually moved.
        if (updatedCard) await recordPrice(item.card_id, updatedCard.price_trend);
      } catch (itemErr) {
        console.error(`Failed to update price for card ${item.card_id}:`, itemErr.message);
      }
      // Wait 1 second between requests to respect API rate limits
      await new Promise(r => setTimeout(r, 1000));
    }
    await markPricesSwept('pokemon');
    console.log('Background price update complete.');
  } catch (err) {
    console.error('Error during background price update:', err);
  }
}

module.exports = {
  searchCards,
  getCardById,
  getCardsBySet,
  updateCollectionPrices,
  fetchAndCacheSets,
  cacheCards,
  tcgClient // exported so test/tcgretry.test.js can point it at a local server
};
