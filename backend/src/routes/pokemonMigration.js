const express = require('express');
const migration = require('../pokemonMigration');

// Admin → the pokemontcg.io card-id migration (see ../pokemonMigration.js).
// Mounted inside routes/admin.js, below its authenticateToken + requireAdmin, so
// every handler here is admin-only and refuses API keys.
const router = express.Router();

// A 4xx carries its own message, written for the admin. A 5xx is logged with the
// detail and answered generically, plus the message, as the backup route does:
// an admin is who reads it, and "UNIQUE constraint failed: <table>" is the clue.
function sendError(res, error, fallback) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error(`Pokémon id migration: ${error.message}`);
    return res.status(status).json({ error: fallback, message: error.message });
  }
  res.status(status).json({ error: error.message });
}

// Local counts only, cheap enough for every Admin and Dashboard load.
router.get('/status', async (req, res) => {
  try {
    res.json(await migration.status());
  } catch (error) {
    sendError(res, error, 'Could not read the migration status');
  }
});

// The dry run. Reads the target provider's set lists, changes no user data, and
// keeps the plan that /apply then needs the id of.
router.get('/preview', async (req, res) => {
  try {
    res.json(await migration.preview());
  } catch (error) {
    sendError(res, error, 'Could not build the migration preview');
  }
});

router.post('/apply', async (req, res) => {
  const planId = req.body && req.body.plan_id;
  if (typeof planId !== 'string' || !/^[0-9a-f]{16}$/.test(planId)) {
    return res.status(400).json({ error: 'plan_id from the preview is required' });
  }
  try {
    res.json(await migration.apply(planId));
  } catch (error) {
    // Every failure that reaches here happened before the commit: the backup, or
    // the transaction, which has rolled back.
    sendError(res, error, 'The migration failed and was rolled back; nothing was changed.');
  }
});

// Undo the newest applied run, or the one named (which must then be the newest).
router.post('/revert', async (req, res) => {
  const raw = req.body && req.body.run_id;
  const runId = raw === undefined || raw === null ? null : Number(raw);
  if (runId !== null && !(Number.isInteger(runId) && runId > 0)) {
    return res.status(400).json({ error: 'run_id must be a migration run id' });
  }
  try {
    res.json(await migration.revert(runId));
  } catch (error) {
    sendError(res, error, 'The undo failed and was rolled back; nothing was changed.');
  }
});

module.exports = router;
