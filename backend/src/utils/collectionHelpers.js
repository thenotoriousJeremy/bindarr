// Shared helpers for the collection/storage/import routes. Kept in one neutral
// module so the split route files (collection, storage, importExport) never have
// to import each other.
const db = require('../db');
const { recommendSlot, compartmentLabel, locationAcceptsCard } = require('./compartmentSort');

// Default compartment plan by container type — used when a caller doesn't
// specify one at creation time (see POST /locations).
function defaultCompartmentPlan(type) {
  if (type === 'Binder') return { count: 10, capacity: 9 };
  if (type === 'Toploader Binder') return { count: 8, capacity: 4 };
  if (type === 'Box') return { count: 2, capacity: 400 };
  if (type === 'Toploader Box') return { count: 1, capacity: 100 };
  if (type === 'Graded Slab Box') return { count: 1, capacity: 40 };
  if (type === 'Display Shelf / Stand') return { count: 1, capacity: 10 };
  if (type === 'Deck Box') return { count: 1, capacity: 60 };
  if (type === 'Tin / Case') return { count: 1, capacity: 200 };
  return { count: 1, capacity: 500 };
}

// How many copies of each collection entry are physically pulled for a
// checked-out deck. Sums required quantity per card across all of the user's
// checked-out decks, then allocates greedily onto their owned entries using the
// same ordering the checkout locator uses (located copies first, newest first),
// so storage greys out the same copies the wizard told them to grab.
async function checkedOutAllocation(userId) {
  const required = await db.all(`
    SELECT dc.card_id, SUM(dc.quantity) AS req
    FROM deck_cards dc
    JOIN decks d ON dc.deck_id = d.id
    WHERE d.user_id = ? AND d.checked_out = 1
    GROUP BY dc.card_id
  `, [userId]);
  const alloc = new Map();
  for (const { card_id, req } of required) {
    let need = req;
    const entries = await db.all(`
      SELECT id AS entry_id, quantity FROM collection
      WHERE user_id = ? AND list_type = 'collection' AND card_id = ?
      ORDER BY (location_id IS NOT NULL) DESC, added_at DESC
    `, [userId, card_id]);
    for (const e of entries) {
      if (need <= 0) break;
      const take = Math.min(e.quantity, need);
      need -= take;
      alloc.set(e.entry_id, take);
    }
  }
  return alloc;
}

// Resolves where a card should actually land. Supports both object destructuring signature
// and positional (database, locationId, cardId, userId) signature for backwards compatibility.
async function resolveCompartmentAndPosition(arg1, locationId, cardId, userId) {
  let dbClient = db;
  let opts = {};
  if (typeof arg1 === 'object' && arg1 !== null && !(arg1.all || arg1.get || arg1.run)) {
    opts = arg1;
  } else {
    if (arg1 && (arg1.all || arg1.get || arg1.run)) dbClient = arg1;
    opts = { locationId, cardId, userId };
  }

  const {
    locationId: locId,
    compartmentId,
    position,
    userId: uId,
    cardId: cId,
    printing,
    language,
    excludeEntryId
  } = opts;

  if (compartmentId !== undefined && compartmentId !== null) {
    const compartment = await db.get(`
      SELECT c.id, c.idx, c.label, c.capacity, l.id as loc_id, l.type as loc_type, l.name as loc_name FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?
    `, [compartmentId, uId]);
    if (!compartment) return { compartment_id: null, position: position !== undefined ? position : 0 };

    let countQuery = `SELECT COUNT(*) as cnt FROM collection WHERE compartment_id = ? AND user_id = ?`;
    let countParams = [compartmentId, uId];
    if (excludeEntryId) {
      countQuery += ` AND id != ?`;
      countParams.push(excludeEntryId);
    }
    const countRow = await db.get(countQuery, countParams);
    if (countRow.cnt >= compartment.capacity) {
      throw new Error('COMPARTMENT_FULL');
    }

    const label = `${compartmentLabel(compartment, compartment.loc_type)} (in ${compartment.loc_name})`;
    if (position !== undefined) return { compartment_id: compartmentId, position, label, location_id: compartment.loc_id };
    return { compartment_id: compartmentId, position: ((countRow?.cnt || 0) + 1) * 1000, label, location_id: compartment.loc_id };
  }
  if (!locId) {
    return { compartment_id: null, position: position !== undefined ? position : 0 };
  }

  const location = await db.get(`SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, game, user_id FROM locations WHERE id = ? AND user_id = ?`, [locId, uId]);
  if (!location) return { compartment_id: null, position: 0 };

  let cardMetadata = await dbClient.get(`SELECT name, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity, game, cmc, color_identity FROM card_cache WHERE id = ?`, [cId]);
  if (!cardMetadata) cardMetadata = { name: cId || '', types: [] };
  cardMetadata.printing = printing || 'Normal';
  cardMetadata.language = language || 'English';
  try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

  if (!locationAcceptsCard(location, cardMetadata)) {
    return { compartment_id: null, position: 0, rejected: true };
  }

  const recommended = await recommendSlot(dbClient, location, cardMetadata);
  if (!recommended) return null;
  return { compartment_id: recommended.compartment_id, position: recommended.position, location_id: recommended.location_id, label: recommended.label };
}

async function describePlacement(database, entryId, userId) {
  let dbClient = db;
  let eId = entryId;
  let uId = userId;

  if (typeof database === 'number') {
    eId = database;
    uId = entryId;
  } else if (database && (database.get || database.all)) {
    dbClient = database;
  }

  const row = await dbClient.get(`
    SELECT c.compartment_id, c.position, c.location_id,
           cp.idx, cp.label, l.type as loc_type, l.name as loc_name
    FROM collection c
    JOIN compartments cp ON c.compartment_id = cp.id
    JOIN locations l ON cp.location_id = l.id
    WHERE c.id = ? AND c.user_id = ?
  `, [eId, uId]);
  if (!row) return null;
  const seq = Math.max(1, Math.round((row.position || 0) / 1000));
  const label = `${compartmentLabel(row, row.loc_type)}, Pos ${seq} (in ${row.loc_name})`;
  return { location_id: row.location_id, compartment_id: row.compartment_id, position: row.position, label };
}

function normalizeRuleConfig(rule_config) {
  if (rule_config === undefined || rule_config === null || rule_config === '') return null;
  if (typeof rule_config === 'string') { JSON.parse(rule_config); return rule_config; }
  return JSON.stringify(rule_config);
}

async function getCompartmentOccupancy(database, compartmentId) {
  const dbClient = database || db;
  const row = await dbClient.get(
    `SELECT COALESCE(SUM(quantity), 0) AS total_cards FROM collection WHERE compartment_id = ?`,
    [compartmentId]
  );
  return row ? row.total_cards : 0;
}

module.exports = {
  getCompartmentOccupancy,
  defaultCompartmentPlan,
  checkedOutAllocation,
  resolveCompartmentAndPosition,
  describePlacement,
  normalizeRuleConfig,
};
