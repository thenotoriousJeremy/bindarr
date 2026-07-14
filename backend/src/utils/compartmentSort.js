const db = require('../db');

function safeJsonParse(val, fallback = []) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch (e) {
    return fallback;
  }
}

function prepareCardMetadata(card) {
  return {
    ...card,
    parsed_types: Array.isArray(card.types) ? card.types : safeJsonParse(card.types, []),
    parsed_subtypes: Array.isArray(card.subtypes) ? card.subtypes : safeJsonParse(card.subtypes, []),
    parsed_color_identity: Array.isArray(card.color_identity) ? card.color_identity : safeJsonParse(card.color_identity, [])
  };
}

function compareCardByRule(a, b, rule, foilSorting) {
  const by = rule.by || 'name';
  const dir = rule.dir === 'desc' ? -1 : 1;

  if (foilSorting === 'separate') {
    const isFoilA = a.printing && a.printing !== 'Normal' ? 1 : 0;
    const isFoilB = b.printing && b.printing !== 'Normal' ? 1 : 0;
    if (isFoilA !== isFoilB) return isFoilA - isFoilB;
  }

  let valA = a[by];
  let valB = b[by];

  if (by === 'name') {
    valA = (a.name || '').toLowerCase();
    valB = (b.name || '').toLowerCase();
  } else if (by === 'collector_number' || by === 'number') {
    valA = parseInt(a.number || a.collector_number || 0, 10);
    valB = parseInt(b.number || b.collector_number || 0, 10);
  } else if (by === 'type') {
    valA = (a.parsed_types[0] || '').toLowerCase();
    valB = (b.parsed_types[0] || '').toLowerCase();
  } else if (by === 'price') {
    valA = a.price_trend || 0;
    valB = b.price_trend || 0;
  }

  if (valA < valB) return -1 * dir;
  if (valA > valB) return 1 * dir;
  return 0;
}

function sortCards(cards, sortOrder, foilSorting) {
  const defaultOrder = [{ by: 'name', dir: 'asc' }];
  const parsedOrder = typeof sortOrder === 'string' ? safeJsonParse(sortOrder, defaultOrder) : (sortOrder || defaultOrder);
  const preparedCards = cards.map(prepareCardMetadata);

  return preparedCards.sort((a, b) => {
    for (const rule of parsedOrder) {
      const cmp = compareCardByRule(a, b, rule, foilSorting);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

async function getCompartmentOccupancy(database, compartmentId) {
  const dbClient = database || db;
  const row = await dbClient.get(
    `SELECT COALESCE(SUM(quantity), 0) AS total_cards FROM collection WHERE compartment_id = ?`,
    [compartmentId]
  );
  return row ? row.total_cards : 0;
}

async function recommendSlot(database, locationId, card) {
  const dbClient = database || db;
  const compartments = await dbClient.all(
    `SELECT * FROM compartments WHERE location_id = ? ORDER BY idx ASC`,
    [locationId]
  );
  if (!compartments || compartments.length === 0) return null;

  for (const comp of compartments) {
    const totalCards = await getCompartmentOccupancy(dbClient, comp.id);
    if (totalCards < comp.capacity) {
      return { compartment_id: comp.id, label: comp.label };
    }
  }
  return null;
}

async function rebalanceCompartmentByScheme(database, compartmentId, sortOrder, foilSorting) {
  const dbClient = database || db;
  const cards = await dbClient.all(
    `SELECT c.*, cc.name, cc.set_code, cc.number, cc.types, cc.rarity, cc.price_trend
     FROM collection c
     LEFT JOIN card_cache cc ON c.card_id = cc.id
     WHERE c.compartment_id = ?`,
    [compartmentId]
  );

  if (cards.length === 0) return;
  const sorted = sortCards(cards, sortOrder, foilSorting);

  const CHUNK_SIZE = 100;
  for (let i = 0; i < sorted.length; i += CHUNK_SIZE) {
    const chunk = sorted.slice(i, i + CHUNK_SIZE);
    let posCaseStr = 'CASE id ';
    const params = [];
    const ids = [];

    chunk.forEach((card, idx) => {
      const newPos = (i + idx + 1) * 1000;
      posCaseStr += `WHEN ? THEN ? `;
      params.push(card.id, newPos);
      ids.push(card.id);
    });
    posCaseStr += 'END';

    const placeholders = ids.map(() => '?').join(',');
    const sql = `UPDATE collection SET position = (${posCaseStr}) WHERE id IN (${placeholders})`;
    await dbClient.run(sql, [...params, ...ids]);
  }
}

module.exports = {
  safeJsonParse,
  prepareCardMetadata,
  sortCards,
  getCompartmentOccupancy,
  recommendSlot,
  rebalanceCompartmentByScheme
};
