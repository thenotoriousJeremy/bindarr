const express = require('express');
const db = require('../db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

async function getEffectiveSettings() {
  const row = await db.get(`SELECT public_base_url FROM app_settings WHERE id = 1`);
  const public_base_url = (row && row.public_base_url) || process.env.PUBLIC_BASE_URL || '';
  return { public_base_url };
}

// Any logged-in user can read effective settings (needed to render share links)
router.get('/', authenticateToken, async (req, res) => {
  try {
    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// Only admins can override settings
router.put('/', authenticateToken, requireAdmin, async (req, res) => {
  const { public_base_url } = req.body;

  if (public_base_url !== undefined) {
    const trimmed = public_base_url.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ error: 'Public base URL must start with http:// or https://' });
    }
    const cleaned = trimmed.replace(/\/+$/, '');
    await db.run(`UPDATE app_settings SET public_base_url = ? WHERE id = 1`, [cleaned]);
  }

  try {
    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
