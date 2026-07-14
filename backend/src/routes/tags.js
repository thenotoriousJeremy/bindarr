const express = require('express');
const router = express.Router();
const db = require('../db');

// List user tags with count of tagged items
router.get('/api/tags', async (req, res) => {
  const userId = req.user.id;
  try {
    const tags = await db.all(
      `SELECT t.*, COUNT(ct.collection_id) AS item_count 
       FROM tags t 
       LEFT JOIN collection_tags ct ON t.id = ct.tag_id 
       WHERE t.user_id = ? 
       GROUP BY t.id 
       ORDER BY t.name ASC`,
      [userId]
    );
    res.json({ tags });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tags', message: error.message });
  }
});

// Create new custom tag
router.post('/api/tags', async (req, res) => {
  const userId = req.user.id;
  const { name, color = '#3B82F6' } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Tag name is required' });
  }

  try {
    const existing = await db.get(`SELECT id FROM tags WHERE user_id = ? AND name = ?`, [userId, name.trim()]);
    if (existing) {
      return res.status(400).json({ error: 'Tag with this name already exists' });
    }

    const result = await db.run(
      `INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)`,
      [userId, name.trim(), color]
    );
    res.status(201).json({ success: true, tag: { id: result.lastID, name: name.trim(), color } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create tag', message: error.message });
  }
});

// Delete tag
router.delete('/api/tags/:id', async (req, res) => {
  const tagId = req.params.id;
  const userId = req.user.id;

  try {
    const result = await db.run(`DELETE FROM tags WHERE id = ? AND user_id = ?`, [tagId, userId]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    await db.run(`DELETE FROM collection_tags WHERE tag_id = ?`, [tagId]);
    res.json({ success: true, message: 'Tag deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete tag', message: error.message });
  }
});

// Attach tag array to collection item
router.post('/api/collection/:id/tags', async (req, res) => {
  const collectionId = req.params.id;
  const { tag_ids } = req.body;

  try {
    const item = await db.get(`SELECT id FROM collection WHERE id = ? AND user_id = ?`, [collectionId, req.user.id]);
    if (!item) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }

    await db.run(`DELETE FROM collection_tags WHERE collection_id = ?`, [collectionId]);

    if (Array.isArray(tag_ids) && tag_ids.length > 0) {
      const placeholders = tag_ids.map(() => '(?, ?)').join(',');
      const params = [];
      tag_ids.forEach(tagId => params.push(collectionId, tagId));

      await db.run(
        `INSERT INTO collection_tags (collection_id, tag_id) VALUES ${placeholders}`,
        params
      );
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update item tags', message: error.message });
  }
});

module.exports = router;
