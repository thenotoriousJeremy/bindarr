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
//   so they are snapshotted first and put back with it. A reference that is ON
//   DELETE SET NULL instead (a trade's record of the copy) leaves its row in place,
//   and the restore only puts the link back.
//
// It comes back under its original id, which is what keeps those links valid.
// AUTOINCREMENT never reissues an id, so the id is still free.
//
// What the copy itself pointed at can go while it sits in the trash: the sealed
// purchase it was opened from, the record of the trade that brought it in, the
// sender's whole account. The copy comes back without that link rather than not
// at all. Which links those are is read from the schema, like the dependent
// tables above, so one added later is covered too.
const crypto = require('crypto');
const db = require('../db');
const { isBinderType, stackKey, STACK_KEY_SQL, occupancySql, rebalanceCompartmentByScheme } = require('./compartmentSort');
const { wantCards } = require('./defaultWishlist');

const TRASH_DAYS = 30;
const BATCH_ID = /^[0-9a-f-]{36}$/;
const CHUNK = 500;
const UNSORTED = { location_id: null, compartment_id: null, position: 0 };
// The columns a restored copy takes from placementFor() and the request, not
// from its trashed row: already known to name rows that exist.
const PLACED = new Set(['user_id', 'location_id', 'compartment_id']);

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function chunks(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

// Every (table, column) whose foreign key points at collection.id. Read from the
// schema rather than listed, so a table added by a later migration is covered —
// and remembered against PRAGMA schema_version, which any schema change bumps:
// walking every table's foreign keys took some 40 statements for each delete.
let dependentTablesMemo = null;
async function dependentTables() {
  const { schema_version: version } = await db.get(`PRAGMA schema_version`);
  if (dependentTablesMemo && dependentTablesMemo.version === version) return dependentTablesMemo.deps;
  const deps = await readDependentTables();
  dependentTablesMemo = { version, deps };
  return deps;
}

async function readDependentTables() {
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

// The foreign keys `table` holds, one entry per constraint: its columns (`from`),
// the table and columns they point at, what a delete there does to them, and
// whether they can be cleared (none NOT NULL). Remembered against schema_version,
// as dependentTables() is.
const referencesMemo = new Map();
async function referencesOf(table) {
  const { schema_version: version } = await db.get(`PRAGMA schema_version`);
  const memo = referencesMemo.get(table);
  if (memo && memo.version === version) return memo.refs;
  const refs = await readReferences(table);
  referencesMemo.set(table, { version, refs });
  return refs;
}

async function readReferences(table) {
  const notNull = new Set((await db.all(`PRAGMA table_info(${quoteIdent(table)})`)).filter(c => c.notnull).map(c => c.name));
  const byConstraint = new Map();
  const fks = (await db.all(`PRAGMA foreign_key_list(${quoteIdent(table)})`)).sort((a, b) => a.id - b.id || a.seq - b.seq);
  for (const fk of fks) {
    if (!byConstraint.has(fk.id)) {
      byConstraint.set(fk.id, { table: fk.table, from: [], to: [], onDelete: String(fk.on_delete || '').toUpperCase() });
    }
    byConstraint.get(fk.id).from.push(fk.from);
    byConstraint.get(fk.id).to.push(fk.to);
  }
  const refs = [];
  for (const ref of byConstraint.values()) {
    const parent = await db.all(`PRAGMA table_info(${quoteIdent(ref.table)})`);
    // Written without its columns, a reference names the parent's primary key.
    if (ref.to.some(c => c == null)) {
      ref.to = parent.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
      if (ref.to.length !== ref.from.length) continue;   // SQLite could not enforce it either
    }
    refs.push({ ...ref, parentGone: parent.length === 0, clearable: ref.from.every(c => !notNull.has(c)) });
  }
  return refs;
}

// Clear each reference in `row` (`refs`, from referencesOf its table) to a row that
// no longer exists, before the row goes back. A NULL anywhere in a reference
// already satisfies it; one that cannot be cleared (NOT NULL) means the row cannot
// go back at all: false. `vouched` names columns the caller has checked itself.
async function clearDanglingReferences(refs, row, vouched = new Set()) {
  for (const ref of refs) {
    if (ref.from.every(c => vouched.has(c))) continue;
    const key = ref.from.map(c => row[c]);
    if (key.some(v => v == null)) continue;
    const found = !ref.parentGone && await db.get(
      `SELECT 1 FROM ${quoteIdent(ref.table)} WHERE ${ref.to.map(c => `${quoteIdent(c)} = ?`).join(' AND ')} LIMIT 1`,
      key
    );
    if (found) continue;
    if (!ref.clearable) return false;
    for (const c of ref.from) row[c] = null;
  }
  return true;
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
      `SELECT ${occupancySql(!!comp.allow_stacking)} AS n
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

// Put back what pointed at the copy `entryId`, from the rows snapshotted when it
// was trashed. A row the delete cascaded away comes back whole, less any link of
// its own whose row has gone meanwhile. A row the delete only unlinked (ON DELETE
// SET NULL: a trade's or a deal's record of the copy, shared with another account
// in a trade) is still there and gets the link back, unless it points somewhere
// else by now; inserting that row again would at best do nothing, and at worst
// bring back a record that was deleted since.
async function restoreLinks(links, entryId, userId) {
  for (const [table, rows] of Object.entries(links || {})) {
    const info = await db.all(`PRAGMA table_info(${quoteIdent(table)})`);
    if (info.length === 0) continue; // table dropped since
    const cols = new Set(info.map(c => c.name));
    const key = info.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    const refs = await referencesOf(table);
    const unlinked = refs
      .filter(ref => ref.table === 'collection' && ref.from.length === 1 && ref.onDelete === 'SET NULL')
      .map(ref => ref.from[0]);
    for (const child of rows) {
      const relink = unlinked.filter(c => child[c] === entryId);
      if (relink.length) {
        await relinkRow(table, key, child, relink, entryId);
        continue;
      }
      if (table === 'deck_allocations' && !(await allocationWanted(child, userId))) continue;
      const row = {};
      for (const c of Object.keys(child)) if (cols.has(c)) row[c] = child[c];
      // Its other parent (a deck, a tag) is gone: the link has nothing to point at.
      if (!(await clearDanglingReferences(refs, row))) continue;
      const names = Object.keys(row);
      try {
        await db.withTransaction(() => db.run(
          `INSERT OR IGNORE INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(', ')})
           VALUES (${names.map(() => '?').join(', ')})`,
          names.map(c => row[c])
        ));
      } catch (err) {
        console.warn(`Trash restore: dropped a ${table} link:`, err.message);
      }
    }
  }
}

// Point `columns` of one row of `table`, found by its primary key, back at the
// restored copy, where nothing has replaced the link since.
async function relinkRow(table, key, child, columns, entryId) {
  if (key.length === 0 || key.some(c => child[c] == null)) return;   // no way to find the row again
  const where = key.map(c => `${quoteIdent(c)} = ?`).join(' AND ');
  for (const column of columns) {
    try {
      await db.withTransaction(() => db.run(
        `UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ? WHERE ${where} AND ${quoteIdent(column)} IS NULL`,
        [entryId, ...key.map(c => child[c])]
      ));
    } catch (err) {
      console.warn(`Trash restore: could not relink ${table}.${column}:`, err.message);
    }
  }
}

// Put a batch back. Only ever the requesting user's rows: another user's batch id
// finds nothing and restores nothing.
//
// A row deleted while the collection still kept wanted cards (list_type
// 'wishlist') is a want, not a copy: its card goes back on the default Wishlist
// (utils/defaultWishlist.js) and no collection row is made. `wishlisted` counts
// those cards.
async function restoreBatch(batchId, userId) {
  if (!BATCH_ID.test(String(batchId || ''))) return { found: false, restored: 0, skipped: 0, unsorted: 0, wishlisted: 0 };

  return db.withTransaction(async () => {
    const trashed = await db.all(
      `SELECT * FROM collection_trash WHERE batch_id = ? AND user_id = ? ORDER BY entry_id`,
      [batchId, userId]
    );
    if (trashed.length === 0) return { found: false, restored: 0, skipped: 0, unsorted: 0, wishlisted: 0 };

    const columns = new Set((await db.all(`PRAGMA table_info(collection)`)).map(c => c.name));
    const references = await referencesOf('collection');
    const touched = new Map();
    let restored = 0;
    let skipped = 0;
    let unsorted = 0;
    const wanted = [];

    for (const t of trashed) {
      const row = JSON.parse(t.row_json);
      if (row.list_type === 'wishlist') {
        wanted.push({ card_id: row.card_id, quantity: row.quantity, notes: row.notes, added_at: row.added_at });
        continue;
      }
      const place = await placementFor(row, userId);
      const values = { ...row, id: t.entry_id, user_id: userId, location_id: place.location_id, compartment_id: place.compartment_id, position: place.position };
      // A sealed purchase deleted meanwhile, a trade's record removed: keep the
      // card, drop the link (top of this file). Placement is checked already.
      if (!(await clearDanglingReferences(references, values, PLACED))) {
        console.warn(`Trash restore: entry ${t.entry_id} could not be restored: a row it cannot do without is gone`);
        skipped++;
        continue;
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
      if (row.compartment_id && !place.compartment_id) unsorted++;
      if (place.rebalance) touched.set(place.compartment_id, place.rebalance);
      if (t.links_json) await restoreLinks(JSON.parse(t.links_json), t.entry_id, userId);
    }

    for (const [compId, scheme] of touched) {
      await rebalanceCompartmentByScheme(db, compId, scheme.sort_order, scheme.foil_sorting);
    }
    let wishlisted = 0;
    if (wanted.length) {
      const { added, merged, missing } = await wantCards(userId, wanted);
      wishlisted = added + merged;
      skipped += wanted.filter(w => missing.includes(w.card_id)).length;
    }
    // Skipped rows leave too: a copy whose slab is back in the collection under a
    // new entry is not something a second restore could fix.
    await db.run(`DELETE FROM collection_trash WHERE batch_id = ? AND user_id = ?`, [batchId, userId]);
    return { found: true, restored, skipped, unsorted, wishlisted };
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
