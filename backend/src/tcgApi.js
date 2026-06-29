const axios = require('axios');
const db = require('./db');

const API_BASE_URL = 'https://api.pokemontcg.io/v2';
const API_KEY = process.env.POKEMON_TCG_API_KEY || ''; // Optional user key

// Axios instance with rate limit handling headers if key is available
const tcgClient = axios.create({
  baseURL: API_BASE_URL,
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

// Search cards locally first, then hit API if not found or empty
async function searchCards(nameQuery = '', numberQuery = '', setQuery = '') {
  // Sanitize name query by removing short noise words (like single-letter OCR errors)
  let cleanName = '';
  if (nameQuery) {
    const words = nameQuery.split(/\s+/);
    const filtered = words.filter(w => {
      const upper = w.toUpperCase();
      if (upper === 'EX' || upper === 'GX' || upper === 'V') return true;
      return w.length > 2; // skip short noise (like 'i', 'VL', 'Vy')
    });
    cleanName = filtered.join(' ');
  }

  // 1. Try local search first
  let localSql = `SELECT * FROM card_cache WHERE 1=1`;
  const localParams = [];

  if (cleanName) {
    localSql += ` AND name LIKE ?`;
    localParams.push(`%${cleanName}%`);
  }
  if (numberQuery) {
    localSql += ` AND number = ?`;
    localParams.push(numberQuery);
  }
  if (setQuery) {
    localSql += ` AND (set_name LIKE ? OR set_id = ?)`;
    localParams.push(`%${setQuery}%`, setQuery);
  }

  localSql += ` LIMIT 50`;
  
  let localResults = await db.all(localSql, localParams);
  
  // If we found local results and they are not empty, return them
  // (We'll also query online if they want a fresh search, but for instant UI response, this is perfect)
  if (localResults.length > 0 && !numberQuery) {
    // Return local cache parsed back
    return localResults.map(r => ({
      ...r,
      subtypes: JSON.parse(r.subtypes || '[]'),
      types: JSON.parse(r.types || '[]')
    }));
  }

  // 2. Fetch from external API
  try {
    let apiQuery = [];
    if (cleanName) {
      // Escape spaces for API search
      apiQuery.push(`name:"*${cleanName}*"`);
    }
    if (numberQuery) {
      apiQuery.push(`number:"${numberQuery}"`);
    }
    if (setQuery) {
      apiQuery.push(`(set.name:"*${setQuery}*" OR set.id:"${setQuery}")`);
    }

    const q = apiQuery.join(' ');
    console.log(`Querying Pokémon TCG API: q='${q}'`);
    
    let response;
    try {
      response = await tcgClient.get('/cards', {
        params: {
          q: q || undefined,
          pageSize: 50,
          orderBy: 'releaseDate'
        }
      });
    } catch (err) {
      console.error('Initial API query failed:', err.message);
      response = { data: { data: [] } };
    }

    let cards = response.data.data || [];

    // Fallback 1: If name + number query returned nothing, retry search with number only (numbers are highly specific)
    if (cards.length === 0 && cleanName && numberQuery) {
      const fallbackQ = `number:"${numberQuery}"`;
      console.log(`No results for '${q}'. Retrying fallback search: ${fallbackQ}`);
      try {
        const fallbackResponse = await tcgClient.get('/cards', {
          params: {
            q: fallbackQ,
            pageSize: 50,
            orderBy: 'releaseDate'
          }
        });
        cards = fallbackResponse.data.data || [];
      } catch (err) {
        console.error('Fallback 1 query failed:', err.message);
      }
    }

    // Fallback 2: If query still empty, retry search with first word of card name (strip typos/noise)
    if (cards.length === 0 && cleanName) {
      const firstWord = cleanName.split(' ')[0];
      if (firstWord && firstWord.length > 2) {
        const fallbackQ = `name:"*${firstWord}*"`;
        console.log(`No results. Retrying fallback search: ${fallbackQ}`);
        try {
          const fallbackResponse = await tcgClient.get('/cards', {
            params: {
              q: fallbackQ,
              pageSize: 50,
              orderBy: 'releaseDate'
            }
          });
          cards = fallbackResponse.data.data || [];
        } catch (err) {
          console.error('Fallback 2 query failed:', err.message);
        }
      }
    }
    
    // Save to cache in background
    if (cards.length > 0) {
      await cacheCards(cards);
    }

    // Return the fetched cards formatted
    return cards.map(c => ({
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
async function getCardById(id) {
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
    const response = await tcgClient.get(`/cards/${id}`);
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
    const cardsInCollection = await db.all(`
      SELECT DISTINCT card_id FROM collection
    `);
    
    console.log(`Starting background price update for ${cardsInCollection.length} unique cards...`);
    for (const item of cardsInCollection) {
      // Fetching will force update the cache and price
      await getCardById(item.card_id);
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
