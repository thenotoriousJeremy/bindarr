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
// ponytail: N+1 query per distinct checked-out card. Fine at personal-collection
// scale; batch into one windowed query if a user ever checks out hundreds of cards.
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

// Resolves where a card should actually land: an explicit compartment_id is
// trusted as-is (manual placement from the box/binder UI); given only a
// location_id, the recommendation engine picks a compartment automatically;
// given neither, the card is unsorted. Shared by add/update so both follow
// the exact same rule instead of drifting apart.
async function resolveCompartmentAndPosition({ locationId, compartmentId, position, userId, cardId, printing, language, excludeEntryId }) {
  if (compartmentId !== undefined && compartmentId !== null) {
    // A caller-supplied compartment can go stale (the location/compartment was
    // deleted after the client picked it) — verify it still exists rather than
    // trusting it into an INSERT and blowing up the compartment_id FK.
    const compartment = await db.get(`
      SELECT c.id, c.idx, c.label, c.capacity, l.id as loc_id, l.type as loc_type, l.name as loc_name FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?
    `, [compartmentId, userId]);
    if (!compartment) return { compartment_id: null, position: position !== undefined ? position : 0 };

    let countQuery = `SELECT COUNT(*) as cnt FROM collection WHERE compartment_id = ? AND user_id = ?`;
    let countParams = [compartmentId, userId];
    if (excludeEntryId) {
      countQuery += ` AND id != ?`;
      countParams.push(excludeEntryId);
    }
    const countRow = await db.get(countQuery, countParams);
    if (countRow.cnt >= compartment.capacity) {
      throw new Error('COMPARTMENT_FULL');
    }

    // Return the compartment's real location so a manual placement can never
    // leave collection.location_id pointing at a different container.
    const label = `${compartmentLabel(compartment, compartment.loc_type)} (in ${compartment.loc_name})`;
    if (position !== undefined) return { compartment_id: compartmentId, position, label, location_id: compartment.loc_id };
    return { compartment_id: compartmentId, position: ((countRow?.cnt || 0) + 1) * 1000, label, location_id: compartment.loc_id };
  }
  if (!locationId) {
    return { compartment_id: null, position: position !== undefined ? position : 0 };
  }

  const location = await db.get(`SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, game, user_id FROM locations WHERE id = ? AND user_id = ?`, [locationId, userId]);
  if (!location) return { compartment_id: null, position: 0 };

  const cardMetadata = await db.get(`SELECT name, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity, game, cmc, color_identity FROM card_cache WHERE id = ?`, [cardId]);
  if (!cardMetadata) return { compartment_id: null, position: 0 };
  cardMetadata.printing = printing || 'Normal';
  cardMetadata.language = language || 'English';
  try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

  // Distinguish "this container's rule doesn't allow the card" from "no room
  // anywhere" so the client can tell the user which one actually happened.
  if (!locationAcceptsCard(location, cardMetadata)) {
    return { compartment_id: null, position: 0, rejected: true };
  }

  const recommended = await recommendSlot(db, location, cardMetadata);
  if (!recommended) return { compartment_id: null, position: 0, full: true }; // container full — leave unsorted rather than error
  return { compartment_id: recommended.compartment_id, position: recommended.position, location_id: recommended.location_id, label: recommended.label };
}

// Builds the authoritative "where the card physically sits now" descriptor for
// an entry, read AFTER any scheme rebalance so the label's Pos matches the real
// slot (rebalance can shift a card from the seq recommendSlot first guessed).
// Returns null when the card isn't in a compartment (Unsorted).
async function describePlacement(db, entryId, userId) {
  const row = await db.get(`
    SELECT c.compartment_id, c.position, c.location_id,
           cp.idx, cp.label, l.type as loc_type, l.name as loc_name
    FROM collection c
    JOIN compartments cp ON c.compartment_id = cp.id
    JOIN locations l ON cp.location_id = l.id
    WHERE c.id = ? AND c.user_id = ?
  `, [entryId, userId]);
  if (!row) return null;
  const seq = Math.max(1, Math.round((row.position || 0) / 1000));
  const label = `${compartmentLabel(row, row.loc_type)}, Pos ${seq} (in ${row.loc_name})`;
  return { location_id: row.location_id, compartment_id: row.compartment_id, position: row.position, label };
}

// Normalize a location's rule_config for storage: null when empty, validated
// JSON string as-is, otherwise stringify. Throws on malformed JSON strings.
function normalizeRuleConfig(rule_config) {
  if (rule_config === undefined || rule_config === null || rule_config === '') return null;
  if (typeof rule_config === 'string') { JSON.parse(rule_config); return rule_config; }
  return JSON.stringify(rule_config);
}

module.exports = {
  defaultCompartmentPlan,
  checkedOutAllocation,
  resolveCompartmentAndPosition,
  describePlacement,
  normalizeRuleConfig,
};
