const axios = require('axios');
const db = require('./db');
const { parseCardRow, recordPrice, shouldSweepPrices, markPricesSwept } = require('./utils/priceHelpers');
const { parseSetList } = require('./utils/setQuery');
const cardSearchSql = require('./utils/cardSearchSql');
const languages = require('./utils/languages');
const { cacheNormalizedCards } = require('./utils/cardCache');

// Scryfall needs no API key but asks callers to identify themselves and accept
// JSON. See https://scryfall.com/docs/api. IDs from Scryfall are UUIDs / set-num
// slugs; we prefix them with "mtg-" so they never collide with Pokémon TCG ids
// in the shared card_cache table and the game is derivable from the id.
const client = axios.create({
  baseURL: 'https://api.scryfall.com',
  timeout: 6000,
  headers: { 'User-Agent': 'Bindarr/1.0', 'Accept': 'application/json' }
});

// Search, per-set fetches and the background price sweep all hit Scryfall and
// can run concurrently, so every request goes through one serialized queue —
// a global limiter beats per-caller delays that can't see each other.
//
// Scryfall publishes HARD, PER-ENDPOINT limits, and the card endpoints this app
// leans on are the strict ones — not the 10/second that applies to everything
// else. From https://scryfall.com/docs/api/rate-limits:
//   /cards/search, /cards/named, /cards/random, /cards/collection — 2/second
//   /cards/manifest — 10/minute
//   all other methods — 10/second
// A single 120ms gap was ~4x over the limit on exactly the endpoints search and
// the price sweep use, which is what earned the 429s.
// SCRYFALL_GAP_SCALE exists so the e2e suite, which stubs the HTTP layer
// entirely, isn't paced against a real API it never contacts. Never set it
// below 1 against api.scryfall.com — exceeding these limits risks a ban.
const GAP_SCALE = Number.isFinite(Number(process.env.SCRYFALL_GAP_SCALE))
  ? Number(process.env.SCRYFALL_GAP_SCALE)
  : 1;
const ENDPOINT_GAPS = [
  [/^\/cards\/(search|named|random|collection)\b/, 500 * GAP_SCALE],
  [/^\/cards\/manifest\b/, 10000 * GAP_SCALE],
];
const SCRYFALL_MIN_GAP_MS = 100 * GAP_SCALE; // floor for "all other methods" (10/second)
// A 429 says "everything you are sending is too much", so backing off only the
// request that got it is useless — the queue behind it keeps firing at full rate
// and keeps the penalty alive. `cooldownUntil` pauses EVERY request until the
// window Scryfall asked for has passed. Default 60s: that is what its 429 body
// asks for when no Retry-After header is sent.
const SCRYFALL_DEFAULT_COOLDOWN_MS = 60000;
let scryfallQueue = Promise.resolve();
let lastScryfallAt = 0;
let cooldownUntil = 0;
// Per-endpoint clocks. The limits are per endpoint, so a search and a /sets call
// don't have to wait on each other beyond the global 10/second floor.
const lastByEndpoint = new Map();

// Which bucket a URL falls in. Callers pass both relative ('/cards/search?...')
// and absolute (Scryfall's own next_page links) URLs, so read just the path.
function endpointGap(url) {
  let path = String(url || '');
  if (/^https?:\/\//i.test(path)) {
    try { path = new URL(path).pathname; } catch { /* fall through to raw */ }
  }
  path = path.split('?')[0];
  for (const [pattern, gap] of ENDPOINT_GAPS) {
    if (pattern.test(path)) return { key: pattern.source, gap };
  }
  return { key: 'default', gap: SCRYFALL_MIN_GAP_MS };
}

// How long this request must wait: its own endpoint's gap, the global floor,
// and any active 429 cooldown — whichever is longest.
function waitFor(url) {
  const now = Date.now();
  const { key, gap } = endpointGap(url);
  return {
    key,
    ms: Math.max(
      cooldownUntil - now,
      gap - (now - (lastByEndpoint.get(key) || 0)),
      SCRYFALL_MIN_GAP_MS - (now - lastScryfallAt),
      0
    )
  };
}

function noteRateLimit(error) {
  if (!error.response || error.response.status !== 429) return false;
  const ra = parseInt(error.response.headers?.['retry-after'], 10);
  const waitMs = Number.isFinite(ra) ? ra * 1000 : SCRYFALL_DEFAULT_COOLDOWN_MS;
  const until = Date.now() + waitMs;
  if (until > cooldownUntil) {
    cooldownUntil = until;
    console.warn(`Scryfall rate-limited us — pausing all Scryfall traffic for ${Math.round(waitMs / 1000)}s.`);
  }
  return true;
}

function scryGet(url, config) {
  const run = scryfallQueue.then(async () => {
    // Re-check after waiting: a 429 may have armed the cooldown while queued.
    for (let w = waitFor(url); w.ms > 0; w = waitFor(url)) {
      await new Promise(r => setTimeout(r, w.ms));
    }
    const { key } = endpointGap(url);
    lastScryfallAt = Date.now();
    lastByEndpoint.set(key, lastScryfallAt);
    try {
      return await client.get(url, config);
    } catch (error) {
      noteRateLimit(error);
      throw error;
    }
  });
  // Keep the chain alive regardless of this request's outcome.
  scryfallQueue = run.then(() => {}, () => {});
  return run;
}

// Scryfall's bulk lookup takes at most 75 identifiers per request.
const COLLECTION_BATCH = 75;

// POST twin of scryGet: same one global queue, same gap, same 429 cooldown, so
// bulk lookups can never race ahead of (or pile on top of) search traffic.
function scryPost(url, body, config) {
  const run = scryfallQueue.then(async () => {
    for (let w = waitFor(url); w.ms > 0; w = waitFor(url)) {
      await new Promise(r => setTimeout(r, w.ms));
    }
    const { key } = endpointGap(url);
    lastScryfallAt = Date.now();
    lastByEndpoint.set(key, lastScryfallAt);
    try {
      return await client.post(url, body, config);
    } catch (error) {
      noteRateLimit(error);
      throw error;
    }
  });
  scryfallQueue = run.then(() => {}, () => {});
  return run;
}

async function scryPostRetried(url, body, config, retries = 4) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await scryPost(url, body, config);
    } catch (error) {
      lastError = error;
      if (error.response && error.response.status === 429 && i < retries - 1) continue;
      throw error;
    }
  }
  throw lastError;
}

// Queue + 429 retry, returning the raw axios response (callers that need
// has_more/next_page/total_cards can't use fetchFromScryfall, which strips to
// .data.data). The wait itself is handled by the shared cooldown above, so a
// retry here just re-queues behind it.
async function scryGetRetried(url, config, retries = 4) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await scryGet(url, config);
    } catch (error) {
      lastError = error;
      if (error.response && error.response.status === 429 && i < retries - 1) continue;
      throw error;
    }
  }
  throw lastError;
}

const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const CACHE_AGE_LIMIT_MS = 1000 * 60 * 60 * 24 * 3; // 3 days

// Scryfall has NO `lang` query parameter. Language is a search keyword, and
// non-English printings stay hidden unless include_multilingual is set —
// verified: `q=!"Lightning Bolt" unique:prints&lang=ja` returns 64 English
// prints, while `q=!"Lightning Bolt" lang:ja unique:prints` with
// include_multilingual=true returns the 18 Japanese ones. Passing lang as a
// parameter (what this file did before) is silently ignored, so every "foreign"
// search quietly came back in English.
// English adds nothing to the query: that is already Scryfall's default, and
// staying on the exact old query string keeps the English path byte-identical.
function langSearch(q, lang) {
  const code = languages.resolve(lang).scryfall;
  if (code === 'en') return { q, params: '' };
  return { q: `${q} lang:${code}`, params: '&include_multilingual=true' };
}

// Maps a raw Scryfall card onto the card_cache shape the rest of the app (and
// the Pokémon path) already speaks. Double-faced cards carry their art/type on
// card_faces[0] instead of the top level, so fall back to the front face.
function normalizeCard(raw, lang) {
  const face = (!raw.image_uris && Array.isArray(raw.card_faces) && raw.card_faces.length)
    ? raw.card_faces[0]
    : raw;
  // The response's own `lang` is authoritative — a printing only exists in one
  // language, and trusting the requested one mislabels the English fallbacks
  // Scryfall returns when a card was never printed in the language asked for.
  const language = languages.toName(raw.lang || lang);
  const imgSrc = raw.image_uris || face.image_uris || {};
  const typeLine = raw.type_line || face.type_line || '';
  const colors = raw.colors || face.colors || [];
  // USD first, then EUR — and never a mix of the two in one row.
  //
  // Scryfall quotes `usd` from TCGplayer and `eur` from Cardmarket, and which one it
  // has depends on where the printing is actually sold. TCGplayer lists English
  // Magic almost completely (96,090 of 103,656 English rows here carry a usd price)
  // and non-English barely at all, which is why reading usd alone left whole
  // languages at $0.00: Spanish 241 of 1,205 priced, Italian 53 of 194, Simplified
  // Chinese 11 of 61. Those are European and Asian printings sold on Cardmarket,
  // where a eur price usually does exist.
  //
  // The currency is recorded per row (price_currency) rather than converted, because
  // an exchange rate is a live number this app has no source for, and a stale
  // hardcoded one silently misprices a collection. Falling back per row also keeps
  // every column in a row in ONE currency — a normal price in USD next to a foil
  // price in EUR would make the pair meaningless.
  const prices = raw.prices || {};
  const money = (v) => (v != null ? parseFloat(v) : null);
  const eurOnly = money(prices.usd) == null && money(prices.usd_foil) == null
    && (money(prices.eur) != null || money(prices.eur_foil) != null);
  const currency = eurOnly ? 'EUR' : 'USD';
  const usd = eurOnly ? money(prices.eur) : money(prices.usd);
  const usdFoil = eurOnly ? money(prices.eur_foil) : money(prices.usd_foil);
  const cmc = raw.cmc != null ? parseFloat(raw.cmc) : null;
  const colorIdentity = raw.color_identity || face.color_identity || [];

  return {
    id: `mtg-${raw.id}`,
    name: face.name || raw.name || '',
    // The card game itself lives in the dedicated `game` column; `supertype`
    // just tags these as Magic cards for UI that keys off it.
    supertype: 'MTG',
    subtypes: typeLine.split(/[^A-Za-z]+/).filter(Boolean),
    types: colors.map(c => COLOR_NAMES[c] || c),
    rarity: raw.rarity ? raw.rarity.charAt(0).toUpperCase() + raw.rarity.slice(1) : 'Common',
    set_id: raw.set || '',
    set_name: raw.set_name || '',
    number: raw.collector_number || '',
    image_url: imgSrc.normal || imgSrc.large || imgSrc.small || '',
    price_trend: usd != null ? usd : (usdFoil != null ? usdFoil : 0),
    price_normal: usd,
    price_holofoil: usdFoil,
    price_reverse_holofoil: null,
    price_avg1: null,
    price_avg7: null,
    price_avg30: null,
    cmc: cmc,
    color_identity: colorIdentity.map(c => COLOR_NAMES[c] || c),
    game: 'mtg',
    // Which printing this row IS. The quick-add form defaults the copy's language
    // to it, so adding a Japanese card no longer files it as English.
    language,
    // The name as actually printed on a non-English card ("稲妻"). `name` above
    // stays English on purpose: it is what deck lists, marketplace links and the
    // next Scryfall lookup need. Null for English printings, which have none.
    printed_name: raw.printed_name || face.printed_name || null,
    // Scryfall's own marketplace links for THIS printing. Worth storing rather
    // than rebuilding: they search the English name, which is what TCGplayer and
    // Cardmarket actually index, so they resolve for a Japanese printing too.
    tcgplayer_url: raw.purchase_uris?.tcgplayer || null,
    cardmarket_url: raw.purchase_uris?.cardmarket || null,
    // The TCGplayer product id, which `purchase_uris.tcgplayer` only sometimes
    // contains: when Scryfall has no product for a printing it wraps a name
    // SEARCH in the same affiliate link, indistinguishable from the outside
    // without parsing the URL. The id says so plainly — a card either has one or
    // is not listed on TCGplayer.
    //
    // `tcgplayer_etched_id` is the fallback because an etched-only printing (some
    // Commander foils) carries no plain id, and etched is still the right product
    // to link at: it is the one TCGplayer actually sells for that printing.
    tcgplayer_product_id: raw.tcgplayer_id ?? raw.tcgplayer_etched_id ?? null,
    // Scryfall's `prices.usd` is TCGplayer's number and `prices.eur` Cardmarket's,
    // so the currency names the marketplace too (see the fallback above).
    price_source: 'scryfall',
    price_currency: currency
  };
}

const cacheCards = (cards) => cacheNormalizedCards(cards, 'mtg');


// Look up many known cards in as few requests as possible. Rows are matched by
// Scryfall id when we hold one, else set_id + number, else name. Returns
// normalized cards plus, for each, the row it came from, so callers can write
// back against their own ids without trusting the response to preserve order.
//
// The id form matters for more than precision: /cards/collection identifiers
// have no language field, so a {set, collector_number} lookup always answers
// with the ENGLISH printing. Every row here came from card_cache, whose id IS
// that printing's own Scryfall id — including for a Japanese card — so asking by
// id is the only way a non-English row gets its own prices refreshed instead of
// silently re-fetching the English one.
const scryfallUuid = (id) => {
  const raw = String(id || '').replace(/^mtg-/, '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
};

async function bulkFetchByIdentifier(rows) {
  const cards = [];
  const pairs = [];
  let notFound = 0;

  for (let i = 0; i < rows.length; i += COLLECTION_BATCH) {
    const chunk = rows.slice(i, i + COLLECTION_BATCH);
    const byKey = new Map();
    const identifiers = chunk.map(row => {
      const uuid = scryfallUuid(row.id || row.card_id);
      if (uuid) {
        byKey.set(`id:${uuid.toLowerCase()}`, row);
        return { id: uuid };
      }
      const setId = row.set_id != null ? String(row.set_id).toLowerCase() : '';
      const num = row.number != null ? String(row.number) : '';
      if (setId && num) {
        byKey.set(`sn:${setId}|${num.toLowerCase()}`, row);
        return { set: setId, collector_number: num };
      }
      byKey.set(`n:${String(row.name || '').toLowerCase()}`, row);
      return { name: row.name || '' };
    });

    const resp = await scryPostRetried('/cards/collection', { identifiers });
    notFound += ((resp.data && resp.data.not_found) || []).length;
    for (const raw of (resp.data && resp.data.data) || []) {
      const norm = normalizeCard(raw);
      cards.push(norm);
      const row = byKey.get(`id:${String(raw.id).toLowerCase()}`)
        || byKey.get(`sn:${String(norm.set_id).toLowerCase()}|${String(norm.number).toLowerCase()}`)
        || byKey.get(`n:${String(norm.name).toLowerCase()}`);
      if (row) pairs.push({ row, card: norm });
    }
  }
  return { cards, pairs, notFound };
}

async function fetchFromScryfall(q, lang, retries = 3) {
  const scoped = langSearch(q, lang);
  const url = `/cards/search?q=${encodeURIComponent(scoped.q)}${scoped.params}`;

  for (let i = 0; i < retries; i++) {
    try {
      const resp = await scryGet(url);
      return (resp.data && resp.data.data) || [];
    } catch (error) {
      // The shared cooldown already holds the whole queue for as long as
      // Scryfall asked, so a retry here just re-queues behind it.
      if (error.response && error.response.status === 429 && i < retries - 1) continue;
      throw error;
    }
  }
}

// Scryfall pages are a fixed 175 cards. Pull the caller's [offset, offset+limit)
// window out of them so search can page by its own limit instead of being capped
// at one Scryfall page. Returns the raw cards plus whether more exist after them.
const SCRY_PAGE_SIZE = 175;
async function fetchWindow(q, lang, offset, limit, order) {
  let page = Math.floor(offset / SCRY_PAGE_SIZE) + 1;
  let skip = offset % SCRY_PAGE_SIZE;
  const out = [];
  let hasMore = false;
  let total = null;
  const scoped = langSearch(q, lang);
  while (out.length < limit) {
    let url = `/cards/search?q=${encodeURIComponent(scoped.q)}&page=${page}${scoped.params}`;
    if (order) url += `&order=${order}`;
    const resp = await scryGetRetried(url);
    if (resp.data && resp.data.total_cards != null) total = resp.data.total_cards;
    out.push(...(((resp.data && resp.data.data) || []).slice(skip)));
    skip = 0;
    hasMore = !!(resp.data && resp.data.has_more);
    if (!hasMore) break;
    page++;
  }
  return { cards: out.slice(0, limit), hasMore: hasMore || out.length > limit, total };
}

// Public entry point. Returns { cards, total } — `total` is how many matches
// exist upstream in all (null when the answer came from cache, which has no
// such count). Wrapping keeps the many early returns in the body unchanged.
// Same options object as tcgApi/tcgdexApi — see the note there.
async function searchCards({
  name = '', number = '', set = '', scope = 'database', userId = null,
  lang = null, allPrints = false, page = 1, limit = 60,
} = {}) {
  const meta = { total: null };
  const cards = await runSearch(meta, name, number, set, scope, userId, lang, allPrints, page, limit);
  return { cards, total: meta.total };
}

// Search MTG cards: local card_cache first (game='mtg'), then Scryfall. Mirrors
// the Pokémon searchCards contract so the route can dispatch on `game` alone.
// `page` is 1-based over `limit`-sized pages; the caller keeps asking for the
// next page while a full page comes back.
async function runSearch(meta, nameQuery = '', numberQuery = '', setQuery = '', scope = 'database', userId = null, lang = null, allPrints = false, page = 1, limit = 60) {
  const offset = (page - 1) * limit;
  const cleanName = (nameQuery || '').trim();
  const cleanNumber = (numberQuery || '').trim().replace(/^#/, '').split('/')[0].trim();
  // Set field may list several sets ("ltr, ltc") — match any of them. Scryfall
  // uses `(set:ltr or set:ltc)`; a single set stays the plain `set:ltr` form.
  const setList = parseSetList(setQuery);
  const scrySet = setList.length === 1 ? `set:${setList[0]}` : `(${setList.map(s => `set:${s}`).join(' or ')})`;

  // Scanner path: identify-by-image knows the card but not the printing, so it
  // asks for every printing of an exact name (Scryfall collapses to one printing
  // by default — `unique:prints` returns them all) and lets the user pick the set.
  if (allPrints && cleanName && scope !== 'collection') {
    try {
      // A set code narrows to that printing (exact, usually one result -> fast
      // path in the scanner); without it, return every printing to pick from.
      const q = setList.length ? `!"${cleanName}" ${scrySet} unique:prints` : `!"${cleanName}" unique:prints`;
      const raw = await fetchFromScryfall(q, lang);
      if (raw.length) {
        const cards = raw.map(c => normalizeCard(c, lang)).slice(0, 60);
        await cacheCards(cards);
        return cards;
      }
    } catch (e) {
      // No exact-name match / error — fall through to the normal search below.
    }
  }
  // Every cache read below is scoped to the requested language, so a cached
  // English printing can't shadow the localized card that was asked for — and,
  // unlike bypassing the cache outright, a repeat Japanese search still gets to
  // answer locally.
  const langName = languages.toName(lang);

  // 1. Collection-only search. What the user owns, in every language they own it
  // in — filtering by the picker's language here would hide their Japanese copies
  // from a deck search. See utils/cardSearchSql.
  if (scope === 'collection') {
    if (!userId) return [];
    const { sql, params } = cardSearchSql.collectionQuery('mtg', {
      userId, name: cleanName, number: cleanNumber, setList, limit, offset,
    });
    return (await db.all(sql, params)).map(parseCardRow);
  }

  // 2. Local cache first. Kept as a closure because an internet-scope search
  // skips it here but still needs it as a fallback when Scryfall is unreachable.
  const queryLocal = async () => {
    // language is part of the identity of a cached printing, so a Japanese search
    // must not be answered with the English rows sitting next to it.
    const { sql, params } = cardSearchSql.localCacheQuery('mtg', {
      language: langName, name: cleanName, number: cleanNumber, setList, limit, offset,
    });
    return db.all(sql, params);
  };

  let localResults = [];
  if (scope !== 'internet') {
    localResults = await queryLocal();
    if (localResults.length > 0) {
      // Refresh stale prices in the background; return the cached rows instantly.
      const stale = localResults.filter(r => (Date.now() - new Date(r.last_updated).getTime()) > CACHE_AGE_LIMIT_MS);
      if (stale.length > 0) {
        // Batched: a page is now up to 250 rows, and one request per stale row
        // was a 250-call burst behind a single search.
        (async () => {
          try {
            const { cards: fresh } = await bulkFetchByIdentifier(stale);
            if (fresh.length) await cacheCards(fresh);
          } catch (e) {
            console.error('MTG background refresh failed:', e.message);
          }
        })();
      }
      return localResults.map(parseCardRow);
    }
  }

  // Strip leading zeros from collector numbers — input may arrive as "0488" but
  // Scryfall expects "488".
  const strippedNumber = cleanNumber.replace(/^0+/, '') || cleanNumber;

  // Run specific query (set+cn or name+cn) AND the broad name-only query, then
  // merge results: exact matches first, remaining alternatives sorted by cn.
  // This way the user always sees the likely match at top with other printings below.
  // Scryfall collapses printings to one card per name by default, so a plain
  // "Sol Ring" only ever returned a single arbitrary printing. Manual add needs
  // every printing to pick the one actually being added. Digital-only prints
  // (Alchemy rebalances) are dropped — there is no physical card to own, same
  // rule the scan index uses.
  const PRINTS = ' unique:prints -is:digital';
  const specificQuery = (setList.length && strippedNumber) ? `${scrySet} cn:${strippedNumber}`
    : (cleanName && strippedNumber) ? `${cleanName} cn:${strippedNumber}`
    : null;
  // Constrain the name search to the chosen set(s) so a multi-set search
  // ("ltr, ltc") returns only those sets, not every printing. Set-only (no
  // name) falls back to browsing the set(s).
  const setConstraint = setList.length ? ` ${scrySet}` : '';
  const broadQuery = cleanName ? `${cleanName}${setConstraint}${PRINTS}` : (setList.length ? `${scrySet}${PRINTS}` : null);
  // Last resort: first word only (e.g. "Adamant" from "Adamant Will")
  const firstWord = cleanName.split(/\s+/)[0];
  const fallbackQuery = (firstWord && firstWord !== cleanName) ? `${firstWord}${setConstraint}${PRINTS}` : null;

  // Helper: try a Scryfall query window, return [] on 404/error.
  // Browsing a whole set pages by collector number; a name search keeps
  // Scryfall's relevance order so the card you typed stays on page 1.
  const order = (!cleanName && setList.length) ? 'set' : undefined;
  const tryQuery = async (q, off = 0) => {
    if (!q) return [];
    try {
      const { cards, total } = await fetchWindow(q, lang, off, limit, order);
      // The broad query is the one that defines "how many matches exist"; the
      // specific set+cn probe would report its own tiny count.
      if (q === broadQuery && total != null) meta.total = total;
      return cards.map(c => normalizeCard(c, lang));
    } catch (err) {
      // 404 = no cards matched; 422 = asked for a page past the last one.
      if (err.response && (err.response.status === 404 || err.response.status === 422)) return [];
      throw err; // real error (rate limit, network) — bubble up
    }
  };

  try {
    // The specific (set+cn) query yields at most a printing or two and only
    // makes sense as the head of the first page — later pages just walk the
    // broad query. Overlap from that shift is deduped by the caller on id.
    let exact = page === 1 ? await tryQuery(specificQuery) : [];

    // A set + collector number identifies ONE card. Pairing it with the broad
    // set browse would bury that card under the other 800 in the set, so the
    // browse only runs as a fallback when the number found nothing. With a name
    // typed, the broad query is still wanted — it surfaces other printings.
    const numberPinnedIt = !cleanName && strippedNumber && exact.length > 0;
    let broad = (!numberPinnedIt && broadQuery && broadQuery !== specificQuery)
      ? await tryQuery(broadQuery, offset)
      : [];
    if (numberPinnedIt) meta.total = exact.length;

    // If both empty, try first-word fallback.
    if (exact.length === 0 && broad.length === 0 && fallbackQuery) {
      broad = await tryQuery(fallbackQuery, offset);
    }

    // Merge: exact matches first, then broad alternatives deduped.
    const seen = new Set(exact.map(c => c.id));
    const merged = [...exact, ...broad.filter(c => !seen.has(c.id))];
    if (merged.length === 0) return localResults.map(parseCardRow);

    const cards = merged.slice(0, limit);
    // Sort alternatives (after exact) by collector number. A set browse has no
    // exact match to hoist and is already in set order — re-sorting it per page
    // would only shuffle non-numeric collector numbers to the top of each page.
    const exactIds = new Set(exact.map(c => c.id));
    if (cleanName || strippedNumber) cards.sort((a, b) => {
      // Exact matches always first.
      const aExact = exactIds.has(a.id) ? 0 : 1;
      const bExact = exactIds.has(b.id) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const na = parseInt(a.number, 10) || 0;
      const nb = parseInt(b.number, 10) || 0;
      return na - nb;
    });

    await cacheCards(cards);
    return cards;
  } catch (err) {
    console.error('Scryfall search failed:', err.message);
    // Serve whatever the cache already knows before giving up. With nothing
    // cached, say the upstream is down rather than "no such card" — a throttled
    // or broken Scryfall is indistinguishable from an empty result otherwise,
    // and reporting it as "no results" is what made #22 look like a search bug.
    const cached = scope === 'internet' ? await queryLocal() : localResults;
    if (cached.length > 0) {
      console.warn(`Scryfall unavailable — serving ${cached.length} cached match(es).`);
      return cached.map(parseCardRow);
    }
    const status = err.response && err.response.status;
    if (status === 429) throw new Error('RATE_LIMIT_EXCEEDED');
    throw new Error('UPSTREAM_UNAVAILABLE');
  }
}

// Fetch a set's cards from Scryfall (dev seed helper). Mirrors
// tcgApi.getCardsBySet: one request, normalized + cached like any lookup, so
// the seed route gets a varied MTG pool (all colors/rarities). Takes the first
// page (~175 cards) — plenty for test data, so pagination is skipped.
async function getCardsBySet(setCode) {
  try {
    console.log(`Querying Scryfall for full set: ${setCode}`);
    const raw = await fetchFromScryfall(`set:${setCode}`);
    const cards = raw.map(c => normalizeCard(c));
    if (cards.length > 0) await cacheCards(cards);
    return cards;
  } catch (error) {
    console.error(`Error fetching MTG set ${setCode} from Scryfall:`, error.message);
    return [];
  }
}

// Fetch MTG sets from Scryfall and cache them in the shared `sets` table
// (game='mtg'). Set ids are prefixed "mtg-" so a Scryfall set code can never
// collide with a Pokémon set id on the primary key. Skips if already populated
// unless force=true. Matches tcgApi.fetchAndCacheSets so server.js can call both.
async function fetchAndCacheSets(force = false) {
  try {
    const existing = await db.get(`SELECT COUNT(*) as count FROM sets WHERE game = 'mtg'`);
    if (!force && existing && existing.count > 0) {
      console.log(`MTG sets already populated (${existing.count} sets). Skipping fetch.`);
      return;
    }
    console.log('Fetching sets from Scryfall...');
    const resp = await scryGet('/sets');
    const sets = (resp.data && resp.data.data) || [];
    for (const s of sets) {
      await db.run(
        `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mtg')`,
        [
          `mtg-${s.code}`, s.name, s.set_type || '', s.card_count || 0, s.card_count || 0,
          s.released_at || '', s.code || '', s.icon_svg_uri || '', s.icon_svg_uri || ''
        ]
      );
    }
    console.log(`Cached ${sets.length} MTG sets.`);
  } catch (error) {
    console.error('Error fetching MTG sets from Scryfall:', error.message);
  }
}

// Refresh prices for every owned/decked MTG card from Scryfall and record price
// history. The Pokémon updater (tcgApi) skips these, so this is their only
// periodic refresh path.
// `force` bypasses the once-a-day gate (used by the scheduled daily run, which
// is already on the right cadence by construction).
async function updateCollectionPrices(force = false) {
  try {
    const cards = await db.all(`
      SELECT DISTINCT c.card_id, cc.set_id, cc.number, cc.name FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id WHERE cc.game = 'mtg'
      UNION
      SELECT DISTINCT d.card_id, cc.set_id, cc.number, cc.name FROM deck_cards d
      JOIN card_cache cc ON d.card_id = cc.id WHERE cc.game = 'mtg'
    `);
    if (cards.length === 0) return;
    if (!force && !(await shouldSweepPrices('mtg'))) {
      console.log('Skipping MTG price update: already swept within the last 24h (Scryfall updates prices daily).');
      return;
    }
    console.log(`Starting MTG price update for ${cards.length} unique cards...`);

    // One request PER CARD is what got this app rate-limited: a 200-card
    // collection meant 200 Scryfall calls every boot, and nodemon reboots on
    // every code edit. /cards/collection takes 75 identifiers at a time, so the
    // same sweep is a handful of calls. Verified contract: { data, not_found }.
    try {
      const { cards: fresh, pairs, notFound } = await bulkFetchByIdentifier(cards);
      if (fresh.length) await cacheCards(fresh);
      for (const { row, card } of pairs) {
        await recordPrice(row.card_id, card.price_trend);
      }
      await markPricesSwept('mtg');
      console.log(`MTG price update complete: ${pairs.length} priced, ${notFound} not found on Scryfall.`);
    } catch (e) {
      console.error('MTG price update failed:', e.message);
    }
  } catch (err) {
    console.error('Error during MTG price update:', err.message);
  }
}

// The same printing in another language, or null.
//
// Scanning identifies a card from ARTWORK, which is identical in every language,
// so a Japanese card is matched against the English catalog and comes back as the
// English printing (cvScan.load says so outright, and leaves re-expressing the
// answer to the caller — this is that). Set code and collector number ARE
// language-invariant, so they address the printing; /cards/:code/:number/:lang is
// the one Scryfall endpoint that takes a language, unlike /cards/collection.
//
// Returns null rather than throwing when the card was never printed in that
// language (Japanese has no Alpha), so callers keep the English card they had.
async function getPrintingInLang(setCode, number, lang) {
  const code = languages.resolve(lang).scryfall;
  if (code === 'en' || !setCode || !number) return null;
  const name = languages.toName(code);
  const cached = await db.get(
    `SELECT * FROM card_cache WHERE game = 'mtg' AND set_id = ? AND number = ? AND language = ? LIMIT 1`,
    [String(setCode).toLowerCase(), String(number), name]
  );
  if (cached) return parseCardRow(cached);
  try {
    const resp = await scryGet(`/cards/${encodeURIComponent(String(setCode).toLowerCase())}/${encodeURIComponent(number)}/${code}`);
    if (!resp.data) return null;
    const norm = normalizeCard(resp.data, name);
    // Only keep it if Scryfall really answered in that language. A 404 is the
    // usual "not printed in it" signal, but the endpoint can also fall back, and
    // caching an English row under a Japanese query would poison the lookup above.
    if (languages.toCode(norm.language) !== languages.toCode(code)) return null;
    await cacheCards([norm]);
    return norm;
  } catch {
    return null;   // 404 (no such printing in that language) or a transient error
  }
}

async function getCardById(cardId) {
  const rawId = cardId.startsWith('mtg-') ? cardId.slice(4) : cardId;
  const cached = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
  if (cached) return parseCardRow(cached);
  try {
    const resp = await scryGet(`/cards/${rawId}`);
    if (resp.data) {
      const norm = normalizeCard(resp.data);
      await cacheCards([norm]);
      return norm;
    }
  } catch (e) {}
  return null;
}

// `client` and `fetchWindow` are exported for tests (stub the axios adapter),
// mirroring how tcgApi exposes tcgClient.
module.exports = { searchCards, normalizeCard, cacheCards, getCardsBySet, fetchAndCacheSets, updateCollectionPrices, getCardById, getPrintingInLang, scryGetRetried, client, fetchWindow };
