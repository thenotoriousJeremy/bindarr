const express = require('express');
const router = express.Router();
const db = require('../db');
const tcgApi = require('../tcgApi');
const { resolveCompartmentAndPosition } = require('../utils/collectionHelpers');
const { rebalanceCompartmentByScheme } = require('../utils/compartmentSort');
const { logAuditEvent } = require('../utils/auditLogger');

function buildFilterWhereClause(userId, filters) {
  const conditions = ['c.user_id = ?'];
  const params = [userId];

  if (filters.list_type) {
    conditions.push('c.list_type = ?');
    params.push(filters.list_type);
  }
  if (filters.is_trade !== undefined && filters.is_trade !== '') {
    conditions.push('c.is_trade = ?');
    params.push((filters.is_trade === 'true' || filters.is_trade === '1' || filters.is_trade === 1) ? 1 : 0);
  }
  if (filters.game) {
    conditions.push('c.game = ?');
    params.push(filters.game);
  }
  if (filters.search) {
    conditions.push('(cc.name LIKE ? OR cc.set_name LIKE ? OR cc.number LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.condition) {
    conditions.push('c.condition = ?');
    params.push(filters.condition);
  }
  if (filters.printing) {
    conditions.push('c.printing = ?');
    params.push(filters.printing);
  }
  if (filters.min_price) {
    conditions.push('c.purchase_price >= ?');
    params.push(filters.min_price);
  }
  if (filters.tag_id) {
    conditions.push('c.id IN (SELECT collection_id FROM collection_tags WHERE tag_id = ?)');
    params.push(filters.tag_id);
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  };
}

// 1. Get User's Collection with Filtering
router.get('/api/collection', async (req, res) => {
  try {
    const list_type = req.query.list_type || 'collection';
    const filters = {
      list_type,
      is_trade: req.query.is_trade,
      game: req.query.game,
      search: req.query.search,
      condition: req.query.condition,
      printing: req.query.printing,
      min_price: req.query.min_price,
      tag_id: req.query.tag_id
    };

    const { whereClause, params } = buildFilterWhereClause(req.user.id, filters);

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
        c.added_at,
        c.is_trade,
        c.list_type,
        c.game,
        c.location_id,
        c.compartment_id,
        c.position,
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
        l.name as location_name,
        l.type as location_type
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      ${whereClause}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, params);

    const formatted = rows.map(row => ({
      ...row,
      subtypes: JSON.parse(row.subtypes || '[]'),
      types: JSON.parse(row.types || '[]')
    }));

    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve collection', message: error.message });
  }
});

// 2. Add Card to Collection (Refactored to eliminate N+1 loop and execute rebalance once post-insert)
router.post('/api/collection', async (req, res) => {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    printing = 'Normal',
    language = 'English',
    purchase_price = 0,
    location_id = null,
    compartment_id = null,
    sub_location_1 = '',
    sub_location_2 = '',
    list_type = 'collection',
    is_trade = 0,
    game = 'pokemon',
    stackable = false
  } = req.body;

  if (!card_id) {
    return res.status(400).json({ error: 'card_id is required' });
  }

  try {
    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        return res.status(400).json({ error: 'Invalid location ID' });
      }
    }

    let card = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      const apiCard = await tcgApi.getCardById(card_id, req.user.tcg_api_key);
      if (!apiCard) {
        return res.status(404).json({ error: `Card ID ${card_id} not found on Pokémon TCG API.` });
      }
    }

    let insertedId = null;
    let resolvedCompId = compartment_id;

    await db.withTransaction(async (tx) => {
      if (!resolvedCompId && location_id) {
        const resolved = await resolveCompartmentAndPosition(tx, location_id, card_id, req.user.id);
        if (resolved) {
          resolvedCompId = resolved.compartment_id;
        }
      }

      if (stackable) {
        const result = await tx.run(
          `INSERT INTO collection (card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, sub_location_1, sub_location_2, is_trade, list_type, game)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [card_id, req.user.id, quantity, condition, printing, language, purchase_price || 0, location_id, resolvedCompId, Date.now(), sub_location_1, sub_location_2, is_trade ? 1 : 0, list_type, game]
        );
        insertedId = result.lastID;
      } else {
        const placeholders = [];
        const params = [];
        const basePos = Date.now();
        for (let i = 0; i < quantity; i++) {
          placeholders.push('(?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
          params.push(card_id, req.user.id, condition, printing, language, purchase_price || 0, location_id, resolvedCompId, basePos + (i * 0.001), sub_location_1, sub_location_2, is_trade ? 1 : 0, list_type, game);
        }

        const result = await tx.run(
          `INSERT INTO collection (card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, sub_location_1, sub_location_2, is_trade, list_type, game)
           VALUES ${placeholders.join(', ')}`,
          params
        );
        insertedId = result.lastID;
      }

      if (resolvedCompId && location_id) {
        const loc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ?`, [location_id]);
        if (loc) {
          await rebalanceCompartmentByScheme(tx, resolvedCompId, loc.sort_order, loc.foil_sorting);
        }
      }

      const cacheCard = await tx.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [card_id]);
      if (cacheCard && cacheCard.price_trend > 0) {
        await tx.run(`INSERT OR IGNORE INTO price_history (card_id, price) VALUES (?, ?)`, [card_id, cacheCard.price_trend]);
      }

      await logAuditEvent(req.user.id, 'ADD', 'COLLECTION', insertedId, null, { card_id, quantity, location_id, compartment_id: resolvedCompId }, tx);
    });

    res.status(201).json({ message: 'Card added to collection', id: insertedId, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add card', message: error.message });
  }
});

// 3. Bulk Actions (Refactored to use SQL IN (...) updates inside transaction)
router.post('/api/collection/bulk', async (req, res) => {
  const { ids, action, target_location_id, target_compartment_id, target_list_type, is_trade } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }

  try {
    await db.withTransaction(async (tx) => {
      const placeholders = ids.map(() => '?').join(',');

      if (action === 'move') {
        await tx.run(
          `UPDATE collection 
           SET location_id = ?, compartment_id = ?, position = strftime('%s%f', 'now') 
           WHERE id IN (${placeholders}) AND user_id = ?`,
          [target_location_id || null, target_compartment_id || null, ...ids, req.user.id]
        );
      } else if (action === 'delete') {
        await tx.run(
          `DELETE FROM collection WHERE id IN (${placeholders}) AND user_id = ?`,
          [...ids, req.user.id]
        );
      } else if (action === 'set_trade') {
        await tx.run(
          `UPDATE collection SET is_trade = ? WHERE id IN (${placeholders}) AND user_id = ?`,
          [is_trade ? 1 : 0, ...ids, req.user.id]
        );
      } else if (action === 'set_list_type') {
        await tx.run(
          `UPDATE collection SET list_type = ? WHERE id IN (${placeholders}) AND user_id = ?`,
          [target_list_type, ...ids, req.user.id]
        );
      }

      await logAuditEvent(req.user.id, action === 'delete' ? 'BULK_DELETE' : 'BULK_MOVE', 'COLLECTION', null, { ids }, { action, target_location_id, target_compartment_id }, tx);
    });

    return res.json({ success: true, count: ids.length });
  } catch (error) {
    return res.status(500).json({ error: 'Bulk operation failed', message: error.message });
  }
});

// 4. Update Single Card Entry
router.put('/api/collection/:id', async (req, res) => {
  const { id } = req.params;
  const { quantity, condition, printing, language, purchase_price, location_id, compartment_id, sub_location_1, sub_location_2, list_type, is_trade, game } = req.body;

  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }

    const fields = [];
    const params = [];

    if (quantity !== undefined) { fields.push('quantity = ?'); params.push(quantity); }
    if (condition !== undefined) { fields.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { fields.push('printing = ?'); params.push(printing); }
    if (language !== undefined) { fields.push('language = ?'); params.push(language); }
    if (purchase_price !== undefined) { fields.push('purchase_price = ?'); params.push(purchase_price); }
    if (location_id !== undefined) { fields.push('location_id = ?'); params.push(location_id); }
    if (compartment_id !== undefined) { fields.push('compartment_id = ?'); params.push(compartment_id); }
    if (sub_location_1 !== undefined) { fields.push('sub_location_1 = ?'); params.push(sub_location_1); }
    if (sub_location_2 !== undefined) { fields.push('sub_location_2 = ?'); params.push(sub_location_2); }
    if (list_type !== undefined) { fields.push('list_type = ?'); params.push(list_type); }
    if (is_trade !== undefined) { fields.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
    if (game !== undefined) { fields.push('game = ?'); params.push(game); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields provided for update' });
    }

    params.push(id, req.user.id);
    await db.withTransaction(async (tx) => {
      await tx.run(`UPDATE collection SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);
      const updated = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      await logAuditEvent(req.user.id, 'UPDATE', 'COLLECTION', parseInt(id, 10), entry, updated, tx);
    });

    res.json({ message: 'Collection entry updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update entry', message: error.message });
  }
});

// 5. Delete Single Card Entry
router.delete('/api/collection/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }

    await db.withTransaction(async (tx) => {
      await tx.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      await logAuditEvent(req.user.id, 'DELETE', 'COLLECTION', parseInt(id, 10), entry, null, tx);
    });

    res.json({ message: 'Card removed from collection' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove card', message: error.message });
  }
});

// --- SAVED FILTER PRESETS ENDPOINTS ---
router.get('/api/collection/filters/presets', async (req, res) => {
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

router.post('/api/collection/filters/presets', async (req, res) => {
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

router.delete('/api/collection/filters/presets/:id', async (req, res) => {
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
