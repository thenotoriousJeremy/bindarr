async function getCollectionMetrics(db) {
  const users = await db.all(`
    SELECT u.id, u.username,
      COUNT(c.id) AS unique_cards,
      COALESCE(SUM(COALESCE(c.quantity, 1)), 0) AS total_cards,
      COALESCE(SUM(COALESCE(c.quantity, 1) * CASE
        WHEN c.market_value IS NOT NULL AND c.market_value > 0 THEN c.market_value
        WHEN c.printing = 'Holofoil' AND cc.price_holofoil IS NOT NULL AND cc.price_holofoil > 0 THEN cc.price_holofoil
        WHEN c.printing = 'Reverse Holofoil' AND cc.price_reverse_holofoil IS NOT NULL AND cc.price_reverse_holofoil > 0 THEN cc.price_reverse_holofoil
        WHEN c.printing = 'Normal' AND cc.price_normal IS NOT NULL AND cc.price_normal > 0 THEN cc.price_normal
        WHEN c.printing = '1st Edition' AND cc.price_1st_edition IS NOT NULL AND cc.price_1st_edition > 0 THEN cc.price_1st_edition
        ELSE cc.price_trend
      END), 0) AS total_value,
      COALESCE(SUM(CASE
        WHEN DATETIME(c.added_at) >= DATETIME('now', '-30 days') THEN COALESCE(c.quantity, 1)
        ELSE 0
      END), 0) AS cards_added_30d
    FROM users u
    LEFT JOIN collection c ON c.user_id = u.id
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
    GROUP BY u.id, cc.game, cc.types, cc.subtypes, cc.supertype
  `);
  const types = new Map();
  for (const row of typeRows) {
    const cardTypes = JSON.parse(row.types || '[]');
    const subtypes = JSON.parse(row.subtypes || '[]');
    const isMtg = row.game === 'mtg' || row.supertype === 'MTG';
    let names = cardTypes;
    if (isMtg) {
      const isLand = subtypes.includes('Land') || row.supertype === 'Land' ||
        (cardTypes.length === 0 && subtypes.some(type => ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Land'].includes(type)));
      names = isLand ? ['Land'] : cardTypes.length ? cardTypes : ['Colorless'];
    } else if (cardTypes.length === 0) {
      names = ['Colorless'];
    }
    for (const name of names) {
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

  const totals = users.reduce((result, user) => {
    result.totalCards += Number(user.total_cards || 0);
    result.uniqueCards += Number(user.unique_cards || 0);
    result.totalValue += Number(user.total_value || 0);
    result.cardsAdded30d += Number(user.cards_added_30d || 0);
    return result;
  }, { totalCards: 0, uniqueCards: 0, totalValue: 0, cardsAdded30d: 0 });

  return {
    userCount: users.length,
    ...totals,
    totalValue: Number(totals.totalValue.toFixed(2)),
    users: users.map(user => ({
      ...user,
      total_value: Number(user.total_value.toFixed(2)),
    })),
    types: [...types.values()].sort((a, b) => b.cards - a.cards),
  };
}

module.exports = getCollectionMetrics;
