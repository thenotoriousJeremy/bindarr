// Shared helpers for the collection/storage/import routes. Kept in one neutral
// module so the split route files (collection, storage, importExport) never have
// to import each other.
const db = require('../db');
const { FilingPlan, compartmentLabel, isBinderType, locationAcceptsCard } = require('./compartmentSort');

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
// checked-out deck: exactly the copies checkout claimed (utils/deckAllocation.js),
// so storage greys out the same copies the wizard told them to grab. One query —
// this used to re-derive the claim with a query per card on every collection load.
async function checkedOutAllocation(userId) {
  const rows = await db.all(`
    SELECT a.entry_id, a.quantity
    FROM deck_allocations a
    JOIN decks d ON a.deck_id = d.id
    WHERE d.user_id = ? AND d.checked_out = 1
  `, [userId]);
  return new Map(rows.map(r => [r.entry_id, r.quantity]));
}

// Where copies filed into the user's container `locationId` land, each against the
// ones before it: copy two of a three-copy add sees copy one in its slot, so three
// copies into a page with one free pocket file one and leave two unplaced, instead
// of all three going into that pocket. `copies` are { card_id, printing, language },
// optionally with the collection fields a sort reads (favorite, added_at,
// entry_id). Returns { placements, plan }: one placement per copy —
// { compartment_id, position, location_id, label }, or compartment_id null with
// `rejected` (the container's rules refuse the card) or `full` (no room anywhere it
// may go) — and the plan, whose touched() compartments the caller rebalances once
// the rows are written. Nothing is written here.
async function placeCopies({ locationId, userId, copies }) {
  const unplaced = () => ({ compartment_id: null, position: 0 });
  if (!locationId) return { placements: copies.map(unplaced), plan: null };
  const location = await db.get(`SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, game, allow_stacking, fixed_slots, user_id FROM locations WHERE id = ? AND user_id = ?`, [locationId, userId]);
  if (!location) return { placements: copies.map(unplaced), plan: null };

  const metadata = new Map();
  const plan = await FilingPlan.open(db, location);
  const placements = [];
  for (const copy of copies) {
    const cardId = copy.card_id;
    if (!metadata.has(cardId)) {
      metadata.set(cardId, await db.get(`SELECT name, set_id, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity, game, cmc, color_identity FROM card_cache WHERE id = ?`, [cardId]));
    }
    const cached = metadata.get(cardId);
    const cardMetadata = cached ? { ...cached } : { name: cardId || '', types: [] };
    // card_cache has no id column selected above, and a stacking container matches
    // a copy against its twin by card id — so carry it on explicitly.
    cardMetadata.card_id = cardId;
    cardMetadata.printing = copy.printing || 'Normal';
    cardMetadata.language = copy.language || 'English';
    for (const field of ['favorite', 'added_at', 'entry_id']) {
      if (copy[field] !== undefined) cardMetadata[field] = copy[field];
    }
    try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

    if (!locationAcceptsCard(location, cardMetadata)) {
      placements.push({ compartment_id: null, position: 0, rejected: true });
      continue;
    }
    const recommended = await plan.recommend(cardMetadata);
    // No room anywhere the card may go. An object, not null: every caller reads
    // .compartment_id straight off the result, so null made a full binder a 500
    // (this was { full: true } until d0ee430). The caller leaves the card unsorted
    // and reports container_full.
    if (!recommended) {
      placements.push({ compartment_id: null, position: 0, full: true });
      continue;
    }
    plan.commit(cardMetadata, recommended);
    placements.push({ compartment_id: recommended.compartment_id, position: recommended.position, location_id: recommended.location_id, label: recommended.label });
  }
  return { placements, plan };
}

// Where one copy of `cardId` lands in the user's container `locationId`: one
// placement as placeCopies returns it. No container: { compartment_id: null,
// position: 0 }.
async function resolveCompartmentAndPosition({ locationId, userId, cardId, printing, language }) {
  const { placements } = await placeCopies({ locationId, userId, copies: [{ card_id: cardId, printing, language }] });
  return placements[0];
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
  const dbClient = database || db;
  const row = await dbClient.get(`
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

function normalizeRuleConfig(rule_config) {
  if (rule_config === undefined || rule_config === null || rule_config === '') return null;
  if (typeof rule_config === 'string') { JSON.parse(rule_config); return rule_config; }
  return JSON.stringify(rule_config);
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
  return (await reconcileIdenticalRows(database, userId, entryId, target)).change;
}

// setStackQuantity's whole answer: { change, ids, unplaced }.
async function reconcileIdenticalRows(database, userId, entryId, target) {
  const dbClient = database || db;
  const row = await dbClient.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [entryId, userId]);
  if (!row) return { change: 0, ids: [], unplaced: 0 };
  const siblings = await stackSiblings(dbClient, userId, row, entryId);
  return reconcileStack(dbClient, userId, row, siblings, target);
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
  if (!row) return { change: 0, ids: [], unplaced: 0 };
  const siblings = await dbClient.all(`
    SELECT id, quantity FROM collection
    WHERE user_id = ? AND id != ? AND id IN (SELECT value FROM json_each(?))
    ORDER BY (location_id IS NULL) DESC, id DESC
  `, [userId, entryId, JSON.stringify(memberIds)]);
  return reconcileStack(dbClient, userId, row, siblings, target);
}

// How much room the compartment `row` is filed in has for more copies of it, or
// null when that cannot be told (no such compartment of the user's), in which
// case copies mirror the row as they always have. On a stacking container a copy
// of the row shares its pocket and takes no room. A Custom binder page hands out
// its empty pockets, since nothing renumbers it afterwards.
async function compartmentRoom(dbClient, userId, row) {
  const comp = await dbClient.get(`
    SELECT cp.capacity, l.type, l.sort_order, l.allow_stacking
    FROM compartments cp JOIN locations l ON l.id = cp.location_id
    WHERE cp.id = ? AND l.user_id = ?`, [row.compartment_id, userId]);
  if (!comp) return null;
  if (comp.allow_stacking) return { stacking: true };
  const occupants = await dbClient.all(
    `SELECT position, quantity FROM collection WHERE compartment_id = ? AND user_id = ?`,
    [row.compartment_id, userId]
  );
  const pockets = new Set(occupants.map(o => Math.floor((o.position || 0) / 1000)));
  return {
    stacking: false,
    capacity: comp.capacity,
    used: occupants.reduce((n, o) => n + (o.quantity || 1), 0),
    pockets: comp.sort_order === 'custom' && isBinderType(comp.type) ? pockets : null,
  };
}

// Grow or shrink `row` and its `siblings` (trim candidates, in trim order) to
// `target` copies. Growing inserts single-card rows (one physical card = one row),
// filed where the edited row is while its compartment has room and in Unsorted
// past that: three more copies of a card on a full page used to all go onto that
// page. Shrinking removes the trim candidates first and only then reduces the
// edited row's own quantity, which a legacy stacked row can still have above 1.
// Returns { change, ids, unplaced }, unplaced being the copies left in Unsorted.
async function reconcileStack(dbClient, userId, row, siblings, target) {
  const start = (row.quantity || 1) + siblings.reduce((n, s) => n + (s.quantity || 1), 0);
  let current = start;
  const ids = [row.id, ...siblings.map(s => s.id)];
  let unplaced = 0;
  const room = row.compartment_id && current < target ? await compartmentRoom(dbClient, userId, row) : null;

  for (let i = 0; current < target; i++, current++) {
    let place = { location_id: row.location_id, compartment_id: row.compartment_id, position: (row.position || 0) + (i + 1) * 0.001 };
    if (room && !room.stacking) {
      if (room.used >= room.capacity) {
        place = { location_id: null, compartment_id: null, position: 0 };
        unplaced++;
      } else {
        room.used++;
        if (room.pockets) {
          let pocket = 1;
          while (room.pockets.has(pocket)) pocket++;
          room.pockets.add(pocket);
          place.position = pocket * 1000;
        }
      }
    }
    const added = await dbClient.run(`
      INSERT INTO collection (
        card_id, user_id, quantity, condition, printing, language, purchase_price,
        location_id, compartment_id, position, is_trade, favorite, list_type, game
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.card_id, userId, row.condition, row.printing, row.language, row.purchase_price,
      place.location_id, place.compartment_id, place.position,
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

  return { change: current - start, ids, unplaced };
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
  defaultCompartmentPlan,
  checkedOutAllocation,
  placeCopies,
  resolveCompartmentAndPosition,
  describePlacement,
  ownedLocation,
  ownedCompartment,
  normalizeRuleConfig,
  setStackQuantity,
  reconcileIdenticalRows,
  setTileQuantity,
  tileMembers,
};
