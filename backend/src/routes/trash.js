const express = require('express');
const { listTrash, restoreBatch, emptyTrash } = require('../utils/collectionTrash');

// Deleted copies, by batch (utils/collectionTrash.js). Mounted at
// /api/collection/trash ahead of the collection router, whose DELETE
// /collection/:id would otherwise take DELETE /collection/trash as an entry id.
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.json({ batches: await listTrash(req.user.id) });
  } catch (error) {
    console.error('List trash failed:', error);
    res.status(500).json({ error: 'Failed to load trash' });
  }
});

router.post('/:batch/restore', async (req, res) => {
  try {
    const result = await restoreBatch(req.params.batch, req.user.id);
    if (!result.found) return res.status(404).json({ error: 'Trash batch not found' });
    res.json({ restored: result.restored, skipped: result.skipped, unsorted: result.unsorted });
  } catch (error) {
    console.error('Restore from trash failed:', error);
    res.status(500).json({ error: 'Failed to restore cards' });
  }
});

router.delete('/:batch', async (req, res) => {
  try {
    const removed = await emptyTrash(req.user.id, req.params.batch);
    if (removed === 0) return res.status(404).json({ error: 'Trash batch not found' });
    res.json({ removed });
  } catch (error) {
    console.error('Delete trash batch failed:', error);
    res.status(500).json({ error: 'Failed to delete from trash' });
  }
});

router.delete('/', async (req, res) => {
  try {
    res.json({ removed: await emptyTrash(req.user.id) });
  } catch (error) {
    console.error('Empty trash failed:', error);
    res.status(500).json({ error: 'Failed to empty trash' });
  }
});

module.exports = router;
