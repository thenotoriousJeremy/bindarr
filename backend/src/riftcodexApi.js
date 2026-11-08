// Riftbound — Riot Games' League of Legends trading card game, published by UVS
// Games — from RiftCodex (https://riftcodex.com), a free community API with no key.
//
// The whole catalogue is about 1.5k cards, so it is fetched whole (pages of 100,
// the API's limit) and cached in card_cache, and search reads the cache, never
// the API. Same shape as the Lorcana provider (lorcastApi), minus prices:
// RiftCodex carries none. They come from TCGplayer through TCGCSV
// (riftboundPrices.js), matched on the product id each card names.
//
// When the catalogue is fetched: lazily, the first time anything needs a
// Riftbound card or set (a search, the set list, an id, a catalog build), then by
// the weekly set refresh in server.js — and only on an install that has used
// Riftbound at all. Startup asks RiftCodex for nothing.
//
// CARD IDS are `riftbound-` plus the card's riftbound_id, which is its printed
// code: set, collector number WITH the printing suffix, set size —
// 'unl-229*-219' is the signature printing of UNL 229, 'unl-116a-219' an
// alternate art. `*` is the one character in it that is not safe everywhere an id
// travels, so every character outside [a-z0-9-] is written as '.' plus its hex
// UTF-8 bytes ('*' -> '.2a'): 'riftbound-unl-229.2a-219'. That round-trips any
// riftbound_id, survives Express params, SQLite, CSV and share URLs untouched,
// and never produces '~', which separates the collision suffix below.
//
// COLLISIONS. Two RiftCodex records can share a riftbound_id, and they are not
// all the same thing:
//
//   * The same printing listed twice. 95 Vendetta codes have an older record
//     with no TCGplayer product next to a newer one that has it, identical in
//     everything a card shows. They are one printing: the more complete record is
//     kept and the other dropped.
//   * Different printings of one code. The OPP promos and their Metal printings
//     share a code and an image and differ by product — and the Metal can be worth
//     a hundred times the plain promo. Each keeps its own row. The canonical one
//     (listed on TCGplayer, then no printing marker in its name, then the oldest
//     RiftCodex id) keeps the plain id; every other gets '~' plus its RiftCodex id.
//
// Printings are never merged by name: names repeat across printings by design.
const axios = require('axios');
const db = require('./db');
const { parseCardRow } = require('./utils/priceHelpers');
const { parseSetList } = require('./utils/setQuery');
const cardSearchSql = require('./utils/cardSearchSql');
const { cacheNormalizedCards } = require('./utils/cardCache');

const GAME = 'riftbound';
const ID_PREFIX = 'riftbound-';
const SET_PREFIX = 'riftbound-';
const BASE_URL = (process.env.RIFTCODEX_BASE_URL || 'https://api.riftcodex.com').replace(/\/+$/, '');
// The API's own maximum page size; asking for more is a 422.
const PAGE_SIZE = 100;
// A ceiling, not an estimate: 100 pages is 10k cards against today's ~1.5k.
const MAX_PAGES = 100;
// An uncached id may mean a card newer than the cache, so it can refresh — but
// at most this often, or every request for an id RiftCodex never had would cost
// the whole catalogue.
const MISS_REFRESH_MS = 60 * 60 * 1000;

const { version } = require('../package.json');
const USER_AGENT = `Bindarr/${version} (+https://github.com/thenotoriousJeremy/bindarr)`;

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
});

// One request at a time, a short gap between them, and a pause on 429. It is a
// free community service; a catalogue refresh is ~16 requests and has all day.
const MIN_GAP_MS = Number(process.env.RIFTCODEX_GAP_MS ?? 150);
let queue = Promise.resolve();
let lastAt = 0;
let cooldownUntil = 0;

function get(path, config) {
  const run = queue.then(async () => {
    for (;;) {
      const wait = Math.max(cooldownUntil - Date.now(), MIN_GAP_MS - (Date.now() - lastAt), 0);
      if (wait <= 0) break;
      await new Promise(r => setTimeout(r, wait));
    }
    lastAt = Date.now();
    try {
      return await client.get(path, config);
    } catch (error) {
      if (error.response && error.response.status === 429) {
        const ra = parseInt(error.response.headers?.['retry-after'], 10);
        cooldownUntil = Date.now() + (Number.isFinite(ra) ? ra * 1000 : 30000);
        console.warn(`RiftCodex rate-limited us — pausing for ${Math.round((cooldownUntil - Date.now()) / 1000)}s.`);
      }
      throw error;
    }
  });
  queue = run.then(() => {}, () => {});
  return run;
}

// --- ids -----------------------------------------------------------------------

const SAFE = /^[a-z0-9-]$/;

function encodeCode(riftboundId) {
  let out = '';
  for (const ch of String(riftboundId || '').trim().toLowerCase()) {
    if (SAFE.test(ch)) out += ch;
    else for (const byte of Buffer.from(ch, 'utf8')) out += `.${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

function decodeCode(code) {
  const bytes = [];
  const s = String(code || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '.') {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      if (!SAFE.test(s[i])) return null;
      bytes.push(s.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// The Bindarr card id for a riftbound_id, and for the non-canonical printing of a
// shared code, the RiftCodex record id that tells it apart.
const cardIdFor = (riftboundId, variant) =>
  `${ID_PREFIX}${encodeCode(riftboundId)}${variant ? `~${encodeCode(variant)}` : ''}`;

// The inverse: { riftboundId, variant } or null when the id is not one of ours.
function parseCardId(cardId) {
  const s = String(cardId || '');
  if (!s.startsWith(ID_PREFIX)) return null;
  const [code, variant, extra] = s.slice(ID_PREFIX.length).split('~');
  if (!code || extra !== undefined) return null;
  const riftboundId = decodeCode(code);
  const variantId = variant === undefined ? null : decodeCode(variant);
  if (!riftboundId || (variant !== undefined && !variantId)) return null;
  return { riftboundId, variant: variantId };
}

// The printed collector number, printing suffix included: the middle of the code.
// 'unl-229*-219' -> '229*', 'unl-116a-219' -> '116a', 'sfd-t03' -> 't03'.
function numberOf(riftboundId) {
  const parts = String(riftboundId || '').trim().toLowerCase().split('-');
  if (parts.length >= 3) return parts.slice(1, -1).join('-');
  return parts.length === 2 ? parts[1] : (parts[0] || '');
}

// --- images ----------------------------------------------------------------------

// RiftCodex links Riot's own card art on cmsassets.rgpub.io, a Sanity image CDN:
// a 744x1039 PNG of about 800 KB, which is too much for a card grid. That CDN
// resizes on request, so the cached url asks for a 480px WebP (~40 KB) — the
// same reasoning that has TCGdex rows store low.png — and the catalog build asks
// for the full width (embedImageUrl). Riot's asset, Riot's CDN, Riot's resizing.
const RIOT_IMAGE_HOST = 'cmsassets.rgpub.io';
function withWidth(url, width) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.hostname !== RIOT_IMAGE_HOST) return url;
    u.searchParams.set('w', String(width));
    u.searchParams.set('fm', 'webp');
    return u.toString();
  } catch {
    return url;
  }
}
const displayImageUrl = (url) => withWidth(url, 480);
const embedImageUrl = (url) => withWidth(url, 744);

// --- normalization -----------------------------------------------------------------

// A printing marker at the end of a name: '(Signature)', '(Alternate Art)', '(Metal)'.
const PRINTING_MARKER = /\s*\([^()]*\)\s*$/;
const hasPrintingMarker = (name) => PRINTING_MARKER.test(String(name || ''));

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function normalizeCard(raw, id) {
  const cls = raw.classification || {};
  const attrs = raw.attributes || {};
  const domains = (Array.isArray(cls.domain) ? cls.domain : []).filter(Boolean);
  const tags = (Array.isArray(raw.tags) ? raw.tags : []).filter(Boolean);
  const setCode = String(raw.set?.set_id || String(raw.riftbound_id || '').split('-')[0] || '').toLowerCase();
  const productId = num(raw.tcgplayer_id);
  const stats = {};
  for (const key of ['energy', 'might', 'power']) if (num(attrs[key]) != null) stats[key] = num(attrs[key]);
  return {
    id,
    name: raw.name || '',
    // The card type ('Legend', 'Unit', 'Spell', 'Gear', 'Rune', 'Battlefield').
    supertype: cls.type || '',
    // RiftCodex's own supertype ('Champion', 'Signature', 'Token', 'Basic') first,
    // then the tags (champion names, regions, kinds). Deck rules read both.
    subtypes: [...(cls.supertype ? [cls.supertype] : []), ...tags],
    // Domains are Riftbound's colours, kept where Lorcana keeps its inks: `types`
    // drives the type filter and charts, `color_identity` the colour sorts.
    types: domains,
    color_identity: domains,
    rarity: cls.rarity || 'Common',
    set_id: setCode ? `${SET_PREFIX}${setCode}` : '',
    set_name: raw.set?.label || '',
    number: numberOf(raw.riftbound_id),
    image_url: displayImageUrl(raw.media?.image_url || ''),
    // Battlefields are printed landscape; the UI turns them in portrait slots.
    orientation: raw.orientation === 'landscape' ? 'landscape' : 'portrait',
    artist: raw.media?.artist || null,
    card_text: raw.text?.plain || null,
    attributes: Object.keys(stats).length ? stats : null,
    cmc: num(attrs.energy),
    // No prices from RiftCodex. Null, never 0: a zero is a price, and the sweep
    // (riftboundPrices.js) fills these from TCGplayer by product id.
    price_trend: null,
    price_normal: null,
    price_holofoil: null,
    price_reverse_holofoil: null,
    price_avg1: null,
    price_avg7: null,
    price_avg30: null,
    price_currency: 'USD',
    price_source: null,
    tcgplayer_product_id: productId,
    tcgplayer_url: productId ? `https://www.tcgplayer.com/product/${productId}` : null,
    game: GAME,
    // RiftCodex is English-only.
    language: 'English',
    printed_name: null,
  };
}

// What a card shows, which two records must agree on to be one printing listed
// twice. Leaves out what a stale record lacks: its RiftCodex id, product id,
// flavour text and bookkeeping metadata.
const printingFace = (r) => JSON.stringify([
  r.name, r.media?.image_url, r.classification, r.attributes, r.text?.plain, r.orientation,
]);

const hasProduct = (r) => (r.tcgplayer_id ? 1 : 0);
const byCompleteness = (a, b) => (hasProduct(b) - hasProduct(a))
  || ((b.text?.flavour ? 1 : 0) - (a.text?.flavour ? 1 : 0))
  || String(a.id).localeCompare(String(b.id));
const byCanonical = (a, b) => (hasProduct(b) - hasProduct(a))
  || ((hasPrintingMarker(a.name) ? 1 : 0) - (hasPrintingMarker(b.name) ? 1 : 0))
  || String(a.id).localeCompare(String(b.id));

// RiftCodex records -> normalized cards with stable, unique ids. See the header
// for the two kinds of collision. Pure: the same records always give the same ids,
// whatever order the API returned them in.
function normalizeCatalogue(records) {
  const groups = new Map();
  const seen = new Set();
  for (const r of records || []) {
    if (!r || !r.id || !r.riftbound_id || seen.has(r.id)) continue;   // paging overlap
    seen.add(r.id);
    const code = String(r.riftbound_id).trim().toLowerCase();
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(r);
  }
  const out = [];
  for (const [code, group] of groups) {
    const printings = [];
    for (const r of [...group].sort(byCompleteness)) {
      if (!printings.some(p => printingFace(p) === printingFace(r))) printings.push(r);
    }
    printings.sort(byCanonical);
    printings.forEach((r, i) => out.push(normalizeCard(r, cardIdFor(code, i === 0 ? null : r.id))));
  }
  return out;
}

// --- fetching and caching ------------------------------------------------------------

// Every page of a paged RiftCodex listing. `pages` is what the API reports; when
// it reports nothing, a short or empty page ends the walk.
async function fetchAllPages(path) {
  const items = [];
  let pages = 1;
  let total = null;
  for (let page = 1; page <= pages && page <= MAX_PAGES; page++) {
    const { data } = await get(path, { params: { page, size: PAGE_SIZE } });
    if (!data || !Array.isArray(data.items)) throw new Error(`RiftCodex ${path} page ${page} is not a page of results`);
    items.push(...data.items);
    if (page === 1 && Number.isFinite(Number(data.total))) total = Number(data.total);
    const reported = Number(data.pages);
    pages = Number.isFinite(reported) && reported > 0
      ? reported
      : (data.items.length < PAGE_SIZE ? page : page + 1);
    if (!data.items.length) break;
  }
  const unique = new Set(items.map(i => i && i.id)).size;
  if (total != null && unique < total) {
    console.warn(`RiftCodex ${path}: walked ${unique} of ${total} records — the listing shifted while it was paged.`);
  }
  return items;
}

const cacheCards = (cards) => cacheNormalizedCards(cards, GAME, { keepPrices: true });

// Set rows for the `sets` table, from RiftCodex's set list plus any set the cards
// name that the list does not (it has lagged a new release before). `total` is
// what was cached, so the catalog panel's denominator compares like with like.
async function cacheSets(sets, cards) {
  const counts = new Map();
  const labels = new Map();
  for (const c of cards || []) {
    counts.set(c.set_id, (counts.get(c.set_id) || 0) + 1);
    if (c.set_name) labels.set(c.set_id, c.set_name);
  }
  const rows = new Map();
  for (const s of sets || []) {
    if (!s || !s.set_id) continue;
    const id = `${SET_PREFIX}${String(s.set_id).toLowerCase()}`;
    rows.set(id, { id, name: s.name || labels.get(id) || s.set_id, code: String(s.set_id).toUpperCase(),
      released: String(s.published_on || '').slice(0, 10), listed: num(s.card_count) });
  }
  for (const [id, name] of labels) {
    if (!rows.has(id)) rows.set(id, { id, name, code: id.slice(SET_PREFIX.length).toUpperCase(), released: '', listed: null });
  }
  for (const r of rows.values()) {
    const total = counts.get(r.id) ?? (await db.get(
      `SELECT COUNT(*) AS n FROM card_cache WHERE game = ? AND set_id = ?`, [GAME, r.id]
    )).n;
    await db.run(
      `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
       VALUES (?, ?, 'Riftbound', ?, ?, ?, ?, '', '', ?)`,
      [r.id, r.name, r.listed, total || null, r.released, r.code, GAME]
    );
  }
  return rows.size;
}

let refreshing = null;
let lastRefreshAt = 0;
let lastFailureAt = 0;
// After a failed fetch, an empty cache does not retry for this long: the set list
// and every search ask for the catalogue, and an unreachable RiftCodex should
// cost one attempt per few minutes, not one per page view.
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

// Fetch the whole catalogue and cache it. Concurrent callers share one fetch.
function refreshCatalogue() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const sets = await fetchAllPages('/sets');
    const cards = normalizeCatalogue(await fetchAllPages('/cards'));
    if (!cards.length) throw new Error('RiftCodex returned no cards');
    await cacheCards(cards);
    await cacheSets(sets, cards);
    lastRefreshAt = Date.now();
    console.log(`Riftbound: cached ${cards.length} cards in ${new Set(cards.map(c => c.set_id)).size} sets from RiftCodex.`);
    return cards.length;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Make sure there is a catalogue to read. Fetches only when none is cached, and
// fails — with the same codes the other providers use — only when none can be had.
async function ensureCatalogue() {
  const row = await db.get(`SELECT COUNT(*) AS n FROM card_cache WHERE game = ?`, [GAME]);
  if (row && row.n > 0) return;
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) throw new Error('UPSTREAM_UNAVAILABLE');
  try {
    await refreshCatalogue();
  } catch (e) {
    lastFailureAt = Date.now();
    console.error('Riftbound: could not fetch the RiftCodex catalogue:', e.message);
    if (e.response && e.response.status === 429) throw new Error('RATE_LIMIT_EXCEEDED');
    throw new Error('UPSTREAM_UNAVAILABLE');
  }
}

// The weekly set refresh. Sets and cards come together, and only for an install
// that has used Riftbound: one that never has would be asking a free service
// for ~16 pages a week that nothing reads. First use fetches it (ensureCatalogue).
async function fetchAndCacheSets(force = false) {
  try {
    const cached = await db.get(`SELECT COUNT(*) AS n FROM card_cache WHERE game = ?`, [GAME]);
    if (!cached || !cached.n) return;
    const have = await db.get(`SELECT COUNT(*) AS n FROM sets WHERE game = ?`, [GAME]);
    if (!force && have && have.n > 0) return;
    await refreshCatalogue();
  } catch (error) {
    console.error('Error refreshing the Riftbound catalogue from RiftCodex:', error.message);
  }
}

// --- reading ----------------------------------------------------------------------------

// Set tokens as typed ('UNL', 'unl', 'Unleashed') or as stored ('riftbound-unl').
const setTokens = (list) => list.flatMap(t => {
  const s = String(t).trim();
  return /^[a-z0-9]{2,6}$/i.test(s) ? [s, `${SET_PREFIX}${s.toLowerCase()}`] : [s];
});

// Search filters the frontend and API can pass: a domain, a card type, a
// rarity, or a RiftCodex supertype ('Champion', 'Signature', 'Token', 'Basic').
function filterClauses(filters = {}) {
  const parts = [];
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const domain = one(filters.domain);
  const type = one(filters.type);
  const rarity = one(filters.rarity);
  const supertype = one(filters.supertype);
  if (domain) parts.push({ clause: `cc.types LIKE ?`, params: [`%${JSON.stringify(String(domain))}%`] });
  if (type) parts.push({ clause: `cc.supertype = ? COLLATE NOCASE`, params: [String(type)] });
  if (rarity) parts.push({ clause: `cc.rarity = ? COLLATE NOCASE`, params: [String(rarity)] });
  if (supertype) parts.push({ clause: `cc.subtypes LIKE ?`, params: [`%${JSON.stringify(String(supertype))}%`] });
  return parts;
}

async function searchCards({
  name = '', number = '', set = '', scope = 'database', userId = null,
  page = 1, limit = 60, filters = {},
} = {}) {
  const offset = (Math.max(1, page) - 1) * limit;
  const cleanName = String(name || '').trim();
  const cleanNumber = String(number || '').trim();
  const setList = parseSetList(set);

  if (scope === 'collection') {
    if (!userId) return { cards: [], total: 0 };
    const { sql, params } = cardSearchSql.collectionQuery(GAME, {
      userId, name: cleanName, number: cleanNumber, setList: setTokens(setList), limit, offset,
    });
    return { cards: (await db.all(sql, params)).map(parseCardRow), total: null };
  }

  await ensureCatalogue();
  const where = ['cc.game = ?'];
  const params = [GAME];
  const parts = [
    cardSearchSql.nameClause('cc.', cleanName),
    cardSearchSql.numberClause('cc.number', cleanNumber),
    setList.length ? require('./utils/setQuery').setSqlFilter(setTokens(setList), 'cc') : null,
    ...filterClauses(filters),
  ];
  for (const part of parts) {
    if (!part) continue;
    where.push(part.clause);
    params.push(...part.params);
  }
  const from = `FROM card_cache cc LEFT JOIN sets s ON s.id = cc.set_id WHERE ${where.join(' AND ')}`;
  const total = (await db.get(`SELECT COUNT(*) AS n ${from}`, params)).n;
  // Newest set first, then the set's own order: collector number, printing suffix
  // after the base card ('229' before '229*' and '229a').
  const rows = await db.all(
    `SELECT cc.* ${from}
      ORDER BY COALESCE(s.release_date, '') DESC, cc.set_id, CAST(cc.number AS INTEGER), cc.number
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { cards: rows.map(parseCardRow), total };
}

async function getCardById(cardId) {
  const cached = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
  if (cached) return parseCardRow(cached);
  if (!parseCardId(cardId)) return null;
  // The catalogue is cached whole, so an id that is not in it is either newer
  // than the last refresh or not a card at all. Refresh at most hourly for this.
  if (Date.now() - lastRefreshAt < MISS_REFRESH_MS) return null;
  try {
    await refreshCatalogue();
  } catch (e) {
    console.warn(`Riftbound: could not refresh the catalogue for ${cardId}: ${e.message}`);
    return null;
  }
  const row = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
  return row ? parseCardRow(row) : null;
}

// Set codes in release order, for the catalog builder's walk.
async function listSetCodes() {
  await ensureCatalogue();
  const rows = await db.all(`SELECT id, ptcgo_code FROM sets WHERE game = ? ORDER BY release_date ASC`, [GAME]);
  return rows.map(r => String(r.ptcgo_code || r.id.slice(SET_PREFIX.length)).toLowerCase());
}

// One set's cached cards, for the catalog builder.
async function getCardsBySet(setCode) {
  await ensureCatalogue();
  const sid = `${SET_PREFIX}${String(setCode || '').toLowerCase().replace(/^riftbound-/, '')}`;
  const rows = await db.all(
    `SELECT * FROM card_cache WHERE game = ? AND LOWER(set_id) = ? ORDER BY CAST(number AS INTEGER), number`,
    [GAME, sid]
  );
  return rows.map(parseCardRow);
}

module.exports = {
  GAME,
  client,
  cardIdFor,
  parseCardId,
  encodeCode,
  decodeCode,
  numberOf,
  normalizeCard,
  normalizeCatalogue,
  displayImageUrl,
  embedImageUrl,
  fetchAllPages,
  refreshCatalogue,
  ensureCatalogue,
  fetchAndCacheSets,
  cacheCards,
  searchCards,
  getCardById,
  getCardsBySet,
  listSetCodes,
};
