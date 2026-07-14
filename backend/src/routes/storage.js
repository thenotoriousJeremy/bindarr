const express = require('express');
const router = express.Router();
const db = require('../db');
const { sortCards } = require('../utils/compartmentSort');

// 1. Get Storage Locations with Card Count
router.get('/api/locations', async (req, res) => {
  try {
    const locations = await db.all(`
      SELECT l.*, 
             COUNT(c.id) as card_count, 
             COALESCE(SUM(c.quantity), 0) as total_cards 
      FROM locations l
      LEFT JOIN collection c ON l.id = c.location_id AND c.user_id = l.user_id
      WHERE l.user_id = ?
      GROUP BY l.id
    `, [req.user.id]);
    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve locations', message: error.message });
  }
});

// 2. Storage Capacity Warning Alerts Endpoint
router.get('/api/locations/alerts', async (req, res) => {
  const userId = req.user.id;
  try {
    const alerts = await db.all(`
      SELECT 
        l.id AS location_id,
        l.name AS location_name,
        comp.id AS compartment_id,
        comp.label AS compartment_label,
        comp.idx AS compartment_idx,
        COALESCE(SUM(c.quantity), 0) AS current_cards,
        comp.capacity AS max_capacity,
        ROUND((CAST(COALESCE(SUM(c.quantity), 0) AS REAL) / comp.capacity) * 100, 1) AS usage_percent
      FROM compartments comp
      JOIN locations l ON comp.location_id = l.id
      LEFT JOIN collection c ON comp.id = c.compartment_id
      WHERE l.user_id = ?
      GROUP BY comp.id
      HAVING usage_percent >= 80.0
      ORDER BY usage_percent DESC
    `, [userId]);

    const formattedAlerts = alerts.map(row => ({
      location_id: row.location_id,
      location_name: row.location_name,
      compartment_id: row.compartment_id,
      label: row.compartment_label || `Compartment ${row.compartment_idx}`,
      current_cards: row.current_cards,
      max_capacity: row.max_capacity,
      usage_percent: row.usage_percent,
      severity: row.usage_percent >= 100.0 ? 'CRITICAL' : 'WARNING',
      message: row.usage_percent >= 100.0
        ? `Container ${row.location_name} (${row.compartment_label || 'Compartment ' + row.compartment_idx}) is at 100% capacity!`
        : `Container ${row.location_name} (${row.compartment_label || 'Compartment ' + row.compartment_idx}) has reached ${row.usage_percent}% capacity.`
    }));

    return res.json({ alerts: formattedAlerts });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch storage alerts', message: error.message });
  }
});

// 3. Create Location
router.post('/api/locations', async (req, res) => {
  const { name, type, description = '', sort_order, foil_sorting } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  try {
    const existing = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [name, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'A location with this name already exists' });
    }

    const result = await db.run(`
      INSERT INTO locations (name, type, description, sort_order, foil_sorting, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [name, type, description, sort_order || null, foil_sorting || null, req.user.id]);
    res.status(201).json({ message: 'Location created', id: result.lastID });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create location', message: error.message });
  }
});

// 4. Update Location
router.put('/api/locations/:id', async (req, res) => {
  const { id } = req.params;
  const { name, type, description, sort_order, foil_sorting } = req.body;
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
      SET name = COALESCE(?, name), 
          type = COALESCE(?, type), 
          description = COALESCE(?, description),
          sort_order = COALESCE(?, sort_order),
          foil_sorting = COALESCE(?, foil_sorting)
      WHERE id = ? AND user_id = ?
    `, [name, type, description, sort_order, foil_sorting, id, req.user.id]);
    res.json({ message: 'Location updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update location', message: error.message });
  }
});

// 5. Delete Location
router.delete('/api/locations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = NULL, sub_location_1 = NULL, sub_location_2 = NULL WHERE location_id = ? AND user_id = ?`, [id, req.user.id]);
    await db.run(`DELETE FROM compartments WHERE location_id = ?`, [id]);
    await db.run(`DELETE FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);

    res.json({ message: 'Location deleted successfully (stored cards unassigned)' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete location', message: error.message });
  }
});

// 6. Refactor physical container re-sorting endpoint using CASE ... WHEN chunking in withTransaction
router.post('/api/locations/:id/resort', async (req, res) => {
  const locationId = req.params.id;

  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
    }

    let updatedCount = 0;
    await db.withTransaction(async (tx) => {
      const cards = await tx.all(`
        SELECT c.*, cc.name, cc.set_id, cc.number, cc.types, cc.rarity, cc.price_trend
        FROM collection c
        LEFT JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.location_id = ? AND c.user_id = ?
      `, [locationId, req.user.id]);

      if (cards.length === 0) return;

      const compartments = await tx.all(`SELECT * FROM compartments WHERE location_id = ? ORDER BY idx ASC`, [locationId]);
      const sortedCards = sortCards(cards, location.sort_order, location.foil_sorting);

      const CHUNK_SIZE = 100;
      for (let i = 0; i < sortedCards.length; i += CHUNK_SIZE) {
        const chunk = sortedCards.slice(i, i + CHUNK_SIZE);
        const ids = chunk.map(c => c.id);

        let compCaseStr = 'CASE id ';
        let posCaseStr = 'CASE id ';
        const params = [];

        chunk.forEach((card, idx) => {
          const globalIndex = i + idx;
          let targetCompId = card.compartment_id;
          if (compartments && compartments.length > 0) {
            const compIndex = Math.floor(globalIndex / (compartments[0].capacity || 100));
            targetCompId = compartments[Math.min(compIndex, compartments.length - 1)].id;
          }

          compCaseStr += `WHEN ? THEN ? `;
          posCaseStr += `WHEN ? THEN ? `;
          params.push(card.id, targetCompId, card.id, (globalIndex + 1) * 1000);
        });

        compCaseStr += 'END';
        posCaseStr += 'END';

        const placeholders = ids.map(() => '?').join(',');
        const sql = `UPDATE collection 
                     SET compartment_id = (${compCaseStr}), 
                         position = (${posCaseStr}) 
                     WHERE id IN (${placeholders})`;

        await tx.run(sql, [...params, ...ids]);
      }
      updatedCount = sortedCards.length;
    });

    return res.json({ success: true, count: updatedCount });
  } catch (error) {
    return res.status(500).json({ error: 'Container re-sorting failed', message: error.message });
  }
});

module.exports = router;
