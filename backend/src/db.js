const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Ensure database directory exists
const dbPath = process.env.DB_PATH || path.join(__dirname, '../database/pokemon_cards.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`Connecting to SQLite database at: ${dbPath}`);
const dbConnection = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Database connection established successfully.');
    // sqlite3 does not enforce FOREIGN KEY constraints unless explicitly enabled per-connection.
    dbConnection.run('PRAGMA foreign_keys = ON');
  }
});

// Helper wrappers for Promise-based SQL operations
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    dbConnection.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    dbConnection.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    dbConnection.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Password hashing utility for seeding
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Initialize tables
async function initDb() {
  // Create users table
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('admin', 'member')) NOT NULL DEFAULT 'member',
      share_token TEXT UNIQUE NOT NULL,
      share_enabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create sessions table
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Create locations table
  await run(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT CHECK(type IN ('Binder', 'Box', 'Toploader Box', 'Deck Box', 'Tin / Case', 'Other')) NOT NULL,
      description TEXT,
      sort_order TEXT DEFAULT 'name-asc',
      max_pages INTEGER DEFAULT 30,
      page_style TEXT DEFAULT '3x3',
      max_rows INTEGER DEFAULT 3,
      max_capacity INTEGER DEFAULT 1000,
      foil_sorting TEXT DEFAULT 'normals_first'
    )
  `);

  // Create card metadata cache
  await run(`
    CREATE TABLE IF NOT EXISTS card_cache (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      supertype TEXT,
      subtypes TEXT,      -- Store JSON string
      types TEXT,         -- Store JSON string
      rarity TEXT,
      set_id TEXT,
      set_name TEXT,
      number TEXT,
      image_url TEXT,
      price_trend REAL,
      price_normal REAL,
      price_holofoil REAL,
      price_reverse_holofoil REAL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create collection table
  await run(`
    CREATE TABLE IF NOT EXISTS collection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      condition TEXT CHECK(condition IN ('Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged')) DEFAULT 'Near Mint',
      printing TEXT CHECK(printing IN ('Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo')) DEFAULT 'Normal',
      language TEXT DEFAULT 'English',
      purchase_price REAL,
      location_id INTEGER,
      sub_location_1 TEXT,
      sub_location_2 TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE SET NULL,
      FOREIGN KEY(card_id) REFERENCES card_cache(id)
    )
  `);

  // Create price_history table
  await run(`
    CREATE TABLE IF NOT EXISTS price_history (
      card_id TEXT NOT NULL,
      price REAL NOT NULL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(card_id, recorded_at)
    )
  `);

  // Create decks table
  await run(`
    CREATE TABLE IF NOT EXISTS decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Create deck_cards table
  await run(`
    CREATE TABLE IF NOT EXISTS deck_cards (
      deck_id INTEGER NOT NULL,
      card_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      PRIMARY KEY(deck_id, card_id),
      FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
    )
  `);

  // --- MIGRATIONS ---
  // 1. Add user_id to collection table if missing
  const collectionCols = await all(`PRAGMA table_info(collection)`);
  if (!collectionCols.some(c => c.name === 'user_id')) {
    console.log('Adding user_id column to collection table...');
    await run(`ALTER TABLE collection ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
  }

  // Add is_trade to collection table if missing
  if (!collectionCols.some(c => c.name === 'is_trade')) {
    console.log('Adding is_trade column to collection table...');
    await run(`ALTER TABLE collection ADD COLUMN is_trade INTEGER DEFAULT 0`);
  }

  // Add list_type to collection table if missing
  if (!collectionCols.some(c => c.name === 'list_type')) {
    console.log('Adding list_type column to collection table...');
    await run(`ALTER TABLE collection ADD COLUMN list_type TEXT DEFAULT 'collection'`);
  }

  // 2. Add user_id to locations table if missing
  const locationsCols = await all(`PRAGMA table_info(locations)`);
  if (!locationsCols.some(c => c.name === 'user_id')) {
    console.log('Adding user_id column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
  }

  // Add custom dimension columns to locations table if missing
  if (!locationsCols.some(c => c.name === 'sort_order')) {
    console.log('Adding sort_order column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN sort_order TEXT DEFAULT 'name-asc'`);
  }
  if (!locationsCols.some(c => c.name === 'max_pages')) {
    console.log('Adding max_pages column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN max_pages INTEGER DEFAULT 30`);
  }
  if (!locationsCols.some(c => c.name === 'page_style')) {
    console.log('Adding page_style column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN page_style TEXT DEFAULT '3x3'`);
  }
  if (!locationsCols.some(c => c.name === 'max_rows')) {
    console.log('Adding max_rows column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN max_rows INTEGER DEFAULT 3`);
  }
  if (!locationsCols.some(c => c.name === 'max_capacity')) {
    console.log('Adding max_capacity column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN max_capacity INTEGER DEFAULT 1000`);
  }
  if (!locationsCols.some(c => c.name === 'foil_sorting')) {
    console.log('Adding foil_sorting column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN foil_sorting TEXT DEFAULT 'normals_first'`);
  }

  // Add position column to collection table if missing
  if (!collectionCols.some(c => c.name === 'position')) {
    console.log('Adding position column to collection table...');
    await run(`ALTER TABLE collection ADD COLUMN position REAL DEFAULT 0`);

    // Migrate existing collection records to positions
    console.log('Migrating existing coordinates to position indices...');
    const existingCards = await all(`
      SELECT c.id, c.sub_location_1, c.sub_location_2, l.type as location_type, l.page_style
      FROM collection c
      LEFT JOIN locations l ON c.location_id = l.id
      WHERE c.location_id IS NOT NULL
    `);

    for (const card of existingCards) {
      let pageNum = parseInt((card.sub_location_1 || '').replace(/\D/g, ''), 10) || 0;
      let slotNum = parseInt((card.sub_location_2 || '').replace(/\D/g, ''), 10) || 0;
      
      let index = 0;
      if (card.location_type === 'Binder' || card.location_type === 'Toploader Binder') {
        const pocketsCount = card.page_style === '2x2' ? 4 : card.page_style === '3x4' ? 12 : 9;
        if (pageNum > 0 && slotNum > 0) {
          index = (pageNum - 1) * pocketsCount + (slotNum - 1);
        }
      } else if (card.location_type === 'Box' || card.location_type === 'Toploader Box' || card.location_type === 'Graded Slab Box' || card.location_type === 'Display Shelf / Stand') {
        if (pageNum > 0 && slotNum > 0) {
          index = (pageNum - 1) * 40 + (slotNum - 1);
        }
      } else {
        index = slotNum - 1;
      }
      if (index < 0) index = 0;
      const position = index * 1000;
      await run(`UPDATE collection SET position = ? WHERE id = ?`, [position, card.id]);
    }
    console.log('Migration of coordinates to position indices completed.');
  }

  // 3. Remove UNIQUE constraint on locations name per user (optional, but let's make sure it's not unique across users)
  // SQLite doesn't easily support dropping constraints, but we can manage name checking in routes.

  // 4. Add tcg_api_key column to users table if missing
  const usersCols = await all(`PRAGMA table_info(users)`);
  if (!usersCols.some(c => c.name === 'tcg_api_key')) {
    console.log('Adding tcg_api_key column to users table...');
    await run(`ALTER TABLE users ADD COLUMN tcg_api_key TEXT DEFAULT ''`);
  }

  // 5. Add price_normal, price_holofoil, price_reverse_holofoil columns to card_cache table if missing
  const cardCacheCols = await all(`PRAGMA table_info(card_cache)`);
  if (!cardCacheCols.some(c => c.name === 'price_normal')) {
    console.log('Adding price_normal column to card_cache table...');
    await run(`ALTER TABLE card_cache ADD COLUMN price_normal REAL`);
  }
  if (!cardCacheCols.some(c => c.name === 'price_holofoil')) {
    console.log('Adding price_holofoil column to card_cache table...');
    await run(`ALTER TABLE card_cache ADD COLUMN price_holofoil REAL`);
  }
  if (!cardCacheCols.some(c => c.name === 'price_reverse_holofoil')) {
    console.log('Adding price_reverse_holofoil column to card_cache table...');
    await run(`ALTER TABLE card_cache ADD COLUMN price_reverse_holofoil REAL`);
  }

  // 6. Add checked_out columns to decks table if missing
  const decksCols = await all(`PRAGMA table_info(decks)`);
  if (!decksCols.some(c => c.name === 'checked_out')) {
    console.log('Adding checked_out column to decks table...');
    await run(`ALTER TABLE decks ADD COLUMN checked_out INTEGER DEFAULT 0`);
  }
  if (!decksCols.some(c => c.name === 'checked_out_at')) {
    console.log('Adding checked_out_at column to decks table...');
    await run(`ALTER TABLE decks ADD COLUMN checked_out_at DATETIME`);
  }

  // --- SEED DATA & MIGRATION TO DEFAULT ADMIN ---
  const userCount = await get(`SELECT COUNT(*) as count FROM users`);
  let adminId = null;
  if (userCount.count === 0) {
    const generatedPassword = process.env.DEFAULT_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const defaultPassHash = hashPassword(generatedPassword);
    const defaultShareToken = crypto.randomBytes(16).toString('hex');
    const result = await run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, ['admin', defaultPassHash, 'admin', defaultShareToken, 0]);
    adminId = result.lastID;
    console.log('=========================================');
    console.log(`Created default admin user. ID: ${adminId}`);
    console.log(`  username: admin`);
    console.log(`  password: ${generatedPassword}`);
    console.log('Log in and change this password immediately via Settings.');
    console.log('=========================================');
  } else {
    const adminUser = await get(`SELECT id FROM users WHERE username = ?`, ['admin']);
    if (adminUser) {
      adminId = adminUser.id;
    }
  }

  // Assign existing orphan rows (with NULL user_id) to default admin
  if (adminId) {
    const collectionMigrated = await run(`UPDATE collection SET user_id = ? WHERE user_id IS NULL`, [adminId]);
    const locationsMigrated = await run(`UPDATE locations SET user_id = ? WHERE user_id IS NULL`, [adminId]);
    if (collectionMigrated.changes > 0 || locationsMigrated.changes > 0) {
      console.log(`Migrated ${collectionMigrated.changes} collection items and ${locationsMigrated.changes} locations to admin user.`);
    }
  }

  // Insert default locations if locations table is empty
  const locCount = await get(`SELECT COUNT(*) as count FROM locations`);
  if (locCount.count === 0 && adminId) {
    console.log('Populating default locations for admin user...');
    await run(`INSERT INTO locations (name, type, description, user_id) VALUES (?, ?, ?, ?)`, [
      'Main Binder', 'Binder', 'For ultra rares, holos and favorites.', adminId
    ]);
    await run(`INSERT INTO locations (name, type, description, user_id) VALUES (?, ?, ?, ?)`, [
      'Bulk Storage Box 1', 'Box', 'Standard cardboard row box for bulk/common cards.', adminId
    ]);
    await run(`INSERT INTO locations (name, type, description, user_id) VALUES (?, ?, ?, ?)`, [
      'Unsorted Pile', 'Other', 'Temporary staging area for newly scanned cards.', adminId
    ]);
  }
}

module.exports = {
  dbConnection,
  run,
  get,
  all,
  initDb,
  hashPassword // Export for server.js usage
};

