const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// The app began life as "PokeKeep", a Pokémon-only tracker, so its database was
// called pokemon_cards.db. It has handled Magic since v1.4.x, and the file name
// is the last thing still carrying the old name.
const DB_FILENAME = 'bindarr.db';
const LEGACY_DB_FILENAME = 'pokemon_cards.db';

// Rename an existing pokemon_cards.db to the new name, WAL sidecars included.
// Getting this wrong loses collections: point SQLite at a name that isn't there
// and it cheerfully creates an empty database, which looks exactly like the app
// wiping everything. So: never overwrite, move the -wal/-shm files with the
// main one (un-checkpointed transactions live in the WAL), and on any failure
// keep using the old file rather than silently starting fresh.
// Returns the path that should actually be opened.
function resolveDbPath(target) {
  // Only ever migrate INTO the canonical name. A custom DB_PATH is the
  // operator's decision and must not attract someone else's old file.
  if (path.basename(target) !== DB_FILENAME) return target;

  const legacy = path.join(path.dirname(target), LEGACY_DB_FILENAME);
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return target;

  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(legacy + suffix)) fs.renameSync(legacy + suffix, target + suffix);
    }
    console.log(`Renamed legacy database ${LEGACY_DB_FILENAME} -> ${DB_FILENAME}.`);
    return target;
  } catch (err) {
    console.error(
      `Could not rename ${LEGACY_DB_FILENAME} to ${DB_FILENAME} (${err.message}). ` +
      `Continuing with ${LEGACY_DB_FILENAME} — your data is safe, but please rename it manually.`
    );
    return legacy;
  }
}

// Ensure database directory exists
const requestedDbPath = process.env.DB_PATH || path.join(__dirname, `../database/${DB_FILENAME}`);
const dbDir = path.dirname(requestedDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = resolveDbPath(requestedDbPath);

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

// Run fn inside BEGIN IMMEDIATE / COMMIT, rolling back if it throws.
//
// fn takes no argument on purpose. It used to be handed a `tx` object, but that
// object was `{ run, get, all, withTransaction }` — the module's own exports under
// a different name. Callers gained nothing from it, and it read as statement-level
// isolation this does not provide: there is ONE sqlite3 connection here, so every
// query in the process is already inside whatever transaction is open. Use `db`
// directly and the scope is honest.
async function withTransaction(fn) {
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await fn();
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
      price_1st_edition REAL,
      price_currency TEXT DEFAULT 'USD',
      price_source TEXT,
      cmc REAL,
      color_identity TEXT,
      game TEXT DEFAULT 'pokemon',
      language TEXT DEFAULT 'English',
      printed_name TEXT,
      tcgplayer_product_id INTEGER,
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
    CREATE TABLE IF NOT EXISTS price_history (
      card_id TEXT NOT NULL,
      price REAL NOT NULL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(card_id, recorded_at)
    )
  `);

  // card_cache id -> TCGplayer productId, for the Pokémon rows whose providers do
  // not carry one (TCGdex supplies none at all; Scryfall gives MTG its id directly,
  // so MTG never needs a row here).
  //
  // Its own table rather than a card_cache column because the mapping is derived,
  // not provider data: it is rebuilt by matching set+number against TCGplayer's
  // catalogue, and `confidence` records how — 1 for an exact set match, 0.8 for one
  // recovered from a name suffix. Keeping it separate means a rebuild can be
  // discarded and redone without touching a single real card row.
  await run(`
    CREATE TABLE IF NOT EXISTS tcgplayer_product (
      card_id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      confidence REAL DEFAULT 1,
      matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(card_id) REFERENCES card_cache(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_tcgplayer_product_pid ON tcgplayer_product(product_id)`);

  // TCGplayer's own product catalogue, keyed the way the READY-MADE Pokémon scan
  // catalog is keyed: by product id.
  //
  // tcgplayer_product above is the other direction — cards this install holds, for
  // which a product was found — so it can only ever answer for cards already
  // downloaded and priced. The published scan catalog needs the reverse: given a
  // product id the model matched, what card is that? Without this table the answer
  // was nothing at all, and every scan against the ready-made Pokémon catalog
  // matched and then named no card (see routes/collection.js scan-match).
  //
  // Cards only: a product with no collector number is sealed product, and no
  // photograph of a card will ever be one.
  await run(`
    CREATE TABLE IF NOT EXISTS tcgplayer_catalog (
      product_id INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      group_name TEXT,
      set_id TEXT,
      name TEXT,
      number TEXT,
      built_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Sets the provider LISTS but has no usable card data for — no cards at all, or
  // cards with no artwork, which a scan catalog cannot use either way.
  //
  // Recorded so "N sets have no cards here yet" stops counting them. Measured on a
  // real install: all 46 uncached English Pokemon sets were of this kind (promos,
  // samples, jumbo cards, trainer kits), so the panel told the user to build sets
  // that can never be built, and the weekly auto-update chased a number that could
  // never drop. A build fills this in as it walks; a set whose data appears later
  // clears its own row.
  await run(`
    CREATE TABLE IF NOT EXISTS set_data_gaps (
      game TEXT NOT NULL,
      language TEXT NOT NULL,
      set_id TEXT NOT NULL,
      reason TEXT,
      seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (game, language, set_id)
    )
  `);

  // Cached PSA cert lookups. Cached forever, with no staleness check anywhere —
  // deliberate, and the only table in this schema like that: a cert describes a
  // slab that was sealed once and graded once. The grade cannot change, so a
  // second request can only return the same answer while spending quota from a
  // rate-limited token.
  //
  // `payload` is the provider response as received, not a parsed subset. The
  // fields worth reading are still being learned, and re-deriving them from a
  // stored response beats re-fetching 400 certs to pick up one more column.
  await run(`
    CREATE TABLE IF NOT EXISTS psa_cert (
      cert_number TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  await run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      body TEXT DEFAULT '',
      pinned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // --- MIGRATIONS ---
  // When each game's price sweep last ran. Scryfall updates prices once a day,
  // so a sweep more often than that cannot return anything new — and the boot
  // sweep would otherwise re-run on every restart (constantly, under nodemon).
  // Persisted rather than in-memory precisely because restarts are the problem.
  const appSettingsCols = await all(`PRAGMA table_info(app_settings)`);
  if (!appSettingsCols.some(c => c.name === 'mtg_prices_swept_at')) {
    await run(`ALTER TABLE app_settings ADD COLUMN mtg_prices_swept_at DATETIME`);
  }
  if (!appSettingsCols.some(c => c.name === 'pokemon_prices_swept_at')) {
    await run(`ALTER TABLE app_settings ADD COLUMN pokemon_prices_swept_at DATETIME`);
  }
  if (!appSettingsCols.some(c => c.name === 'tcgdex_prices_swept_at')) {
    await run(`ALTER TABLE app_settings ADD COLUMN tcgdex_prices_swept_at DATETIME`);
  }
  // TCGCSV mirrors TCGplayer once a day, so its gate is the same 24h as the rest.
  if (!appSettingsCols.some(c => c.name === 'tcgcsv_prices_swept_at')) {
    await run(`ALTER TABLE app_settings ADD COLUMN tcgcsv_prices_swept_at DATETIME`);
  }

  // VESTIGIAL. This gated non-admin members building an individual per-set ORB
  // index, and there are no per-set indexes any more — scanning is CollectorVision
  // embeddings over a catalog, and catalog builds are admin-only (they walk a whole
  // provider and hammer its rate limits). Nothing reads the column; the migration
  // stays so an existing database still matches the schema this code expects, and
  // dropping it would mean a table rebuild for no gain.
  if (!appSettingsCols.some(c => c.name === 'allow_member_set_builds')) {
    await run(`ALTER TABLE app_settings ADD COLUMN allow_member_set_builds INTEGER NOT NULL DEFAULT 0`);
  }
  // Which API English Pokémon cards and sets come from.
  //
  // TCGdex for a NEW install: 218 English sets against pokemontcg.io's 174, every
  // other language in the same place, no API key, and measured 57-206 ms per card
  // lookup against 971-1963 ms (pokemontcg.io also answers 5xx often enough to need
  // a retry policy — see tcgApi's interceptor).
  //
  // pokemontcg.io for an install that ALREADY HAS DATA, and this half is the point
  // of the WHERE clause. The two providers number the same sets differently — sv1
  // vs sv01, pgo vs swsh10.5, me1 vs me01 — and every cached card, every scan
  // catalog and every collection row was built against one of those numberings.
  // Flipping an existing install underneath its own data is how the set list ends
  // up describing sets none of its cards belong to. An upgrade keeps what it was
  // built with; the admin can switch deliberately in Admin → Instance Settings,
  // which re-syncs the set table and rebuilds the product map behind it.
  //
  // "Already has data" is read off the Pokémon set catalogue and card cache, not
  // off `users`: this migration runs before the startup set sync, so a brand new
  // database genuinely has neither, while any install that has ever run has both.
  // Same shape as the setup_complete migration below.
  if (!appSettingsCols.some(c => c.name === 'pokemon_provider')) {
    await run(`ALTER TABLE app_settings ADD COLUMN pokemon_provider TEXT DEFAULT 'tcgdex'`);
    await run(`
      UPDATE app_settings SET pokemon_provider = 'pokemontcg'
       WHERE (SELECT COUNT(*) FROM sets WHERE game = 'pokemon') > 0
          OR (SELECT COUNT(*) FROM card_cache WHERE game = 'pokemon') > 0
    `);
  }
  if (!appSettingsCols.some(c => c.name === 'scan_exclude_tokens')) {
    await run(`ALTER TABLE app_settings ADD COLUMN scan_exclude_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!appSettingsCols.some(c => c.name === 'scan_exclude_art_cards')) {
    await run(`ALTER TABLE app_settings ADD COLUMN scan_exclude_art_cards INTEGER NOT NULL DEFAULT 0`);
  }
  if (!appSettingsCols.some(c => c.name === 'scan_exclude_jumpstart')) {
    await run(`ALTER TABLE app_settings ADD COLUMN scan_exclude_jumpstart INTEGER NOT NULL DEFAULT 0`);
  }
  if (!appSettingsCols.some(c => c.name === 'scan_exclude_promos')) {
    await run(`ALTER TABLE app_settings ADD COLUMN scan_exclude_promos INTEGER NOT NULL DEFAULT 0`);
  }
  // The one scan exclusion that defaults ON, and the only one that is not a
  // matter of taste: Pokémon TCG Pocket cards exist solely in the phone game, so
  // no camera will ever be pointed at one. Indexing them costs a linear pass over
  // 2,321 extra vectors on every unscoped scan and — because Pocket art is
  // largely redrawn from paper cards — invites confident matches naming a set the
  // user cannot own. MTG has always excluded digital sets (cardSets.listAllSets
  // filters Scryfall's `digital` flag); this is the Pokémon half of that rule
  // finally catching up, which is why existing installs get it applied on
  // migration rather than grandfathered off.
  if (!appSettingsCols.some(c => c.name === 'scan_exclude_digital')) {
    await run(`ALTER TABLE app_settings ADD COLUMN scan_exclude_digital INTEGER NOT NULL DEFAULT 1`);
  }

  // Whether the first-run wizard has been seen through to the end. Server-side,
  // not localStorage, so the wizard follows the install rather than the browser:
  // an admin who starts setup on a laptop finishes it on a phone. Every install
  // starts at 0, upgrades included: the wizard is where catalogs, games and the
  // provider keys are explained, and an install that predates it has never been
  // offered that tour. It is one screen with a "Skip setup" button that marks it
  // done for good, so the cost to someone who wants nothing from it is one click.
  if (!appSettingsCols.some(c => c.name === 'setup_complete')) {
    await run(`ALTER TABLE app_settings ADD COLUMN setup_complete INTEGER NOT NULL DEFAULT 0`);
  }

  // A non-English printing is its own card, not a display variant of the English
  // one: it has its own provider id, its own art and its own name. `language`
  // records which printing a cached row IS (collection.language still records
  // what the user OWNS), and `printed_name` holds the localized name — `name`
  // stays English so search, deck lists and marketplace links keep working.
  const cardCacheCols = await all(`PRAGMA table_info(card_cache)`);
  if (!cardCacheCols.some(c => c.name === 'language')) {
    await run(`ALTER TABLE card_cache ADD COLUMN language TEXT DEFAULT 'English'`);
  }
  if (!cardCacheCols.some(c => c.name === 'printed_name')) {
    await run(`ALTER TABLE card_cache ADD COLUMN printed_name TEXT`);
  }
  // Marketplace links as the PROVIDER gives them. Building them from name+set+number
  // only works for English cards: searching TCGplayer for "ヒトカゲ ポケモンカード151"
  // returns nothing, because those sites index English names. Scryfall and
  // pokemontcg.io both hand us a real product/search URL per card, so store it.
  for (const col of ['tcgplayer_url', 'cardmarket_url']) {
    if (!cardCacheCols.some(c => c.name === col)) {
      await run(`ALTER TABLE card_cache ADD COLUMN ${col} TEXT`);
    }
  }
  // TCGplayer's own product id, which is what turns a link into the actual card.
  // The stored `tcgplayer_url` above is NOT reliably a product page: Scryfall
  // hands back a name search whenever it has no product for a printing (6,109 of
  // 106,163 cached MTG rows), and TCGdex supplies no TCGplayer link at all. An id
  // is unambiguous — /product/<id> either resolves or the card is not listed.
  //
  // Provider-agnostic on purpose: Scryfall publishes it as `tcgplayer_id`, and
  // the Pokémon rows get theirs from the TCGCSV catalogue mapping.
  // collection.printing has allowed '1st Edition' since v1.0, and resolveCardPrice
  // had no column to read for it — so a 1st Edition Base Set card was valued at the
  // Unlimited price, which for a Charizard is a difference of thousands. TCGplayer
  // prices the two separately and always has; this is where that number lands.
  if (!cardCacheCols.some(c => c.name === 'price_1st_edition')) {
    await run(`ALTER TABLE card_cache ADD COLUMN price_1st_edition REAL`);
  }

  // Which marketplace a row's prices came from, and in what currency.
  //
  // The price columns have always been unit-less, and until now they mixed
  // TCGplayer USD (English) with Cardmarket EUR (everything TCGdex served) while
  // the UI rendered one '$' over both. Recording the source per row is what lets
  // the inspector say which number it is showing, instead of inferring it from
  // whether a Cardmarket URL happens to exist.
  if (!cardCacheCols.some(c => c.name === 'price_currency')) {
    await run(`ALTER TABLE card_cache ADD COLUMN price_currency TEXT DEFAULT 'USD'`);
  }
  if (!cardCacheCols.some(c => c.name === 'price_source')) {
    await run(`ALTER TABLE card_cache ADD COLUMN price_source TEXT`);
    // Backfill from what each row's id already tells us: TCGdex is the only source
    // that ever wrote EUR, and its ids are prefixed. No network needed.
    await run(`UPDATE card_cache SET price_source = 'scryfall', price_currency = 'USD' WHERE id LIKE 'mtg-%'`);
    await run(`UPDATE card_cache SET price_source = 'tcgdex', price_currency = 'EUR' WHERE id LIKE 'tcgdex-%'`);
    await run(`UPDATE card_cache SET price_source = 'pokemontcg', price_currency = 'USD' WHERE price_source IS NULL AND game = 'pokemon'`);
  }
  if (!cardCacheCols.some(c => c.name === 'tcgplayer_product_id')) {
    await run(`ALTER TABLE card_cache ADD COLUMN tcgplayer_product_id INTEGER`);
    // Backfill from the URLs already cached, rather than re-fetching 100k+ rows
    // from Scryfall to learn something we are already holding: a product-page URL
    // literally contains the id. Runs once, inside the column-added branch, so a
    // reboot does not re-scan the table.
    //
    // Two encodings, because Scryfall wraps its link in an affiliate redirect that
    // percent-encodes the inner URL ('%2Fproduct%2F') while a plain product URL
    // does not ('/product/'). The SEARCH form is '%2Fproduct%3F' — a different
    // string, so it cannot match either pattern and correctly stays NULL.
    //
    // CAST stops at the first non-digit, which is how the trailing '%3Fpage%3D1'
    // is discarded; the > 0 guard drops anything that produced no digits at all.
    for (const [needle, skip] of [['%2Fproduct%2F', 13], ['/product/', 9]]) {
      await run(
        `UPDATE card_cache
            SET tcgplayer_product_id = CAST(substr(tcgplayer_url, instr(tcgplayer_url, ?) + ?) AS INTEGER)
          WHERE tcgplayer_product_id IS NULL
            AND instr(tcgplayer_url, ?) > 0
            AND CAST(substr(tcgplayer_url, instr(tcgplayer_url, ?) + ?) AS INTEGER) > 0`,
        [needle, skip, needle, needle, skip]
      );
    }
  }

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
  if (!collectionCols.some(c => c.name === 'notes')) {
    await run(`ALTER TABLE collection ADD COLUMN notes TEXT DEFAULT ''`);
  }
  // Grading lives on the COPY, not on the printing. A PSA 10 and a raw copy of the
  // same card share one card_cache row and differ only in what the owner holds —
  // which is exactly what the collection table records. Putting a grade on
  // card_cache would make every owner of that printing share one grade.
  //
  // `grade` is REAL, not INTEGER: PSA uses whole numbers plus 10, but BGS and CGC
  // issue half grades (9.5, 8.5), and the 'Graded Slab Box' container type has been
  // in db.js since v1.0 with nothing to put in it.
  if (!collectionCols.some(c => c.name === 'grader')) {
    await run(`ALTER TABLE collection ADD COLUMN grader TEXT CHECK(grader IN ('Raw','PSA','BGS','CGC','SGC','TAG')) DEFAULT 'Raw'`);
  }
  if (!collectionCols.some(c => c.name === 'grade')) {
    await run(`ALTER TABLE collection ADD COLUMN grade REAL`);
  }
  if (!collectionCols.some(c => c.name === 'cert_number')) {
    await run(`ALTER TABLE collection ADD COLUMN cert_number TEXT`);
  }
  // What this copy is actually worth, when the card_cache price is wrong for it.
  // A PSA 10 is a multiple of the raw price the providers quote, and no free
  // provider prices every grader — so the value of a slab is either typed in or
  // fetched from a graded-price provider, and both land here. One column, because
  // everything downstream (net worth, set totals, sorting by price) then has one
  // number to read regardless of where it came from.
  //
  // Per COPY, like grade and cert: two PSA 10s of the same card in different
  // markets are still one card_cache row.
  if (!collectionCols.some(c => c.name === 'market_value')) {
    await run(`ALTER TABLE collection ADD COLUMN market_value REAL`);
  }
  // 'manual' or a provider name. Kept so a refresh knows which rows it may
  // overwrite: a fetched number is stale in a week, a typed one is the owner's
  // considered judgement and nothing should quietly replace it.
  if (!collectionCols.some(c => c.name === 'market_value_source')) {
    await run(`ALTER TABLE collection ADD COLUMN market_value_source TEXT`);
  }
  if (!collectionCols.some(c => c.name === 'market_value_at')) {
    await run(`ALTER TABLE collection ADD COLUMN market_value_at DATETIME`);
  }
  // A cert number identifies one physical slab, so entering it twice is a mistake
  // rather than a second copy — unlike raw cards, where two identical rows are
  // normal and `quantity` exists for exactly that reason.
  //
  // Scoped per user, and partial. Per user because this instance cannot know that
  // two accounts naming the same cert are wrong (a sold slab legitimately appears
  // in the buyer's collection and the seller's history); partial because the
  // overwhelming majority of rows are raw and have no cert, and a plain UNIQUE
  // would collapse all of them into one.
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_cert
       ON collection(user_id, grader, cert_number)
     WHERE cert_number IS NOT NULL AND cert_number != ''`
  );

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
  if (!usersCols.some(c => c.name === 'share_locations')) {
    await run(`ALTER TABLE users ADD COLUMN share_locations INTEGER DEFAULT 0`);
  }
  // PSA's public API token. Per user, alongside tcg_api_key, because PSA issues
  // these per account and rate-limits per token — one shared instance token would
  // let one member's bulk entry exhaust everyone's quota.
  if (!usersCols.some(c => c.name === 'psa_api_token')) {
    await run(`ALTER TABLE users ADD COLUMN psa_api_token TEXT DEFAULT ''`);
  }
  // PokemonPriceTracker key, for graded (PSA 8/9/10) prices. Same per-user
  // reasoning as the PSA token: its free tier is 100 credits/day per key.
  if (!usersCols.some(c => c.name === 'graded_price_api_key')) {
    await run(`ALTER TABLE users ADD COLUMN graded_price_api_key TEXT DEFAULT ''`);
  }
  // Read-only key for scripts and dashboards (issue #33): a Bearer credential that
  // does not expire the way a session does, so a finance tracker polling net worth
  // is not logged out overnight. authenticateToken refuses anything but GET on it,
  // which is what makes a long-lived credential acceptable in the first place.
  if (!usersCols.some(c => c.name === 'api_key')) {
    await run(`ALTER TABLE users ADD COLUMN api_key TEXT`);
  }
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key) WHERE api_key IS NOT NULL`);

  const deckCardsCols = await all(`PRAGMA table_info(deck_cards)`);
  if (!deckCardsCols.some(c => c.name === 'checked_out')) {
    await run(`ALTER TABLE deck_cards ADD COLUMN checked_out INTEGER DEFAULT 0`);
  }

  const decksCols = await all(`PRAGMA table_info(decks)`);
  if (!decksCols.some(c => c.name === 'format')) {
    await run(`ALTER TABLE decks ADD COLUMN format TEXT DEFAULT 'Standard'`);
  }
  if (!decksCols.some(c => c.name === 'category')) {
    await run(`ALTER TABLE decks ADD COLUMN category TEXT DEFAULT 'Competitive'`);
  }
  if (!decksCols.some(c => c.name === 'accent_color')) {
    await run(`ALTER TABLE decks ADD COLUMN accent_color TEXT DEFAULT '#eab308'`);
  }
  if (!decksCols.some(c => c.name === 'target_size')) {
    await run(`ALTER TABLE decks ADD COLUMN target_size INTEGER DEFAULT 60`);
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

  // Stacking: on a container with this set, duplicate copies of a card share one
  // slot instead of claiming one each, so a nine-pocket page holds nine distinct
  // cards plus however many duplicates of them. Off by default — one card per
  // slot is what a binder physically is unless the owner sleeves copies together.
  const locationsStackCols = await all(`PRAGMA table_info(locations)`);
  if (!locationsStackCols.some(c => c.name === 'allow_stacking')) {
    await run(`ALTER TABLE locations ADD COLUMN allow_stacking INTEGER NOT NULL DEFAULT 0`);
  }

  // --- PERFORMANCE INDEXES ---
  // `user_id` first, because it is the predicate on essentially every read in the
  // app — every collection query, every stats aggregate — and nothing indexed it.
  // idx_collection_comp_user_qty below cannot serve it: a composite index is only
  // usable from its leading column, and that one leads with compartment_id.
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_user_game ON collection(user_id, game)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_comp_user_qty ON collection(compartment_id, user_id, quantity)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_loc_pos ON collection(location_id, position)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_card_cache_set_num ON card_cache(set_id, number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_deck_cards_checkout ON deck_cards(deck_id, checked_out)`);
  // Indexes on the retired tags/audit_logs tables. A fresh database never creates
  // those tables at all now; an upgraded one keeps them (dropping a table is not
  // something a migration should do to data it cannot restore), but nothing reads
  // them, so the indexes are pure write cost.
  await run(`DROP INDEX IF EXISTS idx_collection_tags_tag_id`);
  await run(`DROP INDEX IF EXISTS idx_audit_logs_user_date`);

  // --- SEED DATA & MIGRATION TO DEFAULT ADMIN ---
  const userCount = await get(`SELECT COUNT(*) as count FROM users`);
  let adminId = null;
  // An empty users table stays empty on purpose. The first visit to the web UI
  // asks for a password and creates the owner account itself
  // (POST /api/auth/bootstrap), so no generated password is ever printed to a log
  // and left in place. DEFAULT_ADMIN_PASSWORD still seeds an account up front for
  // scripted deploys that need credentials before anyone opens a browser.
  //
  // Either way the account is named `admin`: the name is not the owner's to choose,
  // because it is what the orphan-row adoption below looks up and what the
  // DEFAULT_ADMIN_PASSWORD path has to hardcode anyway (nobody could guess a name
  // the server picked). Nothing in the app renames a user, so it stays true.
  if (userCount.count === 0 && process.env.DEFAULT_ADMIN_PASSWORD) {
    const defaultPassHash = hashPassword(process.env.DEFAULT_ADMIN_PASSWORD);
    const defaultShareToken = crypto.randomBytes(16).toString('hex');
    const result = await run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, ['admin', defaultPassHash, 'admin', defaultShareToken, 0]);
    adminId = result.lastID;
    console.log('Created admin user "admin" from DEFAULT_ADMIN_PASSWORD.');
  } else if (userCount.count === 0) {
    console.log('No accounts yet. Open the web UI to create the owner account.');
  } else {
    const adminUser = await get(`SELECT id FROM users WHERE username = ?`, ['admin']);
    if (adminUser) {
      adminId = adminUser.id;
    }
  }

  if (adminId) {
    await adoptOrphanRows(adminId);
    await seedStarterLocations(adminId);
  }
}

// Cards and locations from before multi-user carry `user_id IS NULL`. They belong
// to whoever owns the install. Runs from initDb when an admin already exists (or
// DEFAULT_ADMIN_PASSWORD just made one), and from the bootstrap route when the
// owner account is created through the UI instead — a database with orphan rows
// and no users reaches the app that way and would otherwise show an empty
// collection.
async function adoptOrphanRows(userId) {
  await run(`UPDATE collection SET user_id = ? WHERE user_id IS NULL`, [userId]);
  await run(`UPDATE locations SET user_id = ? WHERE user_id IS NULL`, [userId]);
}

// A binder and a bulk box, so a new account has somewhere to put its first card.
// Runs from initDb when DEFAULT_ADMIN_PASSWORD seeds the account, and from the
// bootstrap route when the owner creates it through the UI instead.
async function seedStarterLocations(userId) {
  const locCount = await get(`SELECT COUNT(*) as count FROM locations`);
  if (locCount.count > 0) return;

  console.log('Populating default locations...');
  const binder = await run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [
    'Main Binder', 'Binder', userId
  ]);
  await createCompartments(binder.lastID, 10, 9);

  const box = await run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [
    'Bulk Storage Box 1', 'Box', userId
  ]);
  await createCompartments(box.lastID, 2, 100);
}

async function createCompartments(locationId, count, capacity) {
  for (let i = 1; i <= count; i++) {
    await run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [locationId, i, capacity]);
  }
}

module.exports = {
  dbConnection,
  dbPath,
  run,
  get,
  all,
  withTransaction,
  initDb,
  createCompartments,
  seedStarterLocations,
  adoptOrphanRows,
  hashPassword,
  // Exported for tests — the rename runs at module load, so it can't be
  // exercised through a normal require.
  resolveDbPath,
  DB_FILENAME,
  LEGACY_DB_FILENAME
};
