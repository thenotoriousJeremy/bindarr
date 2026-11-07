const express = require('express');
const fxRates = require('../fxRates');

const router = express.Router();

// GET /api/fx — the newest ECB reference rates and the day they were published.
//
// Public, mounted above the authentication gate: it is the ECB's own public data,
// it reveals nothing about the instance, and a shared collection (no session)
// converts its prices with it too. Before the first successful fetch it answers
// 200 with null rates, which the client reads as "show prices as quoted".
router.get('/', async (req, res) => {
  try {
    const fx = await fxRates.latestRates();
    // A day's rates never change once published; an hour of caching keeps a busy
    // shared page off the database without hiding the next day's for long.
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(fx || { base: 'EUR', date: null, rates: null });
  } catch (error) {
    console.error('Failed to read exchange rates:', error);
    res.status(500).json({ error: 'Failed to read exchange rates' });
  }
});

module.exports = router;
