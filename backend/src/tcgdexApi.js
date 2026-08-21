// Non-English Pokémon cards, via TCGdex (https://tcgdex.dev).
//
// Why a second Pokémon provider exists: pokemontcg.io v2 is English-only. Its
// 174 sets are the Western releases, and Japan-exclusive sets are simply not in
// it — sv2a (ポケモンカード151) returns nothing. No parameter fixes that, so
// every non-English Pokémon lookup comes from here instead. TCGdex carries 11
// languages with localized names, localized art and Cardmarket prices.
//
// Shape of this module deliberately mirrors tcgApi.js: searchCards returns
// { cards, total } of card_cache-shaped rows, so routes/collection.js can pick a
// provider and treat the answer identically.
const axios = require('axios');
const db = require('./db');
const { parseCardRow, recordPrice, shouldSweepPrices, markPricesSwept } = require('./utils/priceHelpers');
const { parseSetList } = require('./utils/setQuery');
const cardSearchSql = require('./utils/cardSearchSql');
const { cacheNormalizedCards } = require('./utils/cardCache');
const languages = require('./utils/languages');
const { pruneStaleSets } = require('./utils/setCatalogue');

const API_BASE_URL = 'https://api.tcgdex.net/v2';

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: { 'User-Agent': 'Bindarr/1.0', Accept: 'application/json' },
});

// TCGdex publishes no rate limit, but a search hydrates one request per result,
// so cap the fan-out rather than firing 60 sockets at someone else's free API.
const HYDRATE_CONCURRENCY = 6;
const CACHE_AGE_LIMIT_MS = 1000 * 60 * 60 * 24 * 3; // 3 days, same as the other providers

// Ids must carry the language: the SAME set id exists in several languages
// (sv03 is published in en, fr, de, ...), so "SV2a-004" alone is ambiguous and
// would make a German card overwrite the Japanese one in card_cache.
const cardId = (lang, id) => `tcgdex-${lang}-${id}`;

// TCGdex serves art from a CDN path with no extension; the size is the last
// segment. `low` is ~245px like pokemontcg.io's `small`, which is what the card
// grids want — the inspector's zoom is still served the same URL, so keep the
// cheap one rather than pushing 210 high-res PNGs through a set browse.
const imageUrl = (image) => (image ? `${image}/low.png` : '');

// Cardmarket quotes in EUR while TCGplayer quotes USD, and TCGdex hands back
// whichever it has (non-English cards are Cardmarket-only). Both land in the same
// price columns the app already mixes them in — tcgApi has always fallen back to
// Cardmarket's trendPrice the same way — and the UI renders one currency symbol.
// ponytail: prices are stored unit-less as before; a per-row currency column and
// a formatPrice unit are the upgrade path if mixed currencies start to matter.
function extractPrices(pricing) {
  const cm = (pricing && pricing.cardmarket) || {};
  const tp = (pricing && pricing.tcgplayer) || {};
  const market = (v) => (v && (v.marketPrice ?? v.midPrice)) || null;

  const normal = market(tp.normal) ?? cm.avg ?? cm.trend ?? null;
  const holofoil = market(tp.holofoil) ?? cm['avg-holo'] ?? cm['trend-holo'] ?? null;
  // Cardmarket does not split reverse-holo on the cards TCGdex exposes; read the
  // keys anyway so the day it does, they land in the right column.
  const reverse = market(tp.reverseHolofoil) ?? cm['avg-reverse'] ?? cm['trend-reverse'] ?? null;

  return {
    price_trend: normal ?? holofoil ?? reverse ?? 0,
    price_normal: normal,
    price_holofoil: holofoil,
    price_reverse_holofoil: reverse,
    // Cardmarket's rolling averages are real computed sales data — the same
    // series tcgApi stores for English cards, so the price charts keep working.
    price_avg1: cm.avg1 > 0 ? cm.avg1 : null,
    price_avg7: cm.avg7 > 0 ? cm.avg7 : null,
    price_avg30: cm.avg30 > 0 ? cm.avg30 : null,
    // Which of the two answered, so the UI can name it instead of guessing. TCGdex
    // carries a tcgplayer block for some Western cards and Cardmarket for the rest,
    // and the two are different currencies — that mixing is what price_currency
    // exists to record. tcgcsvApi overwrites both for any card it can place.
    price_source: 'tcgdex',
    price_currency: market(tp.normal) != null || market(tp.holofoil) != null ? 'USD' : 'EUR',
  };
}

// pokemontcg.io writes "Pokémon" with the accent and spaces its stages; matching
// it keeps one set of supertype/subtype filter values across both providers
// instead of splitting every filter dropdown in two.
const SUPERTYPES = { Pokemon: 'Pokémon', Trainer: 'Trainer', Energy: 'Energy' };
const spaceStage = (s) => String(s || '').replace(/(Stage)(\d)/, '$1 $2');

// A full TCGdex card -> the card_cache shape the rest of the app speaks.
function normalizeCard(card, lang) {
  const code = languages.toCode(lang);
  const name = card.name || '';
  const cardmarketId = card.pricing && card.pricing.cardmarket ? card.pricing.cardmarket.idProduct : null;
  return {
    id: cardId(code, card.id),
    // Unlike Scryfall, TCGdex has no English name to fall back on for a
    // Japan-exclusive card — the localized name is the only name there is. So it
    // goes in BOTH columns: `name` so search/sort keep working, `printed_name` so
    // the UI knows it is already localized and shows it as-is.
    name,
    printed_name: name,
    supertype: SUPERTYPES[card.category] || card.category || '',
    subtypes: card.stage ? [spaceStage(card.stage)] : [],
    types: card.types || [],
    rarity: card.rarity || 'Common',
    set_id: (card.set && card.set.id) || '',
    set_name: (card.set && card.set.name) || '',
    number: card.localId != null ? String(card.localId) : '',
    image_url: imageUrl(card.image),
    ...extractPrices(card.pricing),
    cmc: null,
    color_identity: [],
    game: 'pokemon',
    language: languages.toName(code),
    // Cardmarket link built from the idProduct the price itself came from, so it
    // opens the exact product rather than a search — which matters here more than
    // anywhere, since a search on a Japanese name finds nothing on a site that
    // indexes English.
    //
    // The `Products?idProduct=` form is not guessed: it is what Scryfall emits for
    // Magic (`cardmarket.com/en/Magic/Products?idProduct=89216`), swapping the game
    // segment the same way this codebase already does elsewhere. Cardmarket blocks
    // automated requests, so it could not be probed directly.
    tcgplayer_url: null, // TCGdex carries no TCGplayer id for non-English cards
    cardmarket_url: cardmarketId ? `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${cardmarketId}` : null,
  };
}

const cacheCards = (cards, opts) => cacheNormalizedCards(cards, 'pokemon', opts);

// Fill in a row cached from a set brief (name/number/image only). Safe to call for
// any TCGdex id: it no-ops when the row already has full card data.
//
// Thinness is detected from the ROW, not from its timestamp. A stale stamp only
// marks rows written after that behaviour existed, and the freshness check in
// getCardById would happily hand a brief-shaped row straight back — which is
// exactly how a scanned card kept its defaulted rarity and $0.00. `supertype` is
// the tell: every hydrated card has one, no brief does.
async function hydrateCard(id) {
  const row = await db.get(`SELECT supertype, last_updated FROM card_cache WHERE id = ?`, [id]);
  if (!row) return null;
  const thin = !row.supertype;
  const stale = Date.now() - new Date(row.last_updated).getTime() >= CACHE_AGE_LIMIT_MS;
  if (!thin && !stale) return null;

  const code = idLanguage(id);
  if (!code) return null;
  // Fetch directly rather than through getCardById: that returns the cached row
  // when it looks fresh, which is the case this function exists to break out of.
  const card = normalizeCard(await fetchFullCard(code, providerId(id)), code);
  await cacheCards([card]);
  return card;
}

// Run `fn` over `items` at most HYDRATE_CONCURRENCY at a time, dropping failures.
async function mapLimited(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += HYDRATE_CONCURRENCY) {
    const batch = await Promise.all(
      items.slice(i, i + HYDRATE_CONCURRENCY).map(it => fn(it).catch(() => null))
    );
    out.push(...batch.filter(Boolean));
  }
  return out;
}

// A search returns "briefs" — id, localId, name, image and nothing else. Set,
// rarity, types and prices only exist on the full card, so each result has to be
// fetched. Rows land in card_cache, so the next search for them is local.
const fetchFullCard = (lang, id) => client.get(`/${lang}/cards/${encodeURIComponent(id)}`).then(r => r.data);

// TCGdex filters briefs with `field=value` (exact) or `field=like:value`
// (substring, case-insensitive). There is no `set` field on a brief, so a
// set-scoped search reads the set endpoint instead — one request that also
// carries the set's localized name.
//
// `paged` says whether TCGdex already applied our page window. A set browse gets
// the whole set in one response and is sliced locally; a name search is paged
// server-side so we never pull (or hydrate) more than one page.
async function searchBriefs(lang, name, setList, page, limit) {
  if (setList.length) {
    const perSet = await mapLimited(setList, async (set) => {
      const { data } = await client.get(`/${lang}/sets/${encodeURIComponent(set)}`);
      return data.cards || [];
    });
    return { briefs: perSet.flat(), paged: false };
  }
  if (!name) return { briefs: [], paged: true };
  const { data } = await client.get(`/${lang}/cards`, {
    params: { name: `like:${name}`, 'pagination:page': page, 'pagination:itemsPerPage': limit },
  });
  return { briefs: data || [], paged: true };
}

const numberMatches = (localId, wanted) => {
  const a = String(localId ?? '').trim();
  const bRaw = String(wanted ?? '').trim();
  if (!bRaw) return true;
  const match = bRaw.match(/^#?([A-Z0-9★\-]+)(?:\s*\/\s*[A-Z0-9★\-]+)?$/i);
  const b = match ? match[1] : bRaw;
  if (a === bRaw || a === b || a.replace(/^0+/, '') === b.replace(/^0+/, '')) return true;
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
};

// Same options object as tcgApi/scryfallApi — see the note there.
async function searchCards({
  name = '', number = '', set = '', scope = 'database', userId = null,
  lang = 'en', page = 1, limit = 60,
} = {}) {
  const cards = await runSearch(name, number, set, scope, userId, lang || 'en', page, limit);
  // TCGdex sends no total-count header, so the caller shows what it has. The UI
  // already handles a null total (it falls back to the loaded count).
  return { cards, total: null };
}

// `page` is 1-based over `limit`-sized pages, matching the other providers.
async function runSearch(nameQuery = '', numberQuery = '', setQuery = '', scope = 'database', userId = null, lang = 'ja', page = 1, limit = 60) {
  const code = languages.toCode(lang);
  const langName = languages.toName(code);
  const offset = (page - 1) * limit;
  const name = (nameQuery || '').trim();
  const number = (numberQuery || '').trim().replace(/^#/, '').split('/')[0].trim();
  const setList = parseSetList(setQuery);

  // 1. Collection-only search — never touches the network.
  //
  // No language filter, unlike the local-cache query below. This used to filter,
  // and it was the odd one out: the same "what do I own" search returned
  // different rows depending on the UI language, so browsing in Japanese hid the
  // English copies of the very cards being looked for. You own the card whatever
  // language you own it in. See utils/cardSearchSql.
  if (scope === 'collection') {
    if (!userId) return [];
    const { sql, params } = cardSearchSql.collectionQuery('pokemon', {
      userId, name, number, setList, limit, offset,
    });
    return (await db.all(sql, params)).map(parseCardRow);
  }

  // 2. Local cache, scoped to this language so English rows can't answer a
  // Japanese search. Kept as a closure: an internet-scope search skips it here
  // but still wants it as a fallback when TCGdex is unreachable.
  const queryLocal = async () => {
    const { sql, params } = cardSearchSql.localCacheQuery('pokemon', {
      language: langName, name, number, setList, limit, offset,
    });
    return db.all(sql, params);
  };

  let localResults = [];
  if (scope !== 'internet') {
    localResults = await queryLocal();
    if (localResults.length > 0) {
      const stale = localResults.filter(r => (Date.now() - new Date(r.last_updated).getTime()) > CACHE_AGE_LIMIT_MS);
      if (stale.length > 0) refreshInBackground(code, stale);
      return localResults.map(parseCardRow);
    }
  }

  // 3. TCGdex.
  try {
    const { briefs, paged } = await searchBriefs(code, name, setList, page, limit);
    const lowerName = name.toLowerCase();
    // A number filter is applied here rather than upstream: TCGdex can only match
    // localId exactly, and collector numbers arrive zero-padded ("004") or not
    // ("4") depending on where they were typed.
    // ponytail: on a name search the number filter only sees the page TCGdex
    // returned. A number is only reliable alongside a set anyway (same reason the
    // English path refuses a bare number search), and that path reads the whole set.
    const matched = briefs.filter(b =>
      numberMatches(b.localId, number) &&
      (!name || String(b.name || '').toLowerCase().includes(lowerName))
    );
    if (matched.length === 0) return localResults.map(parseCardRow);

    // Only the requested page gets hydrated — one request per card, so paging is
    // what keeps a 210-card set browse from becoming 210 requests at once.
    const window = paged ? matched.slice(0, limit) : matched.slice(offset, offset + limit);
    const full = await mapLimited(window, b => fetchFullCard(code, b.id));
    const cards = full.map(c => normalizeCard(c, code));
    if (cards.length > 0) await cacheCards(cards);
    return cards;
  } catch (error) {
    console.error(`TCGdex search failed (${code}):`, error.message);
    // Same rule as the other providers: serve the cache before admitting defeat,
    // and only report an outage when there is genuinely nothing to show — an
    // empty result would otherwise read as "no such card".
    const cached = scope === 'internet' ? await queryLocal() : localResults;
    if (cached.length > 0) {
      console.warn(`TCGdex unavailable — serving ${cached.length} cached match(es).`);
      return cached.map(parseCardRow);
    }
    if (error.response && error.response.status === 404) return [];
    throw new Error('UPSTREAM_UNAVAILABLE');
  }
}

// Re-fetch stale rows and record any price movement. Fire-and-forget: the search
// that triggered it has already answered from cache.
function refreshInBackground(code, rows) {
  (async () => {
    try {
      const fresh = await mapLimited(rows, async (row) => {
        const raw = await fetchFullCard(code, providerId(row.id));
        return normalizeCard(raw, code);
      });
      if (fresh.length) await cacheCards(fresh);
      for (const card of fresh) await recordPrice(card.id, card.price_trend);
    } catch (e) {
      console.error('TCGdex background refresh failed:', e.message);
    }
  })();
}

// Split "tcgdex-ja-SV2a-004" back into its language and the provider's own id.
//
// This matches against the known language codes instead of a `[a-z]{2}` pattern
// on purpose: TCGdex set ids contain dashes AND can be two lowercase letters
// ("lc-3", "ex-12"), so a generic pattern reads "tcgdex-en-lc-3" as language
// "en-lc" and card "3". Codes are tried longest-first so "zh-tw" wins over "zh".
const CODES = languages.LANGUAGES.map(l => l.code).sort((a, b) => b.length - a.length);

function splitId(id) {
  const s = String(id || '');
  if (!s.startsWith('tcgdex-')) return { lang: null, id: s };
  const rest = s.slice('tcgdex-'.length);
  for (const code of CODES) {
    if (rest.startsWith(`${code}-`)) return { lang: code, id: rest.slice(code.length + 1) };
  }
  return { lang: null, id: rest };
}

// "tcgdex-ja-SV2a-004" -> "SV2a-004"
const providerId = (id) => splitId(id).id;

// Language of a cached row's id, so a sweep knows which language endpoint to ask.
const idLanguage = (id) => splitId(id).lang;

async function getCardById(id) {
  const cached = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [id]);
  if (cached && (Date.now() - new Date(cached.last_updated).getTime() < CACHE_AGE_LIMIT_MS)) {
    return parseCardRow(cached);
  }
  const code = idLanguage(id);
  if (!code) return cached ? parseCardRow(cached) : null;
  try {
    const card = normalizeCard(await fetchFullCard(code, providerId(id)), code);
    await cacheCards([card]);
    return card;
  } catch (e) {
    console.error(`TCGdex card ${id} lookup failed:`, e.message);
  }
  return cached ? parseCardRow(cached) : null;
}

// The same card in another language, or null.
//
// Scanning matches on ARTWORK, so a French card with no French catalog built is
// matched against the English one and comes back as the English printing. The
// mapping is the id itself: a TCGdex id is `tcgdex-<lang>-<setId>-<number>` and
// the same set id is published across languages (sv03 exists in en, fr, de, ...),
// so swapping the language segment addresses the same card. See the note on
// `cardId` above — that shared set id is the whole reason ids carry a language.
//
// Two cases deliberately return null rather than guessing:
//
//   · a pokemontcg.io id ("basep-50"), which has no language segment. Its set
//     numbering DISAGREES with TCGdex's for the same set (swsh10.5 vs pgo, sv01
//     vs sv1 — see the note on pokemonApiFor), so there is no honest translation.
//   · a set that does not exist in the target language. Japanese, Korean and
//     Chinese Pokémon have their own set structure (S12, SV2a) rather than
//     localised editions of the English sets, so the swapped id simply 404s.
//
// Both keep the English card the caller already has, which beats showing nothing.
// The real answer for those is a catalog built in that language — then the match
// returns localised ids directly and this is never consulted.
async function getPrintingInLang(id, lang) {
  const want = languages.toCode(lang);
  const have = idLanguage(id);
  if (!have || have === want) return null;
  const localized = await getCardById(cardId(want, providerId(id))).catch(() => null);
  // getCardById falls back to a cached row when the fetch fails, so confirm the
  // row we got is really in the language asked for before preferring it.
  if (!localized || languages.toCode(localized.language) !== want) return null;
  return localized;
}

// Every set TCGdex publishes for a language, in the shape /api/sets returns. Not
// written to the `sets` table on purpose: the same set id exists in several
// languages with different names and card counts, and that table is keyed by id
// alone. Cached in memory instead — set lists change a few times a year.
const setsCache = new Map(); // lang -> { at, sets }
const SETS_TTL_MS = 1000 * 60 * 60 * 12;

async function listSets(lang) {
  const code = languages.toCode(lang);
  const hit = setsCache.get(code);
  if (hit && Date.now() - hit.at < SETS_TTL_MS) return hit.sets;
  const { data } = await client.get(`/${code}/sets`);
  // A set brief carries id, name and cardCount only. Release date, series and
  // logos live on the per-set endpoint, and 177 extra requests to decorate an
  // autocomplete is not a trade worth making — the list already arrives oldest
  // first, which is the order the set pickers expect.
  const sets = (data || []).map(s => ({
    id: s.id,
    name: s.name,
    series: '',
    printed_total: (s.cardCount && s.cardCount.official) || 0,
    total: (s.cardCount && s.cardCount.total) || 0,
    release_date: '',
    ptcgo_code: '',
    symbol_url: '',
    logo_url: '',
    game: 'pokemon',
  }));
  setsCache.set(code, { at: Date.now(), sets });
  return sets;
}

// Pokémon TCG Pocket — the phone game. Its cards have artwork and set codes but
// no physical printing, so they can never be the answer to a camera scan. TCGdex
// publishes them alongside the paper sets with nothing on the set brief to tell
// them apart, which is how 14 of them (2,321 artworks) ended up in the scan index:
// dead weight on every recall pass, and a live source of confident wrong answers,
// since Pocket art is largely redrawn from paper cards.
//
// Scryfall marks its digital sets and setIndex.listAllSets filters on that flag
// for MTG; this constant is the Pokémon equivalent.
const DIGITAL_SERIES = 'tcgp';

// Which series each set belongs to, as setId -> { id, name }.
//
// A set brief carries no series (see listSets) and the per-set endpoint does —
// but asking that 218 times to answer "which of these are digital" is not a trade
// worth making, and this runs behind a panel that re-polls every 1.5s. The series
// endpoints invert the question: one request for the series list plus one per
// series (~22 total) returns every set already grouped. Same answer, a tenth of
// the traffic.
//
// Cached as long as the set list, since a set's series never changes after it
// ships. A series whose detail request fails is skipped rather than fatal: the
// caller's fallback ("no series known") degrades to showing the set, which is the
// safe direction — better a digital set slips into the catalogue than a network
// blip silently drops half the paper sets from a build.
const seriesCache = new Map();   // lang -> { at, bySet }

async function listSeries(lang) {
  const code = languages.toCode(lang);
  const hit = seriesCache.get(code);
  if (hit && Date.now() - hit.at < SETS_TTL_MS) return hit.bySet;

  const { data } = await client.get(`/${code}/series`);
  const details = await mapLimited(data || [], async (s) => {
    const r = await client.get(`/${code}/series/${encodeURIComponent(s.id)}`);
    return { id: s.id, name: s.name || s.id, sets: r.data.sets || [] };
  });

  const bySet = new Map();
  for (const serie of details) {
    for (const s of serie.sets) {
      if (s && s.id) bySet.set(s.id, { id: serie.id, name: serie.name });
    }
  }
  seriesCache.set(code, { at: Date.now(), bySet });
  return bySet;
}

// Fill the `sets` table from TCGdex, for installs where TCGdex is the configured
// Pokémon provider.
//
// The set catalogue used to come from pokemontcg.io unconditionally while the
// CARDS followed the provider setting — so an install switched to TCGdex cached
// cards under TCGdex ids (sv01, swsh10.5, me01) and then browsed a set list
// numbered by pokemontcg.io (sv1, pgo, me1). That is the exact mismatch
// utils/pokemonProvider was written to prevent, one layer up.
//
// Two passes on purpose. The brief list is one request and is enough to browse
// and to scope a scan, so it is written first and immediately. Release dates,
// series and logos only exist on the per-set endpoint, and chronological binder
// sorting needs the dates — so those are filled in afterwards, four at a time,
// and a failure there leaves a usable row rather than no row.
async function fetchAndCacheSets(force = false) {
  try {
    const existing = await db.get(`SELECT COUNT(*) n FROM sets WHERE game = 'pokemon'`);
    // Rows numbered by the OTHER provider must not count as "already populated",
    // so the caller forces a re-sync when the setting changes.
    if (!force && existing && existing.n > 0) {
      console.log(`Pokemon sets already populated (${existing.n} sets). Skipping TCGdex fetch.`);
      return;
    }
    console.log('Fetching sets from TCGdex...');
    const sets = await listSets('en');
    if (!sets.length) throw new Error('TCGdex returned no sets');
    for (const s of sets) {
      await db.run(
        `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
         VALUES (?, ?, '', ?, ?, '', '', '', '', 'pokemon')`,
        [s.id, s.name, s.printed_total || 0, s.total || 0]
      );
    }
    console.log(`Cached ${sets.length} Pokemon sets from TCGdex. Filling in dates and series...`);
    await pruneStaleSets(sets.map(s => s.id), 'TCGdex');

    const series = await listSeries('en').catch(() => new Map());
    let dated = 0;
    await mapLimited(sets, async (s) => {
      const { data } = await client.get(`/en/sets/${encodeURIComponent(s.id)}`);
      await db.run(
        `UPDATE sets SET release_date = ?, series = ?, symbol_url = ?, logo_url = ? WHERE id = ? AND game = 'pokemon'`,
        // Slashes, not TCGdex's hyphens: compartmentSort orders by this column as a
        // STRING (`ORDER BY release_date ASC`), and pokemontcg.io wrote YYYY/MM/DD.
        // Mixing the two formats sorts '-' before '/' and puts 2026 ahead of 2023 —
        // which is exactly what a chronological binder must not do on an install
        // that holds rows from both providers.
        [String(data.releaseDate || '').replace(/-/g, '/'),
          (series.get(s.id) || {}).name || (data.serie && data.serie.name) || '',
          data.symbol || '', data.logo || '', s.id]
      );
      dated++;
      return true;
    });
    console.log(`TCGdex sets: ${dated} of ${sets.length} have release dates and series.`);
  } catch (error) {
    console.error('Error fetching TCGdex sets:', error.message);
  }
}

// Price sweep for owned/decked non-English Pokémon cards. tcgApi's sweep skips
// these (their ids 404 on pokemontcg.io), so this is their only refresh path.
// `force` bypasses the once-a-day gate (used by the scheduled daily run, which is
// already on the right cadence). Without the gate the boot sweep re-ran on every
// restart — which under nodemon means every code edit.
async function updateCollectionPrices(force = false) {
  try {
    if (!force && !(await shouldSweepPrices('tcgdex'))) {
      console.log('Skipping TCGdex price update: already swept within the last 24h.');
      return;
    }
    const rows = await db.all(`
      SELECT DISTINCT c.card_id AS id FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id WHERE cc.game = 'pokemon' AND cc.language != 'English'
      UNION
      SELECT DISTINCT d.card_id AS id FROM deck_cards d
      JOIN card_cache cc ON d.card_id = cc.id WHERE cc.game = 'pokemon' AND cc.language != 'English'
    `);
    const owned = rows.filter(r => idLanguage(r.id));
    if (owned.length === 0) return;
    console.log(`Starting TCGdex price update for ${owned.length} unique cards...`);
    const fresh = await mapLimited(owned, async (row) => {
      const code = idLanguage(row.id);
      return normalizeCard(await fetchFullCard(code, providerId(row.id)), code);
    });
    if (fresh.length) await cacheCards(fresh);
    // The sweep already visits every non-English card owned, which makes it the one
    // place rows added before English names were learned can catch up. One extra
    // request each, once: afterwards the row no longer qualifies.
    await mapLimited(fresh, learnEnglishName);
    for (const card of fresh) await recordPrice(card.id, card.price_trend);
    await markPricesSwept('tcgdex');
    console.log(`TCGdex price update complete: ${fresh.length} priced.`);
  } catch (err) {
    console.error('Error during TCGdex price update:', err.message);
  }
}

// Teach a localized row the card's English name, so a collection can be searched in
// English as well as in the language printed on the card.
//
// Magic needs none of this: Scryfall gives every printing an English `name` plus the
// localized `printed_name`. TCGdex has ONE name per language, so normalizeCard above
// writes the localized one into both columns — and a Japanese card was then findable
// only by typing Japanese, which is not much use to someone whose keyboard is not.
//
// The English sibling is one request away whenever the set exists in English (sv03
// does, sv2a does not), because ids differ only in their language segment. So ask for
// it once — when a card is actually being kept, or when the price sweep next visits
// it — and store it in `name`. Display reads printed_name and is unchanged; search
// reads both columns (see utils/cardSearchSql and CollectionList's filter).
//
// Cheap on a repeat: the English row caches like any other, and once the name is
// learned this returns on the second line. Never fatal — a Japan-exclusive card keeps
// the localized name in both columns, which is exactly the old behaviour.
async function learnEnglishName(card) {
  const have = card && idLanguage(card.id);
  if (!have || have === 'en') return card;
  if (!card.printed_name || card.name !== card.printed_name) return card;
  const english = await getPrintingInLang(card.id, 'en').catch(() => null);
  if (!english || !english.name || english.name === card.name) return card;
  await db.run(`UPDATE card_cache SET name = ? WHERE id = ?`, [english.name, card.id]);
  return { ...card, name: english.name };
}

// `client` is exported for tests (stub the axios adapter), like tcgApi.tcgClient.
module.exports = {
  searchCards, getCardById, getPrintingInLang, hydrateCard, listSets, fetchAndCacheSets, cacheCards, normalizeCard,
  updateCollectionPrices, learnEnglishName, providerId, idLanguage, client,
  // setIndex.listAllSets filters digital sets out of a build with these, and
  // globalIndex groups the coverage breakdown by series.
  listSeries, DIGITAL_SERIES,
};
