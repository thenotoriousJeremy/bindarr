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

// Save a list of cards to SQLite cache
async function cacheCards(cards) {
  for (const card of cards) {
    const price = extractPrice(card);
    const subtypes = JSON.stringify(card.subtypes || []);
    const types = JSON.stringify(card.types || []);
    const imageUrl = card.images ? (card.images.small || card.images.large) : '';

    await db.run(
      `INSERT OR REPLACE INTO card_cache 
       (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
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
        price
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
async function searchCards(nameQuery = '', numberQuery = '', setQuery = '', apiKey = '') {
  // Sanitize name query by keeping only Title Case words or allowed uppercase tags (like EX, GX, V)
  let cleanName = '';
  if (nameQuery) {
    const ALLOWED_UPPER = new Set(['EX', 'GX', 'V', 'VMAX', 'VSTAR', 'BREAK', 'PROMO', 'V-UNION']);
    const words = nameQuery.split(/\s+/);
    const filtered = words.filter(w => {
      const cleanWord = w.replace(/[^A-Za-z\-]/g, ''); // keep only letters and hyphens for formatting checks
      if (!cleanWord) return false;
      
      const upper = cleanWord.toUpperCase();
      if (ALLOWED_UPPER.has(upper)) return true;
      
      // Keep Title Case: starts with uppercase letter and contains at least one lowercase letter
      const isTitleCase = /^[A-Z]/.test(cleanWord) && /[a-z]/.test(cleanWord);
      return isTitleCase;
    });
    cleanName = filtered.join(' ');
  }

  // Preserve leading zeroes while keeping a stripped version for fallback matching
  const cleanNumber = numberQuery ? numberQuery.trim() : '';
  const strippedNumber = cleanNumber.replace(/^0+/, '');

  // 1. Try local search first
  let localSql = `SELECT * FROM card_cache WHERE 1=1`;
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
  
  let localResults = await db.all(localSql, localParams);
  
  // If we found local results and they are not empty, return them instantly.
  // Stale prices (older than 3 days) are updated asynchronously in the background.
  if (localResults.length > 0) {
    const cacheAgeLimit = 1000 * 60 * 60 * 24 * 3; // 3 days
    const staleCards = localResults.filter(r => (new Date() - new Date(r.last_updated) > cacheAgeLimit));
    if (staleCards.length > 0) {
      (async () => {
        try {
          for (const card of staleCards) {
            await getCardById(card.id);
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
      if (err.response && err.response.status === 429) {
        throw new Error('RATE_LIMIT_EXCEEDED');
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

    // 2. Number-only query: fallback if name was completely garbled or not provided
    const isNumNoise = !cleanNumber || cleanNumber === '0' || cleanNumber === '00' || cleanNumber === '000';
    if (cards.length === 0 && cleanNumber && !isNumNoise) {
      const queryStr = `number:"${cleanNumber}"`;
      console.log(`No name results. Querying TCG API (Number-only): q='${queryStr}'`);
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
      const numberMatchBonus = (!isNaN(cleanNumInt) && !isNaN(cardNumInt) && cleanNumInt === cardNumInt) ? 0.35 : 0.0;
      
      const score = nameSim * 0.65 + numberSim * 0.35 + numberMatchBonus;
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
    return finalCards.map(c => ({
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
      price_trend: extractPrice(c)
    }));
  } catch (error) {
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
        price_trend: extractPrice(card)
      };
    }
  } catch (error) {
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

// Periodic function to update pricing for all cards in the collection
async function updateCollectionPrices() {
  try {
    // Select unique card IDs from both collections (owned and wishlist) and decks
    const cardsInUse = await db.all(`
      SELECT DISTINCT card_id FROM collection
      UNION
      SELECT DISTINCT card_id FROM deck_cards
    `);
    
    console.log(`Starting background price update for ${cardsInUse.length} unique cards...`);
    for (const item of cardsInUse) {
      // Fetching will force update the cache and price
      const updatedCard = await getCardById(item.card_id);
      if (updatedCard && updatedCard.price_trend > 0) {
        // Record the new price in history
        await db.run(`INSERT INTO price_history (card_id, price) VALUES (?, ?)`, [item.card_id, updatedCard.price_trend]);
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
  updateCollectionPrices
};
