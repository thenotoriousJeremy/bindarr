// Every table and index, as the CREATE ... IF NOT EXISTS statement that makes
// it, keyed by the table's or index's name and listed in the order initDb
// (./migrations.js) creates them. initDb decides when each one runs: most before
// any migration, some only after the migration that adds a column they need, or
// the migration that has to look before the table exists. On a database that
// already has the table or index, the statement does nothing.
//
// A new database gets each table from its CREATE TABLE here, then gains through
// initDb's addColumns every column that only a migration adds; an older database
// gains the columns it lacks the same way.
//
// Keep the SQL text exactly as it is, whitespace included: SQLite stores it in
// sqlite_master, so a reformatted statement would give a new database schema
// text that differs from every existing one's.
module.exports = {
  users: `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('admin', 'member')) NOT NULL DEFAULT 'member',
      share_token TEXT UNIQUE NOT NULL,
      share_enabled INTEGER DEFAULT 0,
      oidc_sub TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,

  sessions: `
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,

  app_settings: `
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_base_url TEXT DEFAULT ''
    )
  `,

  locations: `
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
  `,

  compartments: `
    CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      label TEXT,
      capacity INTEGER NOT NULL DEFAULT 40,
      rule_config TEXT,
      UNIQUE(location_id, idx)
    )
  `,

  compartment_assignments: `
    CREATE TABLE IF NOT EXISTS compartment_assignments (
      compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
      filter_value TEXT NOT NULL,
      PRIMARY KEY(compartment_id, filter_value)
    )
  `,

  sets: `
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
  `,

  card_cache: `
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
      image_url_back TEXT,
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
  `,

  collection: `
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
  `,

  price_history: `
    CREATE TABLE IF NOT EXISTS price_history (
      card_id TEXT NOT NULL,
      price REAL NOT NULL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(card_id, recorded_at)
    )
  `,

  // The ECB's daily euro reference rates (fxRates.js), one row per currency per
  // publication date. Prices stay stored in the currency the marketplace quoted;
  // these only convert them for display, and the date travels with every
  // conversion so a total can say how old its rate is.
  fx_rates: `
    CREATE TABLE IF NOT EXISTS fx_rates (
      rate_date TEXT NOT NULL,
      currency TEXT NOT NULL,
      rate REAL NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(rate_date, currency)
    )
  `,

  // card_cache id -> TCGplayer productId, for the Pokémon rows whose providers do
  // not carry one (TCGdex supplies none at all; Scryfall gives MTG its id directly,
  // so MTG never needs a row here).
  //
  // Its own table rather than a card_cache column because the mapping is derived,
  // not provider data: it is rebuilt by matching set+number against TCGplayer's
  // catalogue, and `confidence` records how — 1 for an exact set match, 0.8 for one
  // recovered from a name suffix. Keeping it separate means a rebuild can be
  // discarded and redone without touching a single real card row.
  tcgplayer_product: `
    CREATE TABLE IF NOT EXISTS tcgplayer_product (
      card_id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      confidence REAL DEFAULT 1,
      matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(card_id) REFERENCES card_cache(id)
    )
  `,
  idx_tcgplayer_product_pid: `CREATE INDEX IF NOT EXISTS idx_tcgplayer_product_pid ON tcgplayer_product(product_id)`,

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
  tcgplayer_catalog: `
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
  `,

  // Sets the provider LISTS but has no usable card data for — no cards at all, or
  // cards with no artwork, which a scan catalog cannot use either way.
  //
  // Recorded so "N sets have no cards here yet" stops counting them. Measured on a
  // real install: all 46 uncached English Pokemon sets were of this kind (promos,
  // samples, jumbo cards, trainer kits), so the panel told the user to build sets
  // that can never be built, and the weekly auto-update chased a number that could
  // never drop. A build fills this in as it walks; a set whose data appears later
  // clears its own row.
  set_data_gaps: `
    CREATE TABLE IF NOT EXISTS set_data_gaps (
      game TEXT NOT NULL,
      language TEXT NOT NULL,
      set_id TEXT NOT NULL,
      reason TEXT,
      seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (game, language, set_id)
    )
  `,

  // Which cards a set holds, as its provider listed them (setListing.js). The
  // cards themselves are in card_cache; this records that the list is COMPLETE,
  // which card_cache cannot say — a set's rows arrive there one search at a time.
  // `source` is the provider that listed it, so a Pokémon provider switch (a
  // different numbering of the same set) reads as stale rather than as current.
  set_listings: `
    CREATE TABLE IF NOT EXISTS set_listings (
      game TEXT NOT NULL,
      language TEXT NOT NULL,
      set_id TEXT NOT NULL,
      source TEXT,
      card_ids TEXT NOT NULL,
      meta TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (game, language, set_id)
    )
  `,

  // Cached PSA cert lookups. Cached forever, with no staleness check anywhere —
  // deliberate, and the only table in this schema like that: a cert describes a
  // slab that was sealed once and graded once. The grade cannot change, so a
  // second request can only return the same answer while spending quota from a
  // rate-limited token.
  //
  // `payload` is the provider response as received, not a parsed subset. The
  // fields worth reading are still being learned, and re-deriving them from a
  // stored response beats re-fetching 400 certs to pick up one more column.
  psa_cert: `
    CREATE TABLE IF NOT EXISTS psa_cert (
      cert_number TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,

  decks: `
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
  `,

  deck_cards: `
    CREATE TABLE IF NOT EXISTS deck_cards (
      deck_id INTEGER NOT NULL,
      card_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      checked_out INTEGER DEFAULT 0,
      PRIMARY KEY(deck_id, card_id),
      FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
    )
  `,

  notes: `
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
  `,

  // One purchase event: N identical sealed units bought together (store, date,
  // unit price). Product/set/type/image fields are a snapshot at purchase time so
  // a later catalog rebuild can't rewrite purchase history out from under a user.
  sealed_purchases: `
    CREATE TABLE IF NOT EXISTS sealed_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      set_name TEXT,
      sealed_type TEXT,
      game TEXT NOT NULL DEFAULT 'pokemon',
      image_url TEXT,
      store TEXT,
      purchase_date TEXT,
      unit_price REAL,
      quantity INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      available_to_all INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  idx_sealed_purchases_user: `CREATE INDEX IF NOT EXISTS idx_sealed_purchases_user ON sealed_purchases(user_id)`,

  // One row per physical unit in a purchase, so a box of 2 can have one opened and
  // one still sealed. opened_at NULL means still sealed.
  sealed_units: `
    CREATE TABLE IF NOT EXISTS sealed_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      opened_at DATETIME,
      claimed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(purchase_id) REFERENCES sealed_purchases(id) ON DELETE CASCADE
    )
  `,
  idx_sealed_units_purchase: `CREATE INDEX IF NOT EXISTS idx_sealed_units_purchase ON sealed_units(purchase_id)`,

  // A reusable "recipe" for what a product actually contains (TCGCSV publishes no
  // contents data, so this is typed in once by the user and matched to every
  // future purchase of the same product — by product_id when known, else by an
  // exact product_name match; see the match query in routes/sealed.js).
  sealed_templates: `
    CREATE TABLE IF NOT EXISTS sealed_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      game TEXT NOT NULL DEFAULT 'pokemon',
      expected_cards INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `,

  // One row per guaranteed thing inside a template. A 'card' component is a
  // specific guaranteed pull (an alt-art promo, an oversized card) — not a whole
  // decklist, since quantity multiplies ONE card_id. A 40-card precon deck is
  // instead a 'product' component (its own sealed sub-item, opened and linked
  // later like any other box) rather than 40 enumerated cards.
  sealed_template_components: `
    CREATE TABLE IF NOT EXISTS sealed_template_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      component_type TEXT CHECK(component_type IN ('card', 'product')) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      card_id TEXT,
      product_name TEXT,
      sealed_type TEXT,
      product_id INTEGER,
      game TEXT,
      expected_cards INTEGER,
      FOREIGN KEY(template_id) REFERENCES sealed_templates(id) ON DELETE CASCADE
    )
  `,
  idx_sealed_template_components_template: `CREATE INDEX IF NOT EXISTS idx_sealed_template_components_template ON sealed_template_components(template_id)`,

  // Named card lists: wishlists, buylists, "what this deck still needs" lists.
  // Cards wanted, not cards owned — so neither the collection table (rows there
  // are physical copies with a slot) nor a deck (format rules, checkout). Owned
  // and missing counts are computed against the collection on read
  // (utils/listOwnership.js), never stored, so they cannot go stale.
  //
  // `game` NULL means the list takes cards of any game. `deck_id` links a
  // 'missing' list to the deck it was built from, so rebuilding it updates the
  // same list; SET NULL keeps the shopping list when the deck is deleted.
  card_lists: `
    CREATE TABLE IF NOT EXISTS card_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'wishlist' CHECK(kind IN ('wishlist', 'buylist', 'missing', 'custom')),
      game TEXT,
      notes TEXT DEFAULT '',
      deck_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE SET NULL
    )
  `,
  // One row per wanted card: adding a card already on the list merges into its
  // quantity rather than listing it twice. `any_printing` counts every printing
  // of the same card (same game, same name) as owned; condition_min and language
  // narrow which owned copies count.
  card_list_items: `
    CREATE TABLE IF NOT EXISTS card_list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL,
      card_id TEXT NOT NULL,
      quantity_wanted INTEGER NOT NULL DEFAULT 1 CHECK(quantity_wanted BETWEEN 1 AND 9999),
      any_printing INTEGER NOT NULL DEFAULT 0,
      condition_min TEXT CHECK(condition_min IS NULL OR condition_min IN ('Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged')),
      language TEXT,
      notes TEXT DEFAULT '',
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(list_id, card_id),
      FOREIGN KEY(list_id) REFERENCES card_lists(id) ON DELETE CASCADE,
      FOREIGN KEY(card_id) REFERENCES card_cache(id)
    )
  `,
  idx_card_lists_user: `CREATE INDEX IF NOT EXISTS idx_card_lists_user ON card_lists(user_id)`,
  // On card_lists.is_default, which a migration adds (see initDb).
  idx_card_lists_default: `CREATE UNIQUE INDEX IF NOT EXISTS idx_card_lists_default ON card_lists(user_id) WHERE is_default = 1`,

  // Notifications (notify.js). A channel is somewhere one user's notifications go.
  // `url` and `token` are secrets — a Discord webhook URL IS its credential — so
  // the API reports has_url/has_token and never the values (routes/notifications).
  notification_channels: `
    CREATE TABLE IF NOT EXISTS notification_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('discord', 'ntfy', 'webhook', 'apprise')),
      name TEXT,
      url TEXT NOT NULL,
      topic TEXT,
      token TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      events_price INTEGER NOT NULL DEFAULT 1,
      events_admin INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
  idx_notification_channels_user: `CREATE INDEX IF NOT EXISTS idx_notification_channels_user ON notification_channels(user_id)`,
  // Per-user price-move thresholds. A move notifies when it clears EITHER bar;
  // a NULL bar is off. min_price keeps a 5¢ card's 100% move out of the digest.
  notification_prefs: `
    CREATE TABLE IF NOT EXISTS notification_prefs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      price_enabled INTEGER NOT NULL DEFAULT 1,
      price_pct REAL DEFAULT 15,
      price_abs REAL DEFAULT 5,
      min_price REAL DEFAULT 1,
      include_wishlist INTEGER NOT NULL DEFAULT 1
    )
  `,
  // The price each user was last told about, per card: "moved more than X since
  // the last notification" is measured from here, so a card drifting 2% a day is
  // reported once it has drifted far enough, and not again until it moves again.
  notification_price_state: `
    CREATE TABLE IF NOT EXISTS notification_price_state (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL,
      price REAL NOT NULL,
      currency TEXT,
      notified_at DATETIME,
      PRIMARY KEY (user_id, card_id)
    )
  `,
  // Every delivery, one row per message per channel. Doubles as the outbound
  // queue — status 'pending' rows survive a restart and are retried — and as the
  // dedupe record for admin events (dedupe_key).
  notification_log: `
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id INTEGER REFERENCES notification_channels(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      dedupe_key TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed', 'dropped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME
    )
  `,
  idx_notification_log_queue: `CREATE INDEX IF NOT EXISTS idx_notification_log_queue ON notification_log(status, next_attempt_at)`,
  idx_notification_log_dedupe: `CREATE INDEX IF NOT EXISTS idx_notification_log_dedupe ON notification_log(user_id, dedupe_key, created_at)`,

  // Binder artwork: a picture one user uploaded, not a card. It never joins
  // collection, so it cannot reach counts, set completion or value. The bytes
  // live on disk beside the database (utils/binderArtStore.js); this row is the
  // ownership record every read checks.
  binder_artwork: `
    CREATE TABLE IF NOT EXISTS binder_artwork (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      mime TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  idx_binder_artwork_user: `CREATE INDEX IF NOT EXISTS idx_binder_artwork_user ON binder_artwork(user_id)`,

  // Where one picture sits on a binder page, in millimetres, and which pockets
  // show it (mask: [{ side, row, col }]). One layer per page; `spread` carries it
  // onto the next page as the right half of a two-page spread. No location_id:
  // a page can move to another binder, and the compartment already knows where
  // it lives. Pocket size and spacing are per layer because they describe the
  // physical page the inserts are cut for.
  binder_art_layers: `
    CREATE TABLE IF NOT EXISTS binder_art_layers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      compartment_id INTEGER NOT NULL UNIQUE,
      artwork_id INTEGER NOT NULL,
      x_mm REAL NOT NULL,
      y_mm REAL NOT NULL,
      width_mm REAL NOT NULL,
      rotation_deg REAL NOT NULL DEFAULT 0,
      spread INTEGER NOT NULL DEFAULT 0,
      mask TEXT NOT NULL DEFAULT '[]',
      pocket_w_mm REAL NOT NULL DEFAULT 63,
      pocket_h_mm REAL NOT NULL DEFAULT 88,
      gap_mm REAL NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(compartment_id) REFERENCES compartments(id) ON DELETE CASCADE,
      FOREIGN KEY(artwork_id) REFERENCES binder_artwork(id) ON DELETE CASCADE
    )
  `,
  idx_binder_art_layers_user: `CREATE INDEX IF NOT EXISTS idx_binder_art_layers_user ON binder_art_layers(user_id)`,

  // --- Created among the migrations (initDb has where and why) ---

  // Keep ETags and complete pages across restarts: card_cache alone cannot tell
  // whether a set or a search result was fully paged. Credentials are never stored.
  pokemontcgapi_cache: `CREATE TABLE IF NOT EXISTS pokemontcgapi_cache (
    request TEXT PRIMARY KEY, body TEXT NOT NULL, etag TEXT, fetched_at INTEGER NOT NULL
  )`,

  // TCGCSV responses, cut down to the fields Bindarr reads (utils/tcgcsvSlim.js).
  tcgcsv_cache: `
    CREATE TABLE IF NOT EXISTS tcgcsv_cache (
      path TEXT NOT NULL,
      data_version TEXT NOT NULL,
      results_json TEXT NOT NULL,
      PRIMARY KEY (path, data_version)
    )
  `,

  // The admin-run Pokémon card-id migration (pokemonMigration.js): its runs, the
  // old -> new id log, and the before-images an exact undo needs. initDb has why.
  pokemon_id_migration_runs: `CREATE TABLE IF NOT EXISTS pokemon_id_migration_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_provider TEXT NOT NULL, previous_provider TEXT,
    backup_file TEXT, summary TEXT, started_at TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reverted_at DATETIME, revert_summary TEXT
  )`,
  pokemon_id_migration_log: `CREATE TABLE IF NOT EXISTS pokemon_id_migration_log (
    run_id INTEGER NOT NULL REFERENCES pokemon_id_migration_runs(id), old_id TEXT NOT NULL, new_id TEXT NOT NULL,
    method TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (run_id, old_id)
  )`,
  idx_pokemon_id_migration_log_new: `CREATE INDEX IF NOT EXISTS idx_pokemon_id_migration_log_new ON pokemon_id_migration_log(new_id)`,
  pokemon_id_migration_undo: `CREATE TABLE IF NOT EXISTS pokemon_id_migration_undo (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, tbl TEXT NOT NULL, action TEXT NOT NULL,
    ref TEXT, old_id TEXT, new_id TEXT, data TEXT
  )`,
  idx_pokemon_id_migration_undo_run: `CREATE INDEX IF NOT EXISTS idx_pokemon_id_migration_undo_run ON pokemon_id_migration_undo(run_id, tbl, action)`,

  // One recipe per product and game (#168). Created once the recipes are shared
  // and any duplicates merged (migrateSealedTemplatesToShared, ./migrations.js).
  idx_sealed_templates_user: `CREATE INDEX IF NOT EXISTS idx_sealed_templates_user ON sealed_templates(user_id)`,
  idx_sealed_templates_global_product: `CREATE UNIQUE INDEX IF NOT EXISTS idx_sealed_templates_global_product
    ON sealed_templates(game, product_id) WHERE product_id IS NOT NULL`,
  idx_sealed_templates_global_name: `CREATE UNIQUE INDEX IF NOT EXISTS idx_sealed_templates_global_name
    ON sealed_templates(game, product_name COLLATE NOCASE) WHERE product_id IS NULL`,

  idx_sealed_units_claimed_by_user: `CREATE INDEX IF NOT EXISTS idx_sealed_units_claimed_by_user ON sealed_units(claimed_by_user_id)`,

  // A transfer is a proposal between two users. Item rows snapshot the asset at
  // proposal time and keep nullable source links so completed history survives
  // when the original collection row or sealed unit is later removed.
  //
  // Deleting one of the two accounts must not take the other one's history with
  // it, so every user reference is SET NULL, and the names the history shows are
  // snapshotted at creation (proposer_name, recipient_name).
  user_transfers: `
    CREATE TABLE IF NOT EXISTS user_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposer_id INTEGER,
      recipient_id INTEGER,
      proposer_name TEXT NOT NULL DEFAULT '',
      recipient_name TEXT NOT NULL DEFAULT '',
      transfer_type TEXT NOT NULL CHECK(transfer_type IN ('gift', 'trade')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'accepted', 'rejected', 'cancelled', 'countered')),
      response_to_transfer_id INTEGER,
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      CHECK(proposer_id != recipient_id),
      FOREIGN KEY(proposer_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(recipient_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(response_to_transfer_id) REFERENCES user_transfers(id) ON DELETE SET NULL
    )
  `,
  idx_user_transfers_proposer_status: `CREATE INDEX IF NOT EXISTS idx_user_transfers_proposer_status ON user_transfers(proposer_id, status, created_at)`,
  idx_user_transfers_recipient_status: `CREATE INDEX IF NOT EXISTS idx_user_transfers_recipient_status ON user_transfers(recipient_id, status, created_at)`,

  user_transfer_items: `
    CREATE TABLE IF NOT EXISTS user_transfer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id INTEGER NOT NULL,
      from_user_id INTEGER,
      to_user_id INTEGER,
      item_type TEXT NOT NULL CHECK(item_type IN ('card', 'sealed')),
      source_collection_id INTEGER,
      source_sealed_unit_id INTEGER,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
      purchase_cost REAL,
      received_cost REAL,
      item_snapshot TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(transfer_id) REFERENCES user_transfers(id) ON DELETE CASCADE,
      FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(source_collection_id) REFERENCES collection(id) ON DELETE SET NULL,
      FOREIGN KEY(source_sealed_unit_id) REFERENCES sealed_units(id) ON DELETE SET NULL
    )
  `,
  idx_user_transfer_items_transfer: `CREATE INDEX IF NOT EXISTS idx_user_transfer_items_transfer ON user_transfer_items(transfer_id)`,
  idx_user_transfer_items_collection: `CREATE INDEX IF NOT EXISTS idx_user_transfer_items_collection ON user_transfer_items(source_collection_id)`,
  idx_user_transfer_items_sealed_unit: `CREATE INDEX IF NOT EXISTS idx_user_transfer_items_sealed_unit ON user_transfer_items(source_sealed_unit_id)`,

  historical_trades: `
    CREATE TABLE IF NOT EXISTS historical_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER,
      recipient_id INTEGER,
      creator_name TEXT NOT NULL DEFAULT '',
      recipient_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending_confirmation'
        CHECK(status IN ('pending_confirmation', 'confirmed', 'rejected')),
      completed_at TEXT NOT NULL,
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME,
      CHECK(creator_id != recipient_id),
      FOREIGN KEY(creator_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(recipient_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `,
  idx_historical_trades_creator: `CREATE INDEX IF NOT EXISTS idx_historical_trades_creator
    ON historical_trades(creator_id, status, completed_at DESC)`,
  idx_historical_trades_recipient: `CREATE INDEX IF NOT EXISTS idx_historical_trades_recipient
    ON historical_trades(recipient_id, status, completed_at DESC)`,

  historical_trade_items: `
    CREATE TABLE IF NOT EXISTS historical_trade_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL,
      from_user_id INTEGER,
      to_user_id INTEGER,
      card_id TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
      item_snapshot TEXT NOT NULL,
      creator_collection_id INTEGER,
      recipient_collection_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(trade_id) REFERENCES historical_trades(id) ON DELETE CASCADE,
      FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(creator_collection_id) REFERENCES collection(id) ON DELETE SET NULL,
      FOREIGN KEY(recipient_collection_id) REFERENCES collection(id) ON DELETE SET NULL
    )
  `,
  idx_historical_trade_items_trade: `CREATE INDEX IF NOT EXISTS idx_historical_trade_items_trade
    ON historical_trade_items(trade_id, id)`,
  idx_historical_trade_items_collection: `CREATE INDEX IF NOT EXISTS idx_historical_trade_items_collection
    ON historical_trade_items(creator_collection_id, recipient_collection_id)`,

  external_contacts: `
    CREATE TABLE IF NOT EXISTS external_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  idx_external_contacts_user_name: `CREATE UNIQUE INDEX IF NOT EXISTS idx_external_contacts_user_name
    ON external_contacts(user_id, name COLLATE NOCASE)`,
  idx_external_contacts_user: `CREATE INDEX IF NOT EXISTS idx_external_contacts_user ON external_contacts(user_id, name)`,

  external_transactions: `
    CREATE TABLE IF NOT EXISTS external_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      contact_id INTEGER,
      contact_name_snapshot TEXT NOT NULL,
      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('gift', 'trade')),
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(contact_id) REFERENCES external_contacts(id) ON DELETE SET NULL
    )
  `,
  idx_external_transactions_user_created: `CREATE INDEX IF NOT EXISTS idx_external_transactions_user_created
    ON external_transactions(user_id, created_at DESC)`,

  external_transaction_items: `
    CREATE TABLE IF NOT EXISTS external_transaction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('given', 'received')),
      item_type TEXT NOT NULL CHECK(item_type IN ('card', 'sealed')),
      source_collection_id INTEGER,
      source_sealed_unit_id INTEGER,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
      purchase_cost REAL,
      received_cost REAL,
      item_snapshot TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(transaction_id) REFERENCES external_transactions(id) ON DELETE CASCADE,
      FOREIGN KEY(source_collection_id) REFERENCES collection(id) ON DELETE SET NULL,
      FOREIGN KEY(source_sealed_unit_id) REFERENCES sealed_units(id) ON DELETE SET NULL
    )
  `,
  idx_external_transaction_items_transaction: `CREATE INDEX IF NOT EXISTS idx_external_transaction_items_transaction
    ON external_transaction_items(transaction_id)`,
  idx_external_transaction_items_collection: `CREATE INDEX IF NOT EXISTS idx_external_transaction_items_collection
    ON external_transaction_items(source_collection_id, direction)`,

  // Which transfer, recorded trade or outside deal brought a copy in. Partial: most
  // copies came from none, and a SET NULL cascade from a deleted history row looks
  // its rows up here instead of scanning the collection.
  idx_collection_acquired_transfer: `CREATE INDEX IF NOT EXISTS idx_collection_acquired_transfer
    ON collection(acquired_via_transfer_item_id) WHERE acquired_via_transfer_item_id IS NOT NULL`,
  idx_collection_acquired_historical: `CREATE INDEX IF NOT EXISTS idx_collection_acquired_historical
    ON collection(acquired_via_historical_trade_item_id) WHERE acquired_via_historical_trade_item_id IS NOT NULL`,
  idx_collection_acquired_external: `CREATE INDEX IF NOT EXISTS idx_collection_acquired_external
    ON collection(acquired_via_external_item_id) WHERE acquired_via_external_item_id IS NOT NULL`,

  // A cert number identifies one physical slab, so entering it twice is a mistake
  // rather than a second copy — unlike raw cards, where two identical rows are
  // normal and `quantity` exists for exactly that reason.
  //
  // Scoped per user, and partial. Per user because this instance cannot know that
  // two accounts naming the same cert are wrong (a sold slab legitimately appears
  // in the buyer's collection and the seller's history); partial because the
  // overwhelming majority of rows are raw and have no cert, and a plain UNIQUE
  // would collapse all of them into one.
  idx_collection_cert: `CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_cert
       ON collection(user_id, grader, cert_number)
     WHERE cert_number IS NOT NULL AND cert_number != ''`,

  idx_users_api_key: `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key) WHERE api_key IS NOT NULL`,
  idx_users_oidc_sub: `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL`,

  // When each background job last ran (scheduler.js). The weekly set refresh and
  // the daily backup used to live on in-memory timers that every restart reset,
  // so an install that updates weekly never refreshed its sets and one that
  // restarts daily never backed up. One row per job name; last_run_at is when the
  // most recent finished run started, last_status 'ok', 'error' or 'baseline'
  // (a clock started without a run, see scheduler.js).
  job_runs: `
    CREATE TABLE IF NOT EXISTS job_runs (
      name TEXT PRIMARY KEY,
      last_run_at DATETIME,
      last_status TEXT,
      last_error TEXT
    )
  `,

  // The copies a checked-out deck holds. The collection entry is the key, so one
  // physical card can be in one deck at a time — two checkouts cannot both claim it
  // (utils/deckAllocation.js). `card_id` is the deck card the copy fills, which for
  // a deck accepting any printing may be another printing than the copy's own.
  deck_allocations: `
    CREATE TABLE IF NOT EXISTS deck_allocations (
      entry_id INTEGER PRIMARY KEY REFERENCES collection(id) ON DELETE CASCADE,
      deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      allocated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
  idx_deck_allocations_deck: `CREATE INDEX IF NOT EXISTS idx_deck_allocations_deck ON deck_allocations(deck_id)`,

  // --- PERFORMANCE INDEXES ---
  // `user_id` first, because it is the predicate on essentially every read in the
  // app — every collection query, every stats aggregate — and nothing indexed it.
  // idx_collection_comp_user_qty below cannot serve it: a composite index is only
  // usable from its leading column, and that one leads with compartment_id.
  idx_collection_user_game: `CREATE INDEX IF NOT EXISTS idx_collection_user_game ON collection(user_id, game)`,
  // "This user's copies of this card": owned counts on search results, deck
  // availability, the copies a quantity edit adds or trims, and the cards behind
  // the value timeline (routes/stats.js). user_id alone narrows to the whole
  // collection and leaves every lookup a scan of it.
  idx_collection_user_card: `CREATE INDEX IF NOT EXISTS idx_collection_user_card ON collection(user_id, card_id)`,
  idx_collection_comp_user_qty: `CREATE INDEX IF NOT EXISTS idx_collection_comp_user_qty ON collection(compartment_id, user_id, quantity)`,
  idx_collection_loc_pos: `CREATE INDEX IF NOT EXISTS idx_collection_loc_pos ON collection(location_id, position)`,
  // The collection list, newest first, a page at a time: GET /collection orders by
  // added_at DESC, id DESC within one list, and without this sorted the whole
  // collection for every page.
  idx_collection_user_list_added: `CREATE INDEX IF NOT EXISTS idx_collection_user_list_added ON collection(user_id, list_type, added_at, id)`,
  // The copies pulled from a sealed unit. Partial, because most copies came from
  // no unit at all. Without it every unit's linked-card count (and the foreign-key
  // check when a unit is deleted) scanned the whole collection: listing 300 units
  // took four seconds.
  idx_collection_sealed_unit: `CREATE INDEX IF NOT EXISTS idx_collection_sealed_unit ON collection(sealed_unit_id) WHERE sealed_unit_id IS NOT NULL`,
  // The product-map rows written before `game` existed, for the backfill in initDb
  // that runs every boot. Nothing writes a NULL game any more, so this holds no rows,
  // costs nothing to keep, and turns that backfill's full scan into a lookup.
  idx_tcgplayer_catalog_no_game: `CREATE INDEX IF NOT EXISTS idx_tcgplayer_catalog_no_game ON tcgplayer_catalog(category_id) WHERE game IS NULL`,
  idx_card_cache_set_num: `CREATE INDEX IF NOT EXISTS idx_card_cache_set_num ON card_cache(set_id, number)`,
  idx_deck_cards_checkout: `CREATE INDEX IF NOT EXISTS idx_deck_cards_checkout ON deck_cards(deck_id, checked_out)`,

  // Deleted copies, kept 30 days so a delete can be undone (utils/collectionTrash.js).
  // The whole collection row is kept as JSON rather than as mirrored columns, so a
  // column added to collection later is carried through a delete and restore
  // without this table having to learn about it. entry_id is the row's original
  // id: AUTOINCREMENT never hands it out again, so it can come back under it.
  collection_trash: `
    CREATE TABLE IF NOT EXISTS collection_trash (
      entry_id INTEGER PRIMARY KEY,
      batch_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id TEXT,
      deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      row_json TEXT NOT NULL,
      links_json TEXT
    )
  `,
  idx_collection_trash_user_batch: `CREATE INDEX IF NOT EXISTS idx_collection_trash_user_batch ON collection_trash(user_id, batch_id)`,
  idx_collection_trash_deleted: `CREATE INDEX IF NOT EXISTS idx_collection_trash_deleted ON collection_trash(deleted_at)`,
};
