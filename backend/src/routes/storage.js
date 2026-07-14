const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const {
  recommendSlot,
  compartmentLabel,
  loadCompartments,
  locationAcceptsCard,
  compartmentAcceptsCard,
  sortCards
} = require('../utils/compartmentSort');
const { defaultCompartmentPlan, normalizeRuleConfig } = require('../utils/collectionHelpers');

const router = express.Router();

router.use(authenticateToken);

// 1. Get Storage Locations with Compartment Summaries
router.get('/locations', async (req, res) => {
  try {
    const locations = await db.all(`
      SELECT l.*,
             COUNT(DISTINCT cp.id) as compartment_count,
             COALESCE(SUM(cp.capacity), 0) as total_capacity,
             COALESCE(SUM(c.quantity), 0) as total_cards
      FROM locations l
      LEFT JOIN compartments cp ON l.id = cp.location_id
      LEFT JOIN collection c ON cp.id = c.compartment_id AND c.user_id = l.user_id
      WHERE l.user_id = ?
      GROUP BY l.id
    `, [req.user.id]);
    res.json(locations);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve locations' });
  }
});

const RULE_TYPES = ['any', 'alphabetical_range', 'specific_sets', 'compound'];
const GAME_RESTRICTIONS = ['any', 'pokemon', 'mtg'];

router.post('/locations', async (req, res) => {
  const { name, type, sort_order = 'name-asc', foil_sorting = 'normals_first', rule_type = 'any', rule_config, compartmentPlan, game = 'any' } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  if (!RULE_TYPES.includes(rule_type)) {
    return res.status(400).json({ error: 'Invalid rule_type' });
  }
  if (!GAME_RESTRICTIONS.includes(game)) {
    return res.status(400).json({ error: 'Invalid game restriction' });
  }
  let ruleConfigJson;
  try {
    ruleConfigJson = normalizeRuleConfig(rule_config);
  } catch {
    return res.status(400).json({ error: 'rule_config must be valid JSON' });
  }
  try {
    const existing = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [name, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'A location with this name already exists' });
    }

    const result = await db.run(`
      INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, rule_config, game, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, type, sort_order, foil_sorting || 'normals_first', rule_type, ruleConfigJson, game, req.user.id]);

    const plan = compartmentPlan || defaultCompartmentPlan(type);
    await db.createCompartments(result.lastID, Math.max(1, parseInt(plan.count, 10) || 1), Math.max(1, parseInt(plan.capacity, 10) || 40));

    res.status(200).json({ message: 'Location created', id: result.lastID });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create location' });
  }
});

router.get('/locations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    res.json(loc);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve location' });
  }
});

router.put('/locations/:id', async (req, res) => {
  const { id } = req.params;
  const { name, type, sort_order, foil_sorting, rule_type, rule_config, game, locked } = req.body;
  if (rule_type !== undefined && !RULE_TYPES.includes(rule_type)) {
    return res.status(400).json({ error: 'Invalid rule_type' });
  }
  if (game !== undefined && !GAME_RESTRICTIONS.includes(game)) {
    return res.status(400).json({ error: 'Invalid game restriction' });
  }
  let ruleConfigJson;
  try {
    ruleConfigJson = rule_config !== undefined ? normalizeRuleConfig(rule_config) : undefined;
  } catch {
    return res.status(400).json({ error: 'rule_config must be valid JSON' });
  }
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    if (name) {
      const dup = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ? AND id != ?`, [name, req.user.id, id]);
      if (dup) {
        return res.status(400).json({ error: 'A location with this name already exists' });
      }
    }

    await db.run(`
      UPDATE locations
      SET
        name = COALESCE(?, name),
        type = COALESCE(?, type),
        sort_order = COALESCE(?, sort_order),
        foil_sorting = COALESCE(?, foil_sorting),
        rule_type = COALESCE(?, rule_type),
        rule_config = COALESCE(?, rule_config),
        game = COALESCE(?, game),
        locked = COALESCE(?, locked)
      WHERE id = ? AND user_id = ?
    `, [name, type, sort_order, foil_sorting, rule_type, ruleConfigJson, game, locked === undefined ? null : (locked ? 1 : 0), id, req.user.id]);

    let evicted = 0;
    if (rule_type !== undefined || rule_config !== undefined || game !== undefined) {
      const updated = await db.get(`SELECT id, rule_type, rule_config, game FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      const stored = await db.all(`
        SELECT c.id as entry_id, c.printing, c.language,
               cc.name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.rarity, cc.supertype, cc.game,
               cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.location_id = ? AND c.user_id = ?
      `, [id, req.user.id]);
      for (const entry of stored) {
        entry.printing = entry.printing || 'Normal';
        entry.language = entry.language || 'English';
        try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }
        if (!locationAcceptsCard(updated, entry)) {
          await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [entry.entry_id, req.user.id]);
          evicted++;
        }
      }
    }
    res.json({ message: 'Location updated', evicted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

router.delete('/locations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE location_id = ? AND user_id = ?`, [id, req.user.id]);

    await db.run(`DELETE FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json({ message: 'Location deleted successfully (any stored cards moved to Unsorted)' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

// 6b. Manage Compartments
router.get('/locations/:id/compartments', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const compartments = await loadCompartments(db, id, req.user.id);
    res.json(compartments.map(c => ({ ...c, display_label: compartmentLabel(c, loc.type) })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve compartments' });
  }
});

router.post('/locations/:id/compartments', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT id, type FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const last = await db.get(`SELECT MAX(idx) as maxIdx, capacity FROM compartments WHERE location_id = ? ORDER BY idx DESC LIMIT 1`, [id]);
    const nextIdx = (last && last.maxIdx ? last.maxIdx : 0) + 1;
    const capacity = (last && last.capacity) ? last.capacity : (loc.type === 'Binder' ? 9 : 400);

    const result = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [id, nextIdx, capacity]);
    const created = await db.get(`SELECT * FROM compartments WHERE id = ?`, [result.lastID]);
    res.status(201).json({ ...created, display_label: compartmentLabel(created, loc.type) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add compartment' });
  }
});

router.put('/locations/:id/compartments/:comp_id', async (req, res) => {
  const { id, comp_id } = req.params;
  const { label, capacity, rule_config, assignedFilters, locked } = req.body;
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    let ruleConfigJson;
    if (rule_config !== undefined) {
      try {
        ruleConfigJson = normalizeRuleConfig(rule_config);
      } catch {
        return res.status(400).json({ error: 'rule_config must be valid JSON' });
      }
    }

    const updates = [];
    const params = [];
    if (label !== undefined) { updates.push('label = ?'); params.push(label || null); }
    if (capacity !== undefined) { updates.push('capacity = ?'); params.push(Math.max(1, parseInt(capacity, 10) || 1)); }
    if (rule_config !== undefined) { updates.push('rule_config = ?'); params.push(ruleConfigJson); }
    if (locked !== undefined) { updates.push('locked = ?'); params.push(locked ? 1 : 0); }

    if (updates.length > 0) {
      params.push(comp_id, id);
      await db.run(`UPDATE compartments SET ${updates.join(', ')} WHERE id = ? AND location_id = ?`, params);
    }

    if (Array.isArray(assignedFilters)) {
      await db.run(`DELETE FROM compartment_assignments WHERE compartment_id = ?`, [comp_id]);
      for (const filterVal of assignedFilters) {
        if (filterVal) {
          await db.run(`INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)`, [comp_id, filterVal]);
        }
      }
    }

    res.json({ message: 'Compartment updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update compartment' });
  }
});

router.delete('/locations/:id/compartments/:comp_id', async (req, res) => {
  const { id, comp_id } = req.params;
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const totalComps = await db.get(`SELECT COUNT(*) as count FROM compartments WHERE location_id = ?`, [id]);
    if (totalComps.count <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last compartment of a location' });
    }

    await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE compartment_id = ? AND user_id = ?`, [comp_id, req.user.id]);
    await db.run(`DELETE FROM compartments WHERE id = ? AND location_id = ?`, [comp_id, id]);

    res.json({ message: 'Compartment deleted successfully (cards inside moved to Unsorted)' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete compartment' });
  }
});

// Recommendation endpoints
router.post('/locations/:id/recommend', async (req, res) => {
  const { id } = req.params;
  const { card_id, printing = 'Normal', language = 'English' } = req.body;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    const cardMetadata = await db.get(`SELECT name, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity, game, cmc, color_identity FROM card_cache WHERE id = ?`, [card_id]);
    if (!cardMetadata) return res.status(404).json({ error: 'Card not found in cache' });
    cardMetadata.printing = printing;
    cardMetadata.language = language;
    try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

    if (!locationAcceptsCard(location, cardMetadata)) {
      return res.json({ rejected: true });
    }

    const recommendation = await recommendSlot(db, location, cardMetadata);
    if (!recommendation) return res.json({ full: true });
    res.json(recommendation);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute recommendation' });
  }
});

router.post('/locations/:id/recommend-batch', async (req, res) => {
  const { id } = req.params;
  const { entry_ids = [] } = req.body;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });
    if (!Array.isArray(entry_ids) || entry_ids.length === 0) return res.status(400).json({ error: 'entry_ids is required' });

    let workingCompartments = await loadCompartments(db, id, req.user.id);
    const mockCards = [];
    const recommendations = [];

    for (const entryId of entry_ids) {
      const entry = await db.get(`
        SELECT c.id as entry_id, c.card_id, c.printing, c.language, cc.name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.supertype, cc.rarity, cc.image_url, cc.game
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.id = ? AND c.user_id = ?
      `, [entryId, req.user.id]);
      if (!entry) continue;
      try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }

      if (!locationAcceptsCard(location, entry)) {
        recommendations.push({ entry, recommended: null, rejected: true });
        continue;
      }

      const recommended = await recommendSlot(db, location, entry, workingCompartments, mockCards);
      if (!recommended) {
        recommendations.push({ entry, recommended: null, full: true });
        continue;
      }

      recommendations.push({ entry, recommended });

      workingCompartments = workingCompartments.map(c =>
        c.id === recommended.compartment_id ? { ...c, count: c.count + 1, free: c.free - 1 } : c
      );

      mockCards.push({
        entry_id: entry.entry_id,
        compartment_id: recommended.compartment_id,
        printing: entry.printing,
        language: entry.language,
        name: entry.name,
        supertype: entry.supertype,
        types: JSON.stringify(entry.types),
        rarity: entry.rarity,
        set_name: entry.set_name,
        number: entry.number,
        price_trend: entry.price_trend,
        price_normal: entry.price_normal,
        price_holofoil: entry.price_holofoil,
        price_reverse_holofoil: entry.price_reverse_holofoil
      });
    }

    res.json(recommendations);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute batch recommendations' });
  }
});

router.post('/locations/:id/apply-all', async (req, res) => {
  const { id } = req.params;
  const { entry_ids = [] } = req.body;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });
    if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
      return res.status(400).json({ error: 'entry_ids is required' });
    }

    let workingCompartments = await loadCompartments(db, id, req.user.id);
    let filed = 0;

    for (const entryId of entry_ids) {
      const entry = await db.get(`
        SELECT c.id, c.card_id, c.printing, c.language, cc.name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.supertype, cc.rarity, cc.game, cc.cmc, cc.color_identity
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.id = ? AND c.user_id = ?
      `, [entryId, req.user.id]);
      if (!entry) continue;
      try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }

      const recommended = await recommendSlot(db, location, entry, workingCompartments);
      if (!recommended) continue;

      await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [
        id, recommended.compartment_id, recommended.position, entryId, req.user.id
      ]);

      workingCompartments = workingCompartments.map(c =>
        c.id === recommended.compartment_id ? { ...c, count: c.count + 1, free: c.free - 1 } : c
      );
      filed++;
    }

    res.json({ message: `Filed ${filed} of ${entry_ids.length} card(s).`, filed, total: entry_ids.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to apply batch' });
  }
});

router.post('/locations/:id/resort', async (req, res) => {
  const { id } = req.params;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    const cards = await db.all(`
      SELECT c.id as entry_id, c.card_id, c.printing, c.language, c.quantity,
             cc.name, cc.set_name, cc.number, cc.types, cc.rarity, cc.supertype, cc.image_url, cc.game,
             cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.location_id = ? AND c.user_id = ?
    `, [id, req.user.id]);
    cards.forEach(c => { try { c.types = JSON.parse(c.types || '[]'); } catch { c.types = []; } });

    if (cards.length === 0) return res.json([]);

    await db.run(`UPDATE collection SET compartment_id = NULL, position = 0 WHERE location_id = ? AND user_id = ?`, [id, req.user.id]);

    const ordered = sortCards(cards, location.sort_order, location.foil_sorting);

    let workingCompartments = await loadCompartments(db, id, req.user.id);
    const results = [];

    for (const entry of ordered) {
      const recommended = await recommendSlot(db, location, entry, workingCompartments, []);
      if (!recommended) { results.push({ entry, recommended: null }); continue; }

      const finalLoc = recommended.location_id || Number(id);
      await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [
        finalLoc, recommended.compartment_id, recommended.position, entry.entry_id, req.user.id
      ]);
      results.push({ entry, recommended });

      if (finalLoc === Number(id)) {
        workingCompartments = workingCompartments.map(c =>
          c.id === recommended.compartment_id ? { ...c, count: c.count + 1, free: c.free - 1 } : c
        );
      }
    }

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to re-sort container' });
  }
});

module.exports = router;
