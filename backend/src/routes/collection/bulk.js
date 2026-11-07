// One action over many selected entries: delete, move, trade, relabel, split a
// price, add to a deck, link to a sealed unit.
const db = require('../../db');
const languages = require('../../utils/languages');
const { rebalanceCompartmentByScheme } = require('../../utils/compartmentSort');
const { resolveCompartmentAndPosition } = require('../../utils/collectionHelpers');
const { validateDeckAddition } = require('../../utils/deckRules');
const { syncDeckAllocation } = require('../../utils/deckAllocation');
const { splitPrice } = require('../../utils/splitPrice');
const { allocateSealedUnitCost } = require('../../utils/sealedCostAllocation');
const { trashEntries } = require('../../utils/collectionTrash');
const { conflictingSealedLinks, cardIdForLanguage } = require('./shared');

// 5b. Bulk actions
const BULK_ACTIONS = ['delete', 'move', 'trade', 'untrade', 'list_type', 'condition', 'printing', 'language', 'purchase_split', 'add_to_deck', 'set_sealed_unit', 'link_sealed_unit'];
// Allowed field values mirror the collection table CHECK constraints in db.js.
const BULK_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const BULK_PRINTINGS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'];
async function bulkAction(req, res) {
  const { entry_ids = [], action, value } = req.body;
  if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
    return res.status(400).json({ error: 'entry_ids is required' });
  }
  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const ids = entry_ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (ids.length === 0) return res.status(400).json({ error: 'No valid entry_ids' });
  const placeholders = ids.map(() => '?').join(',');

  try {
    if (action === 'add_to_deck') {
      const deckId = parseInt(value, 10);
      if (!deckId) return res.status(400).json({ error: 'Invalid deck_id' });
      const deck = await db.get(`SELECT id, checked_out FROM decks WHERE id = ? AND user_id = ?`, [deckId, req.user.id]);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });

      const rows = await db.all(
        `SELECT card_id, SUM(quantity) as total_qty FROM collection WHERE id IN (${placeholders}) AND user_id = ? GROUP BY card_id`,
        [...ids, req.user.id]
      );

      let added = 0;
      const rejected = [];
      for (const row of rows) {
        const existing = await db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deckId, row.card_id]);
        const current = existing ? existing.quantity : 0;
        const newQty = current + row.total_qty;
        // Enforce deck rules (owned cap + the format's copy limit) so this path
        // can't bypass the limits the deck builder enforces.
        const check = await validateDeckAddition({ deckId, userId: req.user.id, cardId: row.card_id, newQty });
        if (!check.ok) { rejected.push(check.error); continue; }
        await db.run(
          `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
          [deckId, row.card_id, newQty]
        );
        added += row.total_qty;
      }
      // A deck that is out on the table takes free copies of what was just added.
      if (added && deck.checked_out) await syncDeckAllocation(deckId, req.user.id);
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
      const result = await db.run(`UPDATE collection SET is_trade = ? WHERE id IN (${placeholders}) AND user_id = ?`, [action === 'trade' ? 1 : 0, ...ids, req.user.id]);
      return res.json({ message: `Updated ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'list_type') {
      if (!['collection', 'wishlist'].includes(value)) return res.status(400).json({ error: 'Invalid list_type' });
      const result = await db.run(`UPDATE collection SET list_type = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Moved ${result.changes} card(s) to ${value}`, affected: result.changes });
    }

    if (action === 'condition' || action === 'printing') {
      const allowed = action === 'condition' ? BULK_CONDITIONS : BULK_PRINTINGS;
      if (!allowed.includes(value)) return res.status(400).json({ error: `Invalid ${action}` });
      // Column name is action, drawn from the BULK_ACTIONS whitelist (not user
      // input), so it is safe to interpolate.
      const result = await db.run(`UPDATE collection SET ${action} = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Set ${action} on ${result.changes} card(s)`, affected: result.changes });
    }

    // Same semantics as the single edit: a copy whose language changes moves to
    // that language's printing when one exists. A game never printed in the
    // language (Lorcana has no Spanish) is skipped rather than mislabelled.
    if (action === 'language') {
      if (!languages.LANGUAGES.some(l => l.name === value)) return res.status(400).json({ error: 'Invalid language' });
      const entries = await db.all(`SELECT id, card_id, language, game FROM collection WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, req.user.id]);
      let changed = 0;
      for (const entry of entries) {
        if (!languages.isLanguageSupported(entry.game, value)) continue;
        const cardId = value === entry.language ? entry.card_id : await cardIdForLanguage(entry.card_id, value);
        await db.run(`UPDATE collection SET language = ?, card_id = ? WHERE id = ? AND user_id = ?`, [value, cardId, entry.id, req.user.id]);
        changed++;
      }
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
      const rows = await db.all(
        `SELECT c.id, COALESCE(cc.price_trend, 0) AS price FROM collection c
         LEFT JOIN card_cache cc ON cc.id = c.card_id
         WHERE c.id IN (${placeholders}) AND c.user_id = ?`,
        [...ids, req.user.id]
      );
      if (rows.length === 0) return res.status(400).json({ error: 'No valid entries' });
      const sum = rows.reduce((s, r) => s + (r.price || 0), 0);
      const weighted = method === 'weighted' && sum > 0;
      const shares = splitPrice(rows.map(r => r.price || 0), total, method);
      for (let i = 0; i < rows.length; i++) {
        await db.run(`UPDATE collection SET purchase_price = ? WHERE id = ? AND user_id = ?`, [shares[i], rows[i].id, req.user.id]);
      }
      return res.json({ message: `Split $${total.toFixed(2)} across ${rows.length} card(s) (${weighted ? 'by value' : 'evenly'})`, affected: rows.length });
    }

    // Link (or unlink, value null) the selected entries to the sealed unit they
    // were pulled from — the "link cards" step of sealed product tracking.
    if (action === 'set_sealed_unit') {
      const unitId = value ? parseInt(value, 10) : null;
      let unit = null;
      if (unitId) {
        unit = await db.get(
          `SELECT u.id, p.unit_price, p.expected_cards FROM sealed_units u
             JOIN sealed_purchases p ON p.id = u.purchase_id
            WHERE u.id = ? AND p.user_id = ?`,
          [unitId, req.user.id]
        );
        if (!unit) return res.status(400).json({ error: 'Invalid sealed unit' });
        const conflicts = await conflictingSealedLinks(ids, req.user.id, unitId);
        if (conflicts.length) {
          const products = [...new Set(conflicts.map(row => row.product_name))].join(', ');
          return res.status(409).json({ error: `Some selected cards are already linked to another sealed product${products ? ` (${products})` : ''}. Unlink them first before linking to this one.` });
        }
      }
      const rows = unit ? await db.all(
        `SELECT c.id, c.quantity, COALESCE(cc.price_trend, 0) AS price FROM collection c
           LEFT JOIN card_cache cc ON cc.id = c.card_id
          WHERE c.id IN (${placeholders}) AND c.user_id = ?`,
        [...ids, req.user.id]
      ) : [];
      if (unit?.expected_cards != null) {
        const alreadyLinked = await db.get(
          `SELECT COALESCE(SUM(quantity), 0) AS count FROM collection
            WHERE sealed_unit_id = ? AND user_id = ? AND id NOT IN (${placeholders})`,
          [unitId, req.user.id, ...ids]
        );
        const requested = rows.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0);
        if ((alreadyLinked.count || 0) + requested > unit.expected_cards) {
          return res.status(400).json({ error: `This pack allows ${unit.expected_cards} linked cards` });
        }
      }
      for (let i = 0; i < rows.length; i++) {
        await db.run(
          `UPDATE collection SET sealed_unit_id = ? WHERE id = ? AND user_id = ?`,
          [unitId, rows[i].id, req.user.id]
        );
      }
      if (unit?.unit_price != null && rows.length) {
        const allocation = await allocateSealedUnitCost(unitId, req.user.id, unit.unit_price);
        if (allocation.componentCount === 0) return res.status(400).json({ error: 'No cards or recipe components are linked to this sealed unit' });
      }
      if (unit) {
        const copyCount = rows.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0);
        return res.json({ message: `Linked ${copyCount} card copy/copies; allocated $${Number(unit.unit_price || 0).toFixed(2)} across the opened pack`, affected: rows.length });
      }
      const result = await db.run(
        `UPDATE collection SET sealed_unit_id = ? WHERE id IN (${placeholders}) AND user_id = ?`,
        [unitId, ...ids, req.user.id]
      );
      return res.json({ message: `Linked ${result.changes} card(s) to the sealed unit`, affected: result.changes });
    }

    if (action === 'link_sealed_unit') {
      const unitId = parseInt(value && value.unit_id, 10);
      const total = Number(value && value.total);
      const method = value && value.method === 'equal' ? 'equal' : 'weighted';
      if (!unitId || !(total >= 0)) return res.status(400).json({ error: 'Invalid sealed unit or total' });
      const unit = await db.get(
        `SELECT u.id, p.expected_cards FROM sealed_units u
           JOIN sealed_purchases p ON p.id = u.purchase_id
          WHERE u.id = ? AND p.user_id = ?`,
        [unitId, req.user.id]
      );
      if (!unit) return res.status(400).json({ error: 'Invalid sealed unit' });
      const conflicts = await conflictingSealedLinks(ids, req.user.id, unitId);
      if (conflicts.length) {
        const products = [...new Set(conflicts.map(row => row.product_name))].join(', ');
        return res.status(409).json({ error: `Some selected cards are already linked to another sealed product${products ? ` (${products})` : ''}. Unlink them first before linking to this one.` });
      }
      const rows = await db.all(
        `SELECT c.id, c.quantity, COALESCE(cc.price_trend, 0) AS price FROM collection c
           LEFT JOIN card_cache cc ON cc.id = c.card_id
          WHERE c.id IN (${placeholders}) AND c.user_id = ?`,
        [...ids, req.user.id]
      );
      if (unit.expected_cards != null) {
        const alreadyLinked = await db.get(
          `SELECT COALESCE(SUM(quantity), 0) AS count FROM collection
            WHERE sealed_unit_id = ? AND user_id = ? AND id NOT IN (${placeholders})`,
          [unitId, req.user.id, ...ids]
        );
        const requested = rows.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0);
        if ((alreadyLinked.count || 0) + requested > unit.expected_cards) {
          return res.status(400).json({ error: `This pack allows ${unit.expected_cards} linked cards` });
        }
      }
      for (let i = 0; i < rows.length; i++) {
        await db.run(
          `UPDATE collection SET sealed_unit_id = ? WHERE id = ? AND user_id = ?`,
          [unitId, rows[i].id, req.user.id]
        );
      }
      const allocation = await allocateSealedUnitCost(unitId, req.user.id, total, method);
      const copyCount = allocation.cardCount;
      return res.json({ message: `Linked ${copyCount} card copy/copies; allocated $${total.toFixed(2)} across ${allocation.componentCount} cards and sealed components`, affected: rows.length });
    }

    const locationId = value ? parseInt(value, 10) : null;
    if (locationId) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
      if (!loc) return res.status(400).json({ error: 'Invalid location ID' });
    }
    let moved = 0;
    let noRoom = 0;
    const touched = new Map();
    // Where each copy sat before a move to Unsorted, for the client's Undo
    // (POST /collection/restore-placement).
    const previous = [];
    for (const id of ids) {
      const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) continue;
      if (!locationId) {
        if (entry.location_id || entry.compartment_id) {
          previous.push({ entry_id: entry.id, location_id: entry.location_id, compartment_id: entry.compartment_id, position: entry.position });
        }
        await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        moved++;
        continue;
      }
      const resolved = await resolveCompartmentAndPosition({
        locationId, userId: req.user.id, cardId: entry.card_id, printing: entry.printing, language: entry.language
      });
      // The container filled up part way through: the rest stay where they are.
      if (resolved.full) { noRoom++; continue; }
      const finalLoc = resolved.compartment_id ? (resolved.location_id ?? locationId) : null;
      await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [finalLoc, resolved.compartment_id, resolved.position, id, req.user.id]);
      if (resolved.compartment_id) touched.set(resolved.compartment_id, finalLoc);
      moved++;
    }
    for (const [compId, locId] of touched) {
      const rbLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [locId, req.user.id]);
      if (rbLoc) await rebalanceCompartmentByScheme(db, compId, rbLoc.sort_order, rbLoc.foil_sorting);
    }
    return res.json({
      message: noRoom ? `Moved ${moved} card(s); ${noRoom} did not fit because the container is full` : `Moved ${moved} card(s)`,
      affected: moved,
      container_full: noRoom > 0,
      ...(locationId ? {} : { previous })
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
}

function register(router) {
  router.post('/collection/bulk', bulkAction);
}

module.exports = { register };
