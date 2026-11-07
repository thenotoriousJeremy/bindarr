// Where a copy sits: tap-to-place in a Custom-order container, and putting
// copies back after an undone move to Unsorted.
const db = require('../../db');
const { isBinderType, rebalanceCompartmentByScheme, stackKey, STACK_KEY_SQL } = require('../../utils/compartmentSort');
const { describePlacement } = require('../../utils/collectionHelpers');
const { placementFor } = require('../../utils/collectionTrash');

// 4b. Manual tap-to-place (Custom order)
async function placeEntry(req, res) {
  const { id } = req.params;
  const { compartment_id, slot, swap_with } = req.body;
  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found', code: 'entry_not_found' });

    const comp = await db.get(`
      SELECT c.id, c.capacity, l.id AS loc_id, l.type AS loc_type, l.sort_order, l.foil_sorting, l.allow_stacking
      FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?`, [compartment_id, req.user.id]);
    if (!comp) return res.status(400).json({ error: 'Invalid compartment' });
    if (comp.sort_order !== 'custom') return res.status(400).json({ error: 'Manual placement is only available in Custom order' });

    const isBinder = isBinderType(comp.loc_type);

    if (swap_with) {
      const other = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [swap_with, req.user.id]);
      if (!other) return res.status(400).json({ error: 'Swap target not found' });
      // Stacking container: dropping a copy onto its own twin joins that pocket
      // rather than trading places with it — trading two identical cards is a
      // no-op the user can see no result from.
      if (comp.allow_stacking && stackKey(entry) === stackKey(other)) {
        await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [other.compartment_id, other.location_id, other.position, id, req.user.id]);
        const stackedPlacement = await describePlacement(db, id, req.user.id);
        return res.json({ message: 'Card stacked', placement: stackedPlacement });
      }
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [other.compartment_id, other.location_id, other.position, id, req.user.id]);
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [entry.compartment_id, entry.location_id, entry.position, swap_with, req.user.id]);
      const placement = await describePlacement(db, id, req.user.id);
      return res.json({ message: 'Cards swapped', placement });
    }

    if (!Number.isInteger(slot) || slot < 1) return res.status(400).json({ error: 'Invalid slot' });

    if (entry.compartment_id !== compartment_id) {
      // Slots used, not cards held, once copies are allowed to share a pocket.
      const cnt = await db.get(
        `SELECT ${comp.allow_stacking ? `COUNT(DISTINCT ${STACK_KEY_SQL})` : 'COUNT(*)'} AS n
         FROM collection WHERE compartment_id = ? AND user_id = ?`, [compartment_id, req.user.id]);
      if (cnt.n >= comp.capacity) return res.status(400).json({ error: 'COMPARTMENT_FULL', code: 'compartment_full' });
    }

    const sourceComp = entry.compartment_id;
    if (isBinder) {
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000, id, req.user.id]);
    } else {
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000 - 500, id, req.user.id]);
      // Custom order keeps the rows in position order, so the half-slot written
      // above is what puts the card between its neighbours before renumbering.
      await rebalanceCompartmentByScheme(db, compartment_id, comp.sort_order, comp.foil_sorting);
    }

    if (sourceComp && sourceComp !== compartment_id) {
      const src = await db.get(
        `SELECT l.type AS loc_type, l.sort_order, l.foil_sorting FROM compartments c JOIN locations l ON c.location_id = l.id WHERE c.id = ?`,
        [sourceComp]);
      if (src && !isBinderType(src.loc_type)) {
        await rebalanceCompartmentByScheme(db, sourceComp, src.sort_order, src.foil_sorting);
      }
    }

    const placement = await describePlacement(db, id, req.user.id);
    res.json({ message: 'Card placed', placement });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to place card' });
  }
}

// 4c. Undo a move to Unsorted: put each copy back where it was, if that slot can
// still take it. Only copies still in Unsorted move; one the user has filed
// somewhere since stays where they put it.
async function restorePlacement(req, res) {
  const list = Array.isArray(req.body && req.body.placements) ? req.body.placements : null;
  if (!list || list.length === 0) return res.status(400).json({ error: 'placements is required' });
  if (list.length > 5000) return res.status(400).json({ error: 'Too many placements' });
  try {
    const result = await db.withTransaction(async () => {
      let restored = 0;
      let unplaced = 0;
      const touched = new Map();
      for (const p of list) {
        const entryId = parseInt(p && p.entry_id, 10);
        if (!Number.isInteger(entryId)) continue;
        const entry = await db.get(
          `SELECT * FROM collection WHERE id = ? AND user_id = ? AND compartment_id IS NULL AND location_id IS NULL`,
          [entryId, req.user.id]
        );
        if (!entry) continue;
        const place = await placementFor({
          ...entry,
          location_id: parseInt(p.location_id, 10) || null,
          compartment_id: parseInt(p.compartment_id, 10) || null,
          position: Number(p.position) || 0
        }, req.user.id);
        if (!place.compartment_id && !place.location_id) { unplaced++; continue; }
        await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [place.location_id, place.compartment_id, place.position, entryId, req.user.id]);
        if (place.rebalance) touched.set(place.compartment_id, place.rebalance);
        restored++;
      }
      for (const [compId, scheme] of touched) {
        await rebalanceCompartmentByScheme(db, compId, scheme.sort_order, scheme.foil_sorting);
      }
      return { restored, unplaced };
    });
    res.json(result);
  } catch (error) {
    console.error('Restore placement failed:', error);
    res.status(500).json({ error: 'Failed to put cards back' });
  }
}

function register(router) {
  router.post('/collection/:id/place', placeEntry);
  router.post('/collection/restore-placement', restorePlacement);
}

module.exports = { register };
