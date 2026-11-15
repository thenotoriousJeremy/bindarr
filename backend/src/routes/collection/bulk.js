// One action over many selected entries: delete, move, trade, relabel, split a
// price, add to a deck, link to a sealed unit.
const db = require('../../db');
const languages = require('../../utils/languages');
const { rebalanceCompartments } = require('../../utils/compartmentSort');
const { placeCopies } = require('../../utils/collectionHelpers');
const { validateDeckAddition } = require('../../utils/deckRules');
const { syncDeckAllocation } = require('../../utils/deckAllocation');
const { splitPrice } = require('../../utils/splitPrice');
const { allocateSealedUnitCost } = require('../../utils/sealedCostAllocation');
const { unitCardProgress } = require('../../utils/sealedContents');
const { getOwnedUnit } = require('../../utils/sealedOwnership');
const { trashEntries } = require('../../utils/collectionTrash');
const { conflictingSealedLinks, cardIdForLanguage, LIST_TYPES, CONDITIONS, PRINTINGS } = require('./shared');

// 5b. Bulk actions
const BULK_ACTIONS = ['delete', 'move', 'trade', 'untrade', 'list_type', 'condition', 'printing', 'language', 'purchase_split', 'add_to_deck', 'set_sealed_unit', 'link_sealed_unit'];
// Allowed field values: the lists the single edit checks against (./shared), which
// mirror the collection table CHECK constraints in db.js.
const BULK_CONDITIONS = CONDITIONS;
const BULK_PRINTINGS = PRINTINGS;

// Ids per statement. A selection can be the whole collection, and one IN (...) per
// selection passed SQLite's limit on bound variables at about 32,000 ids: "select
// all" then "trade" was a 500.
const CHUNK = 500;
function chunks(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}
const holes = (list) => list.map(() => '?').join(',');

// The user's rows among `ids`, chunk by chunk. `sql` selects FROM collection c with
// its WHERE ending in "c.id IN (%IDS%) AND c.user_id = ?".
async function selectOwned(sql, ids, userId) {
  const rows = [];
  for (const part of chunks(ids)) {
    rows.push(...await db.all(sql.replace('%IDS%', holes(part)), [...part, userId]));
  }
  return rows;
}

// One UPDATE per chunk of ids; returns the rows changed.
async function updateOwned(setSql, setParams, ids, userId) {
  let changes = 0;
  for (const part of chunks(ids)) {
    const result = await db.run(`UPDATE collection SET ${setSql} WHERE id IN (${holes(part)}) AND user_id = ?`, [...setParams, ...part, userId]);
    changes += result.changes;
  }
  return changes;
}

// Set one column to a value per row: { id: value }, as CASE updates in chunks.
async function updateEach(column, valuesById, userId) {
  const entries = [...valuesById];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    await db.run(
      `UPDATE collection SET ${column} = CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE id IN (${holes(part)}) AND user_id = ?`,
      [...part.flat(), ...part.map(([id]) => id), userId]
    );
  }
}

async function sealedUnitLinkCapacityError(unitId, userId, entryIds, rows) {
  const progress = await unitCardProgress(userId, unitId);
  if (progress?.expected_cards == null) return null;
  let alreadySelected = 0;
  for (const part of chunks(entryIds)) {
    const row = await db.get(
      `WITH RECURSIVE linked_units(id) AS (
         SELECT ?
         UNION
         SELECT child_unit.id
           FROM linked_units parent
           JOIN sealed_purchases child_purchase ON child_purchase.source_unit_id = parent.id
           JOIN sealed_units child_unit ON child_unit.purchase_id = child_purchase.id
       )
       SELECT COALESCE(SUM(quantity), 0) AS count FROM collection
        WHERE id IN (${holes(part)}) AND user_id = ?
          AND sealed_unit_id IN (SELECT id FROM linked_units)`,
      [unitId, ...part, userId]
    );
    alreadySelected += Number(row?.count || 0);
  }
  const currentCount = Math.max(0, progress.linked_cards - alreadySelected);
  const requestedCount = rows.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0);
  if (currentCount + requestedCount > progress.expected_cards) {
    return `This pack allows ${progress.expected_cards} linked cards`;
  }
  return null;
}

// Thrown inside a transaction to roll it back and answer with its own status.
class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function bulkAction(req, res) {
  const { entry_ids = [], action, value } = req.body;
  if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
    return res.status(400).json({ error: 'entry_ids is required' });
  }
  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const ids = [...new Set(entry_ids.map(n => parseInt(n, 10)).filter(Number.isInteger))];
  if (ids.length === 0) return res.status(400).json({ error: 'No valid entry_ids' });

  try {
    if (action === 'add_to_deck') {
      const deckId = parseInt(value, 10);
      if (!deckId) return res.status(400).json({ error: 'Invalid deck_id' });
      const deck = await db.get(`SELECT id, checked_out FROM decks WHERE id = ? AND user_id = ?`, [deckId, req.user.id]);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });

      const result = await db.withTransaction(async () => {
        const totals = new Map();
        for (const row of await selectOwned(
          `SELECT card_id, SUM(quantity) as total_qty FROM collection c WHERE c.id IN (%IDS%) AND c.user_id = ? GROUP BY card_id`,
          ids, req.user.id
        )) {
          totals.set(row.card_id, (totals.get(row.card_id) || 0) + row.total_qty);
        }

        let added = 0;
        const rejected = [];
        for (const [cardId, totalQty] of totals) {
          const existing = await db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deckId, cardId]);
          const current = existing ? existing.quantity : 0;
          const newQty = current + totalQty;
          // Enforce deck rules (owned cap + the format's copy limit) so this path
          // can't bypass the limits the deck builder enforces.
          const check = await validateDeckAddition({ deckId, userId: req.user.id, cardId, newQty });
          if (!check.ok) { rejected.push(check.error); continue; }
          await db.run(
            `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
             ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
            [deckId, cardId, newQty]
          );
          added += totalQty;
        }
        // A deck that is out on the table takes free copies of what was just added.
        if (added && deck.checked_out) await syncDeckAllocation(deckId, req.user.id);
        return { added, rejected };
      });
      const { added, rejected } = result;
      const msg = rejected.length
        ? (added ? `Added ${added} card(s). ${rejected[0]}` : rejected[0])
        : `Added ${added} card(s) to deck`;
      return res.json({ message: msg, affected: added, rejected: rejected.length });
    }

    if (action === 'delete') {
      const { batchId, trashed } = await trashEntries(ids, req.user.id);
      return res.json({ message: `Deleted ${trashed} card(s)`, affected: trashed, trash_batch: batchId });
    }

    if (action === 'trade' || action === 'untrade') {
      const changes = await db.withTransaction(() => updateOwned('is_trade = ?', [action === 'trade' ? 1 : 0], ids, req.user.id));
      return res.json({ message: `Updated ${changes} card(s)`, affected: changes });
    }

    if (action === 'list_type') {
      if (!LIST_TYPES.includes(value)) return res.status(400).json({ error: 'Invalid list_type' });
      const changes = await db.withTransaction(() => updateOwned('list_type = ?', [value], ids, req.user.id));
      return res.json({ message: `Moved ${changes} card(s) to ${value}`, affected: changes });
    }

    if (action === 'condition' || action === 'printing') {
      const allowed = action === 'condition' ? BULK_CONDITIONS : BULK_PRINTINGS;
      if (!allowed.includes(value)) return res.status(400).json({ error: `Invalid ${action}` });
      // Column name is action, drawn from the BULK_ACTIONS whitelist (not user
      // input), so it is safe to interpolate.
      const changes = await db.withTransaction(() => updateOwned(`${action} = ?`, [value], ids, req.user.id));
      return res.json({ message: `Set ${action} on ${changes} card(s)`, affected: changes });
    }

    // Same semantics as the single edit: a copy whose language changes moves to
    // that language's printing when one exists. A game never printed in the
    // language (Lorcana has no Spanish) is skipped rather than mislabelled.
    if (action === 'language') {
      if (!languages.LANGUAGES.some(l => l.name === value)) return res.status(400).json({ error: 'Invalid language' });
      const entries = await selectOwned(`SELECT c.id, c.card_id, c.language, c.game FROM collection c WHERE c.id IN (%IDS%) AND c.user_id = ?`, ids, req.user.id);
      // The printing lookups can reach a card provider, so they all happen before
      // the write transaction; then one UPDATE per printing rather than per copy.
      const targetCard = new Map();
      const byTarget = new Map();
      for (const entry of entries) {
        if (!languages.isLanguageSupported(entry.game, value)) continue;
        if (!targetCard.has(entry.card_id)) {
          targetCard.set(entry.card_id, value === entry.language ? entry.card_id : await cardIdForLanguage(entry.card_id, value));
        }
        const cardId = value === entry.language ? entry.card_id : targetCard.get(entry.card_id);
        if (!byTarget.has(cardId)) byTarget.set(cardId, []);
        byTarget.get(cardId).push(entry.id);
      }
      let changed = 0;
      await db.withTransaction(async () => {
        for (const [cardId, entryIds] of byTarget) {
          changed += await updateOwned('language = ?, card_id = ?', [value, cardId], entryIds, req.user.id);
        }
      });
      return res.json({ message: `Set language on ${changed} card(s)`, affected: changed });
    }

    // Distribute a total price paid (a pack/deck) across the selected entries,
    // writing each entry's per-card purchase_price. method 'weighted' splits
    // proportional to market value (price_trend); 'equal' splits evenly. Weighted
    // falls back to equal when no selected card has a market price.
    if (action === 'purchase_split') {
      const total = parseFloat(value && value.total);
      const method = value && value.method === 'equal' ? 'equal' : 'weighted';
      if (!(total >= 0)) return res.status(400).json({ error: 'total must be a non-negative number' });
      const rows = await selectOwned(
        `SELECT c.id, COALESCE(cc.price_trend, 0) AS price FROM collection c
         LEFT JOIN card_cache cc ON cc.id = c.card_id
         WHERE c.id IN (%IDS%) AND c.user_id = ?`,
        ids, req.user.id
      );
      if (rows.length === 0) return res.status(400).json({ error: 'No valid entries' });
      const sum = rows.reduce((s, r) => s + (r.price || 0), 0);
      const weighted = method === 'weighted' && sum > 0;
      const shares = splitPrice(rows.map(r => r.price || 0), total, method);
      await db.withTransaction(() => updateEach('purchase_price', new Map(rows.map((r, i) => [r.id, shares[i]])), req.user.id));
      return res.json({ message: `Split $${total.toFixed(2)} across ${rows.length} card(s) (${weighted ? 'by value' : 'evenly'})`, affected: rows.length });
    }

    // Link (or unlink, value null) the selected entries to the sealed unit they
    // were pulled from — the "link cards" step of sealed product tracking. The
    // checks, the link and the cost allocation it causes are one transaction.
    if (action === 'set_sealed_unit') {
      const unitId = value ? parseInt(value, 10) : null;
      const body = await db.withTransaction(async () => {
        if (!unitId) {
          const changes = await updateOwned('sealed_unit_id = ?', [null], ids, req.user.id);
          return { message: `Linked ${changes} card(s) to the sealed unit`, affected: changes };
        }
        const unit = await getOwnedUnit(req.user.id, unitId);
        if (!unit) throw new Refusal(400, 'Invalid sealed unit');
        const conflicts = await conflictingSealedLinks(ids, req.user.id, unitId);
        if (conflicts.length) {
          const products = [...new Set(conflicts.map(row => row.product_name))].join(', ');
          throw new Refusal(409, `Some selected cards are already linked to another sealed product${products ? ` (${products})` : ''}. Unlink them first before linking to this one.`);
        }
        const rows = await selectOwned(
          `SELECT c.id, c.quantity, COALESCE(cc.price_trend, 0) AS price FROM collection c
             LEFT JOIN card_cache cc ON cc.id = c.card_id
            WHERE c.id IN (%IDS%) AND c.user_id = ?`,
          ids, req.user.id
        );
        const capacityError = await sealedUnitLinkCapacityError(unitId, req.user.id, ids, rows);
        if (capacityError) throw new Refusal(400, capacityError);
        await updateOwned('sealed_unit_id = ?', [unitId], rows.map(r => r.id), req.user.id);
        if (unit.unit_price != null && rows.length) {
          const allocation = await allocateSealedUnitCost(unitId, req.user.id, unit.unit_price);
          if (allocation.componentCount === 0) throw new Refusal(400, 'No cards or recipe components are linked to this sealed unit');
        }
        const copyCount = rows.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0);
        return { message: `Linked ${copyCount} card copy/copies; allocated $${Number(unit.unit_price || 0).toFixed(2)} across the opened pack`, affected: rows.length };
      });
      return res.json(body);
    }

    if (action === 'link_sealed_unit') {
      const unitId = parseInt(value && value.unit_id, 10);
      const total = Number(value && value.total);
      const method = value && value.method === 'equal' ? 'equal' : 'weighted';
      if (!unitId || !(total >= 0)) return res.status(400).json({ error: 'Invalid sealed unit or total' });
      const body = await db.withTransaction(async () => {
        const unit = await getOwnedUnit(req.user.id, unitId);
        if (!unit) throw new Refusal(400, 'Invalid sealed unit');
        const conflicts = await conflictingSealedLinks(ids, req.user.id, unitId);
        if (conflicts.length) {
          const products = [...new Set(conflicts.map(row => row.product_name))].join(', ');
          throw new Refusal(409, `Some selected cards are already linked to another sealed product${products ? ` (${products})` : ''}. Unlink them first before linking to this one.`);
        }
        const rows = await selectOwned(
          `SELECT c.id, c.quantity, COALESCE(cc.price_trend, 0) AS price FROM collection c
             LEFT JOIN card_cache cc ON cc.id = c.card_id
            WHERE c.id IN (%IDS%) AND c.user_id = ?`,
          ids, req.user.id
        );
        const capacityError = await sealedUnitLinkCapacityError(unitId, req.user.id, ids, rows);
        if (capacityError) throw new Refusal(400, capacityError);
        await updateOwned('sealed_unit_id = ?', [unitId], rows.map(r => r.id), req.user.id);
        const allocation = await allocateSealedUnitCost(unitId, req.user.id, total, method);
        return { message: `Linked ${allocation.cardCount} card copy/copies; allocated $${total.toFixed(2)} across ${allocation.componentCount} cards and sealed components`, affected: rows.length };
      });
      return res.json(body);
    }

    const locationId = value ? parseInt(value, 10) : null;
    if (locationId) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
      if (!loc) return res.status(400).json({ error: 'Invalid location ID' });
    }
    // Every copy is placed against the ones moved before it, from one read of the
    // container, and the moves are written together: a selection lands whole or
    // not at all.
    const outcome = await db.withTransaction(async () => {
      const entries = await selectOwned(
        `SELECT c.id, c.card_id, c.printing, c.language, c.favorite, c.added_at, c.location_id, c.compartment_id, c.position
           FROM collection c WHERE c.id IN (%IDS%) AND c.user_id = ?`,
        ids, req.user.id
      );
      const byId = new Map(entries.map(e => [e.id, e]));
      const ordered = ids.map(id => byId.get(id)).filter(Boolean);

      if (!locationId) {
        // Where each copy sat before a move to Unsorted, for the client's Undo
        // (POST /collection/restore-placement).
        const previous = ordered
          .filter(e => e.location_id || e.compartment_id)
          .map(e => ({ entry_id: e.id, location_id: e.location_id, compartment_id: e.compartment_id, position: e.position }));
        await updateOwned('location_id = NULL, compartment_id = NULL, position = 0', [], ordered.map(e => e.id), req.user.id);
        return { moved: ordered.length, noRoom: 0, refused: 0, previous };
      }

      const { placements, plan } = await placeCopies({
        locationId,
        userId: req.user.id,
        copies: ordered.map(e => ({ card_id: e.card_id, printing: e.printing, language: e.language, favorite: e.favorite, added_at: e.added_at, entry_id: e.id })),
      });
      const moves = new Map();
      let noRoom = 0;
      let refused = 0;
      ordered.forEach((entry, i) => {
        const place = placements[i];
        // The container filled up part way through, or its rules refuse the card:
        // the copy stays where it is. A refused card used to be moved to Unsorted
        // and counted as moved.
        if (place.full) { noRoom++; return; }
        if (place.rejected) { refused++; return; }
        moves.set(entry.id, place);
      });
      for (const [field, pick] of [
        ['location_id', p => (p.compartment_id ? (p.location_id ?? locationId) : null)],
        ['compartment_id', p => p.compartment_id],
        ['position', p => p.position],
      ]) {
        await updateEach(field, new Map([...moves].map(([id, p]) => [id, pick(p)])), req.user.id);
      }
      if (plan) await rebalanceCompartments(db, plan.touched());
      return { moved: moves.size, noRoom, refused };
    });

    const { moved, noRoom, refused } = outcome;
    const notes = [];
    if (noRoom) notes.push(`${noRoom} did not fit because the container is full`);
    if (refused) notes.push(`${refused} did not match the container's rules`);
    return res.json({
      message: notes.length ? `Moved ${moved} card(s); ${notes.join('; ')}` : `Moved ${moved} card(s)`,
      affected: moved,
      container_full: noRoom > 0,
      rule_rejected: refused,
      ...(locationId ? {} : { previous: outcome.previous })
    });
  } catch (error) {
    if (error instanceof Refusal) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
}

function register(router) {
  router.post('/collection/bulk', bulkAction);
}

module.exports = { register };
