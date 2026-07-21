const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

// List notes, pinned first then most recently updated.
router.get('/notes', async (req, res) => {
  try {
    const notes = await db.all(
      `SELECT * FROM notes WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC`,
      [req.user.id]
    );
    res.json({ notes });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch notes', message: error.message });
  }
});

// Create note.
router.post('/notes', async (req, res) => {
  const { title = '', body = '' } = req.body;
  if (!title.trim() && !body.trim()) {
    return res.status(400).json({ error: 'Note is empty' });
  }
  try {
    const result = await db.run(
      `INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)`,
      [req.user.id, title.trim(), body]
    );
    const note = await db.get(`SELECT * FROM notes WHERE id = ?`, [result.lastID]);
    res.status(201).json({ note });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create note', message: error.message });
  }
});

// Update note. Only the fields present in the body change.
router.put('/notes/:id', async (req, res) => {
  const { title, body, pinned } = req.body;
  const sets = [];
  const params = [];
  if (title !== undefined) { sets.push('title = ?'); params.push(String(title).trim()); }
  if (body !== undefined) { sets.push('body = ?'); params.push(body); }
  if (pinned !== undefined) { sets.push('pinned = ?'); params.push(pinned ? 1 : 0); }
  if (sets.length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  params.push(req.params.id, req.user.id);
  try {
    const result = await db.run(
      `UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
      params
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    const note = await db.get(`SELECT * FROM notes WHERE id = ?`, [req.params.id]);
    res.json({ note });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update note', message: error.message });
  }
});

// Delete note.
router.delete('/notes/:id', async (req, res) => {
  try {
    const result = await db.run(
      `DELETE FROM notes WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete note', message: error.message });
  }
});

module.exports = router;
