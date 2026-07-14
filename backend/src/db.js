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
    dbConnection.run('PRAGMA foreign_keys = ON');
    dbConnection.run('PRAGMA journal_mode = WAL');
    dbConnection.run('PRAGMA busy_timeout = 5000');
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

async function withTransaction(dbOrFn, asyncFn) {
  const fn = typeof dbOrFn === 'function' ? dbOrFn : asyncFn;
  const tx = { run, get, all, withTransaction };
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await fn(tx);
    await run('COMMIT');
    return result;
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
}

const PBKDF2_ITERATIONS = 210000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

// Initialize tables
async function initDb() {
  const existingCollectionCols = await all(`PRAGMA table_info(collection)`).catch(() => []);
  if (existingCollectionCols.some(c => c.name === 'sub_location_1')) {
    console.log('Resetting locations/collection tables for the new compartment-based storage schema...');
    await run(`PRAGMA foreign_keys = OFF`);
    await run(`DROP TABLE IF EXISTS collection`);
    await run(`DROP TABLE IF EXISTS locations`);
    await run(`PRAGMA foreign_keys = ON`);
  }

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

  await run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_base_url TEXT DEFAULT ''
    )
  `);
  await run(`INSERT OR IGNORE INTO app_settings (id, public_base_url) VALUES (1, '')`);

  await run(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT CHECK(type IN ('Binder', 'Toploader Binder', 'Box', 'Toploader Box', 'Graded Slab Box', 'Display Shelf / Stand', 'Deck Box', 'Tin / Case', 'Other')) NOT NULL,
      sort_order TEXT DEFAULT '[{"by":"name","dir":"asc"}]',
      foil_sorting TEXT DEFAULT 'normals_first',
      rule_type TEXT DEFAULT 'any',
      rule_config TEXT,
      game TEXT DEFAULT 'any',
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      label TEXT,
      capacity INTEGER NOT NULL DEFAULT 40,
      rule_config TEXT,
      UNIQUE(location_id, idx)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS compartment_assignments (
      compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
      filter_value TEXT NOT NULL,
      PRIMARY KEY(compartment_id, filter_value)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      series TEXT,
      printed_total INTEGER,
      total INTEGER,
      release_date TEXT,
      ptcgo_code TEXT,
      symbol_url TEXT,
      logo_url TEXT,
      game TEXT DEFAULT 'pokemon'
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS card_cache (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      supertype TEXT,
      subtypes TEXT,
      types TEXT,
      rarity TEXT,
      set_id TEXT,
      set_name TEXT,
      number TEXT,
      image_url TEXT,
      price_trend REAL,
      price_normal REAL,
      price_holofoil REAL,
      price_reverse_holofoil REAL,
      price_avg1 REAL,
      price_avg7 REAL,
      price_avg30 REAL,
      cmc REAL,
      color_identity TEXT,
      game TEXT DEFAULT 'pokemon',
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
      compartment_id INTEGER,
      position REAL DEFAULT 0,
      favorite INTEGER DEFAULT 0,
      is_trade INTEGER DEFAULT 0,
      list_type TEXT DEFAULT 'collection',
      game TEXT DEFAULT 'pokemon',
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE SET NULL,
      FOREIGN KEY(compartment_id) REFERENCES compartments(id) ON DELETE SET NULL,
      FOREIGN KEY(card_id) REFERENCES card_cache(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#3B82F6',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, name)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS collection_tags (
      collection_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (collection_id, tag_id),
      FOREIGN KEY (collection_id) REFERENCES collection(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      before_state TEXT,
      after_state TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS saved_filter_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      filter_config TEXT NOT NULL,
      sort_config TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, name)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS price_history (
      card_id TEXT NOT NULL,
      price REAL NOT NULL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(card_id, recorded_at)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      checked_out INTEGER DEFAULT 0,
      checked_out_at DATETIME,
      game TEXT DEFAULT 'pokemon',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS deck_cards (
      deck_id INTEGER NOT NULL,
      card_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      checked_out INTEGER DEFAULT 0,
      PRIMARY KEY(deck_id, card_id),
      FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
    )
  `);

  // --- MIGRATIONS ---
  const collectionCols = await all(`PRAGMA table_info(collection)`);
  if (!collectionCols.some(c => c.name === 'user_id')) {
    await run(`ALTER TABLE collection ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
  }
  if (!collectionCols.some(c => c.name === 'is_trade')) {
    await run(`ALTER TABLE collection ADD COLUMN is_trade INTEGER DEFAULT 0`);
  }
  if (!collectionCols.some(c => c.name === 'favorite')) {
    await run(`ALTER TABLE collection ADD COLUMN favorite INTEGER DEFAULT 0`);
  }
  if (!collectionCols.some(c => c.name === 'list_type')) {
    await run(`ALTER TABLE collection ADD COLUMN list_type TEXT DEFAULT 'collection'`);
  }
  if (!collectionCols.some(c => c.name === 'compartment_id')) {
    await run(`ALTER TABLE collection ADD COLUMN compartment_id INTEGER REFERENCES compartments(id) ON DELETE SET NULL`);
  }
  if (!collectionCols.some(c => c.name === 'position')) {
    await run(`ALTER TABLE collection ADD COLUMN position REAL DEFAULT 0`);
  }
  if (!collectionCols.some(c => c.name === 'game')) {
    await run(`ALTER TABLE collection ADD COLUMN game TEXT DEFAULT 'pokemon'`);
  }

  const locationsCols = await all(`PRAGMA table_info(locations)`);
  if (!locationsCols.some(c => c.name === 'user_id')) {
    await run(`ALTER TABLE locations ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
  }
  if (!locationsCols.some(c => c.name === 'sort_order')) {
    await run(`ALTER TABLE locations ADD COLUMN sort_order TEXT DEFAULT '[{"by":"name","dir":"asc"}]'`);
  }
  if (!locationsCols.some(c => c.name === 'foil_sorting')) {
    await run(`ALTER TABLE locations ADD COLUMN foil_sorting TEXT DEFAULT 'normals_first'`);
  }
  if (!locationsCols.some(c => c.name === 'game')) {
    await run(`ALTER TABLE locations ADD COLUMN game TEXT DEFAULT 'any'`);
  }

  const usersCols = await all(`PRAGMA table_info(users)`);
  if (!usersCols.some(c => c.name === 'tcg_api_key')) {
    await run(`ALTER TABLE users ADD COLUMN tcg_api_key TEXT DEFAULT ''`);
  }

  const deckCardsCols = await all(`PRAGMA table_info(deck_cards)`);
  if (!deckCardsCols.some(c => c.name === 'checked_out')) {
    await run(`ALTER TABLE deck_cards ADD COLUMN checked_out INTEGER DEFAULT 0`);
  }

  // Lock flags: a locked compartment/location is skipped by auto-filing
  // (recommendSlot) so it never receives new cards; existing cards stay put and
  // manual moves still work.
  const compartmentsCols = await all(`PRAGMA table_info(compartments)`);
  if (!compartmentsCols.some(c => c.name === 'locked')) {
    await run(`ALTER TABLE compartments ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`);
  }
  const locationsLockCols = await all(`PRAGMA table_info(locations)`);
  if (!locationsLockCols.some(c => c.name === 'locked')) {
    await run(`ALTER TABLE locations ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`);
  }

  // --- PERFORMANCE INDEXES ---
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_comp_user_qty ON collection(compartment_id, user_id, quantity)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_loc_pos ON collection(location_id, position)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_card_cache_set_num ON card_cache(set_id, number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_deck_cards_checkout ON deck_cards(deck_id, checked_out)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_tags_tag_id ON collection_tags(tag_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_date ON audit_logs(user_id, created_at DESC)`);

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

  if (adminId) {
    await run(`UPDATE collection SET user_id = ? WHERE user_id IS NULL`, [adminId]);
    await run(`UPDATE locations SET user_id = ? WHERE user_id IS NULL`, [adminId]);
  }

  const locCount = await get(`SELECT COUNT(*) as count FROM locations`);
  if (locCount.count === 0 && adminId) {
    console.log('Populating default locations for admin user...');
    const binder = await run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [
      'Main Binder', 'Binder', adminId
    ]);
    await createCompartments(binder.lastID, 10, 9);

    const box = await run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [
      'Bulk Storage Box 1', 'Box', adminId
    ]);
    await createCompartments(box.lastID, 2, 100);
  }
}

async function createCompartments(locationId, count, capacity) {
  for (let i = 1; i <= count; i++) {
    await run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [locationId, i, capacity]);
  }
}

module.exports = {
  dbConnection,
  run,
  get,
  all,
  withTransaction,
  initDb,
  createCompartments,
  hashPassword
};
