const express = require('express');
const db = require('../db');
const tcgApi = require('../tcgApi');
const { authenticateToken } = require('../middleware/auth');
const {
  resolveCardPrice,
  rebalanceLocationPositions,
  getSortedPositionForCard,
  getSimulatedPriceAt,
  isVintageSet
} = require('../utils/priceHelpers');

const router = express.Router();

router.use(authenticateToken);

// 1. Search Pokémon TCG cards (proxies to Pokemon TCG API and database cache)
router.get('/search', async (req, res) => {
  const { name, number, set } = req.query;
  try {
    const results = await tcgApi.searchCards(name, number, set, req.user.tcg_api_key);
    res.json(results);
  } catch (error) {
    console.error(error);
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
        c.sub_location_1,
        c.sub_location_2,
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
        l.type as location_type
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
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
    sub_location_1 = '',
    sub_location_2 = '',
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
      const apiCard = await tcgApi.getCardById(card_id, req.user.tcg_api_key);
      if (!apiCard) {
        return res.status(404).json({ error: `Card ID ${card_id} not found on Pokémon TCG API.` });
      }
    }

    // Check if an identical card entry already exists in this location to stack them
    const existing = await db.get(`
      SELECT id, quantity FROM collection
      WHERE card_id = ? AND condition = ? AND printing = ? AND language = ?
        AND location_id IS ? AND sub_location_1 IS ? AND sub_location_2 IS ?
        AND user_id = ? AND list_type = ? AND is_trade = ?
    `, [
      card_id,
      condition,
      printing,
      language,
      location_id,
      sub_location_1 || null,
      sub_location_2 || null,
      req.user.id,
      list_type,
      is_trade ? 1 : 0
    ]);

    let lastInsertedId;
    if (existing) {
      const newQuantity = existing.quantity + parseInt(quantity, 10);
      await db.run(`
        UPDATE collection SET quantity = ? WHERE id = ?
      `, [newQuantity, existing.id]);
      lastInsertedId = existing.id;
    } else {
      let finalPosition = position;
      if (finalPosition === undefined) {
        if (location_id) {
          const cardMetadata = await db.get(`SELECT name, set_name, number, types, price_trend, supertype, rarity FROM card_cache WHERE id = ?`, [card_id]);
          if (cardMetadata) {
            cardMetadata.printing = printing;
            try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }
            finalPosition = await getSortedPositionForCard(db, location_id, req.user.id, cardMetadata);
          } else {
            finalPosition = 1000;
          }
        } else {
          finalPosition = 0;
        }
      }

      const result = await db.run(`
        INSERT INTO collection
        (card_id, quantity, condition, printing, language, purchase_price, location_id, sub_location_1, sub_location_2, user_id, list_type, is_trade, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        card_id,
        quantity,
        condition,
        printing,
        language,
        purchase_price || 0,
        location_id,
        sub_location_1 || null,
        sub_location_2 || null,
        req.user.id,
        list_type,
        is_trade ? 1 : 0,
        finalPosition
      ]);
      lastInsertedId = result.lastID;

      if (location_id) {
        const neighbors = await db.all(`
          SELECT position FROM collection
          WHERE location_id = ? AND user_id = ? AND id != ?
          ORDER BY ABS(position - ?) ASC LIMIT 2
        `, [location_id, req.user.id, lastInsertedId, finalPosition]);
        let needsRebalance = false;
        for (const n of neighbors) {
          if (Math.abs(n.position - finalPosition) < 0.001) {
            needsRebalance = true;
            break;
          }
        }
        if (needsRebalance) {
          await rebalanceLocationPositions(db, location_id, req.user.id);
        }
      }
    }

    // Record initial price history trend
    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [card_id]);
    if (cacheCard && cacheCard.price_trend > 0) {
      await db.run(`INSERT OR IGNORE INTO price_history (card_id, price) VALUES (?, ?)`, [card_id, cacheCard.price_trend]);
    }

    res.status(201).json({ message: 'Card added to collection', id: lastInsertedId });
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
    sub_location_1,
    sub_location_2,
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

    const finalLocId = location_id !== undefined ? location_id : entry.location_id;
    const finalSub1 = sub_location_1 !== undefined ? sub_location_1 : entry.sub_location_1;
    const finalSub2 = sub_location_2 !== undefined ? sub_location_2 : entry.sub_location_2;

    // Compute what the final values would be after this update
    const finalQuantity = quantity !== undefined ? parseInt(quantity, 10) : entry.quantity;
    const finalCondition = condition !== undefined ? condition : entry.condition;
    const finalPrinting = printing !== undefined ? printing : entry.printing;
    const finalLanguage = language !== undefined ? language : entry.language;
    const finalListType = list_type !== undefined ? list_type : entry.list_type;
    const finalIsTrade = is_trade !== undefined ? (is_trade ? 1 : 0) : entry.is_trade;

    // Check if there is an identical card entry already in that new location (except this row itself)
    const existing = await db.get(`
      SELECT id, quantity FROM collection
      WHERE card_id = ? AND condition = ? AND printing = ? AND language = ?
        AND location_id IS ? AND sub_location_1 IS ? AND sub_location_2 IS ?
        AND user_id = ? AND list_type = ? AND is_trade = ? AND id != ?
    `, [
      entry.card_id,
      finalCondition,
      finalPrinting,
      finalLanguage,
      finalLocId,
      finalSub1 || null,
      finalSub2 || null,
      req.user.id,
      finalListType,
      finalIsTrade,
      entry.id
    ]);

    if (existing) {
      const newQuantity = existing.quantity + finalQuantity;
      await db.run(`UPDATE collection SET quantity = ? WHERE id = ?`, [newQuantity, existing.id]);
      await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [entry.id, req.user.id]);
      return res.json({ message: 'Collection entry merged/stacked successfully', id: existing.id });
    }

    let finalPosition = position;
    if (finalPosition === undefined && location_id !== undefined && location_id !== entry.location_id) {
      if (location_id) {
        const cardMetadata = await db.get(`SELECT name, set_name, number, types, price_trend, supertype, rarity FROM card_cache WHERE id = ?`, [entry.card_id]);
        if (cardMetadata) {
          cardMetadata.printing = printing !== undefined ? printing : entry.printing;
          try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }
          finalPosition = await getSortedPositionForCard(db, location_id, req.user.id, cardMetadata);
        } else {
          finalPosition = 1000;
        }
      } else {
        finalPosition = 0;
      }
    }

    // Build dynamic UPDATE query based on passed values
    const fields = [];
    const params = [];

    if (quantity !== undefined) { fields.push('quantity = ?'); params.push(quantity); }
    if (condition !== undefined) { fields.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { fields.push('printing = ?'); params.push(printing); }
    if (language !== undefined) { fields.push('language = ?'); params.push(language); }
    if (purchase_price !== undefined) { fields.push('purchase_price = ?'); params.push(purchase_price); }
    if (location_id !== undefined) { fields.push('location_id = ?'); params.push(location_id); }
    if (sub_location_1 !== undefined) { fields.push('sub_location_1 = ?'); params.push(sub_location_1); }
    if (sub_location_2 !== undefined) { fields.push('sub_location_2 = ?'); params.push(sub_location_2); }
    if (list_type !== undefined) { fields.push('list_type = ?'); params.push(list_type); }
    if (is_trade !== undefined) { fields.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
    if (finalPosition !== undefined) { fields.push('position = ?'); params.push(finalPosition); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields provided for update' });
    }

    params.push(id);
    params.push(req.user.id);
    await db.run(`UPDATE collection SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);

    if (finalLocId && finalPosition !== undefined) {
      const neighbors = await db.all(`
        SELECT position FROM collection
        WHERE location_id = ? AND user_id = ? AND id != ?
        ORDER BY ABS(position - ?) ASC LIMIT 2
      `, [finalLocId, req.user.id, id, finalPosition]);
      let needsRebalance = false;
      for (const n of neighbors) {
        if (Math.abs(n.position - finalPosition) < 0.001) {
          needsRebalance = true;
          break;
        }
      }
      if (needsRebalance) {
        await rebalanceLocationPositions(db, finalLocId, req.user.id);
      }
    }

    res.json({ message: 'Collection entry updated successfully' });
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
      SELECT l.*, COUNT(c.id) as card_count, SUM(c.quantity) as total_cards
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
  const {
    name,
    type,
    description = '',
    sort_order = 'name-asc',
    max_pages = 30,
    page_style = '3x3',
    max_rows = 3,
    max_capacity = 1000,
    foil_sorting = 'normals_first'
  } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  try {
    const existing = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [name, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'A location with this name already exists' });
    }

    const result = await db.run(`
      INSERT INTO locations (name, type, description, sort_order, max_pages, page_style, max_rows, max_capacity, foil_sorting, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      type,
      description,
      sort_order,
      parseInt(max_pages, 10) || 30,
      page_style,
      parseInt(max_rows, 10) || 3,
      parseInt(max_capacity, 10) || 1000,
      foil_sorting || 'normals_first',
      req.user.id
    ]);
    res.status(201).json({ message: 'Location created', id: result.lastID });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create location' });
  }
});

router.put('/locations/:id', async (req, res) => {
  const { id } = req.params;
  const { name, type, description, sort_order, max_pages, page_style, max_rows, max_capacity, foil_sorting } = req.body;
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
        description = COALESCE(?, description),
        sort_order = COALESCE(?, sort_order),
        max_pages = COALESCE(?, max_pages),
        page_style = COALESCE(?, page_style),
        max_rows = COALESCE(?, max_rows),
        max_capacity = COALESCE(?, max_capacity),
        foil_sorting = COALESCE(?, foil_sorting)
      WHERE id = ? AND user_id = ?
    `, [
      name,
      type,
      description,
      sort_order,
      max_pages !== undefined ? parseInt(max_pages, 10) : null,
      page_style,
      max_rows !== undefined ? parseInt(max_rows, 10) : null,
      max_capacity !== undefined ? parseInt(max_capacity, 10) : null,
      foil_sorting,
      id,
      req.user.id
    ]);
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

    // Disassociate cards from this location instead of blocking delete (scoped to user)
    await db.run(`UPDATE collection SET location_id = NULL, sub_location_1 = NULL, sub_location_2 = NULL WHERE location_id = ? AND user_id = ?`, [id, req.user.id]);

    await db.run(`DELETE FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json({ message: 'Location deleted successfully (any stored cards moved to Unsorted)' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete location' });
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
    const oneYearMs = 365 * oneDayMs;
    const fiveYearsMs = 5 * oneYearMs;

    let value7dAgo = 0;
    let value30dAgo = 0;
    let value1yAgo = 0;
    let value5yAgo = 0;

    const typeCounts = {};
    const rarityCounts = {};
    const setCounts = {};
    const locationCounts = {};

    rows.forEach(row => {
      const qty = row.quantity || 1;
      const price = resolveCardPrice(row);
      const addedTime = row.added_at ? new Date(row.added_at).getTime() : now;

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

      // Check if the card was in the collection at those times
      if (addedTime <= now - sevenDaysMs) {
        value7dAgo += qty * getSimulatedPriceAt(row.card_id, price, now - sevenDaysMs, now);
      }
      if (addedTime <= now - thirtyDaysMs) {
        value30dAgo += qty * getSimulatedPriceAt(row.card_id, price, now - thirtyDaysMs, now);
      }
      if (addedTime <= now - oneYearMs) {
        value1yAgo += qty * getSimulatedPriceAt(row.card_id, price, now - oneYearMs, now);
      }
      if (addedTime <= now - fiveYearsMs) {
        value5yAgo += qty * getSimulatedPriceAt(row.card_id, price, now - fiveYearsMs, now);
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
      SELECT c.quantity, c.condition, c.printing, c.language, c.added_at,
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
        change7d: {
          abs: parseFloat((totalValue - value7dAgo).toFixed(2)),
          pct: value7dAgo > 0 ? parseFloat((((totalValue - value7dAgo) / value7dAgo) * 100).toFixed(1)) : 100.0
        },
        change30d: {
          abs: parseFloat((totalValue - value30dAgo).toFixed(2)),
          pct: value30dAgo > 0 ? parseFloat((((totalValue - value30dAgo) / value30dAgo) * 100).toFixed(1)) : 100.0
        },
        change1y: {
          abs: parseFloat((totalValue - value1yAgo).toFixed(2)),
          pct: value1yAgo > 0 ? parseFloat((((totalValue - value1yAgo) / value1yAgo) * 100).toFixed(1)) : 100.0
        },
        change5y: {
          abs: parseFloat((totalValue - value5yAgo).toFixed(2)),
          pct: value5yAgo > 0 ? parseFloat((((totalValue - value5yAgo) / value5yAgo) * 100).toFixed(1)) : 100.0
        }
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
        const addedTime = new Date(item.added_at).getTime();
        if (addedTime <= targetTime) {
          const currentPrice = resolveCardPrice(item);
          const simulatedPrice = getSimulatedPriceAt(item.card_id, currentPrice, targetTime, now);
          totalValue += item.quantity * simulatedPrice;
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
        c.sub_location_1,
        c.sub_location_2,
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
        l.name as location_name
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      WHERE c.user_id = ?
    `;
    const dbRows = await db.all(query, [req.user.id]);
    const rows = dbRows.map(row => {
      const resolvedPrice = resolveCardPrice(row);
      return {
        ...row,
        market_price: resolvedPrice
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
      'Market Price', 'Location Container', 'Sub-Location Page/Row', 'Sub-Location Slot/Section', 'Added At'
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
        r.sub_location_1 ? `"${csvCell(r.sub_location_1).replace(/"/g, '""')}"` : '',
        r.sub_location_2 ? `"${csvCell(r.sub_location_2).replace(/"/g, '""')}"` : '',
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
          sub_location_1: cardObj['Sub-Location Page/Row'],
          sub_location_2: cardObj['Sub-Location Slot/Section'],
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

      // 2. Resolve location_id from location_name, scoped to this user only
      let locationId = null;
      const locName = card.location_name || card.location_container;
      if (locName && locName !== 'Unassigned') {
        let locRow = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [locName, req.user.id]);
        if (!locRow) {
          let type = 'Other';
          if (card.sub_location_1 && (card.sub_location_1.toLowerCase().includes('page') || card.sub_location_2)) {
            type = 'Binder';
          }
          const newLoc = await db.run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [locName, type, req.user.id]);
          locationId = newLoc.lastID;
        } else {
          locationId = locRow.id;
        }
      }

      // 3. Insert card into the collection
      await db.run(
        `INSERT INTO collection
         (card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, sub_location_1, sub_location_2, added_at)
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
          card.sub_location_1 || '',
          card.sub_location_2 || '',
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

// Get Card Price History
router.get('/cards/:id/price-history', async (req, res) => {
  const { id } = req.params;
  try {
    let history = await db.all(`
      SELECT price, recorded_at
      FROM price_history
      WHERE card_id = ?
      ORDER BY recorded_at ASC
    `, [id]);

    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [id]);
    const currentPrice = (cacheCard && cacheCard.price_trend) || 1.00;

    // Seed mock price points if less than 5 records exist, so charts display immediately
    if (history.length < 5) {
      history = [];
      const now = new Date();
      for (let i = 9; i >= 0; i--) { // 10 price points
        const date = new Date(now);
        date.setDate(now.getDate() - i * 3); // 3 day intervals
        const fluctuation = (Math.random() - 0.5) * 0.15 * currentPrice; // +/- 15%
        const price = parseFloat(Math.max(0.10, currentPrice + fluctuation).toFixed(2));
        history.push({
          price,
          recorded_at: date.toISOString()
        });
      }
    } else {
      // Map to standardized format
      history = history.map(h => ({
        price: h.price,
        recorded_at: h.recorded_at
      }));
    }

    res.json(history);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve price history' });
  }
});

module.exports = router;
