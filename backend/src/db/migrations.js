// initDb: brings a database of any age up to the current schema, and the helpers
// it shares with the rest of the backend (the stacked-row split, orphan adoption,
// starter storage, the synchronous password hash for its admin seed).
//
// initDb runs the CREATE statements in ./schema.js and the migrations between
// them in one fixed order, and that order matters: a migration reads columns an
// earlier one added, an index needs the column a migration adds, and a backfill
// must run only in the boot that adds its column. Add new steps at the end.
const crypto = require('crypto');
const { run, get, all, withTransaction, opened } = require('./connection');
const schema = require('./schema');

// Passwords are hashed in utils/authHelpers. This is its synchronous form, kept
// for initDb's DEFAULT_ADMIN_PASSWORD seed, the reset-password script and tests;
// request paths use authHelpers.hashPassword, which leaves the event loop free.
// Required on use, not at the top: authHelpers requires db.js, which requires
// this module.
function hashPassword(password) {
  return require('../utils/authHelpers').hashPasswordSync(password);
}

// A copy is a row. A row with quantity > 1 came from an older Rapid Add or import
// that stacked copies onto one row, and such a row cannot be filed into separate
// slots or checked out one copy at a time (#64). Split every stacked row into
// single-copy rows: every column except id is copied, and the extra copies sit
// next to the original in its slot, the way POST /collection places them.
//
// A graded row is the exception: a cert number names one physical slab, so a
// quantity above 1 there is a mistake rather than more slabs, and copying it would
// trip the (grader, cert_number) unique index. It collapses to one copy instead.
//
// Runs on every startup, from initDb, after every column migration — which is
// what makes copying "every column" mean grading, notes and market value too.
// This is the only split. server.js used to run a second one straight after
// initDb, written before those columns existed: it rebuilt each copy from a fixed
// column list, so a copy came out ungraded, without its notes and value, stamped
// as added today, and a graded row was duplicated into raw copies of one slab.
// After the first run nothing matches, so it costs one SELECT.
//
// The read is inside the transaction: the server is already taking requests
// while initDb runs, and a row edited between reading it and splitting it would
// be split from a quantity it no longer has.
async function splitStackedRows() {
  const split = await withTransaction(async () => {
    const stacked = await all(`SELECT * FROM collection WHERE quantity > 1`);
    if (stacked.length === 0) return 0;
    const cols = (await all(`PRAGMA table_info(collection)`)).map(c => c.name).filter(n => n !== 'id');
    const placeholders = cols.map(() => '?').join(', ');
    for (const row of stacked) {
      if (!row.cert_number) {
        for (let i = 1; i < row.quantity; i++) {
          const copy = { ...row, quantity: 1, position: row.position == null ? null : row.position + i * 0.001 };
          await run(`INSERT INTO collection (${cols.join(', ')}) VALUES (${placeholders})`, cols.map(c => copy[c]));
        }
      }
      await run(`UPDATE collection SET quantity = 1 WHERE id = ?`, [row.id]);
    }
    return stacked.length;
  });
  if (split) console.log(`Split ${split} stacked collection row(s) into single copies.`);
  return split;
}

// --- PRE-MIGRATION SNAPSHOT ---
// initDb's migrations are idempotent and mostly additive, but they run against
// the only copy of someone's collection, and one of them drops tables. So before
// a DIFFERENT release migrates a database that holds data, it is snapshotted
// (backup.createPreMigrationBackup: same atomic, verified write as every backup).
//
// "A different release" is one pragma read. PRAGMA user_version records the
// release that last completed initDb on this file, as major*1e6 + minor*1e3 +
// patch — it was unused (0) until now, so every existing install takes one
// snapshot on its first boot of this code. Keyed to the release rather than to a
// schema number someone has to remember to bump: every release that ships a
// migration has a new version, and dev restarts on the same version cost nothing.
const SCHEMA_RELEASE = require('../../package.json').version;

function releaseMarker(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
}
const markerRelease = (marker) => (marker > 0
  ? `${Math.floor(marker / 1e6)}.${Math.floor(marker / 1e3) % 1e3}.${marker % 1e3}`
  : null);

// Anything worth keeping? A brand-new file has no tables, and a database whose
// tables are all empty has nothing to lose.
async function hasData() {
  const tables = await all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  for (const { name } of tables) {
    if (await get(`SELECT 1 AS present FROM "${name.replace(/"/g, '""')}" LIMIT 1`)) return true;
  }
  return false;
}

async function snapshotBeforeMigrating() {
  // Device mode (embedded/index.js) sets this: a phone has no BACKUP_DIR.
  if (process.env.BINDARR_SKIP_PRE_MIGRATION_SNAPSHOT === '1') return;
  const { user_version: stored } = await get(`PRAGMA user_version`);
  if (stored === releaseMarker(SCHEMA_RELEASE)) return;
  const from = markerRelease(stored);
  try {
    if (!(await hasData())) return;
    const snap = await require('../backup').createPreMigrationBackup({ from, to: SCHEMA_RELEASE });
    console.log(snap.reused
      ? `Pre-migration snapshot for ${from || 'an unversioned database'} -> ${SCHEMA_RELEASE} already taken: ${snap.file}.`
      : `Pre-migration snapshot taken before upgrading ${from || 'an unversioned database'} -> ${SCHEMA_RELEASE}: ${snap.file} (${snap.size} bytes).`);
  } catch (err) {
    // Carry on, loudly. Refusing to start would turn a full disk or an unwritable
    // BACKUP_DIR into an outage, with a restart loop and no way into the admin
    // page to download the backups that already exist; the migrations are
    // additive and each statement is atomic. The rotating backups are untouched.
    console.error('==================================================================');
    console.error(`PRE-MIGRATION SNAPSHOT FAILED: ${err.message}`);
    console.error(`Upgrading ${from || 'an unversioned database'} -> ${SCHEMA_RELEASE} WITHOUT a fresh snapshot.`);
    console.error('Check BACKUP_DIR and free disk space. Existing backups are untouched.');
    console.error('==================================================================');
  }
}

// Foreign-key violations that point at sealed_templates, the table the recipe
// migrations rebuild or prune. Read from the three sealed tables only, and only
// those pointing at recipes: an orphan elsewhere in the database (a collection row
// whose card_cache row went missing years ago) is not theirs to report, and used to
// fail the boot after the rebuild had already been committed.
async function recipeForeignKeyViolations() {
  const violations = [];
  for (const table of ['sealed_templates', 'sealed_template_components', 'sealed_purchases']) {
    violations.push(...(await all(`PRAGMA foreign_key_check(${table})`)).filter(v => v.parent === 'sealed_templates'));
  }
  return violations;
}

// One recipe per product and game (#168): by product_id when it has one, else by
// name. The unique indexes in initDb hold that from here on; this merges any
// duplicates a database already has, keeping the oldest recipe and pointing every
// purchase that followed another one at it, so those indexes can be created.
// On a database without duplicates it reads two counts and writes nothing.
async function mergeDuplicateRecipes() {
  const duplicates = await all(`
    SELECT t.id, keep.id AS keep_id
      FROM sealed_templates t
      JOIN sealed_templates keep ON keep.game = t.game AND keep.id < t.id
       AND ((t.product_id IS NOT NULL AND keep.product_id = t.product_id)
         OR (t.product_id IS NULL AND keep.product_id IS NULL AND keep.product_name = t.product_name COLLATE NOCASE))
     WHERE NOT EXISTS (
       SELECT 1 FROM sealed_templates older
        WHERE older.game = t.game AND older.id < keep.id
          AND ((t.product_id IS NOT NULL AND older.product_id = t.product_id)
            OR (t.product_id IS NULL AND older.product_id IS NULL AND older.product_name = t.product_name COLLATE NOCASE))
     )`);
  if (duplicates.length === 0) return 0;
  await withTransaction(async () => {
    for (const { id, keep_id: keepId } of duplicates) {
      await run(`UPDATE sealed_purchases SET template_id = ? WHERE template_id = ?`, [keepId, id]);
      await run(`DELETE FROM sealed_template_components WHERE template_id = ?`, [id]);
      await run(`DELETE FROM sealed_templates WHERE id = ?`, [id]);
    }
  });
  console.log(`Merged ${duplicates.length} duplicate sealed recipe(s) into the oldest recipe for each product.`);
  return duplicates.length;
}

async function migrateSealedTemplatesToShared() {
  const columns = await all(`PRAGMA table_info(sealed_templates)`);
  const ownerColumn = columns.find(column => column.name === 'user_id');
  // Already shared: only duplicates can be left to tidy. The rebuild below merges
  // its own groups, components and all, so this runs instead of it, not before.
  if (!ownerColumn?.notnull) {
    await mergeDuplicateRecipes();
    return;
  }

  const templates = await all(`SELECT * FROM sealed_templates ORDER BY id`);
  const components = await all(`SELECT * FROM sealed_template_components ORDER BY id`);
  const templatesByIdentity = new Map();
  for (const template of templates) {
    const identity = template.product_id != null
      ? `${template.game}:id:${template.product_id}`
      : `${template.game}:name:${String(template.product_name || '').trim().toLowerCase()}`;
    const group = templatesByIdentity.get(identity) || [];
    group.push(template);
    templatesByIdentity.set(identity, group);
  }

  const groups = [];
  for (const rows of templatesByIdentity.values()) {
    const componentCountsByTemplate = new Map();
    for (const template of rows) {
      const byIdentity = new Map();
      for (const component of components.filter(item => item.template_id === template.id)) {
        const key = component.component_type === 'card'
          ? `card:${component.card_id || ''}`
          : `product:${String(component.product_name || '').trim().toLowerCase() || component.product_id}:${component.game || template.game}`;
        const current = byIdentity.get(key);
        if (current) {
          current.quantity += component.quantity;
          if (current.expected_cards == null || component.expected_cards > current.expected_cards) {
            current.expected_cards = component.expected_cards;
          }
          current.product_id = current.product_id || component.product_id;
        } else {
          byIdentity.set(key, { ...component, quantity: component.quantity });
        }
      }
      componentCountsByTemplate.set(template.id, [...byIdentity.values()]);
    }

    const merged = new Map();
    for (const template of rows) {
      for (const component of componentCountsByTemplate.get(template.id) || []) {
        const key = component.component_type === 'card'
          ? `card:${component.card_id || ''}`
          : `product:${String(component.product_name || '').trim().toLowerCase() || component.product_id}:${component.game || template.game}`;
        const current = merged.get(key);
        if (current) {
          current.quantity = Math.max(current.quantity, component.quantity);
          if (current.expected_cards == null || component.expected_cards > current.expected_cards) {
            current.expected_cards = component.expected_cards;
          }
          current.product_id = current.product_id || component.product_id;
        } else {
          merged.set(key, { ...component });
        }
      }
    }
    const expectedCards = rows.reduce((max, template) =>
      template.expected_cards == null
        ? max
        : Math.max(max ?? 0, Number(template.expected_cards)), null);
    groups.push({ canonical: rows[0], rows, components: [...merged.values()], expectedCards });
  }

  // Foreign keys off for the rebuild (a dropped parent table must not cascade its
  // components away), set outside the transaction because the pragma is a no-op
  // inside one. Everything else is one transaction: a crash between the DROP and
  // the RENAME used to strand the recipes in a side table.
  //
  // The CREATE below becomes sealed_templates' own entry in sqlite_master after
  // the RENAME, so its text stays exactly as it is, indentation included.
  await run(`PRAGMA foreign_keys = OFF`);
  try {
    await withTransaction(async () => {
    await run(`DROP TABLE IF EXISTS sealed_templates_shared`);
    await run(`
      CREATE TABLE sealed_templates_shared (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        product_id INTEGER,
        product_name TEXT NOT NULL,
        game TEXT NOT NULL DEFAULT 'pokemon',
        expected_cards INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const group of groups) {
      const template = group.canonical;
      await run(
        `INSERT INTO sealed_templates_shared
           (id, user_id, product_id, product_name, game, expected_cards, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [template.id, template.user_id, template.product_id, template.product_name, template.game,
          group.expectedCards, template.created_at]
      );
      const ids = group.rows.map(row => row.id);
      if (ids.length > 1) {
        const placeholders = ids.map(() => '?').join(',');
        await run(`UPDATE sealed_purchases SET template_id = ? WHERE template_id IN (${placeholders})`, [template.id, ...ids]);
        await run(`DELETE FROM sealed_template_components WHERE template_id IN (${placeholders})`, ids);
        for (const component of group.components) {
          await run(
            `INSERT INTO sealed_template_components
               (template_id, component_type, quantity, card_id, product_name, sealed_type, product_id, game, expected_cards)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [template.id, component.component_type, component.quantity, component.card_id,
              component.product_name, component.sealed_type, component.product_id,
              component.game, component.expected_cards]
          );
        }
      }
    }
    await run(`DROP TABLE sealed_templates`);
    await run(`ALTER TABLE sealed_templates_shared RENAME TO sealed_templates`);
    // Checked before the commit, so a rebuild that broke a link rolls back whole.
    const violations = await recipeForeignKeyViolations();
    if (violations.length) {
      throw new Error(`Sealed recipe migration left ${violations.length} foreign-key violation(s)`);
    }
    });
  } finally {
    await run(`PRAGMA foreign_keys = ON`);
  }
}

// Runs schema.js's CREATE statements, named by table or index, in the order given.
async function create(...names) {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(schema, name)) {
      throw new Error(`db/schema.js has no table or index named ${name}`);
    }
    await run(schema[name]);
  }
}

// addColumns(table, { column: 'DDL', ... }) adds each listed column the table
// lacks, in the order listed, as `ALTER TABLE <table> ADD COLUMN <column> <DDL>`,
// and resolves to the names it added (empty when the table had them all), so a
// backfill can run in the boot that adds its column and never again.
//
// What each table has is read once per initDb (PRAGMA table_info) and kept up to
// date as columns are added. That holds because nothing else in initDb changes a
// table's columns between two addColumns calls on it: collection and locations
// are moved aside before their first one, and sealed_templates is rebuilt after
// its last one. A step that rebuilds a table after that table's first addColumns
// call would leave the record stale.
function columnAdder() {
  const known = new Map();
  return async function addColumns(table, columns) {
    let have = known.get(table);
    if (!have) {
      have = new Set((await all(`PRAGMA table_info(${table})`)).map(c => c.name));
      known.set(table, have);
    }
    const added = [];
    for (const [column, ddl] of Object.entries(columns)) {
      if (have.has(column)) continue;
      await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      have.add(column);
      added.push(column);
    }
    return added;
  };
}

// Initialize tables
async function initDb() {
  await opened;
  await snapshotBeforeMigrating();

  const existingCollectionCols = await all(`PRAGMA table_info(collection)`).catch(() => []);
  if (existingCollectionCols.some(c => c.name === 'sub_location_1')) {
    // A database from before compartments (sub_location_1/2 on collection, shape
    // columns on locations). These two tables used to be DROPPED here, which
    // emptied the collection of anyone upgrading from that release. Move them
    // aside instead, so the statements below create the current tables, and
    // finishPreCompartmentUpgrade() copies the cards across once those tables
    // have every column. The _pending names mark the copy as not yet done: a
    // crash in between resumes on the next boot instead of losing the cards.
    console.log('Pre-compartment storage schema found: setting collection/locations aside for migration...');
    await withTransaction(async () => {
      await run(`ALTER TABLE collection RENAME TO ${LEGACY_COLLECTION}_pending`);
      await run(`ALTER TABLE locations RENAME TO ${LEGACY_LOCATIONS}_pending`);
    });
  }

  const addColumns = columnAdder();

  await create('users', 'sessions', 'app_settings');
  await run(`INSERT OR IGNORE INTO app_settings (id, public_base_url) VALUES (1, '')`);
  await create(
    'locations', 'compartments', 'compartment_assignments', 'sets', 'card_cache', 'collection', 'price_history',
    'fx_rates', 'tcgplayer_product', 'idx_tcgplayer_product_pid', 'tcgplayer_catalog', 'set_data_gaps',
    'set_listings', 'psa_cert', 'decks', 'deck_cards', 'notes',
    'sealed_purchases', 'idx_sealed_purchases_user', 'sealed_units', 'idx_sealed_units_purchase',
    'sealed_templates', 'sealed_template_components', 'idx_sealed_template_components_template',
    'card_lists', 'card_list_items', 'idx_card_lists_user'
  );
  // Each user's default Wishlist: the list the heart on a card adds to. Made on
  // first use (routes/lists.js), at most one per user -- enforced here, so two
  // hearts tapped at once cannot make two.
  await addColumns('card_lists', { is_default: 'INTEGER NOT NULL DEFAULT 0' });
  await create('idx_card_lists_default');
  await create(
    'notification_channels', 'idx_notification_channels_user', 'notification_prefs', 'notification_price_state',
    'notification_log', 'idx_notification_log_queue', 'idx_notification_log_dedupe',
    'binder_artwork', 'idx_binder_artwork_user', 'binder_art_layers', 'idx_binder_art_layers_user'
  );

  // --- MIGRATIONS ---
  // When each game's price sweep last ran. Scryfall updates prices once a day,
  // so a sweep more often than that cannot return anything new — and the boot
  // sweep would otherwise re-run on every restart (constantly, under nodemon).
  // Persisted rather than in-memory precisely because restarts are the problem.
  await addColumns('app_settings', {
    mtg_prices_swept_at: 'DATETIME',
    pokemon_prices_swept_at: 'DATETIME',
    tcgdex_prices_swept_at: 'DATETIME',
    pokemontcgapi_prices_swept_at: 'DATETIME',
  });
  await create('pokemontcgapi_cache');
  await addColumns('app_settings', {
    // TCGCSV mirrors TCGplayer once a day, so its gate is the same 24h as the rest.
    tcgcsv_prices_swept_at: 'DATETIME',
    tcgcsv_403_cooldown_until: 'DATETIME',
    tcgcsv_data_version: 'TEXT',
    tcgcsv_pending_version: 'TEXT',
    // Magic/Lorcana sealed tracking (TCGCSV categories 1 and 71). Off by default:
    // syncing them fetches every MTG and Lorcana group daily. See tcgcsvApi.syncCategories.
    sealed_tcg_extra_enabled: 'INTEGER DEFAULT 0',
    tcgcsv_last_checked_at: 'DATETIME',
  });
  await create('tcgcsv_cache');
  // An earlier build of the daily sync kept whole responses in
  // tcgcsv_response_cache. Slim them into the new table rather than discarding
  // them, so an upgrade does not cost a full re-download from TCGCSV, then drop it.
  const legacyTcgcsv = await get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tcgcsv_response_cache'`
  );
  if (legacyTcgcsv) {
    const { slimResults, slimmerFor } = require('../utils/tcgcsvSlim');
    const keys = await all(`SELECT path, data_version FROM tcgcsv_response_cache`);
    let kept = 0;
    for (const { path: cachePath, data_version: version } of keys) {
      if (!slimmerFor(cachePath)) continue;
      const row = await get(
        `SELECT results_json FROM tcgcsv_response_cache WHERE path = ? AND data_version = ?`,
        [cachePath, version]
      );
      let results;
      try { results = JSON.parse(row.results_json); } catch { continue; }
      if (!Array.isArray(results)) continue;
      await run(
        `INSERT OR REPLACE INTO tcgcsv_cache (path, data_version, results_json) VALUES (?, ?, ?)`,
        [cachePath, version, JSON.stringify(slimResults(cachePath, results))]
      );
      kept++;
    }
    await run(`DROP TABLE tcgcsv_response_cache`);
    console.log(`Migrated ${kept} TCGCSV cache entries to the slim cache table.`);
  }
  await addColumns('app_settings', {
    // How many days between automatic price refreshes; 0 switches them off.
    // Daily is what every install did before this column existed, so that is the
    // default and nothing changes for anyone who never touches it. It exists for
    // the metered provider: pokemontcgapi.com charges credits per card refreshed,
    // and a daily sweep of a large collection is a recurring bill.
    price_refresh_days: 'INTEGER NOT NULL DEFAULT 1',
    lorcana_prices_swept_at: 'DATETIME',

    // VESTIGIAL. This gated non-admin members building an individual per-set ORB
    // index, and there are no per-set indexes any more — scanning is CollectorVision
    // embeddings over a catalog, and catalog builds are admin-only (they walk a whole
    // provider and hammer its rate limits). Nothing reads the column; the migration
    // stays so an existing database still matches the schema this code expects, and
    // dropping it would mean a table rebuild for no gain.
    allow_member_set_builds: 'INTEGER NOT NULL DEFAULT 0',
  });
  // Columns that reached card_cache and decks through their CREATE TABLE only.
  // A database from the Pokémon-only releases has neither, and the provider
  // migration below reads card_cache.game, so without these that upgrade could
  // not get past initDb at all. Placed before the first statement that reads them.
  await addColumns('card_cache', { game: `TEXT DEFAULT 'pokemon'`, cmc: 'REAL', color_identity: 'TEXT' });
  await addColumns('decks', { game: `TEXT DEFAULT 'pokemon'` });
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
  if ((await addColumns('app_settings', { pokemon_provider: `TEXT DEFAULT 'tcgdex'` })).length) {
    await run(`
      UPDATE app_settings SET pokemon_provider = 'pokemontcg'
       WHERE (SELECT COUNT(*) FROM sets WHERE game = 'pokemon') > 0
          OR (SELECT COUNT(*) FROM card_cache WHERE game = 'pokemon') > 0
    `);
  }
  // The way off that pin before pokemontcg.io shuts down: the admin-run card-id
  // migration (pokemonMigration.js). A run, the old -> new id log it can be
  // reported and reversed from, and the before-images an exact undo needs.
  await create(
    'pokemon_id_migration_runs', 'pokemon_id_migration_log', 'idx_pokemon_id_migration_log_new',
    'pokemon_id_migration_undo', 'idx_pokemon_id_migration_undo_run'
  );
  await addColumns('app_settings', {
    scan_exclude_tokens: 'INTEGER NOT NULL DEFAULT 0',
    scan_exclude_art_cards: 'INTEGER NOT NULL DEFAULT 0',
    scan_exclude_jumpstart: 'INTEGER NOT NULL DEFAULT 0',
    scan_exclude_promos: 'INTEGER NOT NULL DEFAULT 0',
    // The one scan exclusion that defaults ON, and the only one that is not a
    // matter of taste: Pokémon TCG Pocket cards exist solely in the phone game, so
    // no camera will ever be pointed at one. Indexing them costs a linear pass over
    // 2,321 extra vectors on every unscoped scan and — because Pocket art is
    // largely redrawn from paper cards — invites confident matches naming a set the
    // user cannot own. MTG has always excluded digital sets (cardSets.listAllSets
    // filters Scryfall's `digital` flag); this is the Pokémon half of that rule
    // finally catching up, which is why existing installs get it applied on
    // migration rather than grandfathered off.
    scan_exclude_digital: 'INTEGER NOT NULL DEFAULT 1',

    // Whether the first-run wizard has been seen through to the end. Server-side,
    // not localStorage, so the wizard follows the install rather than the browser:
    // an admin who starts setup on a laptop finishes it on a phone. Every install
    // starts at 0, upgrades included: the wizard is where catalogs, games and the
    // provider keys are explained, and an install that predates it has never been
    // offered that tour. It is one screen with a "Skip setup" button that marks it
    // done for good, so the cost to someone who wants nothing from it is one click.
    setup_complete: 'INTEGER NOT NULL DEFAULT 0',

    // Which marketplace Magic prices are read from first (#93). Scryfall quotes both
    // TCGplayer (`usd`) and Cardmarket (`eur`) for most printings; 'tcgplayer' is
    // what every install did before this column existed, so it is the default and
    // nothing changes for anyone who never touches it. 'cardmarket' is the mirror
    // image for European collectors, whose collections otherwise came out as a mix
    // of $ and € that the dashboard summed as one number. See
    // scryfallApi.normalizeCard for how the choice is applied.
    mtg_price_source: `TEXT NOT NULL DEFAULT 'tcgplayer'`,
  });

  await addColumns('card_cache', {
    // A non-English printing is its own card, not a display variant of the English
    // one: it has its own provider id, its own art and its own name. `language`
    // records which printing a cached row IS (collection.language still records
    // what the user OWNS), and `printed_name` holds the localized name — `name`
    // stays English so search, deck lists and marketplace links keep working.
    language: `TEXT DEFAULT 'English'`,
    printed_name: 'TEXT',
    // Marketplace links as the PROVIDER gives them. Building them from name+set+number
    // only works for English cards: searching TCGplayer for "ヒトカゲ ポケモンカード151"
    // returns nothing, because those sites index English names. Scryfall and
    // pokemontcg.io both hand us a real product/search URL per card, so store it.
    tcgplayer_url: 'TEXT',
    cardmarket_url: 'TEXT',
    // collection.printing has allowed '1st Edition' since v1.0, and resolveCardPrice
    // had no column to read for it — so a 1st Edition Base Set card was valued at the
    // Unlimited price, which for a Charizard is a difference of thousands. TCGplayer
    // prices the two separately and always has; this is where that number lands.
    price_1st_edition: 'REAL',
  });
  // Magic's rules text — full type line, mana cost, power, toughness, loyalty
  // and keyword abilities — which filtering a collection in Scryfall syntax reads
  // (t:, m:, pow>=, kw:; see shared/scryfallQuery.mjs; oracle_text is #131's). Written by
  // utils/mtgRulesText.js through cardCache.js; NULL for every other game.
  //
  // Existing rows gain it when they are next re-cached, and the MTG price sweep
  // re-fetches every owned and decked card. Clearing the sweep's stamp as the
  // columns are added makes the catch-up sweep shortly after this boot do it, so a
  // collection can be filtered by rules text straight after the upgrade instead of
  // up to a day later.
  const missingRulesText = await addColumns('card_cache', {
    type_line: 'TEXT',
    mana_cost: 'TEXT',
    power: 'TEXT',
    toughness: 'TEXT',
    loyalty: 'TEXT',
    keywords: 'TEXT',
  });
  if (missingRulesText.length) {
    await run(`UPDATE app_settings SET mtg_prices_swept_at = NULL`);
  }

  // Which marketplace a row's prices came from, and in what currency.
  //
  // The price columns have always been unit-less, and until now they mixed
  // TCGplayer USD (English) with Cardmarket EUR (everything TCGdex served) while
  // the UI rendered one '$' over both. Recording the source per row is what lets
  // the inspector say which number it is showing, instead of inferring it from
  // whether a Cardmarket URL happens to exist.
  await addColumns('card_cache', { price_currency: `TEXT DEFAULT 'USD'` });
  if ((await addColumns('card_cache', { price_source: 'TEXT' })).length) {
    // Backfill from what each row's id already tells us: TCGdex is the only source
    // that ever wrote EUR, and its ids are prefixed. No network needed.
    await run(`UPDATE card_cache SET price_source = 'scryfall', price_currency = 'USD' WHERE id LIKE 'mtg-%'`);
    await run(`UPDATE card_cache SET price_source = 'tcgdex', price_currency = 'EUR' WHERE id LIKE 'tcgdex-%'`);
    await run(`UPDATE card_cache SET price_source = 'pokemontcg', price_currency = 'USD' WHERE price_source IS NULL AND game = 'pokemon'`);
  }

  // The currency each price point was recorded in. A card's currency can change
  // under it — an admin switching the MTG price source (#93), or a printing that
  // gains or loses its TCGplayer listing — and price_history only held a bare
  // number, so a $10 card re-priced at €9 would have read as a 10% drop. Readers
  // compare points against the card's CURRENT currency (routes/stats.js), so a
  // switch starts a new series instead of drawing a fake move.
  //
  // Backfilled from card_cache once, on migration, and placed after the
  // price_currency migration above so that column is guaranteed to exist. Until
  // now a card's currency only moved in the rare USD/EUR fallback case, so its
  // current currency is what its history was recorded in for all but a handful
  // of points.
  if ((await addColumns('price_history', { currency: 'TEXT' })).length) {
    await run(`
      UPDATE price_history
         SET currency = (SELECT price_currency FROM card_cache WHERE card_cache.id = price_history.card_id)
       WHERE currency IS NULL
    `);
  }
  // TCGplayer's own product id, which is what turns a link into the actual card.
  // The stored `tcgplayer_url` above is NOT reliably a product page: Scryfall
  // hands back a name search whenever it has no product for a printing (6,109 of
  // 106,163 cached MTG rows), and TCGdex supplies no TCGplayer link at all. An id
  // is unambiguous — /product/<id> either resolves or the card is not listed.
  //
  // Provider-agnostic on purpose: Scryfall publishes it as `tcgplayer_id`, and
  // the Pokémon rows get theirs from the TCGCSV catalogue mapping.
  if ((await addColumns('card_cache', { tcgplayer_product_id: 'INTEGER' })).length) {
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
  // The back face of a double-faced Magic card (transform, modal DFC, reversible),
  // which has no single image — `image_url` only ever held the front, so the back
  // was unviewable (#103). Null for every single-faced card and every other game.
  // Not backfilled: existing rows gain it the next time they are re-cached (the
  // daily MTG price sweep re-fetches every owned and decked card).
  await addColumns('card_cache', { image_url_back: 'TEXT' });

  // tcgplayer_catalog originally held cards only (a product with no collector
  // number was skipped as sealed product). Sealed rows now get a row too, so the
  // build needs somewhere to put the game they belong to, their artwork, and a
  // rough product type (Booster Box, ETB, ...) since none of that was needed
  // while every row was a card matched to a card_cache row already carrying it.
  await addColumns('tcgplayer_catalog', { game: 'TEXT', image_url: 'TEXT', sealed_type: 'TEXT' });
  // Rows written before `game` existed were all Pokémon (categories 3 and 85 are
  // the only ones the old build walked), and summary() counts by game, so an
  // upgraded install reported a 0-row product map until it was rebuilt.
  // Idempotent: only NULLs are touched. It runs every boot but reads only the
  // NULL-game rows, through idx_tcgplayer_catalog_no_game (the index block below):
  // it used to scan the whole catalog, hundreds of thousands of rows, to find none.
  await run(
    `UPDATE tcgplayer_catalog SET game = 'pokemon' WHERE game IS NULL AND category_id IN (3, 85)`
  );

  // What's actually inside a sealed unit (a Build & Battle Box is 4 boosters plus
  // a 40-card preconstructed deck), so opening one can show "how many of the
  // expected cards have I linked so far" instead of leaving that to memory.
  // The expected total belongs to the shared product recipe; the purchase column
  // remains as a legacy fallback for older records and clients.
  await addColumns('sealed_purchases', {
    expected_packs: 'INTEGER',
    expected_cards: 'INTEGER',
    contents_note: 'TEXT',
    // Which recipe this purchase follows (auto-attached at create time by matching
    // product_id/product_name against the user's sealed_templates), and, for a
    // purchase that was itself auto-created by unboxing a parent unit, which unit
    // that was — so "this pack came from that box" is traceable.
    template_id: 'INTEGER REFERENCES sealed_templates(id) ON DELETE SET NULL',
    market_value: 'REAL',
    market_value_source: 'TEXT',
    market_value_at: 'DATETIME',
    source_unit_id: 'INTEGER REFERENCES sealed_units(id) ON DELETE SET NULL',
    source_unit_price_original: 'REAL',
    source_unit_price_saved: 'INTEGER NOT NULL DEFAULT 0',
    available_to_all: 'INTEGER NOT NULL DEFAULT 0',
    // Where a purchase that arrived by transfer came from, kept on the purchase
    // because the source unit belongs to another account (routes/transfers.js).
    source_product_name: 'TEXT',
    source_unit_number: 'INTEGER',
  });
  await addColumns('sealed_template_components', { expected_cards: 'INTEGER' });
  if ((await addColumns('sealed_templates', { expected_cards: 'INTEGER' })).length) {
    await run(
      `UPDATE sealed_templates
          SET expected_cards = (
            SELECT MAX(p.expected_cards) FROM sealed_purchases p
             WHERE p.template_id = sealed_templates.id AND p.expected_cards IS NOT NULL
          )
        WHERE expected_cards IS NULL
          AND EXISTS (
            SELECT 1 FROM sealed_purchases p
             WHERE p.template_id = sealed_templates.id AND p.expected_cards IS NOT NULL
          )`
    );
  }
  await migrateSealedTemplatesToShared();
  await create('idx_sealed_templates_user', 'idx_sealed_templates_global_product', 'idx_sealed_templates_global_name');

  // Idempotency guard: a template's components are created once per unit, the
  // first time it's marked opened. Without this, toggling opened -> closed ->
  // opened again would create a second copy of every card and sub-pack.
  await addColumns('sealed_units', {
    claimed_by_user_id: 'INTEGER REFERENCES users(id) ON DELETE SET NULL',
    components_applied_at: 'DATETIME',
    // Marked "for trade", like collection.is_trade on a card.
    is_trade: 'INTEGER DEFAULT 0',
  });
  await create('idx_sealed_units_claimed_by_user');

  // Trades and gifts between users, trades recorded after the fact, and deals with
  // people outside Bindarr (routes/transfers.js, routes/externalTransfers.js).
  // Before collection's columns below, which reference their item tables.
  await create(
    'user_transfers', 'idx_user_transfers_proposer_status', 'idx_user_transfers_recipient_status',
    'user_transfer_items', 'idx_user_transfer_items_transfer', 'idx_user_transfer_items_collection',
    'idx_user_transfer_items_sealed_unit',
    'historical_trades', 'idx_historical_trades_creator', 'idx_historical_trades_recipient',
    'historical_trade_items', 'idx_historical_trade_items_trade', 'idx_historical_trade_items_collection',
    'idx_historical_trade_items_recipient_collection',
    'external_contacts', 'idx_external_contacts_user_name', 'idx_external_contacts_user',
    'external_transactions', 'idx_external_transactions_user_created',
    'external_transaction_items', 'idx_external_transaction_items_transaction',
    'idx_external_transaction_items_collection'
  );

  // Riftbound (riftcodexApi.js). Four card fields no provider stored before —
  // which way the card is printed (Riftbound battlefields are landscape), its
  // artist, its rules text, and its numeric stats as JSON ({"energy":2,"might":3})
  // — generic rather than Riftbound-only so another provider can fill them, and
  // null everywhere else. Plus the Riftbound price sweep's own clock
  // (utils/priceHelpers SWEEP_COLUMN: an unknown key means the sweep never runs).
  await addColumns('card_cache', { orientation: 'TEXT', artist: 'TEXT', card_text: 'TEXT', attributes: 'TEXT' });
  await addColumns('app_settings', { riftbound_prices_swept_at: 'DATETIME' });

  await addColumns('collection', {
    user_id: 'INTEGER REFERENCES users(id) ON DELETE CASCADE',
    // Which sealed unit (if any) this copy was pulled from, for cost-basis and
    // where-did-this-come-from lookups. SET NULL on delete: removing the purchase
    // record must not delete cards the user still owns.
    sealed_unit_id: 'INTEGER REFERENCES sealed_units(id) ON DELETE SET NULL',
    is_trade: 'INTEGER DEFAULT 0',
    favorite: 'INTEGER DEFAULT 0',
    list_type: `TEXT DEFAULT 'collection'`,
    compartment_id: 'INTEGER REFERENCES compartments(id) ON DELETE SET NULL',
    position: 'REAL DEFAULT 0',
    game: `TEXT DEFAULT 'pokemon'`,
    notes: `TEXT DEFAULT ''`,
    // Grading lives on the COPY, not on the printing. A PSA 10 and a raw copy of the
    // same card share one card_cache row and differ only in what the owner holds —
    // which is exactly what the collection table records. Putting a grade on
    // card_cache would make every owner of that printing share one grade.
    //
    // `grade` is REAL, not INTEGER: PSA uses whole numbers plus 10, but BGS and CGC
    // issue half grades (9.5, 8.5), and the 'Graded Slab Box' container type has been
    // in db.js since v1.0 with nothing to put in it.
    grader: `TEXT CHECK(grader IN ('Raw','PSA','BGS','CGC','SGC','TAG')) DEFAULT 'Raw'`,
    grade: 'REAL',
    cert_number: 'TEXT',
    // What this copy is actually worth, when the card_cache price is wrong for it.
    // A PSA 10 is a multiple of the raw price the providers quote, and no free
    // provider prices every grader — so the value of a slab is either typed in or
    // fetched from a graded-price provider, and both land here. One column, because
    // everything downstream (net worth, set totals, sorting by price) then has one
    // number to read regardless of where it came from.
    //
    // Per COPY, like grade and cert: two PSA 10s of the same card in different
    // markets are still one card_cache row.
    market_value: 'REAL',
    // 'manual' or a provider name. Kept so a refresh knows which rows it may
    // overwrite: a fetched number is stale in a week, a typed one is the owner's
    // considered judgement and nothing should quietly replace it.
    market_value_source: 'TEXT',
    market_value_at: 'DATETIME',
    // Which transfer item or recorded trade item brought this copy in, for "where
    // did this come from". SET NULL: deleting the history keeps the card.
    acquired_via_transfer_item_id: 'INTEGER REFERENCES user_transfer_items(id) ON DELETE SET NULL',
    acquired_via_historical_trade_item_id: 'INTEGER REFERENCES historical_trade_items(id) ON DELETE SET NULL',
    // And from someone outside Bindarr (routes/externalTransfers.js).
    acquired_via_external_item_id: 'INTEGER REFERENCES external_transaction_items(id) ON DELETE SET NULL',
  });
  await create(
    'idx_collection_cert',
    'idx_collection_acquired_transfer', 'idx_collection_acquired_historical', 'idx_collection_acquired_external'
  );

  await addColumns('locations', {
    user_id: 'INTEGER REFERENCES users(id) ON DELETE CASCADE',
    sort_order: `TEXT DEFAULT '[{"by":"name","dir":"asc"}]'`,
    foil_sorting: `TEXT DEFAULT 'normals_first'`,
    game: `TEXT DEFAULT 'any'`,
  });

  // collection and locations now have every column a copied row needs.
  await finishPreCompartmentUpgrade();

  await addColumns('users', {
    tcg_api_key: `TEXT DEFAULT ''`,
    share_locations: 'INTEGER DEFAULT 0',
    // PSA's public API token. Per user, alongside tcg_api_key, because PSA issues
    // these per account and rate-limits per token — one shared instance token would
    // let one member's bulk entry exhaust everyone's quota.
    psa_api_token: `TEXT DEFAULT ''`,
    // PokemonPriceTracker key, for graded (PSA 8/9/10) prices. Same per-user
    // reasoning as the PSA token: its free tier is 100 credits/day per key.
    graded_price_api_key: `TEXT DEFAULT ''`,
    // Read-only key for scripts and dashboards (issue #33): a Bearer credential that
    // does not expire the way a session does, so a finance tracker polling net worth
    // is not logged out overnight. authenticateToken refuses anything but GET on it,
    // which is what makes a long-lived credential acceptable in the first place.
    api_key: 'TEXT',
  });
  await create('idx_users_api_key');

  // OIDC / SSO unique identifier (subject claim `sub`). Links an external IdP
  // user account to a Bindarr user row.
  await addColumns('users', { oidc_sub: 'TEXT' });
  await create('idx_users_oidc_sub');

  // Which optional tabs the nav bar shows (utils/navTabs.js), as a JSON array.
  // NULL means the default set, so a tab added later reaches everyone who never
  // chose.
  await addColumns('users', { nav_tabs: 'TEXT' });
  // Trading with other members is opt-in (routes/transfers.js): a member who has
  // not turned it on is not listed to others and cannot be sent an offer.
  await addColumns('users', { trades_enabled: 'INTEGER NOT NULL DEFAULT 0' });

  // API keys are stored as their SHA-256 (utils/authHelpers.hashApiKey, the same
  // digest a session token gets), so a copy of this file or an admin backup holds
  // no key that reads anyone's collection. Keys made before that are hashed in
  // place and keep working; the 'sha256:' prefix marks a row as done, as it does
  // for sessions below. Each key is unique, so its hash is too.
  const plainApiKeys = await all(
    `SELECT id, api_key FROM users WHERE api_key IS NOT NULL AND api_key <> '' AND api_key NOT LIKE 'sha256:%'`
  );
  if (plainApiKeys.length) {
    await withTransaction(async () => {
      for (const { id, api_key: key } of plainApiKeys) {
        const hashed = `sha256:${crypto.createHash('sha256').update(String(key)).digest('hex')}`;
        await run(`UPDATE users SET api_key = ? WHERE id = ?`, [hashed, id]);
      }
    });
    console.log(`Hashed ${plainApiKeys.length} stored API key(s).`);
  }

  // Session tokens are stored as their SHA-256 (utils/authHelpers.hashSessionToken),
  // so a copy of this file holds nothing that signs anyone in. Rows from before
  // that hold the token itself; hash them in place so nobody is signed out by the
  // upgrade. The 'sha256:' prefix is what marks a row as done, so this is a no-op
  // after the first start -- and a row an older build writes after a downgrade is
  // picked up on the next upgrade instead of silently never matching. Hashed here
  // in JS because SQLite has no SHA-256; it must stay the same digest as
  // hashSessionToken (sessions.test.js holds the two together).
  const unhashedSessions = await all(`SELECT token FROM sessions WHERE token NOT LIKE 'sha256:%'`);
  if (unhashedSessions.length) {
    await withTransaction(async () => {
      for (const { token } of unhashedSessions) {
        const hashed = `sha256:${crypto.createHash('sha256').update(String(token)).digest('hex')}`;
        await run(`UPDATE OR REPLACE sessions SET token = ? WHERE token = ?`, [hashed, token]);
      }
    });
    console.log(`Hashed ${unhashedSessions.length} stored session token(s).`);
  }

  await addColumns('deck_cards', { checked_out: 'INTEGER DEFAULT 0' });

  await addColumns('decks', {
    format: `TEXT DEFAULT 'Standard'`,
    category: `TEXT DEFAULT 'Competitive'`,
    accent_color: `TEXT DEFAULT '#eab308'`,
    target_size: 'INTEGER DEFAULT 60',
  });

  // Lock flags: a locked compartment/location is skipped by auto-filing
  // (recommendSlot) so it never receives new cards; existing cards stay put and
  // manual moves still work.
  await addColumns('compartments', { locked: 'INTEGER NOT NULL DEFAULT 0' });
  await addColumns('locations', {
    locked: 'INTEGER NOT NULL DEFAULT 0',

    // Stacking: on a container with this set, duplicate copies of a card share one
    // slot instead of claiming one each, so a nine-pocket page holds nine distinct
    // cards plus however many duplicates of them. Off by default — one card per
    // slot is what a binder physically is unless the owner sleeves copies together.
    allow_stacking: 'INTEGER NOT NULL DEFAULT 0',

    // Fixed slots: JSON [{ set_id, start_slot, max_number }] pinning a set's cards
    // to the binder pocket their collector number names. NULL (the default) is off.
    fixed_slots: 'TEXT',

    // Page columns: how many pockets wide a binder page is drawn. NULL (the
    // default) lets the client pick from the page's capacity; a number overrides
    // that for pages the standard layouts don't cover, e.g. a 12-pocket page that
    // really is 3 wide.
    page_columns: 'INTEGER',
  });

  await create('job_runs');

  await splitStackedRows();

  // --- DECK FORMATS, ANY-PRINTING DECKS, CHECKOUT ALLOCATION ---
  // What the deck rules (shared/deckRules.mjs) read off a Magic card beyond its type
  // line and colour identity. `oracle_id` is what every printing of one card has in
  // common, so a deck that accepts any printing can count a copy of another one;
  // `oracle_text` is where a card says it can be a commander, partners with another,
  // or may appear in any number. Written by scryfallApi.normalizeCard; null for the
  // other games. Not backfilled: until a row is re-cached the rules fall back to the
  // card's name and a short list, and the daily price sweep re-caches every owned and
  // decked Magic card — the only rows a deck ever compares.
  await addColumns('card_cache', { oracle_id: 'TEXT', oracle_text: 'TEXT' });
  // Whether a deck counts any printing of a card it lists. Only meaningful where a
  // game has a reliable "same card" (Magic's oracle id, Lorcana's full name), and on
  // for the Magic and Lorcana decks that already exist — that is the fix: owning a
  // different printing of Sol Ring stops reading as not owning it.
  if ((await addColumns('decks', { any_printing: 'INTEGER NOT NULL DEFAULT 0' })).length) {
    await run(`UPDATE decks SET any_printing = 1 WHERE game IN ('mtg', 'lorcana')`);
  }
  // The card(s) leading a Commander-style deck, whose colour identity every other
  // card is checked against.
  await addColumns('deck_cards', { is_commander: 'INTEGER NOT NULL DEFAULT 0' });
  // The copies a checked-out deck holds (schema.js has the table). Whether the
  // table existed before this boot decides the backfill below.
  const hadAllocations = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deck_allocations'`);
  await create('deck_allocations', 'idx_deck_allocations_deck');
  if (!hadAllocations) {
    // Decks checked out before this table existed held their copies implicitly:
    // availability was worked out per request. Give them the same copies the old
    // storage view greyed out — exact printing, filed copies first, newest first —
    // handed out in checkout order. Rows are single copies by now (splitStackedRows
    // above), so the n-th copy of a card goes to the deck whose running total of
    // that card first reaches n.
    await run(`
      INSERT OR IGNORE INTO deck_allocations (entry_id, deck_id, card_id, quantity)
      SELECT e.entry_id, r.deck_id, r.card_id, 1
      FROM (
        SELECT d.user_id, dc.deck_id, dc.card_id, dc.quantity,
               SUM(dc.quantity) OVER (PARTITION BY d.user_id, dc.card_id ORDER BY d.checked_out_at, d.id) AS upto
        FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
        WHERE d.checked_out = 1 AND dc.quantity > 0
      ) r
      JOIN (
        SELECT c.id AS entry_id, c.user_id, c.card_id,
               ROW_NUMBER() OVER (
                 PARTITION BY c.user_id, c.card_id
                 ORDER BY (c.location_id IS NOT NULL) DESC, c.added_at DESC, c.id DESC
               ) AS rn
        FROM collection c WHERE c.list_type = 'collection'
      ) e ON e.user_id = r.user_id AND e.card_id = r.card_id
         AND e.rn > r.upto - r.quantity AND e.rn <= r.upto
    `);
  }

  // --- PERFORMANCE INDEXES --- (schema.js has what each one serves)
  await create(
    'idx_collection_user_game', 'idx_collection_user_card', 'idx_collection_comp_user_qty', 'idx_collection_loc_pos',
    'idx_collection_user_list_added', 'idx_collection_sealed_unit', 'idx_tcgplayer_catalog_no_game',
    'idx_card_cache_set_num', 'idx_deck_cards_checkout'
  );
  // Indexes on the retired tags/audit_logs tables. A fresh database never creates
  // those tables at all now; an upgraded one keeps them (dropping a table is not
  // something a migration should do to data it cannot restore), but nothing reads
  // them, so the indexes are pure write cost.
  await run(`DROP INDEX IF EXISTS idx_collection_tags_tag_id`);
  await run(`DROP INDEX IF EXISTS idx_audit_logs_user_date`);

  await create('collection_trash', 'idx_collection_trash_user_batch', 'idx_collection_trash_deleted');

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

  // The pre-1.9 wishlist (collection rows with list_type = 'wishlist') moves onto
  // each user's default Wishlist (utils/wishlistMigration.js). After every step
  // above, so it also catches the rows a pre-compartment upgrade copies in,
  // which a call next to the card_lists tables only reached on the second boot.
  await require('../utils/wishlistMigration').migrateLegacyWishlists();

  // Last: this release has now brought the file up to date. Not written when a
  // step above throws, so the next boot still knows the migration is unfinished.
  await run(`PRAGMA user_version = ${releaseMarker(SCHEMA_RELEASE)}`);
}

// The rest of the pre-compartment upgrade started at the top of initDb: copy the
// set-aside rows into the current tables, then rename the originals to their
// final legacy_* names, all in one transaction. Those names existing is what
// says it is done, so this never runs twice, and the originals stay as a
// recovery copy: nothing in them is deleted.
//
// Cards come across unplaced (no location, no compartment), so they show up in
// Unsorted. Their old places were page/slot strings in containers whose shape no
// longer exists, and guessing a compartment would file cards where they are not.
// Locations come across as plain containers with no compartments, if their type,
// sort order and foil setting still mean something; the rest are listed in the
// log to be recreated.
const LEGACY_COLLECTION = 'legacy_collection_pre_compartments';
const LEGACY_LOCATIONS = 'legacy_locations_pre_compartments';
const LOCATION_TYPES = ['Binder', 'Toploader Binder', 'Box', 'Toploader Box', 'Graded Slab Box', 'Display Shelf / Stand', 'Deck Box', 'Tin / Case', 'Other'];

async function finishPreCompartmentUpgrade() {
  const pendingCollection = `${LEGACY_COLLECTION}_pending`;
  const pendingLocations = `${LEGACY_LOCATIONS}_pending`;
  const pending = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [pendingCollection]);
  if (!pending) return;

  const sortSchemes = require('../../../shared/sortSchemes.json');
  const sortOrderKnown = (v) => v == null || v === 'custom' || Object.prototype.hasOwnProperty.call(sortSchemes, v) ||
    (typeof v === 'string' && v.startsWith('[') && (() => { try { return Array.isArray(JSON.parse(v)); } catch { return false; } })());
  const columnsOf = async (table) => (await all(`PRAGMA table_info(${table})`)).map(c => c.name);

  // Off for the copy, so a card whose card_cache row went missing years ago is
  // carried over as it was instead of failing the whole upgrade. The pragma is a
  // no-op inside a transaction, hence out here.
  await run(`PRAGMA foreign_keys = OFF`);
  try {
    const result = await withTransaction(async () => {
      const hasLocations = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [pendingLocations]);
      const migratedLocations = [];
      const skippedLocations = [];
      if (hasLocations) {
        const legacyLocCols = await columnsOf(pendingLocations);
        const legacyLocs = await all(`SELECT * FROM ${pendingLocations} ORDER BY id`);
        for (const loc of legacyLocs) {
          const clean = LOCATION_TYPES.includes(loc.type) && sortOrderKnown(loc.sort_order) &&
            (loc.foil_sorting == null || ['normals_first', 'foils_first'].includes(loc.foil_sorting));
          if (!clean) { skippedLocations.push(loc); continue; }
          // Same id, so the legacy rows' location_id still names the container.
          const row = { id: loc.id, name: loc.name, type: loc.type, user_id: legacyLocCols.includes('user_id') ? loc.user_id : null };
          if (loc.sort_order != null) row.sort_order = loc.sort_order;
          if (loc.foil_sorting != null) row.foil_sorting = loc.foil_sorting;
          const cols = Object.keys(row);
          await run(`INSERT INTO locations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c]));
          migratedLocations.push(loc);
        }
      }

      // Every column both tables share, id included so a new row can be matched
      // to its legacy original. Placement is left to the new table's defaults.
      const newCols = await columnsOf('collection');
      const unplaced = new Set(['location_id', 'compartment_id', 'position']);
      const shared = (await columnsOf(pendingCollection)).filter(c => newCols.includes(c) && !unplaced.has(c));
      const copied = await run(
        `INSERT INTO collection (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM ${pendingCollection} ORDER BY id`
      );

      await run(`ALTER TABLE ${pendingCollection} RENAME TO ${LEGACY_COLLECTION}`);
      if (hasLocations) await run(`ALTER TABLE ${pendingLocations} RENAME TO ${LEGACY_LOCATIONS}`);
      return { cards: copied.changes, migratedLocations, skippedLocations, hasLocations };
    });

    console.log(`Pre-compartment upgrade: copied ${result.cards} collection row(s) into Unsorted and ` +
      `${result.migratedLocations.length} location(s) as containers without pages/rows (add them in Storage).`);
    if (result.migratedLocations.some(l => l.description)) {
      console.log('Location descriptions are not part of the current schema; they remain in the legacy table.');
    }
    for (const loc of result.skippedLocations) {
      console.log(`  Not migrated, recreate by hand: location #${loc.id} "${loc.name}" (type ${loc.type}, sort ${loc.sort_order}, user ${loc.user_id}).`);
    }
    console.log(`The original rows are kept in ${LEGACY_COLLECTION}${result.hasLocations ? ` and ${LEGACY_LOCATIONS}` : ''}.`);
  } finally {
    await run(`PRAGMA foreign_keys = ON`);
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
//
// `newAccount` is every route that creates an account (the owner's bootstrap,
// registration, an admin's Add User, SSO sign-up): it counts that account's own
// locations, so each new account gets the pair. Counting the whole install's, as
// this used to for everyone, gave them to the first account and to no one after.
//
// Without it, the install-wide count stays: initDb calls this at every boot for
// the existing owner, and an owner who deleted their starter locations must not
// get them back on each restart.
async function seedStarterLocations(userId, { newAccount = false } = {}) {
  const locCount = newAccount
    ? await get(`SELECT COUNT(*) as count FROM locations WHERE user_id = ?`, [userId])
    : await get(`SELECT COUNT(*) as count FROM locations`);
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
  initDb,
  splitStackedRows,
  createCompartments,
  seedStarterLocations,
  adoptOrphanRows,
  hashPassword,
};
