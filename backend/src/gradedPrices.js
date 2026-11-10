// Graded (slab) prices, via PokemonPriceTracker's API.
//
// Why a separate provider at all: every card API Bindarr already talks to quotes
// the RAW card. A PSA 10 of the same printing routinely sells for ten to fifty
// times that, so valuing a slab at the raw price is not an approximation, it is a
// different card's price.
//
// The number this returns is eBay completed sales for that card AT THAT GRADE —
// `ebay.salesByGrade.psa10` and friends, which cover PSA, BGS and CGC including
// half grades, per card, wherever sales exist.
//
// Credits are the design constraint. The free tier is 100 a day and the provider
// bills PER CARD RETURNED (2 with `includeEbay`), so a 50-card default page would
// spend a day's allowance on one button press. Hence: look the card up by its
// TCGplayer product id when we know it — one card, exact, 2 credits — and fall
// back to a name search capped at a handful. There is no sweep and no background
// refresh, and there must not be one.
const axios = require('axios');
const metrics = require('./utils/metrics');

const API_BASE_URL = 'https://www.pokemonpricetracker.com/api/v2';
// Cap on the fallback name search. Each card costs credits, so this trades a few
// missed matches for not emptying the day's allowance on one ambiguous name.
const SEARCH_LIMIT = 5;

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: { 'User-Agent': 'Bindarr/1.0', Accept: 'application/json' },
});
metrics.instrumentAxiosClient(client, 'graded-prices');

class GradedPriceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// grader + grade -> the bucket key this provider uses: PSA 10 -> 'psa10',
// BGS 9.5 -> 'bgs9_5'. Half grades are real on BGS and CGC labels and the
// provider tracks them, so the decimal becomes an underscore rather than being
// rounded to a grade the slab does not have.
function gradeKey(grader, grade) {
  const g = Number(grade);
  if (!grader || grader === 'Raw' || !(g > 0)) return null;
  return `${String(grader).toLowerCase()}${String(g).replace('.', '_')}`;
}

// What one grade bucket is worth. `smartMarketPrice` is the provider's own
// outlier-filtered estimate and is the number their site shows, so it is what a
// collector comparing the two would expect; median and average are there for
// cards whose bucket predates it.
function priceOf(bucket) {
  if (!bucket) return null;
  const candidates = [bucket.smartMarketPrice?.price, bucket.medianPrice, bucket.averagePrice];
  for (const v of candidates) {
    if (typeof v === 'number' && v > 0) return v;
  }
  return null;
}

// The provider answers `{data: {...}}` for an exact id lookup and `{data: [...]}`
// for a search. Both mean "here are the cards".
function cardsOf(payload) {
  const d = payload?.data ?? payload;
  if (Array.isArray(d)) return d;
  return d && typeof d === 'object' ? [d] : [];
}

// Collector numbers are written both ways: our card_cache says '20', the provider
// says '20/75', and a promo is 'XY29' on both. Compare on the part before the
// slash, without leading zeros or case.
function normalizeNumber(n) {
  return String(n ?? '').split('/')[0].replace(/^0+/, '').trim().toLowerCase();
}

// Pick the card we actually asked about. With a collector number this is exact;
// without one it only accepts an unambiguous single result, because pricing the
// wrong Charizard is worse than saying "enter it by hand".
function pickCard(cards, number) {
  const want = normalizeNumber(number);
  if (!want) return cards.length === 1 ? cards[0] : null;
  return cards.find(c => normalizeNumber(c.cardNumber ?? c.number) === want) || null;
}

// Turn a provider failure into words that say what to do about it. Their 4xx
// bodies carry a real explanation ("Insufficient API credits… resets at…"), and
// dropping it left the UI showing "Request failed with status code 400", which
// tells the user nothing and is not actionable.
function providerError(err) {
  const status = err.response?.status;
  const detail = err.response?.data?.message || err.response?.data?.error;
  // 403, not the provider's 401: a 401 from Bindarr means the caller's own
  // session is gone, and the app signs out on it. This is a key in Settings.
  if (status === 401 || status === 403) {
    return new GradedPriceError(403, 'The graded-price API key was rejected. Check it in Settings.');
  }
  if (status === 429) {
    return new GradedPriceError(429, detail || 'Graded-price API limit reached. Enter the value by hand, or try again tomorrow.');
  }
  if (status === 404) {
    return new GradedPriceError(404, detail || 'The graded-price provider has no record of this card.');
  }
  if (detail) return new GradedPriceError(status >= 500 ? 502 : 400, `Graded-price lookup failed: ${detail}`);
  return new GradedPriceError(502, `Graded-price lookup failed: ${err.message}`);
}

async function query(params, apiKey) {
  try {
    const res = await client.get('/cards', { params, headers: { Authorization: `Bearer ${apiKey}` } });
    return res.data;
  } catch (err) {
    throw providerError(err);
  }
}

// One card's price at one grade.
//
// `game` gates this: the provider covers Pokémon only, and an MTG slab must be
// told that plainly instead of getting a silent miss that reads as "no data".
async function fetchGradedPrice({ game, name, setName, number, grader, grade, tcgPlayerId, apiKey }) {
  if (game && !require('./utils/games').hasFeature(game, 'gradedPrices')) {
    throw new GradedPriceError(400, 'Automatic graded prices cover Pokémon only. Enter the value by hand for this card.');
  }
  const key = gradeKey(grader, grade);
  if (!key) {
    throw new GradedPriceError(400, 'This copy needs a grader and a numeric grade before a graded price can be looked up.');
  }
  if (!apiKey) {
    throw new GradedPriceError(400, 'No graded-price API key configured. Add one in Settings, or enter the value by hand.');
  }
  if (!tcgPlayerId && !name) {
    throw new GradedPriceError(400, 'This card has nothing to look up: no TCGplayer id and no name.');
  }

  // Exact id first — one card, no ambiguity, and the cheapest request there is.
  let cards = tcgPlayerId
    ? cardsOf(await query({ tcgPlayerId: String(tcgPlayerId), includeEbay: true, limit: 1 }, apiKey))
    : [];

  if (!cards.length && name) {
    cards = cardsOf(await query({
      search: name,
      ...(setName ? { setName } : {}),
      includeEbay: true,
      limit: SEARCH_LIMIT,
    }, apiKey));
  }

  if (!cards.length) {
    throw new GradedPriceError(404, `No price data found for ${name || tcgPlayerId}.`);
  }

  // An id lookup returns the one card asked for; only a name search needs sorting out.
  const card = cards.length === 1 ? cards[0] : pickCard(cards, number);
  if (!card) {
    throw new GradedPriceError(404, `Found ${cards.length} cards named ${name} but none numbered ${number}. Enter the value by hand.`);
  }

  const byGrade = card.ebay?.salesByGrade || {};
  const price = priceOf(byGrade[key]);
  if (!(price > 0)) {
    // Name the grades that DO have sales. "No PSA 2 sales" plus "PSA 8, 9 and 10
    // have them" is the difference between a dead end and a decision.
    const have = Object.keys(byGrade)
      .filter(k => k !== 'ungraded' && priceOf(byGrade[k]) > 0)
      .map(k => k.replace('_', '.').toUpperCase())
      .join(', ');
    throw new GradedPriceError(
      404,
      `No ${grader} ${grade} sales on record for ${card.name || name}.` +
      (have ? ` Recorded grades: ${have}. Enter the value by hand.` : ' Enter the value by hand.')
    );
  }

  const bucket = byGrade[key];
  return {
    price,
    // What the number actually is, so the UI can say so rather than implying the
    // app knows what this exact slab is worth. It is eBay sold data for that card
    // at that grade, and the sale count is how much to trust it.
    basis: `${grader} ${grade} eBay sales${bucket.count ? ` (${bucket.count} sold)` : ''}`,
    count: bucket.count || null,
    source: 'pokemonpricetracker',
  };
}

module.exports = {
  fetchGradedPrice, GradedPriceError, gradeKey, pickCard, priceOf, cardsOf, normalizeNumber, client, SEARCH_LIMIT,
};
