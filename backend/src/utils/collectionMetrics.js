const { convert, pickUnit, roundMoney } = require('./fx');

// What a user owns: the copies on the collection list. Wishlist rows are cards
// wanted, not held, and every count and value of "the collection" — the
// dashboard, its value timeline, net worth, these metrics — filters by this one
// condition. Two of them did not, so a $100 wishlisted card was the dashboard's
// "most valuable" card and added $100 to the total. `c` is the collection alias.
const OWNED_SQL = `c.list_type = 'collection'`;

// What one copy is worth, in SQL: utils/priceHelpers resolveCardPrice, for queries
// that sum or rank in the database. The value on the copy first (typed by the
// owner, or a graded price for this exact slab), then the price of its printing,
// then the card's headline price. `c` is the collection alias, `cc` card_cache's.
const COPY_PRICE_SQL = `CASE
        WHEN c.market_value IS NOT NULL AND c.market_value > 0 THEN c.market_value
        WHEN c.printing = 'Holofoil' AND cc.price_holofoil IS NOT NULL AND cc.price_holofoil > 0 THEN cc.price_holofoil
        WHEN c.printing = 'Reverse Holofoil' AND cc.price_reverse_holofoil IS NOT NULL AND cc.price_reverse_holofoil > 0 THEN cc.price_reverse_holofoil
        WHEN c.printing = 'Normal' AND cc.price_normal IS NOT NULL AND cc.price_normal > 0 THEN cc.price_normal
        WHEN c.printing = '1st Edition' AND cc.price_1st_edition IS NOT NULL AND cc.price_1st_edition > 0 THEN cc.price_1st_edition
        ELSE cc.price_trend
      END`;

const list = (value) => {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};
const BASIC_LAND_WORDS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Land'];

// The type buckets a card counts under in the type breakdowns: its types (energy
// types, inks, domains; colours for Magic), every Magic land as Land whatever its
// colours, and a card with no type as Colorless.
function typeBuckets({ game, types, subtypes, supertype }) {
  const cardTypes = list(types);
  const subs = list(subtypes);
  if (game === 'mtg' || supertype === 'MTG') {
    const isLand = subs.includes('Land') || supertype === 'Land'
      || (cardTypes.length === 0 && subs.some(type => BASIC_LAND_WORDS.includes(type)));
    if (isLand) return ['Land'];
  }
  return cardTypes.length ? cardTypes : ['Colorless'];
}

// The newest ECB rates, read through the database the caller handed in (the same
// table fxRates.latestRates reads). Null when there are none.
async function latestRates(db) {
  const rows = await db.all(
    `SELECT currency, rate, rate_date FROM fx_rates WHERE rate_date = (SELECT MAX(rate_date) FROM fx_rates)`
  ).catch(() => []);
  const rates = { EUR: 1 };
  let date = null;
  for (const r of rows || []) {
    if (!r || typeof r.currency !== 'string' || !(Number(r.rate) > 0)) continue;
    rates[r.currency] = Number(r.rate);
    date = r.rate_date;
  }
  return date ? { base: 'EUR', date, rates } : null;
}

async function getCollectionMetrics(db) {
  const users = await db.all(`
    SELECT u.id, u.username,
      COUNT(c.id) AS unique_cards,
      COALESCE(SUM(COALESCE(c.quantity, 1)), 0) AS total_cards,
      COALESCE(SUM(COALESCE(c.quantity, 1) * ${COPY_PRICE_SQL}), 0) AS total_value,
      -- The same value per currency it is quoted in, so it can be converted rather
      -- than summed: 10 USD and 10 EUR are not 20 of anything.
      (SELECT json_group_object(currency, value) FROM (
        SELECT COALESCE(cc.price_currency, 'USD') AS currency,
               SUM(COALESCE(c.quantity, 1) * ${COPY_PRICE_SQL}) AS value
          FROM collection c JOIN card_cache cc ON cc.id = c.card_id
         WHERE c.user_id = u.id AND ${OWNED_SQL}
         GROUP BY COALESCE(cc.price_currency, 'USD')
      )) AS value_by_currency,
      COALESCE(SUM(CASE
        WHEN DATETIME(c.added_at) >= DATETIME('now', '-30 days') THEN COALESCE(c.quantity, 1)
        ELSE 0
      END), 0) AS cards_added_30d
    FROM users u
    LEFT JOIN collection c ON c.user_id = u.id AND ${OWNED_SQL}
    LEFT JOIN card_cache cc ON cc.id = c.card_id
    GROUP BY u.id
    ORDER BY u.username COLLATE NOCASE
  `);
  const typeRows = await db.all(`
    SELECT u.id AS user_id, u.username, cc.game, cc.types, cc.subtypes, cc.supertype,
      SUM(COALESCE(c.quantity, 1)) AS cards
    FROM collection c
    JOIN users u ON u.id = c.user_id
    JOIN card_cache cc ON cc.id = c.card_id
    WHERE ${OWNED_SQL}
    GROUP BY u.id, cc.game, cc.types, cc.subtypes, cc.supertype
  `);
  const types = new Map();
  for (const row of typeRows) {
    for (const name of typeBuckets(row)) {
      const key = JSON.stringify([row.user_id, row.game, name]);
      const current = types.get(key) || {
        userId: row.user_id,
        username: row.username,
        game: row.game || 'unknown',
        name,
        cards: 0,
      };
      current.cards += Number(row.cards || 0);
      types.set(key, current);
    }
  }

  // Values are reported in USD, converted at the newest ECB rates — or, when the
  // whole instance is priced in one currency, in that one. An amount in a
  // currency with no rate is left out rather than added to the others as if it
  // were dollars.
  const perUser = users.map(user => {
    let byCurrency = null;
    try { byCurrency = user.value_by_currency ? JSON.parse(user.value_by_currency) : null; } catch { byCurrency = null; }
    return byCurrency || { USD: Number(user.total_value || 0) };
  });
  const currencies = new Set();
  perUser.forEach(byCurrency => Object.entries(byCurrency).forEach(([c, v]) => { if (Number(v) > 0) currencies.add(c); }));
  const fx = currencies.size > 1 || (currencies.size === 1 && !currencies.has('USD')) ? await latestRates(db) : null;
  const unit = pickUnit(currencies, 'USD', fx) || 'USD';
  const inUnit = (byCurrency) => Object.entries(byCurrency)
    .reduce((sum, [currency, value]) => sum + (convert(Number(value) || 0, currency, unit, fx) || 0), 0);

  const totals = users.reduce((result, user, i) => {
    result.totalCards += Number(user.total_cards || 0);
    result.uniqueCards += Number(user.unique_cards || 0);
    result.totalValue += inUnit(perUser[i]);
    result.cardsAdded30d += Number(user.cards_added_30d || 0);
    return result;
  }, { totalCards: 0, uniqueCards: 0, totalValue: 0, cardsAdded30d: 0 });

  return {
    userCount: users.length,
    ...totals,
    totalValue: roundMoney(totals.totalValue, unit),
    valueCurrency: unit,
    users: users.map(({ value_by_currency: _, ...user }, i) => ({
      ...user,
      total_value: roundMoney(inUnit(perUser[i]), unit),
    })),
    types: [...types.values()].sort((a, b) => b.cards - a.cards),
  };
}

module.exports = getCollectionMetrics;
Object.assign(module.exports, { OWNED_SQL, COPY_PRICE_SQL, typeBuckets });
