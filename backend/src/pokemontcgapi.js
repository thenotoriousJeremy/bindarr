// An opt-in Pokémon catalogue. Its ids are not pokemontcg.io or TCGdex ids:
// keep the prefix even when a legacy alias resolves, so switching providers
// cannot overwrite an owned printing or send its next lookup to the wrong API.
const axios = require('axios');
const { createHash } = require('crypto');
const db = require('./db');
const languages = require('./utils/languages');
const { cacheNormalizedCards } = require('./utils/cardCache');
const { parseSetList } = require('./utils/setQuery');
const cardSearchSql = require('./utils/cardSearchSql');
const { parseCardRow, parseSqliteUtc, recordPrice, shouldSweepPrices, markPricesSwept } = require('./utils/priceHelpers');

const BASE = 'https://api.pokemontcgapi.com/v1';
const PREFIX = 'pokemontcgapi-';
const DAY = 24 * 60 * 60 * 1000;
// Two include lists, because prices are what cost credits. A 250-card page is one
// credit without them and about forty with them (measured against the live API on
// 10 Sep 2026: limit 5 with prices cost 4 credits, 50 cost 8, 250 cost 40; every
// size without prices cost 1). So browsing and searching ask for images and names
// only, and prices are fetched per card at the two moments the app shows a value:
// when a card enters the collection (hydrateCard) and in the automatic sweep over
// owned cards (updateCollectionPrices). On the 800-credit trial that is the
// difference between twenty searches and eight hundred.
const LIST_INCLUDE = 'images,translations';
const CARD_INCLUDE = 'images,prices,translations';
// How long a fetched price is current. getCardById and the sweep both read it, and
// the sweep selects on it in SQL, so it is one number: two that disagreed would
// have the sweep pick cards getCardById then refuses to refresh.
const PRICE_AGE_DAYS = 3;
const REGIONS = { en: 'WEST', ja: 'JP', 'zh-cn': 'CN' };
const client = axios.create({
  baseURL: BASE, timeout: 15000, maxRedirects: 0,
  headers: { Accept: 'application/json', 'User-Agent': `Bindarr/${require('../package.json').version}` },
  validateStatus: status => status === 200 || status === 304,
});
const hasKey = () => !!(process.env.POKEMONTCGAPI_KEY || '').trim();
const providerId = id => String(id || '').replace(/^pokemontcgapi-/, '');
const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const pending = new Map();
let pausedUntil = 0;

// Follow only cursors, never an arbitrary URL returned by an upstream. The API
// key belongs to this origin alone; redirects are disabled for the same reason.
function nextCursor(body, path) {
  if (!body.meta?.has_more) return null;
  let next;
  try { next = new URL(body.links?.next, BASE + '/'); }
  catch { throw new Error('UPSTREAM_UNAVAILABLE'); }
  if (next.origin !== new URL(BASE).origin || next.pathname !== '/v1' + path || !next.searchParams.get('cursor')) {
    throw new Error('UPSTREAM_UNAVAILABLE');
  }
  return next.searchParams.get('cursor');
}

async function request(path, params = {}, ttl = DAY) {
  const key = (process.env.POKEMONTCGAPI_KEY || '').trim();
  if (!key) throw new Error('POKEMONTCGAPI_KEY_REQUIRED');
  // A rotated key can have different plan visibility. Its digest scopes cached
  // responses without ever storing the credential itself in the database.
  const scope = createHash('sha256').update(key).digest('hex');
  const cacheKey = scope + path + '?' + new URLSearchParams(Object.entries(params).sort()).toString();
  if (pending.has(cacheKey)) return pending.get(cacheKey);
  const work = (async () => {
    const cached = await db.get('SELECT * FROM pokemontcgapi_cache WHERE request = ?', [cacheKey]);
    if (cached && Date.now() - cached.fetched_at < ttl) return JSON.parse(cached.body);
    if (Date.now() < pausedUntil) throw new Error('UPSTREAM_UNAVAILABLE');
    try {
      const response = await client.get(path, {
        params, headers: { 'X-Api-Key': key, ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}) },
      });
      if (response.status === 304 && !cached) throw new Error('UPSTREAM_UNAVAILABLE');
      const body = response.status === 304 ? JSON.parse(cached.body) : response.data;
      if (!body || typeof body !== 'object') throw new Error('UPSTREAM_UNAVAILABLE');
      await db.run(`INSERT INTO pokemontcgapi_cache (request, body, etag, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(request) DO UPDATE SET body = excluded.body, etag = excluded.etag, fetched_at = excluded.fetched_at`,
      [cacheKey, JSON.stringify(body), response.status === 304 ? cached.etag : response.headers.etag || null, Date.now()]);
      // Bound the response cache separately from card_cache, which holds the
      // durable card identity. Eviction only means re-fetching a page later.
      await db.run(`DELETE FROM pokemontcgapi_cache WHERE request IN (
        SELECT request FROM pokemontcgapi_cache ORDER BY fetched_at DESC LIMIT -1 OFFSET 1024)`);
      return body;
    } catch (error) {
      const status = error.response?.status;
      if (status === 429) {
        const retry = error.response.headers?.['retry-after'];
        const seconds = Number(retry);
        const delay = retry && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
        pausedUntil = Date.now() + Math.max(60000, Number.isFinite(delay) ? delay : 60000);
      }
      // Do not propagate Axios errors: their config carries X-Api-Key, and
      // several route handlers log the whole error object.
      throw new Error(status === 404 ? 'CARD_NOT_FOUND' : status === 401 ? 'POKEMONTCGAPI_KEY_INVALID' : 'UPSTREAM_UNAVAILABLE');
    }
  })();
  pending.set(cacheKey, work);
  try { return await work; } finally { pending.delete(cacheKey); }
}

async function* pages(path, params) {
  let cursor;
  const seen = new Set();
  do {
    const body = await request(path, { ...params, limit: 250, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(body.data)) throw new Error('UPSTREAM_UNAVAILABLE');
    yield body.data;
    cursor = nextCursor(body, path);
    if (cursor && seen.has(cursor)) throw new Error('UPSTREAM_UNAVAILABLE');
    if (cursor) seen.add(cursor);
  } while (cursor);
}

// A quote for a slab, another locale or a different currency is not a fallback
// for this raw card. Pick one source first, then fill every printing column
// from that source alone; resolveCardPrice assumes they share price_currency.
function extractPrices(prices, lang = 'en') {
  // `undefined` means the response was asked WITHOUT prices (a listing page), which
  // is not the same as a card nobody quotes (an empty array). The first is unknown
  // and stays null so hydrateCard knows to fetch it; the second is a genuine zero.
  if (prices === undefined) {
    return {
      price_trend: null, price_normal: null, price_holofoil: null, price_reverse_holofoil: null,
      price_avg1: null, price_avg7: null, price_avg30: null, price_currency: null, price_source: 'pokemontcgapi',
    };
  }
  const code = languages.toCode(lang);
  const eligible = prices.filter(p => !p.grading && p.variant !== 'MEDIAN_GRADED' &&
    Number.isFinite(p.amount) && p.amount > 0 && (!p.locale || p.locale.toLowerCase() === code) &&
    (!p.condition || ['MINT', 'NEAR_MINT'].includes(p.condition)));
  const preference = ['TREND', 'MARKET', 'LOW', 'AVG_7D', 'AVG_30D', 'AVG_1D'];
  const rank = p => preference.indexOf(p.variant);
  const candidates = eligible.filter(p => rank(p) >= 0 && (!p.printing || ['NORMAL', 'HOLOFOIL', 'REVERSE_HOLO'].includes(p.printing))).sort((a, b) => rank(a) - rank(b) || String(b.as_of).localeCompare(String(a.as_of)));
  const cm = candidates.filter(p => p.source === 'CARDMARKET' && p.currency === 'EUR');
  const tp = candidates.filter(p => p.source === 'TCGPLAYER' && p.currency === 'USD');
  const rows = cm.length ? cm : tp;
  const representative = rows.find(p => !p.printing || ['NORMAL', 'HOLOFOIL', 'REVERSE_HOLO'].includes(p.printing));
  const printing = value => rows.find(p => p.printing === value)?.amount ?? null;
  const average = variant => rows.find(p => p.variant === variant && p.printing === representative?.printing)?.amount ?? null;
  return {
    price_trend: representative?.amount ?? 0,
    price_normal: printing('NORMAL'), price_holofoil: printing('HOLOFOIL'),
    price_reverse_holofoil: printing('REVERSE_HOLO'),
    price_avg1: average('AVG_1D'), price_avg7: average('AVG_7D'), price_avg30: average('AVG_30D'),
    price_currency: cm.length ? 'EUR' : 'USD',
    price_source: rows.length ? `pokemontcgapi-${cm.length ? 'cardmarket' : 'tcgplayer'}` : 'pokemontcgapi',
  };
}

function languageOf(card) {
  if (card.print_region === 'JP') return 'ja';
  if (card.print_region === 'CN') return 'zh-cn';
  return 'en';
}

function normalizeCard(card) {
  if (!card || typeof card.id !== 'string' || !card.id || typeof card.set_code !== 'string' || !card.set_code || !['WEST', 'JP', 'CN'].includes(card.print_region)) throw new Error('UPSTREAM_UNAVAILABLE');
  const code = languageOf(card);
  const translated = locale => (card.translations || []).find(t => t.locale === locale)?.name;
  const images = (card.images || []).filter(i => i.face === 'FRONT' && (!i.locale || i.locale === code));
  images.sort((a, b) => (a.locale === code ? 0 : 1) - (b.locale === code ? 0 : 1) ||
    ['LARGE', 'NORMAL', 'SMALL'].indexOf(a.size) - ['LARGE', 'NORMAL', 'SMALL'].indexOf(b.size));
  return {
    id: PREFIX + card.id, name: translated('en') || card.name || '',
    printed_name: translated(code) || card.name || '',
    supertype: card.supertype || '', subtypes: card.subtypes || [], types: card.types || [],
    rarity: card.rarity || '', number: String(card.number ?? ''),
    set_id: PREFIX + card.set_code, set_name: card.set_name || '', image_url: images[0]?.url || '',
    game: 'pokemon', language: languages.toName(code), cmc: null, color_identity: [],
    ...extractPrices(card.prices, code),
    tcgplayer_product_id: card.tcgplayer_id || null,
    tcgplayer_url: card.tcgplayer_id ? `https://www.tcgplayer.com/product/${card.tcgplayer_id}` : null,
    cardmarket_url: card.cardmarket_id ? `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${card.cardmarket_id}` : null,
  };
}
const cacheCards = cards => cacheNormalizedCards(cards, 'pokemon');

// Listing rows carry no prices. A price already in card_cache came from a detail
// fetch or the sweep and cost credits; the upsert would reset it to null, so the
// stored price columns are copied onto the incoming row first. Its last_updated is
// put back too: that timestamp is how the sweep tells a stale price from a fresh
// one, and a listing that bumped it would make a browsed card's ten-day-old price
// look refreshed, so the sweep would never ask about the cards the user looks at.
const PRICE_COLUMNS = ['price_trend', 'price_normal', 'price_holofoil', 'price_reverse_holofoil',
  'price_avg1', 'price_avg7', 'price_avg30', 'price_currency', 'price_source'];
async function cacheListedCards(cards) {
  if (!cards.length) return;
  const kept = new Map();
  for (let i = 0; i < cards.length; i += 200) {
    const ids = cards.slice(i, i + 200).map(c => c.id);
    const rows = await db.all(`SELECT id, last_updated, ${PRICE_COLUMNS.join(', ')} FROM card_cache
      WHERE price_trend IS NOT NULL AND id IN (${ids.map(() => '?').join(', ')})`, ids);
    for (const row of rows) kept.set(row.id, row);
  }
  await cacheCards(cards.map(c => (kept.has(c.id) ? { ...c, ...kept.get(c.id) } : c)));
  for (const [id, row] of kept) {
    if (row.last_updated) await db.run('UPDATE card_cache SET last_updated = ? WHERE id = ?', [row.last_updated, id]);
  }
}

// Called when a card enters the collection: the one moment a browsed card needs a
// price. A row that already carries one is left alone; a listing row (price_trend
// null) is fetched in full, which costs two credits for that card only.
async function hydrateCard(id) {
  if (!String(id).startsWith(PREFIX)) return;
  const cached = await db.get('SELECT price_trend FROM card_cache WHERE id = ?', [id]);
  if (cached && cached.price_trend != null) return;
  await getCardById(id, { refresh: true });
}

async function listSets(lang = 'en') {
  const region = REGIONS[languages.toCode(lang)];
  if (!region) return [];
  const sets = [];
  for await (const rows of pages('/sets', { region, orderBy: 'release_date' })) {
    for (const s of rows) sets.push({
      id: PREFIX + s.code, name: s.name, series: s.series || '',
      printed_total: s.printed_total || 0, total: s.total || 0,
      release_date: String(s.release_date || '').replace(/-/g, '/'),
      ptcgo_code: s.ptcgo_code || '', symbol_url: s.symbol_url || '', logo_url: s.logo_url || '', game: 'pokemon',
    });
  }
  return sets;
}

async function fetchAndCacheSets() {
  try {
    const sets = await listSets('en');
    if (!sets.length) throw new Error('UPSTREAM_UNAVAILABLE');
    for (const s of sets) {
      await db.run(`INSERT OR REPLACE INTO sets
        (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pokemon')`,
      [s.id, s.name, s.series, s.printed_total, s.total, s.release_date, s.ptcgo_code, s.symbol_url, s.logo_url]);
    }
    await require('./utils/setCatalogue').pruneStaleSets(sets.map(s => s.id), 'pokemontcgapi');
  } catch (error) {
    // An unavailable catalogue must not abort startup or the other games' sync.
    console.warn('pokemontcgapi set sync:', error.message);
  }
}

async function getCardsBySet(set, lang = 'en') {
  const region = REGIONS[languages.toCode(lang)];
  if (!region) return [];
  const cards = [];
  for await (const rows of pages('/cards', { set: providerId(set), include: LIST_INCLUDE, orderBy: 'number' })) {
    const normalized = rows.filter(c => c.print_region === region).map(normalizeCard);
    await cacheListedCards(normalized);
    cards.push(...normalized);
  }
  return cards;
}

async function searchCards({ name = '', number = '', set = '', scope = 'database', userId = null, lang = 'en', page = 1, limit = 60 } = {}) {
  const code = languages.toCode(lang);
  page = Math.max(1, Math.floor(Number(page) || 1));
  limit = Math.max(1, Math.min(250, Math.floor(Number(limit) || 60)));
  const offset = (page - 1) * limit;
  name = String(name).trim();
  number = String(number).trim().replace(/^#/, '').split('/')[0].trim();
  const setList = parseSetList(set);
  const opts = { userId, name, number, setList, limit, offset, language: languages.toName(code) };
  if (scope === 'collection') {
    if (!userId) return { cards: [], total: 0 };
    const query = cardSearchSql.collectionQuery('pokemon', opts);
    return { cards: (await db.all(query.sql, query.params)).map(parseCardRow), total: null };
  }
  const local = async () => {
    const query = cardSearchSql.localCacheQuery('pokemon', opts);
    // Provider scope must be applied BEFORE LIMIT/OFFSET, or another provider's
    // rows consume the page and make a non-empty cache appear empty.
    query.sql = query.sql.replace(' LIMIT ?', ` AND id LIKE 'pokemontcgapi-%' LIMIT ?`);
    return (await db.all(query.sql, query.params)).map(parseCardRow);
  };
  if (scope !== 'internet') {
    const cached = await local();
    if (cached.length) return { cards: cached, total: null };
  }
  if (!REGIONS[code] || (!name && !setList.length)) return { cards: [], total: 0 };
  try {
    const params = { include: LIST_INCLUDE, orderBy: 'id', lang: code === 'ja' ? 'ja' : 'en' };
    if (setList.length) params.set = setList.map(providerId).join(',');
    if (name) params.q = `name:${quote(name)}`;
    const matches = [];
    // lang changes a NAME, not the physical printing. Cards have no documented
    // region query parameter, so filter print_region before slicing UI pages.
    // Full 250-card pages are reused from the response cache on Load more.
    for await (const rows of pages('/cards', params)) {
      const normalized = rows.filter(c => c.print_region === REGIONS[code]).map(normalizeCard);
      await cacheListedCards(normalized);
      for (const card of normalized) {
        if (!number || card.number === number || (/^\d+$/.test(number) && /^\d+$/.test(card.number) && Number(card.number) === Number(number))) matches.push(card);
      }
      if (matches.length >= offset + limit) return { cards: matches.slice(offset, offset + limit), total: null };
    }
    return { cards: matches.slice(offset, offset + limit), total: matches.length };
  } catch (error) {
    const cached = await local();
    if (cached.length) return { cards: cached, total: null };
    throw error;
  }
}

async function getCardById(id, { refresh = false } = {}) {
  if (!String(id).startsWith(PREFIX)) return null;
  const cached = await db.get('SELECT * FROM card_cache WHERE id = ?', [id]);
  // A fresh row still counts as stale when it never had prices: it came from a
  // listing page, and the inspector asking for this one card is what a detail
  // fetch is for.
  if (!refresh && cached && cached.price_trend != null && Date.now() - parseSqliteUtc(cached.last_updated).getTime() < PRICE_AGE_DAYS * DAY) return parseCardRow(cached);
  try {
    const raw = await request(`/cards/${encodeURIComponent(providerId(id))}`, { include: CARD_INCLUDE });
    const card = normalizeCard(raw);
    await cacheCards([card]);
    return card;
  } catch (error) {
    if (cached) return parseCardRow(cached);
    if (error.message === 'CARD_NOT_FOUND') return null;
    throw error;
  }
}

// The automatic price sweep. Two gates, neither of them this module's to override:
//
// shouldSweepPrices is the admin's cadence (Admin → Instance Settings → Refresh
// prices, app_settings.price_refresh_days; 0 switches automatic refreshes off).
// server.js ticks hourly and unforced, so this is consulted on every tick and is
// the only thing deciding whether a sweep is due. There is no `force` parameter:
// the one this used to take let the timer skip the gate, which on a metered
// provider is a bill the admin cannot turn down.
//
// Then, within a due sweep, only cards whose stored price is actually stale are
// asked about: never priced (a listing row that entered the collection while the
// quota was exhausted), or older than PRICE_AGE_DAYS. A card refreshed yesterday
// costs nothing today. Owned and decked cards only; a browsed card is never paid for.
async function updateCollectionPrices() {
  const provider = require('./utils/pokemonProvider');
  if (!hasKey() || await provider.configured() !== provider.POKEMONTCGAPI) return;
  if (!await shouldSweepPrices('pokemontcgapi')) return;
  try {
    const owned = await db.all(`SELECT id FROM card_cache WHERE id LIKE 'pokemontcgapi-%'
      AND id IN (SELECT card_id FROM collection UNION SELECT card_id FROM deck_cards)
      AND (price_trend IS NULL OR last_updated IS NULL OR last_updated <= datetime('now', '-${PRICE_AGE_DAYS} days'))`);
    if (!owned.length) {
      await markPricesSwept('pokemontcgapi');
      return;
    }
    // Bounded OR groups stay under the query complexity limit. No per-card
    // detail requests and no whole-set sweep just to refresh one owned card.
    for (let i = 0; i < owned.length; i += 25) {
      const q = owned.slice(i, i + 25).map(c => `id:${quote(providerId(c.id))}`).join(' OR ');
      for await (const rows of pages('/cards', { q, include: CARD_INCLUDE })) {
        const cards = rows.map(normalizeCard);
        await cacheCards(cards);
        for (const card of cards) await recordPrice(card.id, card.price_trend);
      }
    }
    await markPricesSwept('pokemontcgapi');
  } catch (error) {
    console.warn('pokemontcgapi price refresh:', error.message);
  }
}

module.exports = { client, hasKey, providerId, normalizeCard, extractPrices, cacheCards, listSets, fetchAndCacheSets,
  getCardsBySet, searchCards, getCardById, hydrateCard, updateCollectionPrices, LIST_INCLUDE, CARD_INCLUDE };
