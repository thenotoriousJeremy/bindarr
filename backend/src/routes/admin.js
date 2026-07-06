const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const tcgApi = require('../tcgApi');
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
    // 1. Get or create Binder and Box locations for admin
    let binder = await db.get(`SELECT id, page_style FROM locations WHERE user_id = ? AND type = 'Binder' LIMIT 1`, [req.user.id]);
    if (!binder) {
      const result = await db.run(`
        INSERT INTO locations (name, type, description, sort_order, max_pages, page_style, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, ['Binder Seed Box', 'Binder', 'Seeded binder', 'custom', 10, '3x3', req.user.id]);
      binder = { id: result.lastID, page_style: '3x3' };
    }

    let box = await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Box' LIMIT 1`, [req.user.id]);
    if (!box) {
      const result = await db.run(`
        INSERT INTO locations (name, type, description, sort_order, max_rows, max_capacity, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, ['Box Seed Box', 'Box', 'Seeded bulk box', 'custom', 3, 200, req.user.id]);
      box = { id: result.lastID };
    }

    // Real card IDs spanning vintage (Base Set/Fossil/Jungle/Neo) and modern
    // (Scarlet & Violet) sets, so seeded data actually shows "old vs new" and
    // mixed rarities. Fetched live via tcgApi.getCardById (same path real
    // search/scan use) instead of hand-built image URLs, which previously had
    // a typo and 404'd for every seeded card.
    const MOCK_IDS = [
      'base1-58', // Pikachu - Base Set (vintage, Common)
      'base1-4',  // Charizard - Base Set (vintage, Rare Holo)
      'base1-2',  // Blastoise - Base Set (vintage, Rare Holo)
      'fossil-20', // Gengar - Fossil (vintage, Rare)
      'jungle-51', // Eevee - Jungle (vintage, Common)
      'neo1-9',   // Lugia - Neo Genesis (vintage, Rare Holo)
      'sv1-13',   // Sprigatito - Scarlet & Violet (modern, Common)
      'sv1-36',   // Fuecoco - Scarlet & Violet (modern, Common)
      'sv1-52',   // Quaxly - Scarlet & Violet (modern, Common)
      'sv1-227',  // Miraidon ex - Scarlet & Violet (modern, Ultra Rare)
    ];

    const MOCK_POOL = [];
    for (const id of MOCK_IDS) {
      const card = await tcgApi.getCardById(id);
      if (card) MOCK_POOL.push(card);
    }
    if (MOCK_POOL.length === 0) {
      return res.status(502).json({ error: 'Could not fetch seed card data from the Pokémon TCG API. Try again shortly.' });
    }

    // Insert random collection entries distributed across binder & box
    const prints = ['Normal', 'Holofoil', 'Reverse Holofoil'];
    const conditions = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played'];
    const languages = ['English', 'English', 'English', 'Japanese']; // ~25% Japanese so both display modes are visible

    let addedCount = 0;

    // Seed binder entries (use pages 1 to 3, slots 1 to 9)
    for (let p = 1; p <= 3; p++) {
      for (let s = 1; s <= 9; s++) {
        if (Math.random() > 0.25) {
          const card = MOCK_POOL[Math.floor(Math.random() * MOCK_POOL.length)];
          const print = prints[Math.floor(Math.random() * prints.length)];
          const condition = conditions[Math.floor(Math.random() * conditions.length)];
          const language = languages[Math.floor(Math.random() * languages.length)];
          const qty = Math.floor(Math.random() * 3) + 1; // 1-3 copies
          const purchasePrice = parseFloat((Math.random() * 10).toFixed(2));
          const pos = ((p - 1) * 9 + (s - 1)) * 1000;

          await db.run(`
            INSERT INTO collection (card_id, quantity, condition, printing, language, purchase_price, location_id, sub_location_1, sub_location_2, position, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [card.id, qty, condition, print, language, purchasePrice, binder.id, `Page ${p}`, `Slot ${s}`, pos, req.user.id]);
          addedCount += qty;
        }
      }
    }

    // Seed box entries (use row 1-2, slot 1-15)
    for (let r = 1; r <= 2; r++) {
      for (let s = 1; s <= 15; s++) {
        if (Math.random() > 0.4) {
          const card = MOCK_POOL[Math.floor(Math.random() * MOCK_POOL.length)];
          const print = prints[Math.floor(Math.random() * prints.length)];
          const condition = conditions[Math.floor(Math.random() * conditions.length)];
          const language = languages[Math.floor(Math.random() * languages.length)];
          const qty = Math.floor(Math.random() * 4) + 1; // 1-4 copies
          const purchasePrice = parseFloat((Math.random() * 5).toFixed(2));
          const pos = ((r - 1) * 40 + (s - 1)) * 1000;

          await db.run(`
            INSERT INTO collection (card_id, quantity, condition, printing, language, purchase_price, location_id, sub_location_1, sub_location_2, position, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [card.id, qty, condition, print, language, purchasePrice, box.id, `Row ${r}`, `Slot ${s}`, pos, req.user.id]);
          addedCount += qty;
        }
      }
    }

    res.json({ message: `Successfully seeded test collection with ${addedCount} cards for admin user!` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to seed test cards' });
  }
});

module.exports = router;
