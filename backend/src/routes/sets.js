const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const sets = await db.all(`
      SELECT id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url
      FROM sets
      ORDER BY release_date ASC
    `);
    res.json(sets);
  } catch (error) {
    console.error('Error fetching sets:', error);
    res.status(500).json({ error: 'Failed to retrieve sets' });
  }
});

module.exports = router;
