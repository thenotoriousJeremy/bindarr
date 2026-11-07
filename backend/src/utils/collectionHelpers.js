// Shared helpers for the collection/storage/import routes. Kept in one neutral
// module so the split route files (collection, storage, importExport) never have
// to import each other.
const db = require('../db');
const { recommendSlot, compartmentLabel, locationAcceptsCard, STACK_KEY_SQL } = require('./compartmentSort');

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
      SELECT c.id, c.idx, c.label, c.capacity, l.id as loc_id, l.type as loc_type, l.name as loc_name, l.allow_stacking
      FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?
    `, [compartmentId, uId]);
    if (!compartment) return { compartment_id: null, position: position !== undefined ? position : 0 };

    // On a stacking container the slot count is what fills up, not the card count.
    let countQuery = `SELECT ${compartment.allow_stacking ? `COUNT(DISTINCT ${STACK_KEY_SQL})` : 'COUNT(*)'} as cnt FROM collection WHERE compartment_id = ? AND user_id = ?`;
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

  const location = await db.get(`SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, game, allow_stacking, fixed_slots, user_id FROM locations WHERE id = ? AND user_id = ?`, [locId, uId]);
  if (!location) return { compartment_id: null, position: 0 };

  let cardMetadata = await dbClient.get(`SELECT name, set_id, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity, game, cmc, color_identity FROM card_cache WHERE id = ?`, [cId]);
  if (!cardMetadata) cardMetadata = { name: cId || '', types: [] };
  // card_cache has no id column selected above, and a stacking container matches
  // a copy against its twin by card id — so carry it on explicitly.
  cardMetadata.card_id = cId;
  cardMetadata.printing = printing || 'Normal';
  cardMetadata.language = language || 'English';
  try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

  if (!locationAcceptsCard(location, cardMetadata)) {
    return { compartment_id: null, position: 0, rejected: true };
  }

  const recommended = await recommendSlot(dbClient, location, cardMetadata);
  // No room anywhere the card may go. An object, not null: every caller reads
  // .compartment_id straight off the result, so null made a full binder a 500
  // (this was { full: true } until d0ee430). The caller leaves the card unsorted
  // and reports container_full.
  if (!recommended) return { compartment_id: null, position: 0, full: true };
  return { compartment_id: recommended.compartment_id, position: recommended.position, location_id: recommended.location_id, label: recommended.label };
}

// A container or compartment the user may file a copy into: one of their own.
// Both kinds of id are global, so one a client sends can exist and still be
// somebody else's — PUT /collection/:id took compartment_id on trust, which let
// any user file their cards into another user's binder. Null when not theirs.
async function ownedLocation(locationId, userId) {
  return db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [locationId, userId]);
}

async function ownedCompartment(compartmentId, userId) {
  return db.get(`
    SELECT cp.id, cp.location_id FROM compartments cp JOIN locations l ON l.id = cp.location_id
    WHERE cp.id = ? AND l.user_id = ?`, [compartmentId, userId]);
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

// The rows identical to this one: same card, same printing details, same list.
// Ordered as trim candidates — unplaced copies
// first, then newest — so a copy already filed into a binder is the last one
// removed. The edited row itself is excluded: it is never the row deleted.
async function stackSiblings(dbClient, userId, row, entryId) {
  return dbClient.all(`
    SELECT id, quantity FROM collection
    WHERE user_id = ? AND card_id = ? AND condition = ? AND printing = ?
      AND language = ? AND list_type = ? AND id != ?
    ORDER BY (location_id IS NULL) DESC, id DESC
  `, [userId, row.card_id, row.condition, row.printing, row.language, row.list_type, entryId]);
}

// Make the number of copies this row's stack represents equal `target`, keeping
// the edited row. The quantity field in the card popup is absolute — "how many
// of these I own" — so an edit reconciles a whole group, both ways. Here the
// group is the identical rows (stackSiblings), for a caller that does not say
// which rows its number covered; the card popup does say (setTileQuantity),
// because a tile on screen is often not this group. Returns the net change in
// copies.
async function setStackQuantity(database, userId, entryId, target) {
  const dbClient = database || db;
  const row = await dbClient.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [entryId, userId]);
  if (!row) return 0;
  const siblings = await stackSiblings(dbClient, userId, row, entryId);
  return (await reconcileStack(dbClient, userId, row, siblings, target)).change;
}

// The same reconcile over a stacked tile: exactly the rows the client drew under
// one number (see tileMembers), with the same trim order. The tile is not the
// identical-row group above — the collection view stacks by card alone unless
// told to split by condition or printing, and a stacking binder stacks a pocket
// — and reconciling that group instead is how a x5 tile of 3 Near Mint + 2
// Lightly Played copies, set to 4, came out at six. Returns { change, ids }, ids
// being the rows the tile holds afterwards, so a screen that keeps the tile
// object can keep it current.
async function setTileQuantity(database, userId, entryId, target, memberIds) {
  const dbClient = database || db;
  const row = await dbClient.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [entryId, userId]);
  if (!row) return { change: 0, ids: [] };
  const siblings = await dbClient.all(`
    SELECT id, quantity FROM collection
    WHERE user_id = ? AND id != ? AND id IN (SELECT value FROM json_each(?))
    ORDER BY (location_id IS NULL) DESC, id DESC
  `, [userId, entryId, JSON.stringify(memberIds)]);
  return reconcileStack(dbClient, userId, row, siblings, target);
}

// Grow or shrink `row` and its `siblings` (trim candidates, in trim order) to
// `target` copies. Growing inserts single-card rows (one physical card = one row,
// mirroring the edited row's placement); shrinking removes the trim candidates
// first and only then reduces the edited row's own quantity, which a legacy
// stacked row can still have above 1.
async function reconcileStack(dbClient, userId, row, siblings, target) {
  const start = (row.quantity || 1) + siblings.reduce((n, s) => n + (s.quantity || 1), 0);
  let current = start;
  const ids = [row.id, ...siblings.map(s => s.id)];

  for (let i = 0; current < target; i++, current++) {
    const added = await dbClient.run(`
      INSERT INTO collection (
        card_id, user_id, quantity, condition, printing, language, purchase_price,
        location_id, compartment_id, position, is_trade, favorite, list_type, game
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.card_id, userId, row.condition, row.printing, row.language, row.purchase_price,
      row.location_id, row.compartment_id, (row.position || 0) + (i + 1) * 0.001,
      row.is_trade, row.favorite, row.list_type, row.game
    ]);
    if (added) ids.push(added.lastID);
  }

  for (const s of siblings) {
    if (current <= target) break;
    const have = s.quantity || 1;
    const drop = Math.min(have, current - target);
    current -= drop;
    if (drop >= have) {
      await dbClient.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [s.id, userId]);
      ids.splice(ids.indexOf(s.id), 1);
    } else {
      await dbClient.run(`UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?`, [drop, s.id, userId]);
    }
  }

  if (current > target) {
    await dbClient.run(`UPDATE collection SET quantity = ? WHERE id = ? AND user_id = ?`, [target, row.id, userId]);
    current = target;
  }

  return { change: current - start, ids };
}

// The rows a client says a stacked tile stands for (PUT /collection/:id's
// stack_entry_ids), checked before the edit writes anything and against the
// edited row as it was. Kept only where they are this user's copies of that
// row's card in its list. Anything else is ignored rather than refused: a tile
// can name a copy deleted in another tab since, and ignoring an id can only make
// the tile smaller, never reach a row that is not part of it. The edited row is
// always a member. Null when no list was sent, { error } for one that is not a
// list of ids, else { ids }.
async function tileMembers(dbClient, userId, entry, raw) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || !raw.every(id => Number.isSafeInteger(id) && id > 0)) {
    return { error: 'stack_entry_ids must be a list of collection entry ids' };
  }
  const rows = await dbClient.all(`
    SELECT id FROM collection
    WHERE user_id = ? AND card_id = ? AND list_type IS ? AND id IN (SELECT value FROM json_each(?))
  `, [userId, entry.card_id, entry.list_type, JSON.stringify(raw)]);
  const ids = new Set(rows.map(r => r.id));
  ids.add(entry.id);
  return { ids: [...ids] };
}

module.exports = {
  getCompartmentOccupancy,
  defaultCompartmentPlan,
  checkedOutAllocation,
  resolveCompartmentAndPosition,
  describePlacement,
  ownedLocation,
  ownedCompartment,
  normalizeRuleConfig,
  setStackQuantity,
  setTileQuantity,
  tileMembers,
};
