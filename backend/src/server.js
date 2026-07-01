const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const tcgApi = require('./tcgApi');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Initialize Database on startup
db.initDb()
  .then(() => {
    console.log('Database tables verified/created successfully.');
    // Schedule a weekly price update (every 7 days)
    setInterval(() => {
      tcgApi.updateCollectionPrices();
    }, 1000 * 60 * 60 * 24 * 7);

    // Run a price update in the background shortly after startup (after 30 seconds to not bog down init)
    setTimeout(() => {
      tcgApi.updateCollectionPrices();
    }, 30000);
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
  });

// --- AUTHENTICATION HELPERS & MIDDLEWARE ---

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

async function generateSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiration
  const expiresAtStr = expiresAt.toISOString().slice(0, 19).replace('T', ' '); // YYYY-MM-DD HH:MM:SS
  await db.run(`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (?, ?, ?)
  `, [token, userId, expiresAtStr]);
  return token;
}

async function authenticateToken(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && req.query.token) {
    // Support token in query parameter for downloading files
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const session = await db.get(`
      SELECT s.user_id, u.username, u.role, u.share_token, u.share_enabled, u.tcg_api_key
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > DATETIME('now')
    `, [token]);

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session token.' });
    }

    req.user = {
      id: session.user_id,
      username: session.username,
      role: session.role,
      share_token: session.share_token,
      share_enabled: session.share_enabled,
      tcg_api_key: session.tcg_api_key || ''
    };
    next();
  } catch (error) {
    res.status(500).json({ error: 'Authentication error', message: error.message });
  }
}

// --- API ROUTES ---

// --- USER AUTHENTICATION & PROFILE ENDPOINTS ---

// Register a new user
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 5) {
    return res.status(400).json({ error: 'Password must be at least 5 characters' });
  }

  try {
    const existingUser = await db.get(`SELECT id FROM users WHERE username = ?`, [cleanUsername]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken' });
    }

    const passwordHash = db.hashPassword(password);
    const shareToken = crypto.randomBytes(16).toString('hex');

    const result = await db.run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [cleanUsername, passwordHash, 'member', shareToken, 0]);

    const token = await generateSession(result.lastID);

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        username: cleanUsername,
        role: 'member',
        share_token: shareToken,
        share_enabled: 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register', message: error.message });
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();

  try {
    const user = await db.get(`SELECT * FROM users WHERE username = ?`, [cleanUsername]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = await generateSession(user.id);

    res.json({
      message: 'Login successful',
      token,
      user: {
        username: user.username,
        role: user.role,
        share_token: user.share_token,
        share_enabled: user.share_enabled,
        tcg_api_key: user.tcg_api_key || ''
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed', message: error.message });
  }
});

// Logout user
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  try {
    if (token) {
      await db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
    }
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Logout failed', message: error.message });
  }
});

// Get current user profile
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Update settings (password, sharing)
app.put('/api/auth/settings', authenticateToken, async (req, res) => {
  const { password, share_enabled, regenerate_share_token, tcg_api_key } = req.body;
  
  try {
    if (password !== undefined) {
      if (password.length < 5) {
        return res.status(400).json({ error: 'Password must be at least 5 characters' });
      }
      const newHash = db.hashPassword(password);
      await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.user.id]);
    }

    if (share_enabled !== undefined) {
      await db.run(`UPDATE users SET share_enabled = ? WHERE id = ?`, [share_enabled ? 1 : 0, req.user.id]);
    }

    if (tcg_api_key !== undefined) {
      await db.run(`UPDATE users SET tcg_api_key = ? WHERE id = ?`, [tcg_api_key.trim(), req.user.id]);
    }

    let newShareToken = req.user.share_token;
    if (regenerate_share_token) {
      newShareToken = crypto.randomBytes(16).toString('hex');
      await db.run(`UPDATE users SET share_token = ? WHERE id = ?`, [newShareToken, req.user.id]);
    }

    // Retrieve updated info
    const updatedUser = await db.get(`SELECT username, role, share_token, share_enabled, tcg_api_key FROM users WHERE id = ?`, [req.user.id]);
    res.json({
      message: 'Settings updated successfully',
      user: {
        username: updatedUser.username,
        role: updatedUser.role,
        share_token: updatedUser.share_token,
        share_enabled: updatedUser.share_enabled,
        tcg_api_key: updatedUser.tcg_api_key || ''
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings', message: error.message });
  }
});

// --- PUBLIC SHARING ENDPOINT ---

// Retrieve a shared collection by share token
app.get('/api/shared/:share_token', async (req, res) => {
  const { share_token } = req.params;
  const listType = req.query.list || 'collection';

  try {
    const owner = await db.get(`SELECT id, username, share_enabled FROM users WHERE share_token = ?`, [share_token]);
    if (!owner || owner.share_enabled === 0) {
      return res.status(404).json({ error: 'This card collection is private or does not exist.' });
    }

    let filterSql = `WHERE c.user_id = ?`;
    let filterParams = [owner.id];

    if (listType === 'wishlist') {
      filterSql += ` AND c.list_type = 'wishlist'`;
    } else if (listType === 'trade') {
      filterSql += ` AND c.is_trade = 1 AND c.list_type = 'collection'`;
    } else {
      filterSql += ` AND c.list_type = 'collection'`;
    }

    // Retrieve their collection without private fields (locations, purchase price, ROI)
    const query = `
      SELECT 
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.added_at,
        c.is_trade,
        c.list_type,
        cc.name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    const formatted = rows.map(row => ({
      ...row,
      subtypes: JSON.parse(row.subtypes || '[]'),
      types: JSON.parse(row.types || '[]'),
    }));

    // Calculate public stats
    let totalCards = 0;
    let uniqueCards = formatted.length;
    let totalValue = 0;

    const typeCounts = {};
    const rarityCounts = {};
    const setCounts = {};

    formatted.forEach(row => {
      const qty = row.quantity || 1;
      const price = row.price_trend || 0;

      totalCards += qty;
      totalValue += qty * price;

      row.types.forEach(t => {
        typeCounts[t] = (typeCounts[t] || 0) + qty;
      });
      if (row.types.length === 0) {
        typeCounts['Colorless'] = (typeCounts['Colorless'] || 0) + qty;
      }

      const rarity = row.rarity || 'Unknown';
      rarityCounts[rarity] = (rarityCounts[rarity] || 0) + qty;

      if (!setCounts[row.set_id]) {
        setCounts[row.set_id] = { name: row.set_name, count: 0, value: 0 };
      }
      setCounts[row.set_id].count += qty;
      setCounts[row.set_id].value += qty * price;
    });

    res.json({
      owner: owner.username,
      collection: formatted,
      stats: {
        summary: {
          totalCards,
          uniqueCards,
          totalValue: parseFloat(totalValue.toFixed(2))
        },
        types: Object.keys(typeCounts).map(name => ({ name, value: typeCounts[name] })),
        rarities: Object.keys(rarityCounts).map(name => ({ name, value: rarityCounts[name] })),
        sets: Object.keys(setCounts).map(id => ({ 
          id, 
          name: setCounts[id].name, 
          count: setCounts[id].count, 
          value: parseFloat(setCounts[id].value.toFixed(2)) 
        })).sort((a,b) => b.value - a.value).slice(0, 8)
      }
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve shared collection', message: error.message });
  }
});

// --- ADMIN ENDPOINTS (Only accessible by users with role 'admin') ---

// Helper middleware to restrict to admin
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
  }
}

// Get all users with their statistics
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
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
        SELECT COUNT(c.id) as unique_cards, SUM(c.quantity) as total_cards, SUM(c.quantity * cc.price_trend) as total_value
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
    res.status(500).json({ error: 'Failed to retrieve users list', message: error.message });
  }
});

// Create a new user from Admin Panel
app.post('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const { username, password, role = 'member' } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 5) {
    return res.status(400).json({ error: 'Password must be at least 5 characters' });
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
    res.status(500).json({ error: 'Failed to create user', message: error.message });
  }
});

// Update a user (Change password or Role) from Admin Panel
app.put('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { password, role } = req.body;

  try {
    const targetUser = await db.get(`SELECT id, username, role FROM users WHERE id = ?`, [id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (password !== undefined) {
      if (password.length < 5) {
        return res.status(400).json({ error: 'Password must be at least 5 characters' });
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
    res.status(500).json({ error: 'Failed to update user', message: error.message });
  }
});

// Delete user from Admin Panel
app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Failed to delete user', message: error.message });
  }
});

// --- CARD MANAGEMENT ENDPOINTS ---

// 1. Search Pokémon TCG cards (proxies to Pokemon TCG API and database cache)
app.get('/api/search', authenticateToken, async (req, res) => {
  const { name, number, set } = req.query;
  try {
    const results = await tcgApi.searchCards(name, number, set, req.user.tcg_api_key);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Search failed', message: error.message });
  }
});

// 2. Get User's Collection
app.get('/api/collection', authenticateToken, async (req, res) => {
  try {
    const listType = req.query.list_type || 'collection';
    const isTrade = req.query.is_trade;

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ?`;
    let filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }

    const query = `
      SELECT 
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.sub_location_1,
        c.sub_location_2,
        c.added_at,
        c.is_trade,
        c.list_type,
        cc.name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        l.id as location_id,
        l.name as location_name,
        l.type as location_type
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);
    
    // Parse JSON fields
    const formatted = rows.map(row => ({
      ...row,
      subtypes: JSON.parse(row.subtypes || '[]'),
      types: JSON.parse(row.types || '[]'),
    }));
    
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve collection', message: error.message });
  }
});

// 3. Add Card to Collection
app.post('/api/collection', authenticateToken, async (req, res) => {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    printing = 'Normal',
    language = 'English',
    purchase_price = 0,
    location_id = null,
    sub_location_1 = '',
    sub_location_2 = '',
    list_type = 'collection',
    is_trade = 0
  } = req.body;

  if (!card_id) {
    return res.status(400).json({ error: 'card_id is required' });
  }

  try {
    // Ensure location_id belongs to the user if provided
    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        return res.status(400).json({ error: 'Invalid location ID' });
      }
    }

    // Ensure card is in the local metadata cache
    let card = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      console.log(`Card ${card_id} not found in cache. Fetching from API first...`);
      const apiCard = await tcgApi.getCardById(card_id, req.user.tcg_api_key);
      if (!apiCard) {
        return res.status(404).json({ error: `Card ID ${card_id} not found on Pokémon TCG API.` });
      }
    }

    // Insert into collection
    const result = await db.run(`
      INSERT INTO collection 
      (card_id, quantity, condition, printing, language, purchase_price, location_id, sub_location_1, sub_location_2, user_id, list_type, is_trade)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      card_id,
      quantity,
      condition,
      printing,
      language,
      purchase_price || 0,
      location_id,
      sub_location_1,
      sub_location_2,
      req.user.id,
      list_type,
      is_trade ? 1 : 0
    ]);

    // Record initial price history trend
    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [card_id]);
    if (cacheCard && cacheCard.price_trend > 0) {
      await db.run(`INSERT OR IGNORE INTO price_history (card_id, price) VALUES (?, ?)`, [card_id, cacheCard.price_trend]);
    }

    res.status(201).json({ message: 'Card added to collection', id: result.lastID });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add card', message: error.message });
  }
});

// 4. Update Card in Collection
app.put('/api/collection/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const {
    quantity,
    condition,
    printing,
    language,
    purchase_price,
    location_id,
    sub_location_1,
    sub_location_2,
    list_type,
    is_trade
  } = req.body;

  try {
    // Ensure entry exists and belongs to the user
    const entry = await db.get(`SELECT id FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }

    // Ensure location_id belongs to the user if updated
    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        return res.status(400).json({ error: 'Invalid location ID' });
      }
    }

    // Build dynamic UPDATE query based on passed values
    const fields = [];
    const params = [];

    if (quantity !== undefined) { fields.push('quantity = ?'); params.push(quantity); }
    if (condition !== undefined) { fields.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { fields.push('printing = ?'); params.push(printing); }
    if (language !== undefined) { fields.push('language = ?'); params.push(language); }
    if (purchase_price !== undefined) { fields.push('purchase_price = ?'); params.push(purchase_price); }
    if (location_id !== undefined) { fields.push('location_id = ?'); params.push(location_id); }
    if (sub_location_1 !== undefined) { fields.push('sub_location_1 = ?'); params.push(sub_location_1); }
    if (sub_location_2 !== undefined) { fields.push('sub_location_2 = ?'); params.push(sub_location_2); }
    if (list_type !== undefined) { fields.push('list_type = ?'); params.push(list_type); }
    if (is_trade !== undefined) { fields.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields provided for update' });
    }

    params.push(id);
    params.push(req.user.id);
    await db.run(`UPDATE collection SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);
    
    res.json({ message: 'Collection entry updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update entry', message: error.message });
  }
});

// 5. Delete Card from Collection
app.delete('/api/collection/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }
    res.json({ message: 'Card removed from collection' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove card', message: error.message });
  }
});

// 6. Manage Locations (Physical Storage)
app.get('/api/locations', authenticateToken, async (req, res) => {
  try {
    const locations = await db.all(`
      SELECT l.*, COUNT(c.id) as card_count, SUM(c.quantity) as total_cards 
      FROM locations l
      LEFT JOIN collection c ON l.id = c.location_id AND c.user_id = l.user_id
      WHERE l.user_id = ?
      GROUP BY l.id
    `, [req.user.id]);
    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve locations', message: error.message });
  }
});

app.post('/api/locations', authenticateToken, async (req, res) => {
  const { name, type, description = '' } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  try {
    // Check for duplicates for this user
    const existing = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [name, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'A location with this name already exists' });
    }

    const result = await db.run(`
      INSERT INTO locations (name, type, description, user_id)
      VALUES (?, ?, ?, ?)
    `, [name, type, description, req.user.id]);
    res.status(201).json({ message: 'Location created', id: result.lastID });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create location', message: error.message });
  }
});

app.put('/api/locations/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, type, description } = req.body;
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    if (name) {
      const dup = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ? AND id != ?`, [name, req.user.id, id]);
      if (dup) {
        return res.status(400).json({ error: 'A location with this name already exists' });
      }
    }

    await db.run(`
      UPDATE locations 
      SET name = COALESCE(?, name), type = COALESCE(?, type), description = COALESCE(?, description)
      WHERE id = ? AND user_id = ?
    `, [name, type, description, id, req.user.id]);
    res.json({ message: 'Location updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update location', message: error.message });
  }
});

app.delete('/api/locations/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // Disassociate cards from this location instead of blocking delete (scoped to user)
    await db.run(`UPDATE collection SET location_id = NULL, sub_location_1 = NULL, sub_location_2 = NULL WHERE location_id = ? AND user_id = ?`, [id, req.user.id]);
    
    await db.run(`DELETE FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json({ message: 'Location deleted successfully (any stored cards moved to Unsorted)' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete location', message: error.message });
  }
});

// Helper for deterministic price simulation over history
const getSimulatedPriceAt = (cardId, currentPrice, t, now) => {
  const timeDiff = now - t;
  const yearsAgo = timeDiff / (365.25 * 24 * 60 * 60 * 1000);
  
  // Deterministic seed from card ID
  let seed = 0;
  for (let i = 0; i < cardId.length; i++) {
    seed += cardId.charCodeAt(i);
  }
  
  // Simulate a slow appreciation/depreciation over the years with some sin wave noise
  const trend = 0.05 * Math.sin(seed * 0.1) * yearsAgo; // up or down trend
  const noise = 0.03 * Math.sin(seed + yearsAgo * 12); // monthly waves
  const factor = Math.max(0.1, 1.0 - (yearsAgo * 0.06) + trend + noise);
  
  return parseFloat((currentPrice * factor).toFixed(2));
};

const isVintageSet = (setId) => {
  const id = (setId || '').toLowerCase();
  return id.startsWith('base') || id.startsWith('gym') || id.startsWith('neo') || 
         id.startsWith('lc') || id.startsWith('ecard') || id.startsWith('ex') || 
         id.startsWith('pop') || id.startsWith('promo1') || id.startsWith('si') ||
         id.startsWith('xy12') || id.startsWith('cel25');
};

// 7. Get Collection Statistics & Analytics
app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    // Retrieve all collection items to compute statistics
    const query = `
      SELECT 
        c.quantity, c.purchase_price, c.added_at, c.printing, c.condition, c.card_id,
        cc.types, cc.rarity, cc.set_name, cc.set_id, cc.price_trend,
        l.name as location_name
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      WHERE c.user_id = ?
    `;
    const rows = await db.all(query, [req.user.id]);

    let totalCards = 0;
    let uniqueCards = rows.length;
    let totalValue = 0;
    let nearMintCount = 0;
    let vintageCount = 0;

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * oneDayMs;
    const thirtyDaysMs = 30 * oneDayMs;
    const oneYearMs = 365 * oneDayMs;
    const fiveYearsMs = 5 * oneYearMs;

    let value7dAgo = 0;
    let value30dAgo = 0;
    let value1yAgo = 0;
    let value5yAgo = 0;

    const typeCounts = {};
    const rarityCounts = {};
    const setCounts = {};
    const locationCounts = {};

    rows.forEach(row => {
      const qty = row.quantity || 1;
      const price = row.price_trend || 0;
      const addedTime = row.added_at ? new Date(row.added_at).getTime() : now;

      totalCards += qty;
      totalValue += qty * price;

      if (row.condition === 'Near Mint') {
        nearMintCount += qty;
      }

      if (isVintageSet(row.set_id)) {
        vintageCount += qty;
      }

      // Check if the card was in the collection at those times
      if (addedTime <= now - sevenDaysMs) {
        value7dAgo += qty * getSimulatedPriceAt(row.card_id, price, now - sevenDaysMs, now);
      }
      if (addedTime <= now - thirtyDaysMs) {
        value30dAgo += qty * getSimulatedPriceAt(row.card_id, price, now - thirtyDaysMs, now);
      }
      if (addedTime <= now - oneYearMs) {
        value1yAgo += qty * getSimulatedPriceAt(row.card_id, price, now - oneYearMs, now);
      }
      if (addedTime <= now - fiveYearsMs) {
        value5yAgo += qty * getSimulatedPriceAt(row.card_id, price, now - fiveYearsMs, now);
      }

      // Parse types
      const types = JSON.parse(row.types || '[]');
      types.forEach(t => {
        typeCounts[t] = (typeCounts[t] || 0) + qty;
      });
      if (types.length === 0) {
        typeCounts['Colorless'] = (typeCounts['Colorless'] || 0) + qty;
      }

      // Rarity
      const rarity = row.rarity || 'Unknown';
      rarityCounts[rarity] = (rarityCounts[rarity] || 0) + qty;

      // Set
      const set = row.set_name || 'Other';
      if (!setCounts[row.set_id]) {
        setCounts[row.set_id] = { name: set, count: 0, value: 0 };
      }
      setCounts[row.set_id].count += qty;
      setCounts[row.set_id].value += qty * price;

      // Location
      const loc = row.location_name || 'Unassigned';
      locationCounts[loc] = (locationCounts[loc] || 0) + qty;
    });

    // Get top most valuable cards (scoped to user)
    const topValuableQuery = `
      SELECT 
        c.quantity, c.condition, c.printing, c.language, c.purchase_price,
        cc.id as card_id, cc.name, cc.rarity, cc.set_name, cc.image_url, cc.price_trend
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
      ORDER BY cc.price_trend DESC
      LIMIT 6
    `;
    const topValuable = await db.all(topValuableQuery, [req.user.id]);

    // Compute progress for top 4 sets in database (estimate set total)
    const setSizes = {
      'base1': 102,  // Base Set
      'base2': 64,   // Jungle
      'base3': 62,   // Fossil
      'base4': 130,  // Base Set 2
      'neo1': 111,   // Neo Genesis
      'cel25': 25,   // Celebrations
      'swsh1': 202,  // Sword & Shield Base
      'swsh11': 196, // Lost Origin
      'swsh12': 98,  // Silver Tempest
      'sv1': 198,    // Scarlet & Violet Base
      'sv2': 193,    // Paldea Evolved
      'sv3': 197,    // Obsidian Flames
      'sv3pt5': 165, // 151
    };

    const setProgress = [];
    for (const setId in setCounts) {
      const userUniqueInSet = await db.get(`
        SELECT COUNT(DISTINCT card_id) as count 
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE cc.set_id = ? AND c.user_id = ?
      `, [setId, req.user.id]);

      const size = setSizes[setId] || 150; // default estimate if set not in database
      const count = userUniqueInSet.count;
      setProgress.push({
        setId,
        setName: setCounts[setId].name,
        ownedUnique: count,
        totalCards: size,
        percent: Math.min(Math.round((count / size) * 100), 100)
      });
    }

    // Sort set progress by completion percentage descending
    setProgress.sort((a, b) => b.percent - a.percent);

    const mintRate = totalCards > 0 ? parseFloat(((nearMintCount / totalCards) * 100).toFixed(1)) : 0.0;
    const vintageRatio = totalCards > 0 ? parseFloat(((vintageCount / totalCards) * 100).toFixed(1)) : 0.0;

    res.json({
      summary: {
        totalCards,
        uniqueCards,
        totalValue: parseFloat(totalValue.toFixed(2)),
        mintRate,
        vintageRatio,
        change7d: {
          abs: parseFloat((totalValue - value7dAgo).toFixed(2)),
          pct: value7dAgo > 0 ? parseFloat((((totalValue - value7dAgo) / value7dAgo) * 100).toFixed(1)) : 100.0
        },
        change30d: {
          abs: parseFloat((totalValue - value30dAgo).toFixed(2)),
          pct: value30dAgo > 0 ? parseFloat((((totalValue - value30dAgo) / value30dAgo) * 100).toFixed(1)) : 100.0
        },
        change1y: {
          abs: parseFloat((totalValue - value1yAgo).toFixed(2)),
          pct: value1yAgo > 0 ? parseFloat((((totalValue - value1yAgo) / value1yAgo) * 100).toFixed(1)) : 100.0
        },
        change5y: {
          abs: parseFloat((totalValue - value5yAgo).toFixed(2)),
          pct: value5yAgo > 0 ? parseFloat((((totalValue - value5yAgo) / value5yAgo) * 100).toFixed(1)) : 100.0
        }
      },
      types: Object.keys(typeCounts).map(name => ({ name, value: typeCounts[name] })),
      rarities: Object.keys(rarityCounts).map(name => ({ name, value: rarityCounts[name] })),
      sets: Object.keys(setCounts).map(id => ({ 
        id, 
        name: setCounts[id].name, 
        count: setCounts[id].count, 
        value: parseFloat(setCounts[id].value.toFixed(2)) 
      })).sort((a,b) => b.value - a.value).slice(0, 8),
      locations: Object.keys(locationCounts).map(name => ({ name, value: locationCounts[name] })),
      topValuable,
      setProgress: setProgress.slice(0, 4)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute statistics', message: error.message });
  }
});

// 7b. Get Collection Net Worth Timeline History
app.get('/api/stats/history', authenticateToken, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    
    // Retrieve all collection items to compute history
    const query = `
      SELECT c.quantity, c.added_at, cc.id as card_id, cc.price_trend
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
    `;
    const items = await db.all(query, [req.user.id]);

    const now = Date.now();
    let points = [];
    let step = 0;
    let count = 0;
    let formatLabel = (d) => d.toLocaleDateString();

    if (period === '7d') {
      count = 7;
      step = 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { weekday: 'short' });
    } else if (period === '30d') {
      count = 30;
      step = 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } else if (period === '1y') {
      count = 12;
      step = 30 * 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    } else if (period === '5y') {
      count = 20;
      step = 91 * 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    } else {
      count = 30;
      step = 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    const historyData = [];
    for (let i = count - 1; i >= 0; i--) {
      const targetTime = now - (i * step);
      const targetDate = new Date(targetTime);
      
      let totalValue = 0;
      items.forEach(item => {
        const addedTime = new Date(item.added_at).getTime();
        if (addedTime <= targetTime) {
          const currentPrice = item.price_trend || 0;
          const simulatedPrice = getSimulatedPriceAt(item.card_id, currentPrice, targetTime, now);
          totalValue += item.quantity * simulatedPrice;
        }
      });

      historyData.push({
        date: formatLabel(targetDate),
        value: parseFloat(totalValue.toFixed(2))
      });
    }

    res.json(historyData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute timeline history', message: error.message });
  }
});

// 8. Export Database
app.get('/api/export', authenticateToken, async (req, res) => {
  const { format = 'csv' } = req.query;
  try {
    const query = `
      SELECT 
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.sub_location_1,
        c.sub_location_2,
        c.added_at,
        cc.id as card_id,
        cc.name as card_name,
        cc.supertype,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number as card_number,
        cc.image_url,
        cc.price_trend as market_price,
        l.name as location_name
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      WHERE c.user_id = ?
    `;
    const rows = await db.all(query, [req.user.id]);

    if (format.toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=pokedexrr_collection.json');
      return res.json(rows);
    }

    // Default to CSV
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=pokedexrr_collection.csv');

    // Headers
    const headers = [
      'Card ID', 'Name', 'Set Name', 'Set ID', 'Card Number', 'Rarity',
      'Quantity', 'Condition', 'Printing', 'Language', 'Purchase Price',
      'Market Price', 'Location Container', 'Sub-Location Page/Row', 'Sub-Location Slot/Section', 'Added At'
    ];

    let csvContent = headers.join(',') + '\n';
    
    rows.forEach(r => {
      const line = [
        r.card_id,
        `"${r.card_name.replace(/"/g, '""')}"`,
        `"${r.set_name.replace(/"/g, '""')}"`,
        r.set_id,
        r.card_number,
        r.rarity,
        r.quantity,
        r.condition,
        r.printing,
        r.language,
        r.purchase_price || 0,
        r.market_price || 0,
        r.location_name ? `"${r.location_name.replace(/"/g, '""')}"` : 'Unassigned',
        r.sub_location_1 ? `"${r.sub_location_1.replace(/"/g, '""')}"` : '',
        r.sub_location_2 ? `"${r.sub_location_2.replace(/"/g, '""')}"` : '',
        r.added_at
      ];
      csvContent += line.join(',') + '\n';
    });

    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});

// 8b. Import Database
app.post('/api/import', authenticateToken, async (req, res) => {
  try {
    const { format, data } = req.body;
    if (!data) {
      return res.status(400).json({ error: 'No data provided' });
    }

    let cards = [];

    if (format === 'json') {
      cards = typeof data === 'string' ? JSON.parse(data) : data;
    } else if (format === 'csv') {
      const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length <= 1) {
        return res.status(400).json({ error: 'CSV file is empty' });
      }

      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      
      const parseCSVLine = (line) => {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        result.push(current.trim());
        return result;
      };

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;

        const cardObj = {};
        headers.forEach((header, idx) => {
          cardObj[header] = values[idx];
        });
        
        cards.push({
          card_id: cardObj['Card ID'],
          card_name: cardObj['Name'],
          set_name: cardObj['Set Name'],
          set_id: cardObj['Set ID'],
          card_number: cardObj['Card Number'],
          rarity: cardObj['Rarity'],
          quantity: parseInt(cardObj['Quantity']) || 1,
          condition: cardObj['Condition'] || 'Near Mint',
          printing: cardObj['Printing'] || 'Normal',
          language: cardObj['Language'] || 'English',
          purchase_price: parseFloat(cardObj['Purchase Price']) || 0,
          market_price: parseFloat(cardObj['Market Price']) || 0,
          location_name: cardObj['Location Container'],
          sub_location_1: cardObj['Sub-Location Page/Row'],
          sub_location_2: cardObj['Sub-Location Slot/Section'],
          added_at: cardObj['Added At']
        });
      }
    }

    if (!Array.isArray(cards)) {
      return res.status(400).json({ error: 'Invalid data format. Expected an array or CSV lines.' });
    }

    let importedCount = 0;
    for (const card of cards) {
      const cardId = card.card_id || card.id;
      if (!cardId) continue;

      // 1. Ensure the card is in the cache
      let cached = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [cardId]);
      if (!cached) {
        try {
          const tcgApi = require('./tcgApi');
          await tcgApi.getCardById(cardId);
        } catch (apiErr) {
          console.error(`Failed to fetch card ${cardId} from TCG API during import:`, apiErr.message);
          await db.run(
            `INSERT OR IGNORE INTO card_cache 
             (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              cardId,
              card.card_name || 'Imported Card',
              card.supertype || 'Pokémon',
              '[]',
              card.types ? JSON.stringify(card.types) : '[]',
              card.rarity || 'Common',
              card.set_id || '',
              card.set_name || 'Imported Set',
              card.card_number || card.number || '',
              card.image_url || '',
              card.market_price || card.price_trend || 0
            ]
          );
        }
      }

      // 2. Resolve location_id from location_name
      let locationId = null;
      const locName = card.location_name || card.location_container;
      if (locName && locName !== 'Unassigned') {
        let locRow = await db.get(`SELECT id FROM locations WHERE name = ?`, [locName]);
        if (!locRow) {
          let type = 'Other';
          if (card.sub_location_1 && (card.sub_location_1.toLowerCase().includes('page') || card.sub_location_2)) {
            type = 'Binder';
          }
          const newLoc = await db.run(`INSERT INTO locations (name, type) VALUES (?, ?)`, [locName, type]);
          locationId = newLoc.lastID;
        } else {
          locationId = locRow.id;
        }
      }

      // 3. Insert card into the collection
      await db.run(
        `INSERT INTO collection 
         (card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, sub_location_1, sub_location_2, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cardId,
          req.user.id,
          card.quantity || 1,
          card.condition || 'Near Mint',
          card.printing || 'Normal',
          card.language || 'English',
          card.purchase_price || 0,
          locationId,
          card.sub_location_1 || '',
          card.sub_location_2 || '',
          card.added_at || new Date().toISOString()
        ]
      );
      importedCount++;
    }

    res.json({ success: true, message: `Successfully imported ${importedCount} cards.` });
  } catch (error) {
    console.error('Import failed:', error);
    res.status(500).json({ error: 'Import failed', message: error.message });
  }
});


// --- ADVANCED COLLECTOR ENDPOINTS (DEX FEATURES) ---

// 1. Get Card Price History
app.get('/api/cards/:id/price-history', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    let history = await db.all(`
      SELECT price, recorded_at 
      FROM price_history 
      WHERE card_id = ? 
      ORDER BY recorded_at ASC
    `, [id]);

    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [id]);
    const currentPrice = (cacheCard && cacheCard.price_trend) || 1.00;

    // Seed mock price points if less than 5 records exist, so charts display immediately
    if (history.length < 5) {
      history = [];
      const now = new Date();
      for (let i = 9; i >= 0; i--) { // 10 price points
        const date = new Date(now);
        date.setDate(now.getDate() - i * 3); // 3 day intervals
        const fluctuation = (Math.random() - 0.5) * 0.15 * currentPrice; // +/- 15%
        const price = parseFloat(Math.max(0.10, currentPrice + fluctuation).toFixed(2));
        history.push({
          price,
          recorded_at: date.toISOString()
        });
      }
    } else {
      // Map to standardized format
      history = history.map(h => ({
        price: h.price,
        recorded_at: h.recorded_at
      }));
    }

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve price history', message: error.message });
  }
});

// 2. Get User Decks
app.get('/api/decks', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT 
        d.id,
        d.name,
        d.description,
        d.created_at,
        COUNT(dc.card_id) as total_card_types,
        COALESCE(SUM(dc.quantity), 0) as total_cards
      FROM decks d
      LEFT JOIN deck_cards dc ON d.id = dc.deck_id
      WHERE d.user_id = ?
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `;
    const rows = await db.all(query, [req.user.id]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve decks', message: error.message });
  }
});

// 3. Create Deck
app.post('/api/decks', authenticateToken, async (req, res) => {
  const { name, description = '' } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Deck name is required' });
  }

  try {
    const result = await db.run(
      `INSERT INTO decks (name, description, user_id) VALUES (?, ?, ?)`,
      [name, description, req.user.id]
    );
    res.status(201).json({ message: 'Deck created successfully', id: result.lastID });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create deck', message: error.message });
  }
});

// 4. Get Deck Details (with Cards)
app.get('/api/decks/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const deck = await db.get(`SELECT * FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found' });
    }

    const cardsQuery = `
      SELECT 
        dc.quantity,
        cc.id,
        cc.name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend
      FROM deck_cards dc
      JOIN card_cache cc ON dc.card_id = cc.id
      WHERE dc.deck_id = ?
    `;
    const cards = await db.all(cardsQuery, [id]);

    const formatted = cards.map(c => ({
      ...c,
      subtypes: JSON.parse(c.subtypes || '[]'),
      types: JSON.parse(c.types || '[]')
    }));

    res.json({
      ...deck,
      cards: formatted
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve deck details', message: error.message });
  }
});

// 5. Update Deck Metadata
app.put('/api/decks/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Deck name is required' });
  }

  try {
    const result = await db.run(
      `UPDATE decks SET name = ?, description = ? WHERE id = ? AND user_id = ?`,
      [name, description || '', id, req.user.id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    res.json({ message: 'Deck updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update deck', message: error.message });
  }
});

// 6. Delete Deck
app.delete('/api/decks/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    // Verify ownership
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    // Manual cascade deletion
    await db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [id]);
    await db.run(`DELETE FROM decks WHERE id = ?`, [id]);

    res.json({ message: 'Deck deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete deck', message: error.message });
  }
});

// 7. Add/Update Card in Deck
app.post('/api/decks/:id/cards', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { card_id, quantity = 1 } = req.body;

  if (!card_id) {
    return res.status(400).json({ error: 'card_id is required' });
  }

  try {
    // Verify deck ownership
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    // Ensure card metadata exists in cache
    let card = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      console.log(`Card ${card_id} not in cache. Fetching...`);
      const apiCard = await tcgApi.getCardById(card_id, req.user.tcg_api_key);
      if (!apiCard) {
        return res.status(404).json({ error: 'Card not found on Pokémon TCG API.' });
      }
    }

    // Insert or update quantities
    await db.run(`
      INSERT INTO deck_cards (deck_id, card_id, quantity)
      VALUES (?, ?, ?)
      ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = ?
    `, [id, card_id, parseInt(quantity, 10), parseInt(quantity, 10)]);

    // Record initial price history trend if card is added
    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [card_id]);
    if (cacheCard && cacheCard.price_trend > 0) {
      await db.run(`INSERT OR IGNORE INTO price_history (card_id, price) VALUES (?, ?)`, [card_id, cacheCard.price_trend]);
    }

    res.json({ message: 'Card added/updated in deck successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add card to deck', message: error.message });
  }
});

// 8. Remove Card from Deck
app.delete('/api/decks/:id/cards/:card_id', authenticateToken, async (req, res) => {
  const { id, card_id } = req.params;
  try {
    // Verify deck ownership
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    await db.run(`DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [id, card_id]);
    res.json({ message: 'Card removed from deck successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove card from deck', message: error.message });
  }
});


// Serve production static assets from Frontend
const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendBuildPath));

// Catch-all route to serve Index.html in production
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`Pokedexrr Server running on port ${PORT}`);
  console.log(`Access local: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
