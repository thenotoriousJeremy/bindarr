const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { recommendSlot, compartmentLabel, loadCompartments, sortCards, locationAcceptsCard, compartmentAcceptsCard, loadSetsCache, getSortCategory } = require('../utils/compartmentSort');
const { defaultCompartmentPlan, normalizeRuleConfig } = require('../utils/collectionHelpers');

const router = express.Router();
router.use(authenticateToken);

// 6. Manage Locations (Physical Storage)
router.get('/locations', async (req, res) => {
  try {
    const locations = await db.all(`
      SELECT l.*, COUNT(DISTINCT c.id) as card_count, SUM(c.quantity) as total_cards,
        (SELECT COUNT(*) FROM compartments WHERE compartments.location_id = l.id) as compartment_count
      FROM locations l
      LEFT JOIN collection c ON l.id = c.location_id AND c.user_id = l.user_id
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

// rule_config arrives as an object (structured editor) or an already-encoded
// JSON string; store canonical JSON text either way. Double-stringifying a
// string would make locationAcceptsCard parse back a string instead of an
// object, silently breaking the filing rule. Throws on unparseable strings.
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
  const { name, type, sort_order, foil_sorting, rule_type, rule_config, game } = req.body;
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
        game = COALESCE(?, game)
      WHERE id = ? AND user_id = ?
    `, [name, type, sort_order, foil_sorting, rule_type, ruleConfigJson, game, id, req.user.id]);

    // A tightened rule/game may now reject cards already stored here. Evict them
    // to Unsorted (same as deleting the container) so it only holds cards it
    // accepts. Only runs when a rule/game field actually changed.
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

    // Disassociate cards from this location instead of blocking delete (scoped to user).
    // Deleting the location cascades to its compartments (ON DELETE CASCADE), which in
    // turn nulls collection.compartment_id (ON DELETE SET NULL) — this explicit update
    // covers location_id the same way for clarity/safety regardless of FK enforcement state.
    await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE location_id = ? AND user_id = ?`, [id, req.user.id]);

    await db.run(`DELETE FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json({ message: 'Location deleted successfully (any stored cards moved to Unsorted)' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

// 6b. Manage Compartments (pages/rows within a location)
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
    const nextIdx = (last?.maxIdx || 0) + 1;
    const capacity = parseInt(req.body.capacity, 10) || last?.capacity || defaultCompartmentPlan(loc.type).capacity;
    const result = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [id, nextIdx, capacity]);
    res.status(201).json({ message: 'Compartment added', id: result.lastID, idx: nextIdx });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add compartment' });
  }
});

router.patch('/compartments/:id', async (req, res) => {
  const { id } = req.params;
  const { label, capacity, rule_config } = req.body;
  try {
    const compartment = await db.get(`
      SELECT cp.id, cp.idx, cp.location_id FROM compartments cp
      JOIN locations l ON cp.location_id = l.id
      WHERE cp.id = ? AND l.user_id = ?
    `, [id, req.user.id]);
    if (!compartment) return res.status(404).json({ error: 'Compartment not found' });

    // Per-compartment filing rules. Passing null/empty clears them.
    let evicted = 0;
    if (rule_config !== undefined) {
      const hasRules = rule_config && (Array.isArray(rule_config) ? rule_config.length : (rule_config.rules || []).length);
      await db.run(`UPDATE compartments SET rule_config = ? WHERE id = ?`, [hasRules ? JSON.stringify(rule_config) : null, id]);

      // A tightened rule may now reject cards already filed in this compartment.
      // Evict them to Unsorted (the app doesn't auto-refile into sibling
      // compartments on a rule change) so the compartment only holds cards it accepts.
      if (hasRules) {
        const stored = await db.all(`
          SELECT c.id as entry_id, c.printing, c.language,
                 cc.name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.rarity, cc.supertype, cc.game,
                 cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
          FROM collection c
          JOIN card_cache cc ON c.card_id = cc.id
          WHERE c.compartment_id = ? AND c.user_id = ?
        `, [id, req.user.id]);
        for (const entry of stored) {
          entry.printing = entry.printing || 'Normal';
          entry.language = entry.language || 'English';
          try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }
          if (!compartmentAcceptsCard({ ruleConfig: rule_config }, entry)) {
            await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [entry.entry_id, req.user.id]);
            evicted++;
          }
        }
      }
    }

    if (req.query.updateAll === 'true' && capacity !== undefined) {
      await db.run(`UPDATE compartments SET capacity = COALESCE(?, capacity) WHERE location_id = ?`, [
        parseInt(capacity, 10),
        compartment.location_id
      ]);
      // Also update label if provided (only for this specific compartment)
      if (label !== undefined) {
        await db.run(`UPDATE compartments SET label = ? WHERE id = ?`, [label, id]);
      }
    } else {
      await db.run(`UPDATE compartments SET label = COALESCE(?, label), capacity = COALESCE(?, capacity) WHERE id = ?`, [
        label !== undefined ? label : null,
        capacity !== undefined ? parseInt(capacity, 10) : null,
        id
      ]);
    }
    res.json({ message: 'Compartment updated', evicted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update compartment' });
  }
});

// Only the highest-index (last) compartment in a location can be removed,
// and only if it's empty — removing one from the middle would require
// re-numbering every compartment after it and every card stored there.
router.delete('/compartments/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const compartment = await db.get(`
      SELECT cp.id, cp.idx, cp.location_id FROM compartments cp
      JOIN locations l ON cp.location_id = l.id
      WHERE cp.id = ? AND l.user_id = ?
    `, [id, req.user.id]);
    if (!compartment) return res.status(404).json({ error: 'Compartment not found' });

    const last = await db.get(`SELECT MAX(idx) as maxIdx FROM compartments WHERE location_id = ?`, [compartment.location_id]);
    if (compartment.idx !== last.maxIdx) {
      return res.status(400).json({ error: 'Only the last compartment can be removed' });
    }
    const cardCount = await db.get(`SELECT COUNT(*) as cnt FROM collection WHERE compartment_id = ?`, [id]);
    if (cardCount.cnt > 0) {
      return res.status(400).json({ error: 'Empty this compartment before removing it' });
    }
    const compartmentTotal = await db.get(`SELECT COUNT(*) as cnt FROM compartments WHERE location_id = ?`, [compartment.location_id]);
    if (compartmentTotal.cnt <= 1) {
      return res.status(400).json({ error: 'A location needs at least one compartment' });
    }

    await db.run(`DELETE FROM compartments WHERE id = ?`, [id]);
    res.json({ message: 'Compartment removed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove compartment' });
  }
});

// Replaces the full set of categories assigned to a compartment in one call —
// the sort assistant then prefers this compartment for matching cards.
router.put('/compartments/:id/filters', async (req, res) => {
  const { id } = req.params;
  const { filters = [] } = req.body;
  try {
    const compartment = await db.get(`
      SELECT cp.id FROM compartments cp
      JOIN locations l ON cp.location_id = l.id
      WHERE cp.id = ? AND l.user_id = ?
    `, [id, req.user.id]);
    if (!compartment) return res.status(404).json({ error: 'Compartment not found' });

    await db.run(`DELETE FROM compartment_assignments WHERE compartment_id = ?`, [id]);
    for (const filterValue of filters) {
      await db.run(`INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)`, [id, filterValue]);
    }
    res.json({ message: 'Filter assignments updated', filters });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update filter assignments' });
  }
});

// Distributes every owned category (based on the location's sort_order)
// across a location's compartments automatically, sizing each category to
// however many compartments it actually needs.
router.post('/locations/:id/auto-assign-categories', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT id, sort_order FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const compartments = await db.all(`SELECT id, idx, capacity FROM compartments WHERE location_id = ? ORDER BY idx ASC`, [id]);
    if (compartments.length === 0) return res.status(400).json({ error: 'This location has no compartments' });

    const allCards = await db.all(`
      SELECT c.quantity, c.language, cc.name, cc.set_name, cc.number, cc.types, cc.price_trend
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
    `, [req.user.id]);

    await loadSetsCache(db);

    const catCounts = new Map();
    allCards.forEach(c => {
      try { c.types = JSON.parse(c.types || '[]'); } catch { c.types = []; }
      const cat = getSortCategory(c, loc.sort_order);
      if (cat) {
        catCounts.set(cat, (catCounts.get(cat) || 0) + c.quantity);
      }
    });

    const catsBySize = Array.from(catCounts.entries())
      .map(([catName, owned]) => ({ catName, compartmentsNeeded: Math.max(1, Math.ceil(owned / (compartments[0]?.capacity || 40))) }))
      .sort((a, b) => b.compartmentsNeeded - a.compartmentsNeeded);

    const plan = new Map();
    let cursor = 0;
    const skipped = [];
    for (const { catName, compartmentsNeeded } of catsBySize) {
      if (cursor + compartmentsNeeded > compartments.length) {
        skipped.push(catName);
        continue;
      }
      for (let i = 0; i < compartmentsNeeded; i++) {
        const compartment = compartments[cursor + i];
        if (!plan.has(compartment.id)) plan.set(compartment.id, []);
        plan.get(compartment.id).push(catName);
      }
      cursor += compartmentsNeeded;
    }

    for (const compartment of compartments) {
      await db.run(`DELETE FROM compartment_assignments WHERE compartment_id = ?`, [compartment.id]);
      for (const catName of plan.get(compartment.id) || []) {
        await db.run(`INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)`, [compartment.id, catName]);
      }
    }

    res.json({
      message: 'Row assignments updated',
      assigned: Array.from(plan.entries()).map(([compartment_id, filters]) => ({ compartment_id, filters })),
      skipped
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to auto-assign categories' });
  }
});

// Recommends where a card would land in this location right now — used by
// the sort assistant to preview a placement before committing to it.
router.get('/locations/:id/recommend', async (req, res) => {
  const { id } = req.params;
  const { card_id, printing, language } = req.query;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    const cardMetadata = await db.get(`SELECT name, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity, game, cmc, color_identity FROM card_cache WHERE id = ?`, [card_id]);
    if (!cardMetadata) return res.status(404).json({ error: 'Card not found in cache' });
    cardMetadata.printing = printing || 'Normal';
    cardMetadata.language = language || 'English';
    try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

    // Distinguish rule rejection from a full container so the client can say
    // which one actually happened.
    if (!locationAcceptsCard(location, cardMetadata)) return res.json({ rejected: true });

    const recommendation = await recommendSlot(db, location, cardMetadata);
    if (!recommendation) return res.json({ full: true });
    res.json(recommendation);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute recommendation' });
  }
});

// Computes placement for a batch of unsorted cards, passing each placed card
// into the next iteration's mock state so they order correctly relative to each other.
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

      // Tell the client whether the miss was a rule mismatch or no room, so
      // the filing walkthrough can explain it instead of claiming "full".
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

// Files a whole batch of unsorted cards into a location in one request,
// simulating slot assignment against an in-memory snapshot so two cards in
// the same batch never collide on the same compartment/position — the
// "scan everything first, then apply once" workflow instead of filing cards
// one at a time.
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

// Re-sort an entire container: recompute every card's compartment+position from
// the container's scheme, fixing cross-compartment drift accumulated by
// incremental adds. Physical repair — returns the full card-by-card order so
// the client can walk the user through re-filing. Cards are cleared first, then
// re-placed in scheme order so each lands at its true slot.
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

    // Clear placements so recommendSlot plans against an empty container.
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

      // Only track capacity in-memory for slots inside THIS container; overflow
      // into another location is placed straight to the DB and not re-counted.
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
