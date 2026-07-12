const axios = require('axios');
const db = require('./db');

const API_BASE_URL = 'https://api.pokemontcg.io/v2';
const API_KEY = process.env.POKEMON_TCG_API_KEY || ''; // Optional user key

// Axios instance with rate limit handling headers if key is available
const tcgClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 6000,
  headers: API_KEY ? { 'X-Api-Key': API_KEY } : {}
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

// Fetch and cache all sets. Pass force=true to re-fetch even when the table is
// already populated — used by the weekly refresh so newly released sets show up
// without a restart (INSERT OR REPLACE below upserts, so this is idempotent).
async function fetchAndCacheSets(force = false) {
  try {
    const existingSets = await db.get('SELECT COUNT(*) as count FROM sets');
    if (!force && existingSets && existingSets.count > 0) {
      console.log(`Sets table already populated (${existingSets.count} sets). Skipping fetch.`);
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
    
    console.log(`Fetched ${sets.length} sets. Saving to database...`);
    
    for (const s of sets) {
      await db.run(
        `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    console.log('Sets successfully cached.');
  } catch (error) {
    console.error('Error fetching sets:', error.message);
  }
}

// Save a list of cards to SQLite cache
async function cacheCards(cards) {
  for (const card of cards) {
    const price = extractPrice(card);
    const detailed = extractDetailedPrices(card);
    const subtypes = JSON.stringify(card.subtypes || []);
    const types = JSON.stringify(card.types || []);
    const imageUrl = card.images ? (card.images.small || card.images.large) : '';

    await db.run(
      `INSERT OR REPLACE INTO card_cache
       (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, price_normal, price_holofoil, price_reverse_holofoil, price_avg1, price_avg7, price_avg30, cmc, color_identity, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        card.id,
        card.name,
        card.supertype || '',
        subtypes,
        types,
        card.rarity || 'Common',
        card.set ? card.set.id : '',
        card.set ? card.set.name : '',
        card.number || '',
        imageUrl,
        price,
        detailed.normal,
        detailed.holofoil,
        detailed.reverseHolofoil,
        detailed.avg1,
        detailed.avg7,
        detailed.avg30,
        null,
        null
      ]
    );
  }
}

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
async function searchCards(nameQuery = '', numberQuery = '', setQuery = '', apiKey = '', scope = 'database', userId = null) {
  // Sanitize the name query: drop pure-noise tokens (OCR garbage with no letters)
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

  // Preserve leading zeroes while keeping a stripped version for fallback matching
  const cleanNumber = numberQuery ? numberQuery.trim() : '';
  const strippedNumber = cleanNumber.replace(/^0+/, '');

  // 1. Collection-only search
  if (scope === 'collection') {
    if (!userId) return [];
    let collSql = `
      SELECT cc.*, SUM(c.quantity) AS owned_qty
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ? AND c.list_type = 'collection' AND cc.game = 'pokemon'
    `;
    const collParams = [userId];

    if (cleanName) {
      collSql += ` AND cc.name LIKE ?`;
      collParams.push(`%${cleanName}%`);
    }
    if (cleanNumber) {
      if (cleanNumber !== strippedNumber && strippedNumber !== '') {
        collSql += ` AND (cc.number = ? OR cc.number = ? OR CAST(cc.number AS INTEGER) = CAST(? AS INTEGER))`;
        collParams.push(cleanNumber, strippedNumber, cleanNumber);
      } else {
        collSql += ` AND (cc.number = ? OR CAST(cc.number AS INTEGER) = CAST(? AS INTEGER))`;
        collParams.push(cleanNumber, cleanNumber);
      }
    }
    if (setQuery) {
      collSql += ` AND (cc.set_name LIKE ? OR cc.set_id = ?)`;
      collParams.push(`%${setQuery}%`, setQuery);
    }

    collSql += ` GROUP BY cc.id LIMIT 50`;
    let collResults = await db.all(collSql, collParams);
    return collResults.map(r => ({
      ...r,
      subtypes: JSON.parse(r.subtypes || '[]'),
      types: JSON.parse(r.types || '[]')
    }));
  }

  // 2. Try local search first (if not forcing internet)
  let localResults = [];
  if (scope !== 'internet') {
    let localSql = `SELECT * FROM card_cache WHERE game = 'pokemon'`;
    const localParams = [];

    if (cleanName) {
      localSql += ` AND name LIKE ?`;
      localParams.push(`%${cleanName}%`);
    }
    if (cleanNumber) {
      if (cleanNumber !== strippedNumber && strippedNumber !== '') {
        localSql += ` AND (number = ? OR number = ? OR CAST(number AS INTEGER) = CAST(? AS INTEGER))`;
        localParams.push(cleanNumber, strippedNumber, cleanNumber);
      } else {
        localSql += ` AND (number = ? OR CAST(number AS INTEGER) = CAST(? AS INTEGER))`;
        localParams.push(cleanNumber, cleanNumber);
      }
    }
    if (setQuery) {
      localSql += ` AND (set_name LIKE ? OR set_id = ?)`;
      localParams.push(`%${setQuery}%`, setQuery);
    }

    localSql += ` LIMIT 50`;
    
    localResults = await db.all(localSql, localParams);
    
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

      return localResults.map(r => ({
        ...r,
        subtypes: JSON.parse(r.subtypes || '[]'),
        types: JSON.parse(r.types || '[]')
      }));
    }
  }

  // 2. Fetch from external API
  const fetchCardsFromAPI = async (queryStr) => {
    try {
      const response = await tcgClient.get('/cards', {
        params: {
          q: queryStr || undefined,
          pageSize: 50,
          orderBy: 'releaseDate'
        },
        headers: apiKey ? { 'X-Api-Key': apiKey } : {}
      });
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
      console.error(`API query failed for q='${queryStr}':`, err.message);
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
      if (setQuery) {
        queryStr = `(${queryStr}) AND (set.name:"${setQuery}" OR set.id:"${setQuery}")`;
      }
      
      console.log(`Querying Pokémon TCG API (Name-first): q='${queryStr}'`);
      cards = await fetchCardsFromAPI(queryStr);
    }

    // 2. Number+set fallback: only when name was garbled but we have a set.
    // Pure number-only search returns every set's card with that number (~50 junk
    // results), so skip it — a number without a set almost never finds the right card.
    const isNumNoise = !cleanNumber || cleanNumber === '0' || cleanNumber === '00' || cleanNumber === '000';
    if (cards.length === 0 && cleanNumber && !isNumNoise && setQuery) {
      const queryStr = `number:"${cleanNumber}" AND (set.name:"${setQuery}" OR set.id:"${setQuery}")`;
      console.log(`No name results. Querying TCG API (Number+set): q='${queryStr}'`);
      cards = await fetchCardsFromAPI(queryStr);
    }
    
    // Save to cache in background
    if (cards.length > 0) {
      await cacheCards(cards);
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
    return finalCards.map(c => {
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
        price_avg30: detailed.avg30
      };
    });
  } catch (error) {
    if (error.message === 'INVALID_API_KEY' || error.message === 'RATE_LIMIT_EXCEEDED') {
      throw error;
    }
    console.error('Error fetching cards from Pokémon TCG API:', error.message);
    // Return whatever local matches we have if API fails
    return localResults.map(r => ({
      ...r,
      subtypes: JSON.parse(r.subtypes || '[]'),
      types: JSON.parse(r.types || '[]')
    }));
  }
}

// Fetch single card by ID (with caching)
async function getCardById(id, apiKey = '') {
  const cached = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [id]);

  // MTG cards live under the "mtg-" prefix and are served by Scryfall, not the
  // Pokémon TCG API — never query pokemontcg.io for them (it would 404). Return
  // whatever is cached (Scryfall refreshes MTG prices on search).
  if (id && id.startsWith('mtg-')) {
    return cached
      ? { ...cached, subtypes: JSON.parse(cached.subtypes || '[]'), types: JSON.parse(cached.types || '[]') }
      : null;
  }

  // If cached and fresh (e.g. within 3 days), return it
  const cacheAgeLimit = 1000 * 60 * 60 * 24 * 3; // 3 days
  if (cached && (new Date() - new Date(cached.last_updated) < cacheAgeLimit)) {
    return {
      ...cached,
      subtypes: JSON.parse(cached.subtypes || '[]'),
      types: JSON.parse(cached.types || '[]')
    };
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
    return {
      ...cached,
      subtypes: JSON.parse(cached.subtypes || '[]'),
      types: JSON.parse(cached.types || '[]')
    };
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
async function updateCollectionPrices() {
  if (!process.env.POKEMON_TCG_API_KEY) {
    console.log('Skipping background price update: No global POKEMON_TCG_API_KEY configured to protect rate limits.');
    return;
  }

  try {
    // Select unique Pokémon card IDs from both collections (owned and wishlist)
    // and decks. MTG cards are excluded — they refresh via Scryfall on search,
    // and hitting the Pokémon API for an "mtg-" id would just 404.
    const cardsInUse = await db.all(`
      SELECT DISTINCT c.card_id FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id WHERE cc.game = 'pokemon'
      UNION
      SELECT DISTINCT d.card_id FROM deck_cards d
      JOIN card_cache cc ON d.card_id = cc.id WHERE cc.game = 'pokemon'
    `);
    
    console.log(`Starting background price update for ${cardsInUse.length} unique cards...`);
    for (const item of cardsInUse) {
      try {
        // Fetching will force update the cache and price
        const updatedCard = await getCardById(item.card_id, process.env.POKEMON_TCG_API_KEY);
        if (updatedCard && updatedCard.price_trend > 0) {
          // Record the new price in history
          await db.run(`INSERT INTO price_history (card_id, price) VALUES (?, ?)`, [item.card_id, updatedCard.price_trend]);
        }
      } catch (itemErr) {
        console.error(`Failed to update price for card ${item.card_id}:`, itemErr.message);
      }
      // Wait 1 second between requests to respect API rate limits
      await new Promise(r => setTimeout(r, 1000));
    }
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
  fetchAndCacheSets
};
