// Deleting copies recoverably.
//
// A deleted row MOVES to collection_trash rather than gaining a deleted_at flag:
// dozens of queries read the collection table, a flag would need every one of
// them to filter, and one miss would leave a deleted card counting toward a deck,
// the collection value or a container's fill. A row that has moved out cannot be
// counted by a query that forgot about it.
//
// What a trashed row keeps:
// - every collection column, as JSON (grading, notes, market value, sealed link,
//   placement — and any column added later, without this file changing);
// - the rows of any table that references collection(id), such as deck_allocations
//   or an upgraded install's collection_tags. Deleting the copy cascades those away,
//   so they are snapshotted first and put back with it.
//
// It comes back under its original id, which is what keeps those links valid.
// AUTOINCREMENT never reissues an id, so the id is still free.
const crypto = require('crypto');
const db = require('../db');
const { isBinderType, stackKey, STACK_KEY_SQL, rebalanceCompartmentByScheme } = require('./compartmentSort');

const TRASH_DAYS = 30;
const BATCH_ID = /^[0-9a-f-]{36}$/;
const CHUNK = 500;
const UNSORTED = { location_id: null, compartment_id: null, position: 0 };

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function chunks(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

// Every (table, column) whose foreign key points at collection.id. Read from the
// schema rather than listed, so a table added by a later migration is covered.
async function dependentTables() {
  const tables = await db.all(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('collection', 'collection_trash')`
  );
  const deps = [];
  for (const { name } of tables) {
    const fks = await db.all(`PRAGMA foreign_key_list(${quoteIdent(name)})`);
    for (const fk of fks) {
      if (fk.table === 'collection' && (fk.to == null || fk.to === 'id')) deps.push({ table: name, column: fk.from });
    }
  }
  return deps;
}

// Move the user's copies with these ids into the trash as one batch. Ids that are
// not the user's are ignored, exactly as a DELETE scoped by user_id ignores them.
async function trashEntries(entryIds, userId) {
  const ids = [...new Set((entryIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger))];
  if (ids.length === 0) return { batchId: null, trashed: 0 };

  return db.withTransaction(async () => {
    const rows = [];
    for (const part of chunks(ids)) {
      rows.push(...await db.all(
        `SELECT * FROM collection WHERE id IN (${part.map(() => '?').join(',')}) AND user_id = ?`,
        [...part, userId]
      ));
    }
    if (rows.length === 0) return { batchId: null, trashed: 0 };
    const owned = rows.map(r => r.id);

    // Snapshot what the delete is about to cascade away.
    const links = new Map(owned.map(id => [id, {}]));
    for (const { table, column } of await dependentTables()) {
      for (const part of chunks(owned)) {
        const children = await db.all(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IN (${part.map(() => '?').join(',')})`,
          part
        );
        for (const child of children) {
          const bucket = links.get(child[column]);
          (bucket[table] = bucket[table] || []).push(child);
        }
      }
    }

    const batchId = crypto.randomUUID();
    for (const row of rows) {
      const rowLinks = links.get(row.id);
      await db.run(
        `INSERT INTO collection_trash (entry_id, batch_id, user_id, card_id, row_json, links_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.id, batchId, userId, row.card_id, JSON.stringify(row),
          Object.keys(rowLinks).length ? JSON.stringify(rowLinks) : null]
      );
    }
    for (const part of chunks(owned)) {
      await db.run(`DELETE FROM collection WHERE id IN (${part.map(() => '?').join(',')}) AND user_id = ?`, [...part, userId]);
    }
    return { batchId, trashed: rows.length };
  });
}

// Where a restored copy goes: back to its old slot when that slot can still take
// it, otherwise Unsorted. Called row by row, after the rows before it went back,
// so two copies from one batch cannot both claim the last free slot.
async function placementFor(row, userId) {
  if (!row.compartment_id) {
    if (!row.location_id) return UNSORTED;
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [row.location_id, userId]);
    return loc ? { location_id: loc.id, compartment_id: null, position: row.position || 0 } : UNSORTED;
  }

  const comp = await db.get(
    `SELECT c.id, c.capacity, l.id AS loc_id, l.type AS loc_type, l.allow_stacking, l.sort_order, l.foil_sorting
       FROM compartments c JOIN locations l ON l.id = c.location_id
      WHERE c.id = ? AND l.user_id = ?`,
    [row.compartment_id, userId]
  );
  if (!comp) return UNSORTED;

  const key = stackKey(row);
  const stacks = !!comp.allow_stacking && !!(await db.get(
    `SELECT 1 FROM collection WHERE compartment_id = ? AND user_id = ? AND ${STACK_KEY_SQL} = ? LIMIT 1`,
    [comp.id, userId, key]
  ));
  if (!stacks) {
    const used = await db.get(
      `SELECT ${comp.allow_stacking ? `COUNT(DISTINCT ${STACK_KEY_SQL})` : 'COUNT(*)'} AS n
         FROM collection WHERE compartment_id = ? AND user_id = ?`,
      [comp.id, userId]
    );
    if (used.n >= comp.capacity) return UNSORTED;
  }

  if (isBinderType(comp.loc_type)) {
    // A binder slot is its position (slot * 1000). Taken by a different card, or
    // past the end of a page that has since shrunk: the copy goes to Unsorted.
    const position = Number(row.position) || 0;
    if (position < 1000 || position > comp.capacity * 1000) return UNSORTED;
    const occupants = await db.all(
      `SELECT card_id, printing, language FROM collection WHERE compartment_id = ? AND user_id = ? AND position = ?`,
      [comp.id, userId, position]
    );
    if (occupants.some(o => !comp.allow_stacking || stackKey(o) !== key)) return UNSORTED;
    return { location_id: comp.loc_id, compartment_id: comp.id, position };
  }

  // A box row is an order, not a grid. Just before its old position puts the copy
  // back ahead of the card that followed it, whether or not the row was renumbered
  // since; the rebalance afterwards turns that into a clean position.
  return {
    location_id: comp.loc_id, compartment_id: comp.id, position: (Number(row.position) || 0) - 0.5,
    rebalance: { sort_order: comp.sort_order, foil_sorting: comp.foil_sorting }
  };
}

// A deck allocation only comes back if the deck is still checked out and still
// short of that card: the user may have returned the deck, or checked it out
// again with another copy, while this one sat in the trash.
async function allocationWanted(alloc, userId) {
  const deck = await db.get(`SELECT checked_out FROM decks WHERE id = ? AND user_id = ?`, [alloc.deck_id, userId]);
  if (!deck || !deck.checked_out) return false;
  const need = await db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [alloc.deck_id, alloc.card_id]);
  const held = await db.get(
    `SELECT COALESCE(SUM(quantity), 0) AS n FROM deck_allocations WHERE deck_id = ? AND card_id = ?`,
    [alloc.deck_id, alloc.card_id]
  );
  return !!need && held.n + (alloc.quantity || 1) <= need.quantity;
}

async function restoreLinks(links, userId) {
  for (const [table, rows] of Object.entries(links || {})) {
    const cols = new Set((await db.all(`PRAGMA table_info(${quoteIdent(table)})`)).map(c => c.name));
    if (cols.size === 0) continue; // table dropped since
    for (const child of rows) {
      if (table === 'deck_allocations' && !(await allocationWanted(child, userId))) continue;
      const names = Object.keys(child).filter(c => cols.has(c));
      try {
        await db.withTransaction(() => db.run(
          `INSERT OR IGNORE INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(', ')})
           VALUES (${names.map(() => '?').join(', ')})`,
          names.map(c => child[c])
        ));
      } catch (err) {
        // Its other parent (a deck, a tag) is gone: the link has nothing to point at.
        console.warn(`Trash restore: dropped a ${table} link:`, err.message);
      }
    }
  }
}

// Put a batch back. Only ever the requesting user's rows: another user's batch id
// finds nothing and restores nothing.
async function restoreBatch(batchId, userId) {
  if (!BATCH_ID.test(String(batchId || ''))) return { found: false, restored: 0, skipped: 0, unsorted: 0 };

  return db.withTransaction(async () => {
    const trashed = await db.all(
      `SELECT * FROM collection_trash WHERE batch_id = ? AND user_id = ? ORDER BY entry_id`,
      [batchId, userId]
    );
    if (trashed.length === 0) return { found: false, restored: 0, skipped: 0, unsorted: 0 };

    const columns = new Set((await db.all(`PRAGMA table_info(collection)`)).map(c => c.name));
    const touched = new Map();
    let restored = 0;
    let skipped = 0;
    let unsorted = 0;

    for (const t of trashed) {
      const row = JSON.parse(t.row_json);
      const place = await placementFor(row, userId);
      if (row.compartment_id && !place.compartment_id) unsorted++;
      const values = { ...row, id: t.entry_id, user_id: userId, location_id: place.location_id, compartment_id: place.compartment_id, position: place.position };
      // A sealed purchase deleted meanwhile: keep the card, drop the link.
      if (values.sealed_unit_id != null && !(await db.get(`SELECT 1 FROM sealed_units WHERE id = ?`, [values.sealed_unit_id]))) {
        values.sealed_unit_id = null;
      }
      const names = Object.keys(values).filter(c => columns.has(c));
      try {
        // Its own savepoint, so one copy that cannot come back (the same slab was
        // added again since, so its cert is taken) does not keep the rest out.
        await db.withTransaction(() => db.run(
          `INSERT INTO collection (${names.map(quoteIdent).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
          names.map(c => values[c])
        ));
      } catch (err) {
        console.warn(`Trash restore: entry ${t.entry_id} could not be restored:`, err.message);
        skipped++;
        continue;
      }
      restored++;
      if (place.rebalance) touched.set(place.compartment_id, place.rebalance);
      if (t.links_json) await restoreLinks(JSON.parse(t.links_json), userId);
    }

    for (const [compId, scheme] of touched) {
      await rebalanceCompartmentByScheme(db, compId, scheme.sort_order, scheme.foil_sorting);
    }
    // Skipped rows leave too: a copy whose slab is back in the collection under a
    // new entry is not something a second restore could fix.
    await db.run(`DELETE FROM collection_trash WHERE batch_id = ? AND user_id = ?`, [batchId, userId]);
    return { found: true, restored, skipped, unsorted };
  });
}

// The user's batches, newest first, each with a few of its cards to recognise it by.
async function listTrash(userId, previewSize = 6) {
  const batches = await db.all(
    `SELECT batch_id, MAX(deleted_at) AS deleted_at, COUNT(*) AS count,
            DATETIME(MAX(deleted_at), '+${TRASH_DAYS} days') AS expires_at
       FROM collection_trash WHERE user_id = ?
      GROUP BY batch_id ORDER BY MAX(deleted_at) DESC, batch_id DESC`,
    [userId]
  );
  const cards = await db.all(
    `SELECT t.batch_id, t.entry_id, t.card_id, cc.name, cc.set_name, cc.number, cc.image_url, cc.game
       FROM collection_trash t LEFT JOIN card_cache cc ON cc.id = t.card_id
      WHERE t.user_id = ? ORDER BY t.entry_id`,
    [userId]
  );
  const byBatch = new Map(batches.map(b => [b.batch_id, { ...b, cards: [] }]));
  for (const c of cards) {
    const batch = byBatch.get(c.batch_id);
    if (batch.cards.length < previewSize) {
      batch.cards.push({ entry_id: c.entry_id, card_id: c.card_id, name: c.name, set_name: c.set_name, number: c.number, image_url: c.image_url, game: c.game });
    }
  }
  return [...byBatch.values()];
}

// Delete for good: one batch, or (no batchId) all of the user's trash.
async function emptyTrash(userId, batchId = null) {
  if (batchId !== null && !BATCH_ID.test(String(batchId))) return 0;
  const result = batchId === null
    ? await db.run(`DELETE FROM collection_trash WHERE user_id = ?`, [userId])
    : await db.run(`DELETE FROM collection_trash WHERE user_id = ? AND batch_id = ?`, [userId, batchId]);
  return result.changes;
}

// Everyone's batches past the retention window.
async function purgeExpiredTrash(days = TRASH_DAYS) {
  const result = await db.run(`DELETE FROM collection_trash WHERE deleted_at <= DATETIME('now', ?)`, [`-${days} days`]);
  return result.changes;
}

module.exports = { TRASH_DAYS, trashEntries, placementFor, restoreBatch, listTrash, emptyTrash, purgeExpiredTrash, dependentTables };
