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
    // Default rollback-journal mode locks the whole file per writer and fails
    // instantly (SQLITE_BUSY) on any concurrent write instead of waiting. This
    // app has frequent background writers (price history recording, the
    // startup/weekly price updater, session purging) that otherwise collide
    // with user-triggered writes like adding a card or seeding test data.
    // WAL lets readers and writers coexist; busy_timeout makes writers retry
    // for a few seconds instead of failing immediately.
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

// Password hashing utility. The iteration count is stored alongside the hash
// (rather than hardcoded at verify-time) so it can be raised in the future
// without invalidating passwords hashed under a lower count.
const PBKDF2_ITERATIONS = 210000;
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

// Initialize tables
async function initDb() {
  // One-time reset for the storage-system redesign: sub_location_1/2 strings
  // and location-wide shape columns (max_rows, page_style, etc.) are being
  // replaced by real compartments + compartment_set_assignments tables. No
  // real user collections exist on this schema version yet (dev/seed data
  // only), so this drops and lets the statements below recreate clean rather
  // than carrying forward a second, parallel migration path.
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

  // Single-row instance-wide settings (currently just the public base URL
  // used for collection share links behind a reverse proxy). id is pinned
  // to 1 since there's only ever one row.
  await run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_base_url TEXT DEFAULT ''
    )
  `);
  await run(`INSERT OR IGNORE INTO app_settings (id, public_base_url) VALUES (1, '')`);

  // Create locations table. Physical shape (how many pages/rows, their
  // capacity, which sets they hold) lives entirely in the compartments table
  // below — a location is just an identity + a sort scheme, not a shape.
  await run(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT CHECK(type IN ('Binder', 'Toploader Binder', 'Box', 'Toploader Box', 'Graded Slab Box', 'Display Shelf / Stand', 'Deck Box', 'Tin / Case', 'Other')) NOT NULL,
      sort_order TEXT DEFAULT '[{"by":"name","dir":"asc"}]',
      foil_sorting TEXT DEFAULT 'normals_first',
      rule_type TEXT DEFAULT 'any',
      rule_config TEXT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // A compartment is one physical unit a card can be placed in: a binder page,
  // a box row, or (for single-compartment containers like a Deck Box) the
  // container's whole interior. Real capacity and set assignment live here
  // instead of being inferred from location-wide columns or parsed out of a
  // free-text sub_location string.
  await run(`
    CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      label TEXT,
      capacity INTEGER NOT NULL DEFAULT 40,
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

  // Create sets table
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
      logo_url TEXT
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
      cmc REAL,
      color_identity TEXT, -- Store JSON string
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
      compartment_id INTEGER,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE SET NULL,
      FOREIGN KEY(compartment_id) REFERENCES compartments(id) ON DELETE SET NULL,
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

  // Add favorite (starred) flag to collection table if missing. Per-copy
  // boolean like is_trade; used as a sort key (favorites to front) and a view
  // filter.
  if (!collectionCols.some(c => c.name === 'favorite')) {
    console.log('Adding favorite column to collection table...');
    await run(`ALTER TABLE collection ADD COLUMN favorite INTEGER DEFAULT 0`);
  }

  // Add list_type to collection table if missing
  if (!collectionCols.some(c => c.name === 'list_type')) {
    console.log('Adding list_type column to collection table...');
    await run(`ALTER TABLE collection ADD COLUMN list_type TEXT DEFAULT 'collection'`);
  }

  // Add game to collection table if missing (multi-game support: 'pokemon' | 'mtg')
  if (!collectionCols.some(c => c.name === 'game')) {
    console.log('Adding game column to collection table...');
    await run(`ALTER TABLE collection ADD COLUMN game TEXT DEFAULT 'pokemon'`);
  }

  // 2. Add user_id to locations table if missing
  const locationsCols = await all(`PRAGMA table_info(locations)`);
  if (!locationsCols.some(c => c.name === 'user_id')) {
    console.log('Adding user_id column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
  }
  if (!locationsCols.some(c => c.name === 'sort_order')) {
    console.log('Adding sort_order column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN sort_order TEXT DEFAULT '[{"by":"name","dir":"asc"}]'`);
  }
  if (!locationsCols.some(c => c.name === 'foil_sorting')) {
    console.log('Adding foil_sorting column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN foil_sorting TEXT DEFAULT 'normals_first'`);
  }
  if (!locationsCols.some(c => c.name === 'rule_type')) {
    console.log('Adding rule_type column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN rule_type TEXT DEFAULT 'any'`);
  }
  if (!locationsCols.some(c => c.name === 'rule_config')) {
    console.log('Adding rule_config column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN rule_config TEXT`);
  }
  // Restrict a container to one game's cards. 'any' accepts both; 'pokemon' /
  // 'mtg' reject the other game during filing (keeps mixed collections apart).
  if (!locationsCols.some(c => c.name === 'game')) {
    console.log('Adding game column to locations table...');
    await run(`ALTER TABLE locations ADD COLUMN game TEXT DEFAULT 'any'`);
  }

  // Add position column to collection table if missing (ordering within a
  // compartment — fractional so inserts between two cards don't need to
  // renumber everything, see rebalanceCompartmentPositions).
  if (!collectionCols.some(c => c.name === 'position')) {
    console.log('Adding position column to collection table...');
    await run(`ALTER TABLE collection ADD COLUMN position REAL DEFAULT 0`);
  }
  if (!collectionCols.some(c => c.name === 'compartment_id')) {
    console.log('Adding compartment_id column to collection table...');
    await run(`ALTER TABLE collection ADD COLUMN compartment_id INTEGER REFERENCES compartments(id) ON DELETE SET NULL`);
  }

  // Per-compartment filing rules (same compound {rules:[...]} shape as
  // locations.rule_config). Lets a single row/page accept only cards matching
  // its own include/exclude rules, independent of the container-level rule.
  const compartmentsCols = await all(`PRAGMA table_info(compartments)`);
  if (!compartmentsCols.some(c => c.name === 'rule_config')) {
    console.log('Adding rule_config column to compartments table...');
    await run(`ALTER TABLE compartments ADD COLUMN rule_config TEXT`);
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
  // Cardmarket's real 1-day/7-day/30-day rolling averages — the only genuine
  // historical price data the API exposes (nothing older is available from
  // any source). avg1 is kept alongside avg7/avg30 so "now vs. then" trend
  // comparisons stay within the same marketplace instead of comparing
  // against price_trend, which prioritizes TCGPlayer — a different
  // marketplace with a structurally different price than Cardmarket's.
  if (!cardCacheCols.some(c => c.name === 'price_avg1')) {
    console.log('Adding price_avg1 column to card_cache table...');
    await run(`ALTER TABLE card_cache ADD COLUMN price_avg1 REAL`);
  }
  if (!cardCacheCols.some(c => c.name === 'price_avg7')) {
    console.log('Adding price_avg7 column to card_cache table...');
    await run(`ALTER TABLE card_cache ADD COLUMN price_avg7 REAL`);
  }
  if (!cardCacheCols.some(c => c.name === 'price_avg30')) {
    console.log('Adding price_avg30 column to card_cache table...');
    await run(`ALTER TABLE card_cache ADD COLUMN price_avg30 REAL`);
  }
  // Game tag so a single card_cache holds both Pokémon (tcgApi) and MTG
  // (scryfallApi) cards. Search filters on it; collections derive their game
  // from the cached card. Existing rows default to 'pokemon'.
  if (!cardCacheCols.some(c => c.name === 'game')) {
    console.log('Adding game column to card_cache table...');
    await run(`ALTER TABLE card_cache ADD COLUMN game TEXT DEFAULT 'pokemon'`);
  }

  // Support MTG-specific sorting and filtering
  if (!cardCacheCols.some(c => c.name === 'cmc')) {
    console.log('Adding cmc column to card_cache table...');
    await run(`ALTER TABLE card_cache ADD COLUMN cmc REAL`);
  }
  if (!cardCacheCols.some(c => c.name === 'color_identity')) {
    console.log('Adding color_identity column to card_cache table...');
    await run(`ALTER TABLE card_cache ADD COLUMN color_identity TEXT`);
  }

  // Game tag on cached sets so Pokémon (pokemontcg.io) and MTG (Scryfall) sets
  // coexist; drives chronological set sorting and the rule-builder set picker.
  const setsCols = await all(`PRAGMA table_info(sets)`);
  if (!setsCols.some(c => c.name === 'game')) {
    console.log('Adding game column to sets table...');
    await run(`ALTER TABLE sets ADD COLUMN game TEXT DEFAULT 'pokemon'`);
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
  // Which game a deck is for; drives the deck's card-search default. Existing
  // decks default to pokemon.
  if (!decksCols.some(c => c.name === 'game')) {
    console.log('Adding game column to decks table...');
    await run(`ALTER TABLE decks ADD COLUMN game TEXT DEFAULT 'pokemon'`);
  }

  // 7. One-time repair: the dev-only admin seed route used to build image_url
  // with a typo'd "_hier.png" suffix instead of the real pokemontcg.io CDN
  // path ("<number>.png"), so every seeded card showed a broken image. Fix
  // any rows still carrying that bad suffix; they'll re-fetch correctly from
  // the API on next lookup if the fix below doesn't already cover it.
  const brokenSeedImages = await run(`UPDATE card_cache SET image_url = REPLACE(image_url, '_hier.png', '.png') WHERE image_url LIKE '%_hier.png'`);
  if (brokenSeedImages.changes > 0) {
    console.log(`Repaired ${brokenSeedImages.changes} card_cache row(s) with broken seed image URLs.`);
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
    const binder = await run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [
      'Main Binder', 'Binder', adminId
    ]);
    await createCompartments(binder.lastID, 10, 9); // 10 pages, 9 pockets each (3x3)

    const box = await run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [
      'Bulk Storage Box 1', 'Box', adminId
    ]);
    await createCompartments(box.lastID, 2, 100); // 2 rows, 100 cards each
  }
}

// Bulk-creates N compartments for a location (e.g. binder pages or box rows),
// each with the given capacity. Used at location creation and here for
// default seed data — the single place compartment numbering/labels default
// from, so a page/row's implicit label ("Page 3", "Row 2") always agrees
// between however the location was created.
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
  initDb,
  createCompartments,
  hashPassword // Export for server.js usage
};

