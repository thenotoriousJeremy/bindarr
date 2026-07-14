const db = require('../db');

/**
 * Calculates current aggregate occupancy for a physical compartment.
 * Uses SUM(quantity) instead of COUNT(*) to prevent overfilling.
 */
async function getCompartmentOccupancy(database, compartmentId) {
  const dbClient = database || db;
  const row = await dbClient.get(
    `SELECT COALESCE(SUM(quantity), 0) AS total_cards FROM collection WHERE compartment_id = ?`,
    [compartmentId]
  );
  return row ? row.total_cards : 0;
}

/**
 * Resolves available compartment and position in a storage location.
 */
async function resolveCompartmentAndPosition(database, locationId, cardId, userId) {
  const dbClient = database || db;
  if (!locationId) return null;

  const compartments = await dbClient.all(
    `SELECT * FROM compartments WHERE location_id = ? ORDER BY idx ASC`,
    [locationId]
  );
  if (!compartments || compartments.length === 0) return null;

  for (const comp of compartments) {
    const totalCards = await getCompartmentOccupancy(dbClient, comp.id);
    if (totalCards < comp.capacity) {
      const posRow = await dbClient.get(
        `SELECT MAX(position) AS max_pos FROM collection WHERE compartment_id = ?`,
        [comp.id]
      );
      const nextPos = (posRow && posRow.max_pos !== null) ? posRow.max_pos + 1000 : 1000;
      return { compartment_id: comp.id, position: nextPos };
    }
  }
  return null;
}

/**
 * Returns map of checked-out deck card allocations using single JOIN query.
 */
async function checkedOutAllocation(database, userId) {
  const dbClient = database || db;
  const sql = `
    SELECT 
      dc.card_id,
      dc.quantity AS checked_out_qty,
      c.id AS collection_id,
      c.location_id,
      c.compartment_id,
      c.quantity AS collection_qty
    FROM deck_cards dc
    JOIN decks d ON dc.deck_id = d.id
    JOIN collection c ON dc.card_id = c.card_id AND c.user_id = d.user_id
    WHERE d.user_id = ? AND dc.checked_out = 1
    ORDER BY dc.card_id, c.id ASC
  `;

  const rows = await dbClient.all(sql, [userId]);
  const map = new Map();

  for (const r of rows) {
    if (!map.has(r.card_id)) {
      map.set(r.card_id, { required: r.checked_out_qty, allocated: [] });
    }
    const item = map.get(r.card_id);
    item.allocated.push({
      collection_id: r.collection_id,
      location_id: r.location_id,
      compartment_id: r.compartment_id,
      quantity: r.collection_qty
    });
  }

  return map;
}

module.exports = {
  getCompartmentOccupancy,
  resolveCompartmentAndPosition,
  checkedOutAllocation
};
