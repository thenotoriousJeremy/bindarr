const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const tcgApi = require('../tcgApi');
const scryfallApi = require('../scryfallApi');
const catalog = require('../catalog');
const { parseCardRow } = require('../utils/priceHelpers');
const languages = require('../utils/languages');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { BACKUP_DIR, listBackups, createBackup } = require('../backup');

const router = express.Router();

router.use(authenticateToken, requireAdmin);

router.post('/seed-cards', async (req, res) => {
  try {
    let binder = await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Binder' LIMIT 1`, [req.user.id]);
    if (!binder) {
      const result = await db.run(`
        INSERT INTO locations (name, type, sort_order, user_id) VALUES (?, ?, ?, ?)
      `, ['Binder Seed Box', 'Binder', 'custom', req.user.id]);
      await db.createCompartments(result.lastID, 12, 9);
      binder = { id: result.lastID };
    }

    let box = await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Box' LIMIT 1`, [req.user.id]);
    if (!box) {
      const result = await db.run(`
        INSERT INTO locations (name, type, sort_order, user_id) VALUES (?, ?, ?, ?)
      `, ['Box Seed Box', 'Box', 'custom', req.user.id]);
      await db.createCompartments(result.lastID, 4, 40);
      box = { id: result.lastID };
    }

    const SEED_SETS = ['base1', 'sv1', 'swsh1'];
    const MOCK_POOL = [];
    for (const setId of SEED_SETS) {
      try {
        MOCK_POOL.push(...await tcgApi.getCardsBySet(setId, req.user.tcg_api_key));
        await new Promise(r => setTimeout(r, 500)); // Be gentle on the rate limits
      } catch (err) {
        console.error(`Seed: skipping Pokémon set ${setId}:`, err.message);
      }
    }
    const MTG_SEED_SETS = ['lea', 'mh3'];
    for (const setCode of MTG_SEED_SETS) {
      try {
        MOCK_POOL.push(...await scryfallApi.getCardsBySet(setCode));
        await new Promise(r => setTimeout(r, 500)); // Scryfall strictly requires 50-100ms between requests
      } catch (err) {
        console.error(`Seed: skipping MTG set ${setCode}:`, err.message);
      }
    }
    if (MOCK_POOL.length === 0) {
      // Fallback: If APIs are completely down/rate-limited, try to use whatever is already in the cache
      const cached = await db.all(`SELECT * FROM card_cache LIMIT 500`);
      if (cached.length > 0) {
        console.log(`Seed: APIs failed, falling back to ${cached.length} locally cached cards.`);
        for (const r of cached) {
          MOCK_POOL.push(parseCardRow(r));
        }
      } else {
        return res.status(502).json({ error: 'Could not fetch seed card data from the card APIs, and local cache is empty. Try again shortly.' });
      }
    }

    const seedSetIds = [...new Set(MOCK_POOL.map(c => c.set_id))];
    const seedSetPlaceholders = seedSetIds.map(() => '?').join(',');
    await db.run(
      `DELETE FROM collection WHERE user_id = ? AND card_id IN (
         SELECT id FROM card_cache WHERE set_id IN (${seedSetPlaceholders})
       )`,
      [req.user.id, ...seedSetIds]
    );

    const conditions = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played'];
    const languages = ['English', 'English', 'English', 'Japanese'];

    const printsForCard = (card) => {
      const options = [];
      if (card.price_normal > 0) options.push('Normal');
      if (card.price_holofoil > 0) options.push('Holofoil');
      if (card.price_reverse_holofoil > 0) options.push('Reverse Holofoil');
      return options.length > 0 ? options : ['Normal'];
    };

    let addedCount = 0;

    const randomEntry = (maxPrice) => {
      const card = MOCK_POOL[Math.floor(Math.random() * MOCK_POOL.length)];
      const prints = printsForCard(card);
      return {
        card,
        print: prints[Math.floor(Math.random() * prints.length)],
        condition: conditions[Math.floor(Math.random() * conditions.length)],
        language: languages[Math.floor(Math.random() * languages.length)],
        qty: Math.floor(Math.random() * 2) + 1,
        purchasePrice: parseFloat((Math.random() * maxPrice).toFixed(2))
      };
    };

    const fillLocation = async (locationId, maxPrice, fillRatio) => {
      const compartments = await db.all(
        `SELECT id, capacity FROM compartments WHERE location_id = ? ORDER BY idx`,
        [locationId]
      );
      for (const comp of compartments) {
        const slots = Math.max(1, Math.round(comp.capacity * fillRatio));
        for (let s = 0; s < slots; s++) {
          const e = randomEntry(maxPrice);
          await db.run(`
            INSERT INTO collection (card_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [e.card.id, e.qty, e.condition, e.print, e.language, e.purchasePrice, locationId, comp.id, s * 1000, req.user.id]);
          addedCount += e.qty;
        }
      }
    };

    await fillLocation(binder.id, 10, 0.7);
    await fillLocation(box.id, 5, 0.6);

    let unsortedAdded = 0;
    for (let i = 0; i < 40; i++) {
      const e = randomEntry(5);
      await db.run(`
        INSERT INTO collection (card_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, user_id)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)
      `, [e.card.id, e.qty, e.condition, e.print, e.language, e.purchasePrice, req.user.id]);
      addedCount += e.qty;
      unsortedAdded++;
    }

    res.json({ message: `Successfully seeded a large test collection: ${addedCount} cards for admin user (${unsortedAdded} left unsorted to try Assistant Mode on).` });
  } catch (error) {
    console.error('SEEDING ERROR:', error);
    res.status(500).json({ error: 'Failed to seed test cards' });
  }
});

// Get all users with their statistics
router.get('/users', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT id, username, role, share_enabled, created_at
      FROM users
      ORDER BY username ASC
    `);

    // Fetch stats for each user
    const usersWithStats = [];
    for (const u of users) {
      const stats = await db.get(`
        SELECT COUNT(c.id) as unique_cards, SUM(c.quantity) as total_cards,
          SUM(c.quantity * CASE
            WHEN c.printing = 'Holofoil' AND cc.price_holofoil IS NOT NULL AND cc.price_holofoil > 0 THEN cc.price_holofoil
            WHEN c.printing = 'Reverse Holofoil' AND cc.price_reverse_holofoil IS NOT NULL AND cc.price_reverse_holofoil > 0 THEN cc.price_reverse_holofoil
            WHEN c.printing = 'Normal' AND cc.price_normal IS NOT NULL AND cc.price_normal > 0 THEN cc.price_normal
            WHEN c.printing = '1st Edition' AND cc.price_1st_edition IS NOT NULL AND cc.price_1st_edition > 0 THEN cc.price_1st_edition
            ELSE cc.price_trend
          END) as total_value
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.user_id = ?
      `, [u.id]);

      usersWithStats.push({
        ...u,
        total_cards: stats.total_cards || 0,
        unique_cards: stats.unique_cards || 0,
        total_value: parseFloat((stats.total_value || 0).toFixed(2))
      });
    }

    res.json(usersWithStats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve users list' });
  }
});

// Create a new user from Admin Panel
router.post('/users', async (req, res) => {
  const { username, password, role = 'member' } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (role !== 'member' && role !== 'admin') {
    return res.status(400).json({ error: 'Invalid role specification' });
  }

  try {
    const existingUser = await db.get(`SELECT id FROM users WHERE username = ?`, [cleanUsername]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken' });
    }

    const passwordHash = db.hashPassword(password);
    const shareToken = crypto.randomBytes(16).toString('hex');

    await db.run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [cleanUsername, passwordHash, role, shareToken, 0]);

    res.status(201).json({ message: `User "${cleanUsername}" created successfully.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update a user (Change password or Role) from Admin Panel
router.put('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { password, role } = req.body;

  try {
    const targetUser = await db.get(`SELECT id, username, role FROM users WHERE id = ?`, [id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (password !== undefined) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const newHash = db.hashPassword(password);
      await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, id]);
    }

    if (role !== undefined) {
      if (role !== 'member' && role !== 'admin') {
        return res.status(400).json({ error: 'Invalid role' });
      }
      // Block admin demoting themselves
      if (parseInt(id, 10) === req.user.id && role !== 'admin') {
        return res.status(400).json({ error: 'You cannot demote yourself from Administrator role.' });
      }
      await db.run(`UPDATE users SET role = ? WHERE id = ?`, [role, id]);
    }

    res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user from Admin Panel
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;

  if (parseInt(id, 10) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own Administrator account.' });
  }

  try {
    const targetUser = await db.get(`SELECT id, username FROM users WHERE id = ?`, [id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    await db.run(`DELETE FROM collection WHERE user_id = ?`, [id]);
    await db.run(`DELETE FROM locations WHERE user_id = ?`, [id]);
    await db.run(`DELETE FROM users WHERE id = ?`, [id]);

    res.json({ message: `User "${targetUser.username}" and all their card collections/locations have been permanently deleted.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});



// --- Set-index build management ---

const isGame = (g) => g === 'mtg' || g === 'pokemon' || g === 'lorcana';

// List persisted builds plus any in-flight/recent build progress.
// --- Catalogs -------------------------------------------------------------
//
// A catalog is one (game, language). Building it caches every set's cards and
// then embeds their artwork; scanning searches the result. This replaced the
// per-set and whole-game ORB index endpoints, which asked the user to reason
// about scan indexes, recall depth and set scoping to get a working scanner.
// There is one thing to build now, and the list below says how complete it is.
router.get('/catalogs', async (req, res) => {
  try {
    res.json({
      catalogs: await catalog.list(),
      progress: catalog.state(),
      last: catalog.lastResult(),
    });
  } catch (e) {
    console.error('catalog list failed:', e.message);
    res.status(500).json({ error: 'Could not list catalogs' });
  }
});

// The non-English catalogs that can be built at all, with per-language counts.
//
// Separate from /catalogs because it costs a provider set list per language and
// /catalogs is polled every second during a build. The panel asks for this once,
// when the user opens the language section.
router.get('/catalogs/languages', async (req, res) => {
  try {
    res.json({ languages: await catalog.listLanguages(String(req.query.game || 'pokemon')) });
  } catch (e) {
    console.error('listLanguages failed:', e.message);
    res.status(500).json({ error: 'Could not list languages' });
  }
});

router.post('/catalogs/build', (req, res) => {
  // `sets` scopes the build to the sets the user actually has in front of them,
  // which is minutes instead of hours. Omit it for the whole game. A scoped build
  // MERGES into the existing catalog (catalog.js embedPhase), so building one set
  // never discards the sets built before it.
  const { game, lang, skipCache, sets } = req.body || {};
  try {
    res.json({ progress: catalog.start(game, lang, { skipCache: !!skipCache, sets: Array.isArray(sets) ? sets : [] }) });
  } catch (e) {
    // "already running" is a conflict, not a server fault — the UI shows the
    // running build rather than an error.
    res.status(409).json({ error: e.message, progress: catalog.state() });
  }
});

// The scan engine's downloadable pieces: what is installed, what it would cost,
// and the licence the models carry. See utils/modelAssets for why the models are
// a deliberate download rather than part of the image.
router.get('/models', async (req, res) => {
  // The product map ships with the ready-made Pokémon catalog's state because it is
  // that catalog's other half: product ids with nothing to look them up in name no
  // cards at all. Reported per game now that the map covers sealed product too.
  const productMap = require('../tcgplayerCatalog');
  const productMaps = {};
  for (const game of Object.keys(productMap.SEALED_CATEGORIES)) {
    productMaps[game] = await productMap.summary(game);
  }
  res.json({
    ...require('../utils/modelAssets').status(),
    productMap: productMaps.pokemon,
    productMaps,
  });
});

// Build (or refresh) the TCGplayer product map for one game. A download of the
// ready-made Pokémon catalog starts this on its own — this is the button for
// refreshing it after a set release, or recovering from a run that failed
// halfway, or building it for a game that never had one.
router.post('/models/product-map', (req, res) => {
  const productMap = require('../tcgplayerCatalog');
  const game = (req.body && req.body.game) || 'pokemon';
  try {
    if (req.body && req.body.stop) return res.json({ stopped: productMap.stop() });
    res.json({ progress: productMap.start(game) });
  } catch (e) {
    res.status(409).json({ error: e.message, progress: productMap.state() });
  }
});

// `what`: 'models' or 'catalog:mtg' / 'catalog:pokemon'. Downloading is the
// operator's own act on their own install — which is precisely why it is a button
// they press rather than something that happens on startup.
router.post('/models/download', (req, res) => {
  const modelAssets = require('../utils/modelAssets');
  try {
    res.json({ progress: modelAssets.start(String((req.body || {}).what || 'models')) });
  } catch (e) {
    res.status(409).json({ error: e.message, progress: modelAssets.state() });
  }
});

router.post('/catalogs/stop', (req, res) => {
  res.json({ stopped: catalog.stop(), progress: catalog.state() });
});

// Progress is polled while a build runs, so it stays cheap: in-memory counters,
// no database and no filesystem.
router.get('/catalogs/progress', (req, res) => {
  res.json({ progress: catalog.state(), last: catalog.lastResult() });
});

router.get('/backups', (req, res) => {
  res.json({ dir: BACKUP_DIR, backups: listBackups() });
});

router.post('/backups', async (req, res) => {
  try {
    const meta = await createBackup();
    res.status(201).json(meta);
  } catch (error) {
    console.error('BACKUP ERROR:', error);
    res.status(500).json({ error: 'Backup failed', message: error.message });
  }
});

router.get('/backups/:file/download', (req, res) => {
  const name = path.basename(req.params.file); // strip any path traversal
  const full = path.join(BACKUP_DIR, name);
  if (!name.endsWith('.bak') || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  res.download(full);
});

module.exports = router;
