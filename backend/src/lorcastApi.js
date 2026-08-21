const axios = require('axios');
const db = require('./db');
const { parseCardRow, recordPrice, shouldSweepPrices, markPricesSwept } = require('./utils/priceHelpers');
const { parseSetList } = require('./utils/setQuery');
const cardSearchSql = require('./utils/cardSearchSql');
const { cacheNormalizedCards } = require('./utils/cardCache');

const { version } = require('../package.json');
const USER_AGENT = `Bindarr/${version} (+https://github.com/thenotoriousJeremy/bindarr)`;

const client = axios.create({
  baseURL: 'https://api.lorcast.com/v0',
  timeout: 10000,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
  },
});

// Rate limiting: 60ms gap between outgoing Lorcast requests + 429 backoff
const LORCAST_MIN_GAP_MS = 60;
let lorcastQueue = Promise.resolve();
let lastLorcastAt = 0;
let cooldownUntil = 0;

function waitFor() {
  const now = Date.now();
  return Math.max(cooldownUntil - now, LORCAST_MIN_GAP_MS - (now - lastLorcastAt), 0);
}

function noteRateLimit(error) {
  if (!error.response || error.response.status !== 429) return false;
  const ra = parseInt(error.response.headers?.['retry-after'], 10);
  const waitMs = Number.isFinite(ra) ? ra * 1000 : 30000;
  const until = Date.now() + waitMs;
  if (until > cooldownUntil) {
    cooldownUntil = until;
    console.warn(`Lorcast rate-limited us — pausing all Lorcast traffic for ${Math.round(waitMs / 1000)}s.`);
  }
  return true;
}

function lorcastGet(url, config) {
  const run = lorcastQueue.then(async () => {
    for (let w = waitFor(); w > 0; w = waitFor()) {
      await new Promise(r => setTimeout(r, w));
    }
    lastLorcastAt = Date.now();
    try {
      return await client.get(url, config);
    } catch (error) {
      noteRateLimit(error);
      throw error;
    }
  });
  lorcastQueue = run.then(() => {}, () => {});
  return run;
}

async function lorcastGetRetried(url, config, retries = 3) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await lorcastGet(url, config);
    } catch (error) {
      lastError = error;
      if (error.response && error.response.status === 429 && i < retries - 1) continue;
      throw error;
    }
  }
  throw lastError;
}

function formatRarity(r) {
  if (!r) return 'Common';
  return String(r)
    .replace(/_/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function normalizeCard(raw) {
  const name = raw.name ? (raw.version ? `${raw.name} - ${raw.version}` : raw.name) : '';
  const supertype = (Array.isArray(raw.type) && raw.type.length) ? raw.type[0] : 'Character';
  const subtypes = [
    ...(Array.isArray(raw.type) ? raw.type.slice(1) : []),
    ...(Array.isArray(raw.classifications) ? raw.classifications : []),
  ];
  const inks = Array.isArray(raw.inks) && raw.inks.length ? raw.inks : (raw.ink ? [raw.ink] : []);
  const img = raw.image_uris?.digital?.normal || raw.image_uris?.digital?.large || raw.image_uris?.digital?.small || '';
  const prices = raw.prices || {};
  const usd = prices.usd != null ? parseFloat(prices.usd) : null;
  const usdFoil = prices.usd_foil != null ? parseFloat(prices.usd_foil) : null;
  const cost = raw.cost != null ? parseFloat(raw.cost) : null;
  const setCode = raw.set?.code ? String(raw.set.code).toLowerCase() : '';
  const setId = setCode ? `lorcana-${setCode}` : (raw.set?.id || '');

  return {
    id: `lorcana-${raw.id}`,
    name,
    supertype,
    subtypes,
    types: inks,
    rarity: formatRarity(raw.rarity),
    set_id: setId,
    set_name: raw.set?.name || '',
    number: raw.collector_number != null ? String(raw.collector_number) : '',
    image_url: img,
    price_trend: usd != null ? usd : (usdFoil != null ? usdFoil : 0),
    price_normal: usd,
    price_holofoil: usdFoil,
    price_reverse_holofoil: null,
    price_avg1: null,
    price_avg7: null,
    price_avg30: null,
    price_1st_edition: null,
    price_currency: 'USD',
    price_source: 'lorcast',
    cmc: cost,
    color_identity: inks,
    game: 'lorcana',
    language: 'English',
    printed_name: null,
    tcgplayer_url: raw.purchase_uris?.tcgplayer || (raw.tcgplayer_id ? `https://www.tcgplayer.com/product/${raw.tcgplayer_id}` : null),
    tcgplayer_product_id: raw.tcgplayer_id ? Number(raw.tcgplayer_id) : null,
  };
}

const cacheCards = (cards) => cacheNormalizedCards(cards, 'lorcana');

async function searchCards({
  name = '', number = '', set = '', scope = 'database', userId = null,
  page = 1, limit = 60,
} = {}) {
  const meta = { total: null };
  const cards = await runSearch(meta, name, number, set, scope, userId, page, limit);
  return { cards, total: meta.total };
}

async function runSearch(meta, nameQuery = '', numberQuery = '', setQuery = '', scope = 'database', userId = null, page = 1, limit = 60) {
  const offset = (page - 1) * limit;
  const cleanName = (nameQuery || '').trim();
  const cleanNumber = (numberQuery || '').trim();
  const setList = parseSetList(setQuery);

  // 1. Collection scope
  if (scope === 'collection') {
    if (!userId) return [];
    const { sql, params } = cardSearchSql.collectionQuery('lorcana', {
      userId, name: cleanName, number: cleanNumber, setList, limit, offset,
    });
    return (await db.all(sql, params)).map(parseCardRow);
  }

  // 2. Local cache first
  const queryLocal = async () => {
    const { sql, params } = cardSearchSql.localCacheQuery('lorcana', {
      language: 'English', name: cleanName, number: cleanNumber, setList, limit, offset,
    });
    return db.all(sql, params);
  };

  let localResults = [];
  if (scope !== 'internet') {
    localResults = await queryLocal();
    if (localResults.length > 0) {
      return localResults.map(parseCardRow);
    }
  }

  // 3. Upstream Lorcast query
  try {
    const queryTokens = [];
    if (cleanName) {
      // In Lorcast search, hyphens act as NOT / negation unless stripped
      const sanitizedName = cleanName.replace(/\s*-\s*/g, ' ').trim();
      if (sanitizedName) queryTokens.push(sanitizedName);
    }
    if (cleanNumber) {
      const strippedNumber = cleanNumber.replace(/^0+/, '') || cleanNumber;
      queryTokens.push(`number:${strippedNumber}`);
    }
    if (setList.length) {
      const rawCodes = setList.map(s => String(s).replace(/^lorcana-/, ''));
      if (rawCodes.length === 1) {
        queryTokens.push(`set:${rawCodes[0]}`);
      } else if (rawCodes.length > 1) {
        queryTokens.push(`(${rawCodes.map(c => `set:${c}`).join(' or ')})`);
      }
    }

    if (!queryTokens.length) {
      return localResults.map(parseCardRow);
    }

    const q = queryTokens.join(' ');
    const resp = await lorcastGetRetried('/cards/search', {
      params: { q, unique: 'prints' },
    });
    const results = (resp.data && resp.data.results) || [];
    meta.total = results.length;

    const normalized = results.map(normalizeCard);
    if (normalized.length > 0) {
      await cacheCards(normalized);
    }

    const pageCards = normalized.slice(offset, offset + limit);
    return pageCards;
  } catch (err) {
    if (err.response && err.response.status === 404) return [];
    console.error('Lorcast search failed:', err.message);
    const cached = scope === 'internet' ? await queryLocal() : localResults;
    if (cached.length > 0) return cached.map(parseCardRow);
    const status = err.response && err.response.status;
    if (status === 429) throw new Error('RATE_LIMIT_EXCEEDED');
    throw new Error('UPSTREAM_UNAVAILABLE');
  }
}

async function getCardById(cardId) {
  const cached = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
  if (cached) return parseCardRow(cached);

  const rawId = String(cardId || '').replace(/^lorcana-/, '');
  try {
    const resp = await lorcastGetRetried(`/cards/${encodeURIComponent(rawId)}`);
    if (resp.data) {
      const norm = normalizeCard(resp.data);
      await cacheCards([norm]);
      return norm;
    }
  } catch (e) {
    console.error(`Error fetching Lorcana card ${cardId}:`, e.message);
  }
  return null;
}

async function getCardsBySet(setCode) {
  const cleanCode = String(setCode || '').replace(/^lorcana-/, '');
  try {
    const resp = await lorcastGetRetried('/cards/search', {
      params: { q: `set:${cleanCode}`, unique: 'prints' },
    });
    const results = (resp.data && resp.data.results) || [];
    const normalized = results.map(normalizeCard);
    if (normalized.length > 0) await cacheCards(normalized);
    return normalized;
  } catch (error) {
    console.error(`Error fetching Lorcana set ${setCode} from Lorcast:`, error.message);
    return [];
  }
}

async function fetchAndCacheSets(force = false) {
  try {
    const existing = await db.get(`SELECT COUNT(*) as count FROM sets WHERE game = 'lorcana'`);
    if (!force && existing && existing.count > 0) {
      console.log(`Lorcana sets already populated (${existing.count} sets). Skipping fetch.`);
      return;
    }
    console.log('Fetching sets from Lorcast...');
    const resp = await lorcastGetRetried('/sets');
    const sets = (resp.data && resp.data.results) || [];
    for (const s of sets) {
      const code = s.code ? String(s.code).toLowerCase() : s.id;
      await db.run(
        `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'lorcana')`,
        [
          `lorcana-${code}`,
          s.name,
          'Disney Lorcana',
          null,
          null,
          s.released_at || '',
          s.code || '',
          '',
          '',
        ]
      );
    }
    console.log(`Cached ${sets.length} Lorcana sets.`);
  } catch (error) {
    console.error('Error fetching Lorcana sets from Lorcast:', error.message);
  }
}

async function updateCollectionPrices(force = false) {
  try {
    const cards = await db.all(`
      SELECT DISTINCT c.card_id, cc.id FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id WHERE cc.game = 'lorcana'
      UNION
      SELECT DISTINCT d.card_id, cc.id FROM deck_cards d
      JOIN card_cache cc ON d.card_id = cc.id WHERE cc.game = 'lorcana'
    `);
    if (cards.length === 0) return;
    if (!force && !(await shouldSweepPrices('lorcana'))) {
      console.log('Skipping Lorcana price update: already swept within the last 24h.');
      return;
    }
    console.log(`Starting Lorcana price update for ${cards.length} unique cards...`);
    let priced = 0;
    for (const item of cards) {
      try {
        const rawId = String(item.card_id).replace(/^lorcana-/, '');
        const resp = await lorcastGetRetried(`/cards/${encodeURIComponent(rawId)}`);
        if (resp.data) {
          const card = normalizeCard(resp.data);
          await db.run(
            `UPDATE card_cache
                SET price_trend = ?, price_normal = ?, price_holofoil = ?,
                    tcgplayer_product_id = ?, price_source = 'lorcast', price_currency = 'USD'
              WHERE id = ?`,
            [card.price_trend, card.price_normal, card.price_holofoil, card.tcgplayer_product_id, item.card_id]
          );
          if (card.price_trend > 0) await recordPrice(item.card_id, card.price_trend);
          priced++;
        }
      } catch (itemErr) {
        console.warn(`Lorcana price refresh failed for ${item.card_id}: ${itemErr.message}`);
      }
    }
    await markPricesSwept('lorcana');
    console.log(`Lorcana price update complete: ${priced} cards refreshed.`);
  } catch (err) {
    console.error('Error during Lorcana price update:', err.message);
  }
}

module.exports = {
  searchCards,
  normalizeCard,
  cacheCards,
  getCardsBySet,
  fetchAndCacheSets,
  updateCollectionPrices,
  getCardById,
  client,
};
