const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const tcgApi = require('../tcgApi');
const setIndex = require('../setIndex');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken, requireAdmin);

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

// Generate a random collection of various cards for admins database so we can test.
// Dev/test-data helper only — unreachable once NODE_ENV=production.
router.post('/seed-cards', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }
  try {
    // 1. Get or create Binder and Box locations for admin. fillLocation below
    // spreads cards across every compartment, so fresh containers get enough
    // pages/rows to make a large, multi-page test collection.
    let binder = await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Binder' LIMIT 1`, [req.user.id]);
    if (!binder) {
      const result = await db.run(`
        INSERT INTO locations (name, type, sort_order, user_id) VALUES (?, ?, ?, ?)
      `, ['Binder Seed Box', 'Binder', 'custom', req.user.id]);
      await db.createCompartments(result.lastID, 12, 9); // 12 pages, 9 pockets each
      binder = { id: result.lastID };
    }

    let box = await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Box' LIMIT 1`, [req.user.id]);
    if (!box) {
      const result = await db.run(`
        INSERT INTO locations (name, type, sort_order, user_id) VALUES (?, ?, ?, ?)
      `, ['Box Seed Box', 'Box', 'custom', req.user.id]);
      await db.createCompartments(result.lastID, 4, 40); // 4 rows, 40 cards each
      box = { id: result.lastID };
    }

    // Pull whole sets so the pool spans every energy type, both supertypes
    // (Pokémon/Trainer/Energy), and Common through Ultra Rare across vintage
    // (Base Set) and modern (Scarlet & Violet, Sword & Shield). One API request
    // per set via getCardsBySet, cached like any real lookup.
    const SEED_SETS = ['base1', 'sv1', 'swsh1'];
    const MOCK_POOL = [];
    for (const setId of SEED_SETS) {
      const cards = await tcgApi.getCardsBySet(setId);
      MOCK_POOL.push(...cards);
    }
    if (MOCK_POOL.length === 0) {
      return res.status(502).json({ error: 'Could not fetch seed card data from the Pokémon TCG API. Try again shortly.' });
    }

    // Clear out any previously-seeded copies of these sets' cards first, so
    // running this repeatedly re-seeds instead of piling up more copies every
    // time. Scoped to the seeded set ids so it never touches cards a real
    // scan/search added.
    const seedCardIds = MOCK_POOL.map(c => c.id);
    const seedIdPlaceholders = seedCardIds.map(() => '?').join(',');
    await db.run(
      `DELETE FROM collection WHERE user_id = ? AND card_id IN (${seedIdPlaceholders})`,
      [req.user.id, ...seedCardIds]
    );

    // Insert random collection entries distributed across binder & box
    const conditions = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played'];
    const languages = ['English', 'English', 'English', 'Japanese']; // ~25% Japanese so both display modes are visible

    // Only offer printings the card actually has a tracked price for (e.g. a
    // modern Common has no Holofoil print/price) — otherwise resolveCardPrice
    // silently falls back to price_trend and the seeded card's "Holofoil"
    // price ends up identical to its Normal price, which looks like a bug.
    const printsForCard = (card) => {
      const options = [];
      if (card.price_normal > 0) options.push('Normal');
      if (card.price_holofoil > 0) options.push('Holofoil');
      if (card.price_reverse_holofoil > 0) options.push('Reverse Holofoil');
      return options.length > 0 ? options : ['Normal'];
    };

    let addedCount = 0;

    // Pick a random card + random valid printing/condition/language/qty for one slot.
    const randomEntry = (maxPrice) => {
      const card = MOCK_POOL[Math.floor(Math.random() * MOCK_POOL.length)];
      const prints = printsForCard(card);
      return {
        card,
        print: prints[Math.floor(Math.random() * prints.length)],
        condition: conditions[Math.floor(Math.random() * conditions.length)],
        language: languages[Math.floor(Math.random() * languages.length)],
        qty: Math.floor(Math.random() * 2) + 1, // 1-2 copies
        purchasePrice: parseFloat((Math.random() * maxPrice).toFixed(2))
      };
    };

    // Fill each compartment of a location up to ~fillRatio of its capacity so
    // the test collection spans many pages/rows, not just the first one.
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

    await fillLocation(binder.id, 10, 0.7); // binder pages ~70% full
    await fillLocation(box.id, 5, 0.6);     // box rows ~60% full

    // A pile of genuinely unsorted cards (no location_id) to try Assistant
    // Mode / bulk sort on right away.
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
    console.error(error);
    res.status(500).json({ error: 'Failed to seed test cards' });
  }
});

// --- Set-index build management ---

const isGame = (g) => g === 'mtg' || g === 'pokemon';

// List persisted builds plus any in-flight/recent build progress.
router.get('/set-indexes', (req, res) => {
  res.json({ builds: setIndex.listBuilds(), progress: setIndex.getProgress() });
});

// Preview a set's printing count so the UI can warn about size before building.
router.get('/set-indexes/preview', async (req, res) => {
  const { game, set } = req.query;
  if (!isGame(game) || !set) return res.status(400).json({ error: 'game (mtg|pokemon) and set are required' });
  try {
    const cardCount = await setIndex.previewSet(game, set);
    if (!cardCount) return res.status(404).json({ error: `No cards found for ${game} set "${set}"` });
    res.json({ game, set, cardCount, estBytes: cardCount * 20 * 1024 });
  } catch (error) {
    res.status(502).json({ error: `Set lookup failed: ${error.message}` });
  }
});

// Start (or restart) a full-set build. Runs in the background; poll GET for progress.
router.post('/set-indexes', (req, res) => {
  const { game, set } = req.body;
  if (!isGame(game) || !set) return res.status(400).json({ error: 'game (mtg|pokemon) and set are required' });
  setIndex.startBuild(game, set);
  res.status(202).json({ message: `Build started for ${game} ${set}` });
});

// Remove a build's files.
router.delete('/set-indexes/:game/:set', (req, res) => {
  const { game, set } = req.params;
  if (!isGame(game)) return res.status(400).json({ error: 'invalid game' });
  setIndex.deleteBuild(game, set);
  res.json({ message: `Removed ${game} ${set} index` });
});

module.exports = router;
