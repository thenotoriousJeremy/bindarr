const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('../db');
const tcgApi = require('../tcgApi');
const scryfallApi = require('../scryfallApi');
const catalog = require('../catalog');
const { parseCardRow } = require('../utils/priceHelpers');
const languages = require('../utils/languages');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const metrics = require('../utils/metrics');
const getCollectionMetrics = require('../utils/collectionMetrics');
const { revokeSessions, hashPassword } = require('../utils/authHelpers');
const { BACKUP_DIR, listBackups, createBackup, resolveBackupFile } = require('../backup');
const binderArtStore = require('../utils/binderArtStore');
const { sendFileAt } = require('../utils/sendFileAt');
const { closePendingTradesFor } = require('../utils/transferAssets');

const router = express.Router();

router.use(authenticateToken, requireAdmin);

router.get('/metrics', async (req, res) => {
  if (!metrics.adminEnabled) return res.json({ enabled: false });

  try {
    res.json({
      enabled: true,
      ...metrics.snapshot(),
      collection: await getCollectionMetrics(db),
    });
  } catch (error) {
    console.error('ADMIN METRICS ERROR:', error);
    res.status(500).json({ error: 'Failed to load metrics' });
  }
});

router.post('/seed-cards', async (req, res) => {
  try {
    // Seeding is for an empty account only. It used to clear every collection row in
    // the seed sets first, which also deleted real cards the admin owned from those
    // sets; nothing marks a row as seeded, so the only safe rule is not to seed over
    // existing data at all.
    const existing = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [req.user.id]);
    if (existing.n > 0) {
      return res.status(409).json({ error: `Refusing to seed: this account already has ${existing.n} collection entries. Seed test data into an empty account instead.` });
    }

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

    // The same counts and value as the dashboard and /metrics, from one grouped
    // query (utils/collectionMetrics): owned copies only (wishlist rows left
    // out), a graded copy at its own value, and every currency converted into
    // one reporting unit rather than added together.
    const metrics = await getCollectionMetrics(db);
    const statsById = new Map(metrics.users.map(u => [u.id, u]));
    res.json(users.map((u) => {
      const stats = statsById.get(u.id) || {};
      return {
        ...u,
        total_cards: Number(stats.total_cards || 0),
        unique_cards: Number(stats.unique_cards || 0),
        total_value: Number(stats.total_value || 0),
        value_currency: metrics.valueCurrency,
      };
    }));
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

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password must be text' });
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

    const passwordHash = await hashPassword(password);
    const shareToken = crypto.randomBytes(16).toString('hex');

    const created = await db.run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [cleanUsername, passwordHash, role, shareToken, 0]);
    // A binder and a box to put the first card in, as every new account gets.
    await db.seedStarterLocations(created.lastID, { newAccount: true });

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

    // Every field is checked before anything is written. The password used to be
    // saved (and the user signed out everywhere) before the role was even looked
    // at, so an edit refused for its role still changed the password.
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (role !== undefined) {
      if (role !== 'member' && role !== 'admin') {
        return res.status(400).json({ error: 'Invalid role' });
      }
      // Block admin demoting themselves
      if (parseInt(id, 10) === req.user.id && role !== 'admin') {
        return res.status(400).json({ error: 'You cannot demote yourself from Administrator role.' });
      }
    }

    const newHash = password !== undefined ? await hashPassword(password) : null;
    await db.withTransaction(async () => {
      if (newHash) {
        await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, id]);
        // A reset happens because the old password was forgotten or got out, so
        // every session made with it goes too. An admin resetting their OWN password
        // here keeps the session doing it, the same as a change from Settings.
        await revokeSessions(targetUser.id, {
          exceptTokenHash: targetUser.id === req.user.id ? req.sessionTokenHash : null
        });
      }
      if (role !== undefined) {
        await db.run(`UPDATE users SET role = ? WHERE id = ?`, [role, id]);
      }
    });

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

    // One transaction. Their trades with other members outlive them (the history
    // rows SET NULL on the account, and keep the names snapshotted), but nothing may
    // stay pending against an account that no longer exists: open offers are
    // cancelled and records awaiting confirmation rejected first.
    await db.withTransaction(async () => {
      await closePendingTradesFor(targetUser.id);
      await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
      await db.run(`DELETE FROM collection WHERE user_id = ?`, [id]);
      await db.run(`DELETE FROM locations WHERE user_id = ?`, [id]);
      await db.run(`DELETE FROM users WHERE id = ?`, [id]);
    });
    // Their binder artwork rows cascade with the user; the files do not.
    binderArtStore.removeUser(targetUser.id);

    res.json({ message: `User "${targetUser.username}" and all their card collections/locations have been permanently deleted.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});



// --- Set-index build management ---

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

// pokemontcg.io → TCGdex / pokemontcgapi.com card ids, before the 2027 shutdown.
router.use('/pokemon-migration', require('./pokemonMigration'));

router.get('/backups/:file/download', (req, res) => {
  // Only a file listed in BACKUP_DIR; backup.resolveBackupFile refuses anything
  // that names a path rather than a file there.
  const full = resolveBackupFile(req.params.file);
  if (!full) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  // sendFileAt, not res.download: Express 5's send refuses any path with a
  // dot-folder in it, and a database under ~/.local/share/... answered every
  // download with a 404. resolveBackupFile has already vetted the file itself.
  res.attachment(path.basename(full));
  sendFileAt(res, full, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Backup not found' });
  });
});

module.exports = router;
