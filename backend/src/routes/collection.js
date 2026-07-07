const express = require('express');
const db = require('../db');
const tcgApi = require('../tcgApi');
const { authenticateToken } = require('../middleware/auth');
const {
  resolveCardPrice,
  isVintageSet,
  parseSqliteUtc
} = require('../utils/priceHelpers');
const { recommendSlot, compartmentLabel, loadCompartments, rebalanceCompartmentByScheme, sortCards, locationAcceptsCard } = require('../utils/compartmentSort');

// Default compartment plan by container type — used when a caller doesn't
// specify one at creation time (see POST /locations).
function defaultCompartmentPlan(type) {
  if (type === 'Binder') return { count: 30, capacity: 9 };
  if (type === 'Toploader Binder') return { count: 14, capacity: 4 };
  if (type === 'Box') return { count: 3, capacity: 1000 };
  if (type === 'Toploader Box') return { count: 1, capacity: 100 };
  if (type === 'Graded Slab Box') return { count: 1, capacity: 40 };
  if (type === 'Display Shelf / Stand') return { count: 1, capacity: 10 };
  if (type === 'Deck Box') return { count: 1, capacity: 60 };
  if (type === 'Tin / Case') return { count: 1, capacity: 200 };
  return { count: 1, capacity: 1000 };
}

// Resolves where a card should actually land: an explicit compartment_id is
// trusted as-is (manual placement from the box/binder UI); given only a
// location_id, the recommendation engine picks a compartment automatically;
// given neither, the card is unsorted. Shared by add/update so both follow
// the exact same rule instead of drifting apart.
async function resolveCompartmentAndPosition({ locationId, compartmentId, position, userId, cardId, printing, excludeEntryId }) {
  if (compartmentId !== undefined && compartmentId !== null) {
    // A caller-supplied compartment can go stale (the location/compartment was
    // deleted after the client picked it) — verify it still exists rather than
    // trusting it into an INSERT and blowing up the compartment_id FK.
    const compartment = await db.get(`
      SELECT c.id, c.idx, c.label, c.capacity, l.type as loc_type, l.name as loc_name FROM compartments c JOIN locations l ON c.location_id = l.id
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

    const label = `${compartmentLabel(compartment, compartment.loc_type)} (in ${compartment.loc_name})`;
    if (position !== undefined) return { compartment_id: compartmentId, position, label };
    return { compartment_id: compartmentId, position: ((countRow?.cnt || 0) + 1) * 1000, label };
  }
  if (!locationId) {
    return { compartment_id: null, position: position !== undefined ? position : 0 };
  }

  const location = await db.get(`SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, user_id FROM locations WHERE id = ? AND user_id = ?`, [locationId, userId]);
  if (!location) return { compartment_id: null, position: 0 };

  const cardMetadata = await db.get(`SELECT name, set_name, number, types, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity FROM card_cache WHERE id = ?`, [cardId]);
  if (!cardMetadata) return { compartment_id: null, position: 0 };
  cardMetadata.printing = printing || 'Normal';
  try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

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

const router = express.Router();

router.use(authenticateToken);

// 1. Search Pokémon TCG cards (proxies to Pokemon TCG API and database cache)
router.get('/search', async (req, res) => {
  const { name, number, set, scope = 'database' } = req.query;
  try {
    const results = await tcgApi.searchCards(name, number, set, req.user.tcg_api_key, scope, req.user.id);
    res.json(results);
  } catch (error) {
    console.error(error);
    if (error.message === 'INVALID_API_KEY') {
      return res.status(403).json({ error: 'Invalid API Key' });
    }
    if (error.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    res.status(500).json({ error: 'Search failed' });
  }
});

// 2. Get User's Collection
router.get('/collection', async (req, res) => {
  try {
    const listType = req.query.list_type || 'collection';
    const isTrade = req.query.is_trade;

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ?`;
    let filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }

    const query = `
      SELECT
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.compartment_id,
        c.position,
        c.added_at,
        c.is_trade,
        c.list_type,
        cc.name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        l.id as location_id,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label,
        cp.capacity as compartment_capacity
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    // Parse JSON fields
    const formatted = rows.map(row => ({
      ...row,
      price_trend: resolveCardPrice(row),
      subtypes: JSON.parse(row.subtypes || '[]'),
      types: JSON.parse(row.types || '[]'),
      compartment_display_label: row.compartment_id
        ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type)
        : null,
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve collection' });
  }
});

// 3. Add Card to Collection
router.post('/collection', async (req, res) => {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    printing = 'Normal',
    language = 'English',
    purchase_price = 0,
    location_id = null,
    compartment_id = null,
    list_type = 'collection',
    is_trade = 0,
    position
  } = req.body;

  if (!card_id) {
    return res.status(400).json({ error: 'card_id is required' });
  }

  try {
    // Ensure location_id belongs to the user if provided
    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        return res.status(400).json({ error: 'Invalid location ID' });
      }
    }

    // Ensure card is in the local metadata cache
    let card = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      console.log(`Card ${card_id} not found in cache. Fetching from API first...`);
      let apiCard;
      try {
        apiCard = await tcgApi.getCardById(card_id, req.user.tcg_api_key);
      } catch (fetchError) {
        if (fetchError.message === 'INVALID_API_KEY') {
          return res.status(403).json({ error: 'Invalid API Key' });
        }
        if (fetchError.message === 'RATE_LIMIT_EXCEEDED') {
          return res.status(429).json({ error: 'Rate limit exceeded' });
        }
        throw fetchError;
      }
      if (!apiCard) {
        return res.status(404).json({ error: `Card ID ${card_id} not found on Pokémon TCG API.` });
      }
    }

    const resolved = await resolveCompartmentAndPosition({
      locationId: location_id, compartmentId: compartment_id, position, userId: req.user.id, cardId: card_id, printing
    });
    const finalLocationId = resolved.location_id !== undefined && resolved.location_id !== null ? resolved.location_id : location_id;

    // No stacking logic here anymore
    
    // If the frontend passed quantity > 1, we insert them as separate unstacked rows
    const numToInsert = quantity ? parseInt(quantity, 10) : 1;
    let lastInsertedId;

    for (let i = 0; i < numToInsert; i++) {
      const result = await db.run(`
        INSERT INTO collection
        (card_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, user_id, list_type, is_trade, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        card_id,
        1, // ALWAYS 1, never stacked
        condition,
        printing,
        language,
        purchase_price || 0,
        finalLocationId,
        resolved.compartment_id,
        req.user.id,
        list_type,
        is_trade ? 1 : 0,
        resolved.position
      ]);
      lastInsertedId = result.lastID;

      if (resolved.compartment_id) {
        // Re-derive positions from the container's scheme so the new card sorts
        // into its true slot instead of colliding with whatever was there.
        const rbLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [finalLocationId, req.user.id]);
        await rebalanceCompartmentByScheme(db, resolved.compartment_id, req.user.id, rbLoc);
      }
    }

    // Record initial price history trend
    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [card_id]);
    if (cacheCard && cacheCard.price_trend > 0) {
      await db.run(`INSERT OR IGNORE INTO price_history (card_id, price) VALUES (?, ?)`, [card_id, cacheCard.price_trend]);
    }

    res.status(201).json({
      message: 'Card added to collection',
      id: lastInsertedId,
      // Where the card physically landed, so the scanner can tell the user
      // which page/row to put the real card in. null = left Unsorted.
      placement: resolved.compartment_id
        ? await describePlacement(db, lastInsertedId, req.user.id)
        : null,
      container_full: !!resolved.full
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// 4. Update Card in Collection
router.put('/collection/:id', async (req, res) => {
  const { id } = req.params;
  const {
    quantity,
    condition,
    printing,
    language,
    purchase_price,
    location_id,
    compartment_id,
    list_type,
    is_trade,
    position
  } = req.body;

  try {
    // Ensure entry exists and belongs to the user
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }

    // Ensure location_id belongs to the user if updated
    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        return res.status(400).json({ error: 'Invalid location ID' });
      }
    }

    // Only re-resolve the compartment when the caller actually asked to move
    // this card (compartment_id given explicitly, or location_id changed) —
    // never as a side effect of e.g. just updating quantity.
    let finalLocId = entry.location_id;
    let finalCompartmentId = entry.compartment_id;
    let finalPosition = position;
    let resolvedFull = false;
    const isMoving = compartment_id !== undefined || (location_id !== undefined && location_id !== entry.location_id);
    if (isMoving) {
      const resolved = await resolveCompartmentAndPosition({
        locationId: location_id !== undefined ? location_id : entry.location_id,
        compartmentId: compartment_id,
        position,
        userId: req.user.id,
        cardId: entry.card_id,
        printing: printing !== undefined ? printing : entry.printing,
        excludeEntryId: id
      });
      finalLocId = resolved.location_id !== undefined && resolved.location_id !== null ? resolved.location_id : (location_id !== undefined ? location_id : entry.location_id);
      finalCompartmentId = resolved.compartment_id;
      finalPosition = resolved.position;
      resolvedFull = !!resolved.full;
    }

    // Compute what the final values would be after this update
    const finalQuantity = quantity !== undefined ? parseInt(quantity, 10) : entry.quantity;
    const finalCondition = condition !== undefined ? condition : entry.condition;
    const finalPrinting = printing !== undefined ? printing : entry.printing;
    const finalLanguage = language !== undefined ? language : entry.language;
    const finalListType = list_type !== undefined ? list_type : entry.list_type;
    const finalIsTrade = is_trade !== undefined ? (is_trade ? 1 : 0) : entry.is_trade;

    // No stacking logic here anymore

    // Build dynamic UPDATE query based on passed values
    const fields = [];
    const params = [];

    if (quantity !== undefined) { fields.push('quantity = ?'); params.push(quantity); }
    if (condition !== undefined) { fields.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { fields.push('printing = ?'); params.push(printing); }
    if (language !== undefined) { fields.push('language = ?'); params.push(language); }
    if (purchase_price !== undefined) { fields.push('purchase_price = ?'); params.push(purchase_price); }
    if (location_id !== undefined) { fields.push('location_id = ?'); params.push(location_id); }
    if (isMoving) { fields.push('compartment_id = ?'); params.push(finalCompartmentId); }
    if (list_type !== undefined) { fields.push('list_type = ?'); params.push(list_type); }
    if (is_trade !== undefined) { fields.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
    if (finalPosition !== undefined) { fields.push('position = ?'); params.push(finalPosition); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields provided for update' });
    }

    params.push(id);
    params.push(req.user.id);
    await db.run(`UPDATE collection SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);

    if (finalCompartmentId && finalPosition !== undefined) {
      // Re-derive the whole compartment from its scheme so the moved card sorts
      // into its true slot instead of colliding with an existing position.
      const rbLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [finalLocId, req.user.id]);
      await rebalanceCompartmentByScheme(db, finalCompartmentId, req.user.id, rbLoc);
    }

    // Read the real post-rebalance slot so the label's Pos is accurate.
    const finalPlacement = isMoving && finalCompartmentId ? await describePlacement(db, id, req.user.id) : null;
    res.json({ message: 'Collection entry updated successfully', placement: finalPlacement, container_full: resolvedFull });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// 5. Delete Card from Collection
router.delete('/collection/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }
    res.json({ message: 'Card removed from collection' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card' });
  }
});

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

router.post('/locations', async (req, res) => {
  const { name, type, sort_order = 'name-asc', foil_sorting = 'normals_first', rule_type = 'any', rule_config, compartmentPlan } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  try {
    const existing = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [name, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'A location with this name already exists' });
    }

    const result = await db.run(`
      INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, rule_config, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [name, type, sort_order, foil_sorting || 'normals_first', rule_type, rule_config ? JSON.stringify(rule_config) : null, req.user.id]);

    const plan = compartmentPlan || defaultCompartmentPlan(type);
    await db.createCompartments(result.lastID, Math.max(1, parseInt(plan.count, 10) || 1), Math.max(1, parseInt(plan.capacity, 10) || 40));

    res.status(201).json({ message: 'Location created', id: result.lastID });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create location' });
  }
});

router.put('/locations/:id', async (req, res) => {
  const { id } = req.params;
  const { name, type, sort_order, foil_sorting, rule_type, rule_config } = req.body;
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
        rule_config = COALESCE(?, rule_config)
      WHERE id = ? AND user_id = ?
    `, [name, type, sort_order, foil_sorting, rule_type, rule_config !== undefined ? JSON.stringify(rule_config) : undefined, id, req.user.id]);
    res.json({ message: 'Location updated' });
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
  const { label, capacity } = req.body;
  try {
    const compartment = await db.get(`
      SELECT cp.id, cp.idx, cp.location_id FROM compartments cp
      JOIN locations l ON cp.location_id = l.id
      WHERE cp.id = ? AND l.user_id = ?
    `, [id, req.user.id]);
    if (!compartment) return res.status(404).json({ error: 'Compartment not found' });

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
    res.json({ message: 'Compartment updated' });
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
      SELECT c.quantity, cc.name, cc.set_name, cc.number, cc.types, cc.price_trend
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
    `, [req.user.id]);

    const { loadSetsCache, sortCards } = require('../utils/compartmentSort');
    await loadSetsCache(db);
    // Since getSortCategory is not exported, we need to export it, but wait! We can just fetch it from utils/compartmentSort.js!
    const { getSortCategory } = require('../utils/compartmentSort');

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
  const { card_id, printing } = req.query;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    const cardMetadata = await db.get(`SELECT name, set_name, number, types, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity FROM card_cache WHERE id = ?`, [card_id]);
    if (!cardMetadata) return res.status(404).json({ error: 'Card not found in cache' });
    cardMetadata.printing = printing || 'Normal';
    try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

    const recommendation = await recommendSlot(db, location, cardMetadata);
    if (!recommendation) return res.json({ full: true });
    res.json(recommendation);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute recommendation' });
  }
});



router.post('/smart-recommend-batch', async (req, res) => {
  const { entry_ids = [] } = req.body;
  try {
    if (!Array.isArray(entry_ids) || entry_ids.length === 0) return res.status(400).json({ error: 'entry_ids is required' });

    const locations = await db.all(`SELECT * FROM locations WHERE user_id = ?`, [req.user.id]);
    const stateByLocation = {};
    for (const loc of locations) {
      stateByLocation[loc.id] = {
        workingCompartments: await loadCompartments(db, loc.id, req.user.id),
        mockCards: []
      };
    }

    const recommendations = [];

    for (const entryId of entry_ids) {
      const entry = await db.get(`
        SELECT c.id as entry_id, c.card_id, c.printing, cc.name, cc.set_name, cc.number, cc.types, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.supertype, cc.rarity, cc.image_url
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.id = ? AND c.user_id = ?
      `, [entryId, req.user.id]);
      if (!entry) continue;
      try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }

      const targetLoc = locations.find(l => locationAcceptsCard(l, entry));
      if (!targetLoc) {
        recommendations.push({ entry, recommended: null, reason: 'No matching location rules' });
        continue;
      }

      const state = stateByLocation[targetLoc.id];
      const recommended = await recommendSlot(db, targetLoc, entry, state.workingCompartments, state.mockCards);
      
      if (!recommended) {
        recommendations.push({ entry, recommended: null, reason: 'Container full' });
        continue;
      }
      
      recommendations.push({ entry, recommended });

      state.workingCompartments = state.workingCompartments.map(c =>
        c.id === recommended.compartment_id ? { ...c, count: c.count + 1, free: c.free - 1 } : c
      );
      
      state.mockCards.push({
        entry_id: entry.entry_id,
        compartment_id: recommended.compartment_id,
        printing: entry.printing,
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
    res.status(500).json({ error: 'Failed to compute smart batch recommendations' });
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
        SELECT c.id as entry_id, c.card_id, c.printing, cc.name, cc.set_name, cc.number, cc.types, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.supertype, cc.rarity, cc.image_url
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.id = ? AND c.user_id = ?
      `, [entryId, req.user.id]);
      if (!entry) continue;
      try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }

      const recommended = await recommendSlot(db, location, entry, workingCompartments, mockCards);
      if (!recommended) {
        recommendations.push({ entry, recommended: null });
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
        SELECT c.id, c.card_id, c.printing, cc.name, cc.set_name, cc.number, cc.types, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.supertype, cc.rarity
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
      SELECT c.id as entry_id, c.card_id, c.printing, c.quantity,
             cc.name, cc.set_name, cc.number, cc.types, cc.rarity, cc.supertype, cc.image_url,
             cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil
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
    const mockCards = [];
    const results = [];

    for (const entry of ordered) {
      const recommended = await recommendSlot(db, location, entry, workingCompartments, mockCards);
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
        mockCards.push({
          entry_id: entry.entry_id, compartment_id: recommended.compartment_id, printing: entry.printing,
          name: entry.name, supertype: entry.supertype, types: JSON.stringify(entry.types), rarity: entry.rarity,
          set_name: entry.set_name, number: entry.number, price_trend: entry.price_trend,
          price_normal: entry.price_normal, price_holofoil: entry.price_holofoil, price_reverse_holofoil: entry.price_reverse_holofoil
        });
      }
    }

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to re-sort container' });
  }
});

// 7. Get Collection Statistics & Analytics
router.get('/stats', async (req, res) => {
  try {
    // Retrieve all collection items to compute statistics
    const query = `
      SELECT
        c.quantity, c.purchase_price, c.added_at, c.printing, c.condition, c.card_id,
        cc.types, cc.rarity, cc.set_name, cc.set_id, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil,
        cc.price_avg1, cc.price_avg7, cc.price_avg30,
        l.name as location_name
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      WHERE c.user_id = ?
    `;
    const rows = await db.all(query, [req.user.id]);

    let totalCards = 0;
    let uniqueCards = rows.length;
    let totalValue = 0;
    let totalSpent = 0;
    let unsortedCount = 0;
    let nearMintCount = 0;
    let vintageCount = 0;

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * oneDayMs;
    const thirtyDaysMs = 30 * oneDayMs;

    // Cardmarket's avg7/avg30 are the only genuine historical price data this
    // app can get (nothing goes back further than 30 days from any source).
    // Both the "now" and "then" totals below are summed over the SAME subset
    // of cards that actually have that real data, so the percentage change
    // isn't skewed by cards silently missing from one side of the comparison.
    let value7dAgo = 0, valueNowFor7d = 0;
    let value30dAgo = 0, valueNowFor30d = 0;

    const typeCounts = {};
    const rarityCounts = {};
    const setCounts = {};
    const locationCounts = {};

    rows.forEach(row => {
      const qty = row.quantity || 1;
      const price = resolveCardPrice(row);
      const addedTime = row.added_at ? parseSqliteUtc(row.added_at).getTime() : now;

      totalCards += qty;
      totalValue += qty * price;
      totalSpent += qty * (row.purchase_price || 0);
      if (!row.location_name) unsortedCount += qty;

      if (row.condition === 'Near Mint') {
        nearMintCount += qty;
      }

      if (isVintageSet(row.set_id)) {
        vintageCount += qty;
      }

      // Only count a card toward the historical comparison if it was owned
      // that long ago AND has real Cardmarket data for both ends of the
      // window. Comparing avg7/avg30 against price_trend (usually TCGPlayer)
      // would mix two different marketplaces' pricing and produce a "change"
      // that's really just the static US/EU price gap, not real movement —
      // avg1 keeps both sides of the comparison on Cardmarket.
      if (addedTime <= now - sevenDaysMs && row.price_avg7 > 0 && row.price_avg1 > 0) {
        value7dAgo += qty * row.price_avg7;
        valueNowFor7d += qty * row.price_avg1;
      }
      if (addedTime <= now - thirtyDaysMs && row.price_avg30 > 0 && row.price_avg1 > 0) {
        value30dAgo += qty * row.price_avg30;
        valueNowFor30d += qty * row.price_avg1;
      }

      // Parse types
      const types = JSON.parse(row.types || '[]');
      types.forEach(t => {
        typeCounts[t] = (typeCounts[t] || 0) + qty;
      });
      if (types.length === 0) {
        typeCounts['Colorless'] = (typeCounts['Colorless'] || 0) + qty;
      }

      // Rarity
      const rarity = row.rarity || 'Unknown';
      rarityCounts[rarity] = (rarityCounts[rarity] || 0) + qty;

      // Set
      const set = row.set_name || 'Other';
      if (!setCounts[row.set_id]) {
        setCounts[row.set_id] = { name: set, count: 0, value: 0 };
      }
      setCounts[row.set_id].count += qty;
      setCounts[row.set_id].value += qty * price;

      // Location
      const loc = row.location_name || 'Unassigned';
      locationCounts[loc] = (locationCounts[loc] || 0) + qty;
    });

    // Get top most valuable cards (scoped to user)
    const topValuableQuery = `
      SELECT
        c.id AS entry_id, c.location_id, (SELECT name FROM locations WHERE id = c.location_id) AS location_name,
        c.quantity, c.condition, c.printing, c.language, c.purchase_price,
        cc.id as card_id, cc.name, cc.rarity, cc.set_name, cc.image_url, cc.price_trend,
        cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
      ORDER BY CASE
        WHEN c.printing = 'Holofoil' AND cc.price_holofoil IS NOT NULL AND cc.price_holofoil > 0 THEN cc.price_holofoil
        WHEN c.printing = 'Reverse Holofoil' AND cc.price_reverse_holofoil IS NOT NULL AND cc.price_reverse_holofoil > 0 THEN cc.price_reverse_holofoil
        WHEN c.printing = 'Normal' AND cc.price_normal IS NOT NULL AND cc.price_normal > 0 THEN cc.price_normal
        ELSE cc.price_trend
      END DESC
      LIMIT 6
    `;
    const topValuableRows = await db.all(topValuableQuery, [req.user.id]);
    const topValuable = topValuableRows.map(row => ({
      ...row,
      price_trend: resolveCardPrice(row)
    }));

    // Compute progress for top 4 sets in database (estimate set total)
    const setSizes = {
      'base1': 102,  // Base Set
      'base2': 64,   // Jungle
      'base3': 62,   // Fossil
      'base4': 130,  // Base Set 2
      'neo1': 111,   // Neo Genesis
      'cel25': 25,   // Celebrations
      'swsh1': 202,  // Sword & Shield Base
      'swsh11': 196, // Lost Origin
      'swsh12': 98,  // Silver Tempest
      'sv1': 198,    // Scarlet & Violet Base
      'sv2': 193,    // Paldea Evolved
      'sv3': 197,    // Obsidian Flames
      'sv3pt5': 165, // 151
    };

    const setProgress = [];
    for (const setId in setCounts) {
      const userUniqueInSet = await db.get(`
        SELECT COUNT(DISTINCT card_id) as count
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE cc.set_id = ? AND c.user_id = ?
      `, [setId, req.user.id]);

      const size = setSizes[setId] || 150; // default estimate if set not in database
      const count = userUniqueInSet.count;
      setProgress.push({
        setId,
        setName: setCounts[setId].name,
        ownedUnique: count,
        totalCards: size,
        percent: Math.min(Math.round((count / size) * 100), 100)
      });
    }

    // Sort set progress by completion percentage descending
    setProgress.sort((a, b) => b.percent - a.percent);

    const mintRate = totalCards > 0 ? parseFloat(((nearMintCount / totalCards) * 100).toFixed(1)) : 0.0;
    const vintageRatio = totalCards > 0 ? parseFloat(((vintageCount / totalCards) * 100).toFixed(1)) : 0.0;

    // Recently added cards (most useful "what did I just add" glance)
    const recentRows = await db.all(`
      SELECT c.id AS entry_id, c.location_id, (SELECT name FROM locations WHERE id = c.location_id) AS location_name,
             c.quantity, c.condition, c.printing, c.language, c.added_at,
             cc.id as card_id, cc.name, cc.rarity, cc.set_name, cc.number, cc.image_url,
             cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
      ORDER BY c.added_at DESC
      LIMIT 6
    `, [req.user.id]);
    const recentAdditions = recentRows.map(row => ({ ...row, price_trend: resolveCardPrice(row) }));

    const gainAbs = totalValue - totalSpent;
    const roi = {
      abs: parseFloat(gainAbs.toFixed(2)),
      pct: totalSpent > 0 ? parseFloat(((gainAbs / totalSpent) * 100).toFixed(1)) : null
    };
    const avgCardValue = totalCards > 0 ? parseFloat((totalValue / totalCards).toFixed(2)) : 0.0;

    res.json({
      summary: {
        totalCards,
        uniqueCards,
        totalValue: parseFloat(totalValue.toFixed(2)),
        totalSpent: parseFloat(totalSpent.toFixed(2)),
        roi,
        avgCardValue,
        unsortedCount,
        duplicateCopies: Math.max(totalCards - uniqueCards, 0),
        mintRate,
        vintageRatio,
        // change7d/change30d compare current vs. real Cardmarket avg7/avg30
        // over the same subset of cards that have that data — never
        // simulated. change1y/change5y have no real data source anywhere
        // (no API here provides pricing history beyond 30 days), so they're
        // marked unavailable instead of faked.
        change7d: value7dAgo > 0 ? {
          available: true,
          abs: parseFloat((valueNowFor7d - value7dAgo).toFixed(2)),
          pct: parseFloat((((valueNowFor7d - value7dAgo) / value7dAgo) * 100).toFixed(1))
        } : { available: false, abs: null, pct: null },
        change30d: value30dAgo > 0 ? {
          available: true,
          abs: parseFloat((valueNowFor30d - value30dAgo).toFixed(2)),
          pct: parseFloat((((valueNowFor30d - value30dAgo) / value30dAgo) * 100).toFixed(1))
        } : { available: false, abs: null, pct: null },
        change1y: { available: false, abs: null, pct: null },
        change5y: { available: false, abs: null, pct: null }
      },
      types: Object.keys(typeCounts).map(name => ({ name, value: typeCounts[name] })),
      rarities: Object.keys(rarityCounts).map(name => ({ name, value: rarityCounts[name] })),
      sets: Object.keys(setCounts).map(id => ({
        id,
        name: setCounts[id].name,
        count: setCounts[id].count,
        value: parseFloat(setCounts[id].value.toFixed(2))
      })).sort((a, b) => b.value - a.value).slice(0, 8),
      locations: Object.keys(locationCounts).map(name => ({ name, value: locationCounts[name] })),
      topValuable,
      recentAdditions,
      setProgress: setProgress.slice(0, 4)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute statistics' });
  }
});

// 7b. Get Collection Net Worth Timeline History
router.get('/stats/history', async (req, res) => {
  try {
    const { period = '30d' } = req.query;

    // Retrieve all collection items to compute history
    const query = `
      SELECT c.quantity, c.added_at, c.printing, cc.id as card_id, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
    `;
    const items = await db.all(query, [req.user.id]);

    // Real recorded price snapshots for every card this user owns, oldest
    // first, so each item's price at any past point can be looked up without
    // per-item queries. No source anywhere provides price history beyond
    // what this table accumulates over the app's actual real lifetime.
    const cardIds = [...new Set(items.map(i => i.card_id))];
    let historyByCard = {};
    if (cardIds.length > 0) {
      const placeholders = cardIds.map(() => '?').join(',');
      const historyRows = await db.all(
        `SELECT card_id, price, recorded_at FROM price_history WHERE card_id IN (${placeholders}) ORDER BY recorded_at ASC`,
        cardIds
      );
      historyRows.forEach(r => {
        if (!historyByCard[r.card_id]) historyByCard[r.card_id] = [];
        historyByCard[r.card_id].push({ price: r.price, time: parseSqliteUtc(r.recorded_at).getTime() });
      });
    }

    // Real price for a card at a point in time: the latest recorded snapshot
    // at or before that time; if history only starts later, carry the
    // earliest real snapshot backward rather than guess; if the card has no
    // history at all, fall back to its current real price_trend. Every value
    // used here was actually recorded or is the actual current price — never
    // a fabricated curve.
    const realPriceAt = (item, targetTime) => {
      const hist = historyByCard[item.card_id];
      if (!hist || hist.length === 0) return resolveCardPrice(item);
      let best = null;
      for (const h of hist) {
        if (h.time <= targetTime) best = h;
        else break;
      }
      return (best || hist[0]).price;
    };

    const now = Date.now();
    let step = 0;
    let count = 0;
    let formatLabel = (d) => d.toLocaleDateString();

    if (period === '7d') {
      count = 7;
      step = 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { weekday: 'short' });
    } else if (period === '30d') {
      count = 30;
      step = 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } else if (period === '1y') {
      count = 12;
      step = 30 * 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    } else if (period === '5y') {
      count = 20;
      step = 91 * 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    } else {
      count = 30;
      step = 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    const historyData = [];
    for (let i = count - 1; i >= 0; i--) {
      const targetTime = now - (i * step);
      const targetDate = new Date(targetTime);

      let totalValue = 0;
      items.forEach(item => {
        const addedTime = parseSqliteUtc(item.added_at).getTime();
        if (addedTime <= targetTime) {
          totalValue += item.quantity * realPriceAt(item, targetTime);
        }
      });

      historyData.push({
        date: formatLabel(targetDate),
        value: parseFloat(totalValue.toFixed(2))
      });
    }

    res.json(historyData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute timeline history' });
  }
});

// 8. Export Database
router.get('/export', async (req, res) => {
  const { format = 'csv' } = req.query;
  try {
    const query = `
      SELECT
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.added_at,
        cc.id as card_id,
        cc.name as card_name,
        cc.supertype,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number as card_number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      WHERE c.user_id = ?
    `;
    const dbRows = await db.all(query, [req.user.id]);
    const rows = dbRows.map(row => {
      const resolvedPrice = resolveCardPrice(row);
      return {
        ...row,
        market_price: resolvedPrice,
        compartment_display: row.compartment_idx ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type) : ''
      };
    });

    if (format.toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=pokedexrr_collection.json');
      return res.json(rows);
    }

    // Default to CSV
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=pokedexrr_collection.csv');

    // Headers
    const headers = [
      'Card ID', 'Name', 'Set Name', 'Set ID', 'Card Number', 'Rarity',
      'Quantity', 'Condition', 'Printing', 'Language', 'Purchase Price',
      'Market Price', 'Location Container', 'Compartment', 'Added At'
    ];

    // Neutralize leading =, +, -, @ so spreadsheet apps don't interpret free-text
    // fields (card/location names) as formulas when the export is opened.
    const csvCell = (value) => {
      const str = String(value ?? '');
      return /^[=+\-@]/.test(str) ? `'${str}` : str;
    };

    let csvContent = headers.join(',') + '\n';

    rows.forEach(r => {
      const line = [
        r.card_id,
        `"${csvCell(r.card_name).replace(/"/g, '""')}"`,
        `"${csvCell(r.set_name).replace(/"/g, '""')}"`,
        r.set_id,
        r.card_number,
        r.rarity,
        r.quantity,
        r.condition,
        r.printing,
        r.language,
        r.purchase_price || 0,
        r.market_price || 0,
        r.location_name ? `"${csvCell(r.location_name).replace(/"/g, '""')}"` : 'Unassigned',
        r.compartment_display ? `"${csvCell(r.compartment_display).replace(/"/g, '""')}"` : '',
        r.added_at
      ];
      csvContent += line.join(',') + '\n';
    });

    res.send(csvContent);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// 8b. Import Database
router.post('/import', async (req, res) => {
  try {
    const { format, data } = req.body;
    if (!data) {
      return res.status(400).json({ error: 'No data provided' });
    }

    let cards = [];

    if (format === 'json') {
      cards = typeof data === 'string' ? JSON.parse(data) : data;
    } else if (format === 'csv') {
      const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length <= 1) {
        return res.status(400).json({ error: 'CSV file is empty' });
      }

      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

      const parseCSVLine = (line) => {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        result.push(current.trim());
        return result;
      };

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;

        const cardObj = {};
        headers.forEach((header, idx) => {
          cardObj[header] = values[idx];
        });

        cards.push({
          card_id: cardObj['Card ID'],
          card_name: cardObj['Name'],
          set_name: cardObj['Set Name'],
          set_id: cardObj['Set ID'],
          card_number: cardObj['Card Number'],
          rarity: cardObj['Rarity'],
          quantity: parseInt(cardObj['Quantity']) || 1,
          condition: cardObj['Condition'] || 'Near Mint',
          printing: cardObj['Printing'] || 'Normal',
          language: cardObj['Language'] || 'English',
          purchase_price: parseFloat(cardObj['Purchase Price']) || 0,
          market_price: parseFloat(cardObj['Market Price']) || 0,
          location_name: cardObj['Location Container'],
          added_at: cardObj['Added At']
        });
      }
    }

    if (!Array.isArray(cards)) {
      return res.status(400).json({ error: 'Invalid data format. Expected an array or CSV lines.' });
    }

    let importedCount = 0;
    for (const card of cards) {
      const cardId = card.card_id || card.id;
      if (!cardId) continue;

      // 1. Ensure the card is in the cache. card_cache is shared across all users, so
      // never trust client-supplied metadata for it beyond a sanitized last-resort placeholder.
      let cached = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [cardId]);
      if (!cached) {
        try {
          await tcgApi.getCardById(cardId);
        } catch (apiErr) {
          console.error(`Failed to fetch card ${cardId} from TCG API during import:`, apiErr.message);
          const safeTypes = Array.isArray(card.types) ? JSON.stringify(card.types.filter(t => typeof t === 'string')) : '[]';
          const safePrice = Number.isFinite(Number(card.market_price || card.price_trend)) ? Math.max(0, Number(card.market_price || card.price_trend)) : 0;
          await db.run(
            `INSERT OR IGNORE INTO card_cache
             (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              cardId,
              String(card.card_name || 'Imported Card').slice(0, 200),
              String(card.supertype || 'Pokémon').slice(0, 50),
              '[]',
              safeTypes,
              String(card.rarity || 'Common').slice(0, 50),
              String(card.set_id || '').slice(0, 50),
              String(card.set_name || 'Imported Set').slice(0, 200),
              String(card.card_number || card.number || '').slice(0, 20),
              '',
              safePrice
            ]
          );
        }
      }

      // 2. Resolve location_id from location_name, scoped to this user only.
      // The exported "Compartment" column is a display label, not a stable
      // identifier — the sort assistant re-picks a real compartment on
      // import rather than trying to parse a page/row number back out of it.
      let locationId = null;
      const locName = card.location_name || card.location_container;
      if (locName && locName !== 'Unassigned') {
        let locRow = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [locName, req.user.id]);
        if (!locRow) {
          const newLoc = await db.run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [locName, 'Other', req.user.id]);
          await db.createCompartments(newLoc.lastID, 1, 1000);
          locationId = newLoc.lastID;
        } else {
          locationId = locRow.id;
        }
      }

      const resolved = await resolveCompartmentAndPosition({
        locationId, compartmentId: null, position: undefined, userId: req.user.id, cardId, printing: card.printing || 'Normal'
      });

      // 3. Insert card into the collection
      await db.run(
        `INSERT INTO collection
         (card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cardId,
          req.user.id,
          card.quantity || 1,
          card.condition || 'Near Mint',
          card.printing || 'Normal',
          card.language || 'English',
          card.purchase_price || 0,
          locationId,
          resolved.compartment_id,
          resolved.position,
          card.added_at || new Date().toISOString()
        ]
      );
      importedCount++;
    }

    res.json({ success: true, message: `Successfully imported ${importedCount} cards.` });
  } catch (error) {
    console.error('Import failed:', error);
    res.status(500).json({ error: 'Import failed' });
  }
});

// --- ADVANCED COLLECTOR ENDPOINTS (DEX FEATURES) ---

// Supported chart windows. Maps a range key to its length in days; anything
// unrecognized (e.g. 'all') returns the full recorded history.
const PRICE_HISTORY_RANGES = { '1m': 30, '1y': 365, '5y': 1825 };

// Get Card Price History
router.get('/cards/:id/price-history', async (req, res) => {
  const { id } = req.params;
  const rangeKey = String(req.query.range || '1y').toLowerCase();
  const days = PRICE_HISTORY_RANGES[rangeKey]; // undefined => 'all'
  try {
    let history = days
      ? await db.all(`
          SELECT price, recorded_at
          FROM price_history
          WHERE card_id = ? AND recorded_at >= datetime('now', ?)
          ORDER BY recorded_at ASC
        `, [id, `-${days} days`])
      : await db.all(`
          SELECT price, recorded_at
          FROM price_history
          WHERE card_id = ?
          ORDER BY recorded_at ASC
        `, [id]);

    history = history.map(h => ({ price: h.price, recorded_at: h.recorded_at }));

    // Fill in with real anchor points instead of fabricating a curve: the
    // current price, plus Cardmarket's real avg7/avg30 when they fall inside
    // the requested window. This app's own price_history only goes back as
    // far as it's actually been running, so this is often the only
    // historical signal available for a given card right now. Prefer avg1 for
    // "now" so all three anchors are the same marketplace (Cardmarket) —
    // pairing avg7/avg30 with price_trend (usually TCGPlayer) would plot a
    // jump that's really just the US/EU price gap, not a real move.
    const cacheCard = await db.get(`SELECT price_trend, price_avg1, price_avg7, price_avg30 FROM card_cache WHERE id = ?`, [id]);
    if (cacheCard) {
      const now = Date.now();
      const nowPrice = cacheCard.price_avg1 > 0 ? cacheCard.price_avg1 : cacheCard.price_trend;
      const anchors = [{ price: nowPrice, time: now }];
      if (cacheCard.price_avg30 > 0 && (!days || days >= 30)) {
        anchors.push({ price: cacheCard.price_avg30, time: now - 30 * 86400000 });
      }
      if (cacheCard.price_avg7 > 0 && (!days || days >= 7)) {
        anchors.push({ price: cacheCard.price_avg7, time: now - 7 * 86400000 });
      }
      for (const a of anchors) {
        if (a.price > 0) {
          history.push({ price: a.price, recorded_at: new Date(a.time).toISOString() });
        }
      }
    }

    history.sort((a, b) => parseSqliteUtc(a.recorded_at) - parseSqliteUtc(b.recorded_at));

    res.json(history);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve price history' });
  }
});

module.exports = router;
