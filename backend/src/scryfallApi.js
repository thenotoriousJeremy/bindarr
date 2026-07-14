const axios = require('axios');
const db = require('./db');
const { parseCardRow } = require('./utils/priceHelpers');

// Scryfall needs no API key but asks callers to identify themselves and accept
// JSON. See https://scryfall.com/docs/api. IDs from Scryfall are UUIDs / set-num
// slugs; we prefix them with "mtg-" so they never collide with Pokémon TCG ids
// in the shared card_cache table and the game is derivable from the id.
const client = axios.create({
  baseURL: 'https://api.scryfall.com',
  timeout: 6000,
  headers: { 'User-Agent': 'Bindarr/1.0', 'Accept': 'application/json' }
});

// Scryfall asks for ~10 requests/second and 429s aggressively on bursts. Search,
// per-set fetches, and the background price refresh all hit it and can run
// concurrently, so serialize EVERY request through one queue with a minimum gap.
// A global limiter beats the per-caller delays that don't see each other.
const SCRYFALL_MIN_GAP_MS = 120;
let scryfallQueue = Promise.resolve();
let lastScryfallAt = 0;
function scryGet(url, config) {
  const run = scryfallQueue.then(async () => {
    const wait = SCRYFALL_MIN_GAP_MS - (Date.now() - lastScryfallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastScryfallAt = Date.now();
    return client.get(url, config);
  });
  // Keep the chain alive regardless of this request's outcome.
  scryfallQueue = run.then(() => {}, () => {});
  return run;
}

const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const CACHE_AGE_LIMIT_MS = 1000 * 60 * 60 * 24 * 3; // 3 days

// Maps a raw Scryfall card onto the card_cache shape the rest of the app (and
// the Pokémon path) already speaks. Double-faced cards carry their art/type on
// card_faces[0] instead of the top level, so fall back to the front face.
function normalizeCard(raw, lang) {
  const face = (!raw.image_uris && Array.isArray(raw.card_faces) && raw.card_faces.length)
    ? raw.card_faces[0]
    : raw;
  const imgSrc = raw.image_uris || face.image_uris || {};
  const typeLine = raw.type_line || face.type_line || '';
  const colors = raw.colors || face.colors || [];
  const prices = raw.prices || {};
  const usd = prices.usd != null ? parseFloat(prices.usd) : null;
  const usdFoil = prices.usd_foil != null ? parseFloat(prices.usd_foil) : null;
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
    // Transient (not a card_cache column) — the printing's language, used by the
    // scanner/quick-add form. Defaults to English.
    language: (lang && lang.toLowerCase() === 'ja') ? 'Japanese' : 'English'
  };
}

async function cacheCards(cards) {
  for (const c of cards) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache
       (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, price_normal, price_holofoil, price_reverse_holofoil, cmc, color_identity, game, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        c.id, c.name, c.supertype,
        JSON.stringify(c.subtypes || []), JSON.stringify(c.types || []),
        c.rarity, c.set_id, c.set_name, c.number, c.image_url,
        c.price_trend, c.price_normal, c.price_holofoil, c.price_reverse_holofoil, c.cmc, JSON.stringify(c.color_identity || []), 'mtg'
      ]
    );
  }
}


async function fetchFromScryfall(q, lang, retries = 3) {
  let url = `/cards/search?q=${encodeURIComponent(q)}`;
  if (lang) url += `&lang=${lang.toLowerCase() === 'ja' ? 'ja' : encodeURIComponent(lang)}`;
  
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await scryGet(url);
      return (resp.data && resp.data.data) || [];
    } catch (error) {
      if (error.response && error.response.status === 429 && i < retries - 1) {
        // Honor Retry-After when Scryfall sends it; else exponential backoff.
        const ra = parseInt(error.response.headers?.['retry-after'], 10);
        const backoff = Number.isFinite(ra) ? ra * 1000 : 1000 * (i + 1);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw error;
    }
  }
}

// Search MTG cards: local card_cache first (game='mtg'), then Scryfall. Mirrors
// the Pokémon searchCards contract so the route can dispatch on `game` alone.
async function searchCards(nameQuery = '', numberQuery = '', setQuery = '', scope = 'database', userId = null, lang = null, allPrints = false) {
  const cleanName = (nameQuery || '').trim();
  const cleanNumber = (numberQuery || '').trim();
  const cleanSet = (setQuery || '').trim();

  // Scanner path: identify-by-image knows the card but not the printing, so it
  // asks for every printing of an exact name (Scryfall collapses to one printing
  // by default — `unique:prints` returns them all) and lets the user pick the set.
  if (allPrints && cleanName && scope !== 'collection') {
    try {
      // A set code narrows to that printing (exact, usually one result -> fast
      // path in the scanner); without it, return every printing to pick from.
      const q = cleanSet ? `!"${cleanName}" set:${cleanSet} unique:prints` : `!"${cleanName}" unique:prints`;
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
  // A non-English request must bypass the cache: a cached English printing would
  // otherwise shadow the localized card the caller asked for.
  const isForeign = lang && !['en', 'english'].includes(lang.toLowerCase());

  // 1. Collection-only search
  if (scope === 'collection') {
    if (!userId) return [];
    let sql = `
      SELECT cc.*, SUM(c.quantity) AS owned_qty
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ? AND c.list_type = 'collection' AND cc.game = 'mtg'
    `;
    const params = [userId];
    if (cleanName) { sql += ` AND cc.name LIKE ?`; params.push(`%${cleanName}%`); }
    if (cleanNumber) { sql += ` AND (cc.number = ? OR CAST(cc.number AS INTEGER) = CAST(? AS INTEGER))`; params.push(cleanNumber, cleanNumber); }
    if (cleanSet) { sql += ` AND (cc.set_name LIKE ? OR cc.set_id = ?)`; params.push(`%${cleanSet}%`, cleanSet); }
    sql += ` GROUP BY cc.id LIMIT 50`;
    return (await db.all(sql, params)).map(parseCardRow);
  }

  // 2. Local cache first
  let localResults = [];
  if (scope !== 'internet' && !isForeign) {
    let sql = `SELECT * FROM card_cache WHERE game = 'mtg'`;
    const params = [];
    if (cleanName) { sql += ` AND name LIKE ?`; params.push(`%${cleanName}%`); }
    if (cleanNumber) { sql += ` AND (number = ? OR CAST(number AS INTEGER) = CAST(? AS INTEGER))`; params.push(cleanNumber, cleanNumber); }
    if (cleanSet) { sql += ` AND (set_name LIKE ? OR set_id = ?)`; params.push(`%${cleanSet}%`, cleanSet); }
    sql += ` LIMIT 50`;

    localResults = await db.all(sql, params);
    if (localResults.length > 0) {
      // Refresh stale prices in the background; return the cached rows instantly.
      const stale = localResults.filter(r => (Date.now() - new Date(r.last_updated).getTime()) > CACHE_AGE_LIMIT_MS);
      if (stale.length > 0) {
        (async () => {
          try {
            for (const row of stale) {
              const raw = await fetchFromScryfall(row.name);
              if (raw.length) await cacheCards(raw.map(c => normalizeCard(c)));
              // Scryfall asks callers to space requests ~50-100ms apart.
              await new Promise(r => setTimeout(r, 120));
            }
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
  const specificQuery = (cleanSet && strippedNumber) ? `set:${cleanSet} cn:${strippedNumber}`
    : (cleanName && strippedNumber) ? `${cleanName} cn:${strippedNumber}`
    : null;
  const broadQuery = cleanName || null;
  // Last resort: first word only (e.g. "Adamant" from "Adamant Will")
  const firstWord = cleanName.split(/\s+/)[0];
  const fallbackQuery = (firstWord && firstWord !== cleanName) ? firstWord : null;

  // Helper: try a Scryfall query, return [] on 404/error.
  const tryQuery = async (q) => {
    if (!q) return [];
    try {
      const raw = await fetchFromScryfall(q, lang);
      return raw.map(c => normalizeCard(c, lang));
    } catch (err) {
      if (err.response && err.response.status === 404) return [];
      throw err; // real error (rate limit, network) — bubble up
    }
  };

  try {
    let exact = await tryQuery(specificQuery);
    // Scryfall asks callers to space requests ~50-100ms apart.
    if (specificQuery && broadQuery && broadQuery !== specificQuery) await new Promise(r => setTimeout(r, 120));
    let broad = (broadQuery && broadQuery !== specificQuery) ? await tryQuery(broadQuery) : [];

    // If both empty, try first-word fallback.
    if (exact.length === 0 && broad.length === 0 && fallbackQuery) {
      broad = await tryQuery(fallbackQuery);
    }

    // Merge: exact matches first, then broad alternatives deduped.
    const seen = new Set(exact.map(c => c.id));
    const merged = [...exact, ...broad.filter(c => !seen.has(c.id))];
    if (merged.length === 0) return localResults.map(parseCardRow);

    const cards = merged.slice(0, 50);
    // Sort alternatives (after exact) by collector number.
    const exactIds = new Set(exact.map(c => c.id));
    cards.sort((a, b) => {
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
    return localResults.map(parseCardRow);
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
async function updateCollectionPrices() {
  try {
    const cards = await db.all(`
      SELECT DISTINCT c.card_id, cc.set_id, cc.number, cc.name FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id WHERE cc.game = 'mtg'
      UNION
      SELECT DISTINCT d.card_id, cc.set_id, cc.number, cc.name FROM deck_cards d
      JOIN card_cache cc ON d.card_id = cc.id WHERE cc.game = 'mtg'
    `);
    if (cards.length === 0) return;
    console.log(`Starting MTG price update for ${cards.length} unique cards...`);
    for (const row of cards) {
      try {
        const raw = (row.set_id && row.number)
          ? await fetchFromScryfall(`set:${row.set_id} cn:${row.number}`)
          : await fetchFromScryfall(row.name || '');
        if (raw.length) {
          const norm = normalizeCard(raw[0]);
          await cacheCards([norm]);
          if (norm.price_trend > 0) {
            await db.run(`INSERT INTO price_history (card_id, price) VALUES (?, ?)`, [row.card_id, norm.price_trend]);
          }
        }
      } catch (e) {
        console.error(`Failed to update MTG price for ${row.card_id}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    console.log('MTG price update complete.');
  } catch (err) {
    console.error('Error during MTG price update:', err.message);
  }
}

module.exports = { searchCards, normalizeCard, cacheCards, getCardsBySet, fetchAndCacheSets, updateCollectionPrices };
