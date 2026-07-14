const express = require('express');
const db = require('../db');
const tcgApi = require('../tcgApi');
const scryfallApi = require('../scryfallApi');
const scanMatch = require('../scanMatch');
const setIndex = require('../setIndex');
const { authenticateToken, searchLimiter } = require('../middleware/auth');
const { resolveCardPrice, parseCardRow } = require('../utils/priceHelpers');
const { compartmentLabel, isBinderType, rebalanceCompartmentByScheme } = require('../utils/compartmentSort');
const { checkedOutAllocation, resolveCompartmentAndPosition, describePlacement } = require('../utils/collectionHelpers');

const router = express.Router();

router.use(authenticateToken);

// 1. Search cards (proxies to Pokémon TCG or Scryfall + database cache). The
// `game` param routes to the right provider; both return the same card shape.
router.get('/search', searchLimiter, async (req, res) => {
  const { name, number, set, scope = 'database', game = 'pokemon', lang, prints } = req.query;
  try {
    const results = game === 'mtg'
      ? await scryfallApi.searchCards(name, number, set, scope, req.user.id, lang, prints === '1')
      : await tcgApi.searchCards(name, number, set, req.user.tcg_api_key, scope, req.user.id);
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

// 1b. Identify a scanned card image by CLIP embedding similarity.
router.post('/scan-match', searchLimiter, async (req, res) => {
  try {
    const { game = 'pokemon', image, set = '', recallK, orb } = req.body || {};
    if (game !== 'mtg' && game !== 'pokemon') return res.status(400).json({ error: 'Invalid game' });
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Missing image' });
    const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 100) return res.status(400).json({ error: 'Invalid image data' });
    const result = await scanMatch.match(buf, game, 8, set, { recallK, orb });
    res.json(result);
  } catch (error) {
    console.error('scan-match failed:', error.message);
    res.status(500).json({ error: 'Scan match failed' });
  }
});

// Build/verify a per-set ORB index
router.post('/prepare-set', searchLimiter, async (req, res) => {
  try {
    const { game = 'mtg', set } = req.body || {};
    const supported = game === 'mtg' || game === 'pokemon';
    if (!supported || !set) return res.json({ ready: false, supported });
    if (setIndex.isReady(game, set)) return res.json({ ready: true });
    setIndex.ensureSet(game, set).catch(() => {});
    res.json({ ready: false, building: true, progress: setIndex.setProgress(game, set) });
  } catch (error) {
    console.error('prepare-set failed:', error.message);
    res.status(500).json({ error: 'Prepare set failed' });
  }
});

// 2. Get User's Collection
router.get('/collection', async (req, res) => {
  try {
    const listType = req.query.list_type || 'collection';
    const isTrade = req.query.is_trade;
    const compId = req.query.compartment_id;

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ?`;
    let filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }
    if (compId !== undefined) {
      filterSql += ` AND c.compartment_id = ?`;
      filterParams.push(compId);
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
        c.favorite,
        c.list_type,
        cc.name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.cmc,
        cc.color_identity,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        cc.game,
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

    const alloc = await checkedOutAllocation(req.user.id);

    const formatted = rows.map(row => ({
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
      checked_out_qty: alloc.get(row.entry_id) || 0,
      compartment_display_label: row.compartment_id
        ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type)
        : null,
      sub_location: row.compartment_id
        ? `${row.location_type === 'Binder' ? 'Page' : 'Row'} ${row.compartment_idx}`
        : ''
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collection' });
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
    list_type = 'collection',
    is_trade = 0,
    game = 'pokemon',
    stackable = false
  } = req.body;

  if (!card_id) {
    return res.status(400).json({ error: 'card_id is required' });
  }

  try {
    let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      if (game === 'mtg' || card_id.startsWith('mtg-')) {
        card = await scryfallApi.getCardById(card_id);
      } else {
        card = await tcgApi.getCardById(card_id, req.user.tcg_api_key);
      }
      if (!card) {
        return res.status(404).json({ error: `Card ID ${card_id} not found.` });
      }
    }

    const effectiveGame = (req.body.game && req.body.game !== 'pokemon')
      ? req.body.game
      : (card.game || (card_id.startsWith('mtg-') ? 'mtg' : 'pokemon'));

    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        return res.status(400).json({ error: 'Invalid location ID' });
      }
    }

    const resolved = await resolveCompartmentAndPosition({
      locationId: location_id,
      userId: req.user.id,
      cardId: card_id,
      printing,
      language
    });

    const targetLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;

    let lastInsertedId = null;
    const count = Math.max(1, parseInt(quantity, 10) || 1);

    if (stackable) {
      const result = await db.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, language, purchase_price,
          location_id, compartment_id, position, is_trade, list_type, game
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        card_id, req.user.id, count, condition, printing, language, purchase_price || 0,
        targetLocationId, resolved.compartment_id, resolved.position, is_trade ? 1 : 0, list_type, effectiveGame
      ]);
      lastInsertedId = result.lastID;
    } else {
      for (let i = 0; i < count; i++) {
        const result = await db.run(`
          INSERT INTO collection (
            card_id, user_id, quantity, condition, printing, language, purchase_price,
            location_id, compartment_id, position, is_trade, list_type, game
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          card_id, req.user.id, condition, printing, language, purchase_price || 0,
          targetLocationId, resolved.compartment_id, resolved.position + (i * 0.001), is_trade ? 1 : 0, list_type, effectiveGame
        ]);
        lastInsertedId = result.lastID;
      }
    }

    if (resolved.compartment_id && targetLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [targetLocationId, req.user.id]);
      if (loc) {
        await rebalanceCompartmentByScheme(db, resolved.compartment_id, loc.sort_order, loc.foil_sorting);
      }
    }

    if (card.price_trend > 0) {
      await db.run(`INSERT OR IGNORE INTO price_history (card_id, price) VALUES (?, ?)`, [card_id, card.price_trend]);
    }

    res.status(200).json({
      message: 'Card added to collection',
      id: lastInsertedId,
      placement: resolved.compartment_id
        ? await describePlacement(db, lastInsertedId, req.user.id)
        : null,
      container_full: !!resolved.full,
      rule_rejected: !!resolved.rejected
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// 4. Update Collection Entry
router.put('/collection/:id', async (req, res) => {
  const { id } = req.params;
  const {
    quantity, condition, printing, language, purchase_price,
    location_id, compartment_id, list_type, is_trade, favorite, game
  } = req.body;

  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });

    const isMoving = location_id !== undefined && location_id !== entry.location_id;
    let finalCompartmentId = entry.compartment_id;
    let finalLocationId = entry.location_id;
    let finalPosition = entry.position;
    let resolvedFull = false;
    let resolvedRejected = false;

    if (isMoving) {
      if (location_id === null || location_id === '') {
        finalLocationId = null;
        finalCompartmentId = null;
        finalPosition = 0;
      } else {
        const resolved = await resolveCompartmentAndPosition({
          locationId: location_id,
          userId: req.user.id,
          cardId: entry.card_id,
          printing: printing !== undefined ? printing : entry.printing,
          language: language !== undefined ? language : entry.language
        });
        finalCompartmentId = resolved.compartment_id;
        finalLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;
        finalPosition = resolved.position;
        resolvedFull = !!resolved.full;
        resolvedRejected = !!resolved.rejected;
      }
    } else if (compartment_id !== undefined) {
      finalCompartmentId = compartment_id;
    }

    const updates = [];
    const params = [];

    if (quantity !== undefined) { updates.push('quantity = ?'); params.push(quantity); }
    if (condition !== undefined) { updates.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { updates.push('printing = ?'); params.push(printing); }
    if (language !== undefined) { updates.push('language = ?'); params.push(language); }
    if (purchase_price !== undefined) { updates.push('purchase_price = ?'); params.push(purchase_price); }
    if (isMoving || compartment_id !== undefined) {
      updates.push('location_id = ?', 'compartment_id = ?', 'position = ?');
      params.push(finalLocationId, finalCompartmentId, finalPosition);
    }
    if (list_type !== undefined) { updates.push('list_type = ?'); params.push(list_type); }
    if (is_trade !== undefined) { updates.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
    if (favorite !== undefined) { updates.push('favorite = ?'); params.push(favorite ? 1 : 0); }
    if (game !== undefined) { updates.push('game = ?'); params.push(game); }

    if (updates.length > 0) {
      params.push(id, req.user.id);
      await db.run(`UPDATE collection SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
    }

    if (isMoving && finalCompartmentId && finalLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [finalLocationId, req.user.id]);
      if (loc) await rebalanceCompartmentByScheme(db, finalCompartmentId, loc.sort_order, loc.foil_sorting);
    }
    if (isMoving && entry.compartment_id && entry.compartment_id !== finalCompartmentId) {
      const oldLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [entry.location_id, req.user.id]);
      if (oldLoc) await rebalanceCompartmentByScheme(db, entry.compartment_id, oldLoc.sort_order, oldLoc.foil_sorting);
    }

    const finalPlacement = isMoving && finalCompartmentId ? await describePlacement(db, id, req.user.id) : null;
    res.json({ message: 'Collection entry updated successfully', placement: finalPlacement, container_full: resolvedFull, rule_rejected: resolvedRejected });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// 4b. Manual tap-to-place (Custom order)
router.post('/collection/:id/place', async (req, res) => {
  const { id } = req.params;
  const { compartment_id, slot, swap_with } = req.body;
  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });

    const comp = await db.get(`
      SELECT c.id, c.capacity, l.id AS loc_id, l.type AS loc_type, l.sort_order
      FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?`, [compartment_id, req.user.id]);
    if (!comp) return res.status(400).json({ error: 'Invalid compartment' });
    if (comp.sort_order !== 'custom') return res.status(400).json({ error: 'Manual placement is only available in Custom order' });

    const isBinder = isBinderType(comp.loc_type);

    if (swap_with) {
      const other = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [swap_with, req.user.id]);
      if (!other) return res.status(400).json({ error: 'Swap target not found' });
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [other.compartment_id, other.location_id, other.position, id, req.user.id]);
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [entry.compartment_id, entry.location_id, entry.position, swap_with, req.user.id]);
      const placement = await describePlacement(db, id, req.user.id);
      return res.json({ message: 'Cards swapped', placement });
    }

    if (!Number.isInteger(slot) || slot < 1) return res.status(400).json({ error: 'Invalid slot' });

    if (entry.compartment_id !== compartment_id) {
      const cnt = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE compartment_id = ? AND user_id = ?`, [compartment_id, req.user.id]);
      if (cnt.n >= comp.capacity) return res.status(400).json({ error: 'COMPARTMENT_FULL' });
    }

    const sourceComp = entry.compartment_id;
    if (isBinder) {
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000, id, req.user.id]);
    } else {
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000 - 500, id, req.user.id]);
      await rebalanceCompartmentByScheme(db, compartment_id, req.user.id, { sort_order: 'custom' });
    }

    if (sourceComp && sourceComp !== compartment_id) {
      const src = await db.get(`SELECT l.type AS loc_type FROM compartments c JOIN locations l ON c.location_id = l.id WHERE c.id = ?`, [sourceComp]);
      if (src && !isBinderType(src.loc_type)) {
        await rebalanceCompartmentByScheme(db, sourceComp, req.user.id, { sort_order: 'custom' });
      }
    }

    const placement = await describePlacement(db, id, req.user.id);
    res.json({ message: 'Card placed', placement });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to place card' });
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

// 5b. Bulk actions
const BULK_ACTIONS = ['delete', 'move', 'trade', 'untrade', 'list_type'];
router.post('/collection/bulk', async (req, res) => {
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
    if (action === 'delete') {
      const result = await db.run(`DELETE FROM collection WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, req.user.id]);
      return res.json({ message: `Deleted ${result.changes} card(s)`, affected: result.changes });
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

    const locationId = value ? parseInt(value, 10) : null;
    if (locationId) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
      if (!loc) return res.status(400).json({ error: 'Invalid location ID' });
    }
    let moved = 0;
    const touched = new Map();
    for (const id of ids) {
      const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) continue;
      if (!locationId) {
        await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        moved++;
        continue;
      }
      const resolved = await resolveCompartmentAndPosition({
        locationId, userId: req.user.id, cardId: entry.card_id, printing: entry.printing, language: entry.language
      });
      const finalLoc = resolved.compartment_id ? (resolved.location_id ?? locationId) : null;
      await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [finalLoc, resolved.compartment_id, resolved.position, id, req.user.id]);
      if (resolved.compartment_id) touched.set(resolved.compartment_id, finalLoc);
      moved++;
    }
    for (const [compId, locId] of touched) {
      const rbLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [locId, req.user.id]);
      if (rbLoc) await rebalanceCompartmentByScheme(db, compId, rbLoc.sort_order, rbLoc.foil_sorting);
    }
    return res.json({ message: `Moved ${moved} card(s)`, affected: moved });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

// Saved Filter Presets
router.get('/collection/filters/presets', async (req, res) => {
  try {
    const presets = await db.all(
      `SELECT * FROM saved_filter_presets WHERE user_id = ? ORDER BY name ASC`,
      [req.user.id]
    );
    res.json({ presets });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch filter presets', message: error.message });
  }
});

router.post('/collection/filters/presets', async (req, res) => {
  const { name, filter_config, sort_config, is_default = 0 } = req.body;
  if (!name || !filter_config) {
    return res.status(400).json({ error: 'Preset name and filter_config are required' });
  }

  try {
    const result = await db.run(
      `INSERT INTO saved_filter_presets (user_id, name, filter_config, sort_config, is_default)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.user.id,
        name.trim(),
        typeof filter_config === 'string' ? filter_config : JSON.stringify(filter_config),
        typeof sort_config === 'string' ? sort_config : JSON.stringify(sort_config || []),
        is_default ? 1 : 0
      ]
    );
    res.status(201).json({ success: true, id: result.lastID });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save filter preset', message: error.message });
  }
});

router.delete('/collection/filters/presets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM saved_filter_presets WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Filter preset not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete filter preset', message: error.message });
  }
});

module.exports = router;
