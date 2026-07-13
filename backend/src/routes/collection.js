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

// 1b. Identify a scanned card image by CLIP embedding similarity. The client
// POSTs a cropped card photo (data URL or base64); we return the closest cards
// from the prebuilt embedding DB. Empty candidates if the DB isn't built yet
// or nothing matched (the scanner then prompts a manual search).
router.post('/scan-match', searchLimiter, async (req, res) => {
  try {
    const { game = 'pokemon', image, set = '' } = req.body || {};
    if (game !== 'mtg' && game !== 'pokemon') return res.status(400).json({ error: 'Invalid game' });
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Missing image' });
    const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 100) return res.status(400).json({ error: 'Invalid image data' });
    const result = await scanMatch.match(buf, game, 8, set);
    res.json(result); // { game, verified, candidates, crop, scoped? }
  } catch (error) {
    console.error('scan-match failed:', error.message);
    res.status(500).json({ error: 'Scan match failed' });
  }
});

// Build/verify a per-set ORB index so subsequent MTG scans of that set are an
// accurate ~300-card match. First call for a set does the (cached) build; the
// client polls until ready.
router.post('/prepare-set', searchLimiter, async (req, res) => {
  try {
    const { game = 'mtg', set } = req.body || {};
    const supported = game === 'mtg' || game === 'pokemon';
    if (!supported || !set) return res.json({ ready: false, supported });
    if (setIndex.isReady(game, set)) return res.json({ ready: true });
    // Kick the build without blocking the request; client polls.
    setIndex.ensureSet(game, set).catch(() => {});
    res.json({ ready: false, building: true });
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

    // Parse JSON fields
    const formatted = rows.map(row => ({
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
      checked_out_qty: alloc.get(row.entry_id) || 0,
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
      locationId: location_id, compartmentId: compartment_id, position, userId: req.user.id, cardId: card_id, printing, language
    });
    // No compartment resolved (full / rule-rejected) = leave the card truly
    // unsorted rather than parked on a location with no physical slot.
    const finalLocationId = resolved.compartment_id
      ? (resolved.location_id !== undefined && resolved.location_id !== null ? resolved.location_id : location_id)
      : null;

    // The card's game is derived from its cached metadata, not the client, so a
    // Scryfall-sourced card is always tagged 'mtg' in the collection.
    const cardMeta = await db.get(`SELECT game FROM card_cache WHERE id = ?`, [card_id]);
    const cardGame = (cardMeta && cardMeta.game) ? cardMeta.game : 'pokemon';

    // If the frontend passed quantity > 1, we insert them as separate unstacked rows
    const numToInsert = quantity ? parseInt(quantity, 10) : 1;
    let lastInsertedId;

    for (let i = 0; i < numToInsert; i++) {
      const result = await db.run(`
        INSERT INTO collection
        (card_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, user_id, list_type, is_trade, position, game)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        resolved.position,
        cardGame
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

    res.status(200).json({
      message: 'Card added to collection',
      id: lastInsertedId,
      // Where the card physically landed, so the scanner can tell the user
      // which page/row to put the real card in. null = left Unsorted.
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
    let resolvedRejected = false;
    const isMoving = compartment_id !== undefined || (location_id !== undefined && location_id !== entry.location_id);
    if (isMoving) {
      const resolved = await resolveCompartmentAndPosition({
        locationId: location_id !== undefined ? location_id : entry.location_id,
        compartmentId: compartment_id,
        position,
        userId: req.user.id,
        cardId: entry.card_id,
        printing: printing !== undefined ? printing : entry.printing,
        language: language !== undefined ? language : entry.language,
        excludeEntryId: id
      });
      finalLocId = resolved.location_id !== undefined && resolved.location_id !== null ? resolved.location_id : (location_id !== undefined ? location_id : entry.location_id);
      finalCompartmentId = resolved.compartment_id;
      finalPosition = resolved.position;
      resolvedFull = !!resolved.full;
      resolvedRejected = !!resolved.rejected;
    }

    // Compute what the final values would be after this update
    const finalQuantity = quantity !== undefined ? parseInt(quantity, 10) : entry.quantity;
    const finalCondition = condition !== undefined ? condition : entry.condition;
    const finalPrinting = printing !== undefined ? printing : entry.printing;
    const finalLanguage = language !== undefined ? language : entry.language;
    const finalListType = list_type !== undefined ? list_type : entry.list_type;
    const finalIsTrade = is_trade !== undefined ? (is_trade ? 1 : 0) : entry.is_trade;

    // Build dynamic UPDATE query based on passed values
    const fields = [];
    const params = [];

    if (quantity !== undefined) { fields.push('quantity = ?'); params.push(quantity); }
    if (condition !== undefined) { fields.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { fields.push('printing = ?'); params.push(printing); }
    if (language !== undefined) { fields.push('language = ?'); params.push(language); }
    if (purchase_price !== undefined) { fields.push('purchase_price = ?'); params.push(purchase_price); }
    // On a move, persist the location the resolver actually landed on (it can
    // differ from the requested one when the container is full and the card
    // overflows to another location, or when a compartment implies its owner).
    // No compartment resolved (full / rule-rejected / cleared) = truly
    // unsorted, so the card stays visible in the Unsorted queue instead of
    // being parked on a location with no physical slot.
    if (isMoving) {
      fields.push('location_id = ?'); params.push(finalCompartmentId ? finalLocId : null);
      fields.push('compartment_id = ?'); params.push(finalCompartmentId);
    } else if (location_id !== undefined) { fields.push('location_id = ?'); params.push(location_id); }
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
    res.json({ message: 'Collection entry updated successfully', placement: finalPlacement, container_full: resolvedFull, rule_rejected: resolvedRejected });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// 4b. Manual tap-to-place, CUSTOM-order containers only. Binder pockets are
// fixed physical slots: place at an absolute pocket (empty pockets between
// cards are preserved) and swap on an occupied pocket, so nothing cascades.
// Boxes are continuous: inserting between cards shifts the rest down one.
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

    // Swap: exchange the two cards' slot + compartment atomically. No cascade.
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

    // Capacity guard only when the card is entering a compartment it isn't in.
    if (entry.compartment_id !== compartment_id) {
      const cnt = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE compartment_id = ? AND user_id = ?`, [compartment_id, req.user.id]);
      if (cnt.n >= comp.capacity) return res.status(400).json({ error: 'COMPARTMENT_FULL' });
    }

    const sourceComp = entry.compartment_id;
    if (isBinder) {
      // Absolute pocket, no compaction — a gap is a real empty pocket.
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000, id, req.user.id]);
    } else {
      // Continuous box: land just before the current occupant of `slot`, then
      // densify so everything from `slot` on shifts down one.
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000 - 500, id, req.user.id]);
      await rebalanceCompartmentByScheme(db, compartment_id, req.user.id, { sort_order: 'custom' });
    }

    // Densify the source box compartment the card left, so no stray gap remains.
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

// 5b. Bulk actions on selected collection entries (multi-select).
// Every action is scoped to the caller's own rows.
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

    // action === 'move': value = target location id, or null/'' to unassign.
    const locationId = value ? parseInt(value, 10) : null;
    if (locationId) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
      if (!loc) return res.status(400).json({ error: 'Invalid location ID' });
    }
    let moved = 0;
    const touched = new Map(); // compartment_id -> location_id, rebalanced once at the end
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
      await rebalanceCompartmentByScheme(db, compId, req.user.id, rbLoc);
    }
    return res.json({ message: `Moved ${moved} card(s)`, affected: moved });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

module.exports = router;
