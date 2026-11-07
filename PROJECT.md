# Bindarr — Architecture & Developer Guide

Developer-facing reference for the codebase. For install/run/deploy and end-user
features, see [README.md](README.md); this document explains **how the system is
built and why**.

Bindarr is a self-hosted trading-card collection manager for **Pokémon**,
**Magic: The Gathering**, **Disney Lorcana** and **Riftbound**. It identifies cards from a phone photo (no typing),
tracks their real-world physical location (which binder page / box row slot),
values the collection over time, and helps you pull and re-file the cards for a
deck.

- **Backend**: Node.js + Express, SQLite (single file), served together with the built frontend from one container.
- **Frontend**: React + Vite SPA.
- **Auth**: opaque session tokens in a server-side `sessions` table, sent as a `Bearer` header.
- **Card data**: Pokémon TCG API / TCGdex / optional pokemontcgapi.com (Pokémon), Scryfall (MTG), and Lorcast (Disney Lorcana), cached locally in `card_cache`.
- **Image ID**: two small ONNX models — `cornelius` finds the card's corners, `milo` embeds the dewarped card as a 128-d unit vector — then a brute-force cosine sweep over a prebuilt catalog of every cached card's artwork. Corner detection also runs in the browser, so the outline on screen is the crop that gets matched.

Stack: React + Vite + Recharts on the front, Express + `sqlite3` + Helmet +
`express-rate-limit` on the back, `onnxruntime-node` + `sharp` for images on the
server and `onnxruntime-web` in a worker on the client, Docker + GitHub Actions
to ship.

---

## Repository layout

```
backend/
  src/
    server.js              Express app: middleware, route mounts, static SPA, health, job list, startup/shutdown
    db.js                  SQLite connection (promisified run/get/all), schema init, password hashing
    scheduler.js           Background jobs on clocks kept in job_runs, checked every 15 minutes
    middleware/auth.js     authenticateToken (session lookup), requireAdmin, rate limiters
    routes/
      auth.js              register / login / logout / me / per-user settings
      collection.js        collection CRUD, locations & compartments, sorting, scan-match, stats, import/export
      decks.js             deck CRUD, deck cards, checkout / return, /:id/locations locator payload
      sets.js              set catalog lookup
      settings.js          app-wide settings (admin)
      shared.js            public read-only shared collection by share_token
      admin.js             user management, card seeding
    tcgApi.js              Pokémon TCG API client (search + fetch by id) -> card_cache shape
    scryfallApi.js         Scryfall (MTG) client -> same normalized card shape
    lorcastApi.js          Lorcast (Disney Lorcana) client -> same normalized card shape
    tcgdexApi.js           TCGdex client: multilingual Pokémon cards
    pokemontcgapi.js        Optional Pokémon client: Western, Japanese and Simplified Chinese print lines
    tcgcsvApi.js           TCGCSV pricing + the tcgplayer_product id mapping
    psaApi.js              PSA cert lookup (what is in the slab), cached forever in psa_cert
    gradedPrices.js        Graded-price lookup (what the slab is worth) via PokemonPriceTracker
    cvScan.js              Image ID pipeline: cornelius corners -> dewarp -> milo embedding -> cosine over a catalog
    catalog.js             Catalog builds: cache every set's cards, then embed their artwork (Admin -> Catalogs)
    cardSets.js            Set discovery per game/language, and fetching a set's cards into card_cache
    cardArt.js             Per-card art overrides (user-supplied images)
    utils/
      compartmentSort.js   Placement engine: which compartment/slot a card files into; sort comparators
      priceHelpers.js      Price resolution across printings; vintage-set detection; UTC parsing
      authHelpers.js       Auth-related helpers
      npz.js               Minimal .npz reader, for the published (not locally built) catalogs
      pokemonProvider.js   The single Pokémon provider decision for this language
      languages.js         Language code/name resolution
      priceSweeps.js       The ordered price-sweep list and its sequential, single-flight runner
      shutdown.js          SIGTERM/SIGINT: close listeners, stop jobs, bounded wait, close SQLite
      staticCache.js       Cache headers for frontend/dist (hashed assets/ immutable, the rest revalidated)
      syncJobs.js          Set sync and the price-sweep entry point, shared by server.js and embedded/
    embedded/              Device mode: the composition root the phone app runs instead of server.js,
                           plus stand-ins for the Node modules a phone lacks (see "Device mode" below)
    backup.js              Atomic, verified VACUUM INTO snapshots in BACKUP_DIR; pre-migration snapshots
  scripts/                 fetch-models.mjs, catalog builders, the scan-gate measurement harness
  data/models/             cornelius.onnx, milo.onnx and the built catalogs (CV_MODEL_DIR)
  test/                    Node test suites and an e2e runner under test/e2e/
frontend/
  src/
    main.jsx, App.jsx      Entry + root: auth state, fetch wrapper (injects Bearer), tab routing, code-split views
    apiBase.js             Where /api goes in the native app: the user's server, or the device backend
    device/                Device mode runtime; generated/ holds the bundled backend (build-device-backend.mjs)
    components/            One component per screen/widget (see Frontend section)
    utils/                 Pure helpers: sorting, pricing, printing/rarity styling, language, shuffle
Dockerfile, docker-compose.yml, .github/workflows/docker-build.yml   Container build + smoke test + CI publish to GHCR
.github/workflows/test.yml, audit.yml, .github/dependabot.yml        Test gate on every PR, dependency audit, weekly update PRs
```

Regenerable/large artifacts live in `backend/data/models` (the two ONNX files and
the built catalogs, `CV_MODEL_DIR`) and the SQLite DB — both gitignored. A catalog
is ~5 MB per 10k cards, two orders of magnitude smaller than the per-set ORB
indexes this replaced (~2.6 GB), but it is still build output, so the container
points `CV_MODEL_DIR` at `/app/database/models` on the mounted volume — otherwise
an image update discards every catalog an admin built.

The two models are in neither the repository nor the image, and that is a
licensing decision rather than an omission: they are AGPL-3.0 while Bindarr is MIT,
so the operator fetches them into `CV_MODEL_DIR` as a deliberate step
(`node scripts/fetch-models.mjs`, optionally `--catalogs` for the published
fallbacks). Startup says so when they are absent, because that is the ordinary
state of a fresh install, and `/api/scan-match` answers `503 notBuilt` rather than
failing obscurely at session creation.

---

## Backend

### Request lifecycle

`server.js` wires Helmet (with an enforced CSP, or Report-Only under `CSP_REPORT_ONLY=true`, that allow-lists the card-image
hosts), JSON body limits, the API routers, then serves the
built SPA and a SPA fallback. `GET /api/health` is unauthenticated and backs the
Docker `HEALTHCHECK`. An empty `users` table stays empty unless
`DEFAULT_ADMIN_PASSWORD` is set, which seeds the `admin` account at startup;
otherwise the first browser visit sets that account's password through
`POST /api/auth/bootstrap`. Both paths name it `admin` — the bootstrap route ignores
any username posted to it, because the name has to be knowable to whoever set
`DEFAULT_ADMIN_PASSWORD` and is what `db.adoptOrphanRows` is reached through. No
password is ever logged.

Startup also probes `CV_MODEL_DIR` with a real write — `fs.access(W_OK)` reports
permission bits, which is not the same question as whether the filesystem will
accept a file — and warms the two ONNX sessions and the default catalog, so the
first scan of a session does not pay for the load. An unwritable model directory
is reported and survived: everything except catalog builds still works.

The listener starts at once and never waits on network work; `/api/health`
answers 503 until `initDb` finishes. A database that cannot be opened or
migrated is fatal: the error is logged and the process exits 1, so a
supervisor restarts it instead of a live process answering 503 forever.
Before a different release migrates a database that holds data, `initDb`
writes a `pre-migration-…` snapshot (see Backups below).

### Background jobs

`scheduler.js` runs the periodic work from `server.js`'s job list, on clocks kept
in the `job_runs` table rather than in timers, so a restart neither resets a
period nor skips a run: one 15-minute check compares each job's period against
its stored last run, and whatever fell due while the server was down runs at the
first check after boot. Each job is single-flight but independent of the others,
and a failure is recorded and retried after an hour.

| Job | Every | Notes |
|-----|-------|-------|
| `sets-refresh` | 7 days | Forced set refresh for all three games, set-cache reload, catalog auto-update. Run (forced) during startup when overdue; otherwise startup only fills empty set tables. |
| `tcgcsv-sync` | 1 hour | `tcgcsvApi.syncIfUpdated`, whose own gate reads `last-updated.txt` at most daily. A 403 cooldown is not an error. Off with `BINDARR_DISABLE_TCGCSV_SYNC=1`. |
| `price-sweeps` | 1 hour | `utils/priceSweeps.runPriceSweeps`: one ordered list, sequential, TCGCSV last, single-flight, failures isolated. Each provider's `shouldSweepPrices` gate decides whether it is actually due. |
| `session-purge` | 1 day | Deletes expired sessions. |
| `backup` | `BACKUP_INTERVAL_HOURS` | First period counted from the newest existing backup, or from first boot on a new database. |

### Backups

`backup.js` snapshots with `VACUUM INTO` a temporary file in `BACKUP_DIR`
(default `backups/` beside the database), verifies it with `PRAGMA quick_check`
and a table count on a separate read-only connection, then renames it to `.bak`;
on failure the temporary file is removed and older backups are untouched.
Snapshots are serialised. Regular ones rotate to `BACKUP_KEEP_LAST`;
`pre-migration-<db>-<from>-to-<to>-<time>.bak` keep their own last three, and at
most one is taken per upgrade, so a restart loop on a failing migration cannot
rotate the real pre-upgrade copy out. `PRAGMA user_version` holds the release
that last completed `initDb` (`major*1e6 + minor*1e3 + patch`), which is how a
pending upgrade is detected. A pre-migration snapshot that fails is logged loudly
and startup continues. The admin list, create and download routes use the same
directory, and a download resolves only a plain `.bak` file directly inside it.

### Shutdown

SIGTERM (`docker stop`) and SIGINT run `utils/shutdown.js`: close the HTTP and
HTTPS listeners (requests in progress finish), stop the scheduler, ask the price
sweeps to stop between sweeps and a catalog build to stop and write what it has,
wait at most 8 s for running work, close SQLite (which checkpoints the WAL) and
exit 0. A second signal exits immediately. In Docker, node is PID 1 —
`entrypoint.sh` execs gosu, which execs node — so the signal reaches it.

### Static files

`utils/staticCache.js` serves `frontend/dist`: Vite's content-hashed `assets/`
with `max-age=1y, immutable`; every file with a fixed name (`/ort/`'s
onnxruntime wasm, the manifest, the logo, `index.html` and the SPA fallback)
with `Cache-Control: no-cache` and an ETag, so it revalidates to a 304 and an
upgrade is picked up on the next load. `/models/cornelius.onnx` is revalidated
the same way by its own route.

### Auth

Authentication is DB-backed session tokens, not JWTs:

- `POST /api/auth/login` verifies a PBKDF2 password hash and inserts a row into `sessions` (`user_id`, `token`, `expires_at`).
- `authenticateToken` (`middleware/auth.js`) reads the `Bearer` token, looks up its SHA-256 (`authHelpers.hashSessionToken`; the table never holds the token itself) in `sessions` where `expires_at > now`, and sets `req.user = { id, username, role, tcg_api_key, ... }`.
- `requireAdmin` gates admin-only routes on `req.user.role === 'admin'`.
- A bearer token that matches no session is then checked against `users.api_key` — a long-lived read-only credential for external scripts (issue #33). It sets `req.user.via_api_key`, which makes `authenticateToken` refuse any non-GET (403) and `requireAdmin` refuse it outright. No user object the server returns (`/auth/me`, login, settings) carries a key: they report `has_*` flags, provider keys are write-only, and the API key is read on demand from `GET /auth/api-key` (login session only). The gate's 401s carry `code: 'session_expired'`; a password change revokes the user's other sessions, an admin reset all of them. Read-only is the whole reason a non-expiring credential is acceptable here; anything that weakens it has to replace it with something scoped.
- Rate limiters (`authLimiter`, `searchLimiter`, `importLimiter`) protect login and expensive endpoints.

`collection.js` applies `router.use(authenticateToken)` up front, so every
collection/location/deck-adjacent route requires a valid session.

### Route map

| Mount | File | Responsibility |
|-------|------|----------------|
| `/api/auth` | auth.js | `register`, `login`, `logout`, `me`, `PUT /settings` (per-user, e.g. `tcg_api_key`), `POST/DELETE /api-key` (read-only external key) |
| `/api` | collection.js | Card `search`, `scan-match`, `collection/cert/:certNumber`; `collection` CRUD + `bulk` + `:id/market-value/fetch`; `locations` & `compartments` CRUD; `recommend(-batch)`, `apply-all`, `resort`; `stats`, `stats/history`, `stats/networth`, `export`, `import`; `cards/:id/price-history` |
| `/api/decks` | decks.js | Deck CRUD, `:id/cards`, `:id/checkout`, `:id/return`, `:id/locations` (checkout/check-in locator payload) |
| `/api/sets` | sets.js | Set catalog for dividers and scan scoping; non-English Pokémon set lists come from TCGdex, whose ids differ per language |
| `/api/settings` | settings.js | App-wide settings (read any; write requires admin) |
| `/api/notifications` | notifications.js | Per-user notification channels (Discord/ntfy/webhook/Apprise; URL and token write-only, reported as `has_url`/`has_token`), `channels/:id/test`, price-move thresholds (`PUT /prefs`) |
| `/api/shared` | shared.js | Public, read-only collection view by `share_token` (no auth) |
| `/api` | backup.js | `GET /backup` (the whole account as one JSON file), `POST /backup/restore` (replace the account's contents from one; ids renumbered, card data only ever added) |
| `/api/admin` | admin.js | User management, card cache seeding, `catalogs` (list / `build` / `stop` / `progress`), DB backups (admin) |

### Device mode (the app without a server)

The Android/iOS app can run with no server ([MOBILE.md](MOBILE.md#device-mode-no-server)).
It does that by running these same route modules inside its WebView, rather than
by reimplementing them:

- `embedded/index.js` is the composition root, the device's `server.js`. It mounts
  the routers in the same order behind the same `authenticateToken` gate, and
  answers `501 { deviceMode: true }` for `/api/shared`, `/api/admin` and
  `/api/card-art`. It also answers `/api/scan-match` with the route's own
  `503 notBuilt` shape before the route reaches for Node's `Buffer`.
- `frontend/scripts/build-device-backend.mjs` bundles it with Vite (Rolldown, CJS
  in, one ESM file out) before every dev/build run. `embedded/aliases.js` is the
  single table of swapped modules: `express` becomes `embedded/router.js` (the
  slice of Express 4's Router the routes use), `sqlite3` becomes an adapter over
  an injected async driver, `fs` reports no files (so scanning stays `notBuilt`),
  `crypto` keeps only `randomBytes`, and native modules (`sharp`,
  `onnxruntime-node`, ...) become a stub that throws if called. Bare imports
  resolve against the frontend's `node_modules`, so the backend's native
  dependencies are never needed to build the app.
- `embedded/dispatch.js` turns `{ method, url, headers, body }` into the req/res
  surface the routes use and back. `frontend/src/device/runtime.js` wraps that
  in `fetch()`: `apiBase.js` sends every `/api` call there in device mode, with
  the device's own session token.
- On first launch `start()` runs `initDb()` (schema and migrations unchanged), then
  creates the `admin` owner with no password and a never-expiring session. It then
  runs the server's startup jobs from `utils/syncJobs.js`. Set lists get a forced
  refresh whenever a launch finds the last one a week old, tracked in a
  device-only `device_state` table, because a weekly timer never fires in an app
  that is opened and closed all day.
- The SQLite driver (`frontend/src/utils/deviceSqlite.js`) maps db.js's statements
  onto `@capacitor-community/sqlite`. It sends BEGIN/COMMIT/ROLLBACK through the
  plugin's transaction calls, passes `transaction: false` on every run (so
  `withTransaction` owns the transaction), routes PRAGMAs through `query` (Android
  rejects row-returning statements on its update path), and strips iOS's
  `ios_columns` header row. The sqlite3 adapter runs statements one at a time in
  issue order, which is what node-sqlite3's single connection guarantees db.js.

- Scanning: `/api/scan-match` and `/api/search` take `embedding` (milo's 128 numbers)
  in place of `image`. In device mode the app computes it (`frontend/src/device/
  scanEngine.js`, onnxruntime-web) and swaps it into the body, and
  `cvScan.setSource()` supplies the published catalogs the phone downloaded
  (`device/scanAssets.js`), so `cvScan.match` skips only the decode and the
  forward pass. Lorcana has no published catalog and answers `503 notBuilt`.

`backend/test/embedded.test.js` loads the real routes through the same alias table
and drives them through `handle()`, against node-sqlite3 as the driver; it also
covers a backup round trip and a scan through `setScanSource`.

### Card data sources

`tcgApi.js` (Pokémon), `tcgdexApi.js` (non-English Pokémon) and `scryfallApi.js`
(MTG) all normalize provider cards into one shape and upsert into `card_cache`, so
the rest of the app is game-agnostic. Every card carries a `game` field
(`pokemon` | `mtg`) and a `language`. A user's Pokémon TCG API key (stored
per-user) is passed through where available.

#### The game registry

Which games exist is one table, `shared/games.json` (with an ESM twin,
`shared/games.js`, for the frontend and bare-Node tests; `test/games.test.js`
fails if they differ). Each entry carries the game's value and labels, card-id
prefixes, provider, printed languages, printing scheme, feature flags (prices,
scan, grading, graded prices, decks), default deck format and size, card-back
key, marketplace link kinds and how a published scan catalog keys its rows.
`backend/src/utils/games.js` and `frontend/src/utils/games.js` wrap it. Lists of
games (validation, pickers, catalog builds, container restrictions, the
languages each game is printed in) read it; genuinely game-specific behaviour
stays in the provider that owns it.

`games.gameOfId` is explicit about card ids: a registered prefix names its game;
an unprefixed id is pokemontcg.io's only in that API's `<set>-<number>` shape;
anything else is unknown, and `cardApi.getCardById` answers null (the routes,
404) instead of asking pokemontcg.io about it. A new game must register a prefix
— the shape check cannot tell a foreign `abc-1` from a Pokémon one.

`utils/pokemonProvider.js` owns the Pokémon provider decision. It is asked,
never re-derived from the language: four call sites once derived it themselves and
four of them disagreed, which is how 21,828 rows were cached with the wrong
normalizer and ended up with no image and no collector number.

#### Optional pokemontcgapi.com provider

`pokemonProvider.apiFor(lang)` maps the central policy to its client. When the
admin selects `pokemontcgapi`, `en`, `ja` and `zh-cn` use `pokemontcgapi.js`;
other languages retain TCGdex. The existing default migration is untouched.
The credential comes only from `POKEMONTCGAPI_KEY` on the server. Merely setting
it does not enable the provider.

Card and set IDs both use `pokemontcgapi-<canonical-id>`. Aliases are accepted
upstream but normalized back to the canonical ID. `cardApi` dispatches stored IDs
independently of today's setting. There is no guessed cross-provider or
cross-language ID conversion: changing a name's locale does not identify the same
physical printing in another release line.

The API's card endpoint does not document a region filter. Searches filter
`print_region` before applying Bindarr's page/limit window, following cursors even
when a page has no matching region. Set lists use `region=WEST|JP|CN`, and set
cards use the `/cards?set=...` shortcut. All list requests use `limit=250` and
include images and translations but NOT prices: prices are what the API's
credits pay for (a 250-card page measured 1 credit without them and 40 with
them), so listing rows are cached unpriced (`price_trend` null, which
`extractPrices` distinguishes from a genuine zero) and `cacheListedCards` copies
any price already stored onto the incoming row so a listing never erases one.
The price arrives at the two moments the app shows a value: `hydrateCard`, called
by `cardApi.hydrate` when a card enters the collection, fetches that one card
with prices (2 credits); and the automatic sweep prices owned/decked cards in
batches, only those whose stored price has aged past three days, as often as
`app_settings.price_refresh_days` allows (`shouldSweepPrices` is the single gate;
the hourly `price-sweeps` job is unforced). `cacheListedCards` also puts a kept row's
`last_updated` back, so a listing cannot make an old price look fresh to the sweep.
User-entered names are quoted as literal query phrases; set IDs go through the
separate `set` parameter.

`pokemontcgapi_cache` stores complete response bodies, ETags and fetch times for
up to 1,024 requests. A key digest scopes entries to the account's plan visibility;
the key itself is never persisted. Responses are reused for 24 hours, then
conditionally revalidated. In-flight identical requests coalesce, redirects are
disabled, and only a same-origin, same-endpoint next cursor is accepted. A 429
pauses further upstream calls for Retry-After (at least one minute), without
sleeping in the request handler or automatically retrying a paid request.
`card_cache` remains the normalized, durable store, written through
`cacheNormalizedCards`. Cached cards can still answer when the API is unavailable.

Price normalization chooses ungraded Cardmarket EUR, then TCGplayer USD, and
keeps every printing/average column in that source and currency. It ignores slab
quotes and known different locales; `index_eur` is a composite, so it is not
presented as a Cardmarket price. Missing quotes stay absent. Source labels are
`pokemontcgapi-cardmarket` and `pokemontcgapi-tcgplayer`. Its own sweep reads only
stale owned/decked IDs in batches of 25, with a separate timestamp, and only while
selected. The older pokemontcg.io and TCGCSV sweeps skip these IDs/sets.

Set browsing, `cardSets` downloads and catalog coverage use the selected client.
Existing cached cards and scan catalogs survive a switch; a rebuild includes the
new provider's artwork. A complete catalog can consume many credits and is not
started by selecting the provider.

Offline contract and HTTP integration tests live in
`backend/test/pokemontcgapi.test.js`, with documented fixtures under
`backend/test/fixtures/pokemontcgapi/`. They cover ID routing, admin activation,
search/add, regions, cursor/UI pagination, persisted ETag revalidation, price
currencies, quota backoff and cache fallback. No live key is needed by the tests.

#### Migrating pokemontcg.io card ids

pokemontcg.io shuts down on `pokemonProvider.POKEMONTCG_SUNSET` (1 March 2027),
and `cardApi` cannot translate its ids: a provider switch leaves every owned row
on them. `pokemonMigration.js` is the one-off, admin-triggered move
(`/api/admin/pokemon-migration/{status,preview,apply,revert}`, mounted inside
`routes/admin.js`). The target is `pokemonProvider.migrationTarget(setting)`:
pokemontcgapi.com when configured, otherwise TCGdex English.

- **Mapping** (`utils/pokemonIdMap.js`, pure). Sets via `setCatalogueMatch`
  (id, unpadded id, `pt5`→`.5`, then name), falling back to a subset's parent
  (TG/GG/SV/Classic Collection sets the target folds in). Numbers via `numKey`
  (padding, `/total`, separators and case dropped; letter suffixes kept). Card
  names must be compatible, and TCGplayer product ids (card_cache,
  `tcgplayer_product`, the `tcgplayer_catalog` product map) must agree where
  both sides have one. Classes: `mapped`, `product` (product id only),
  `ambiguous`, `unmapped`. Ties, mismatches and two old ids on one new id are
  never moved.
- **Preview** lists target sets through the provider clients
  (`tcgdexApi.getSetCards` / `pokemontcgapi.getSetCards`, four at a time,
  cached an hour), never per card, and caches the plan for apply.
- **Apply** calls `backup.createBackup()`, then one `withTransaction`: card-id
  columns are found from the schema (`card_id`, or a foreign key to
  `card_cache`), so tables added later are re-keyed generically by rowid.
  Collection rows are copies and just re-point; a deck listing both ids sums
  (the primary key leaves no other choice); a price point at the same instant
  keeps the target's; the old `card_cache` row is deleted. Every change is
  journaled in `pokemon_id_migration_undo`, the old→new log in
  `pokemon_id_migration_log`, the run in `pokemon_id_migration_runs`. Missing
  target rows are inserted from the listing carrying the old row's
  rarity/types/price, stamped stale. After commit: the local scan catalog's id
  list is re-keyed, cards are hydrated through `cardApi.hydrate`
  (pokemontcgapi.com in one batched priced listing), TCGCSV re-prices, and a
  provider switch gets the same follow-up as Settings.
- **Revert** plays the newest run's journal back, skipping rows changed since.
- Apply refuses to run during a catalog or product-map build (the latter opens
  raw `BEGIN`/`COMMIT` on the shared connection). Re-running apply is a no-op
  for data and resumes unfinished hydration.

Tests: `test/pokemonidmap.test.js` (the mapping table, from
`test/fixtures/pokemonmigration`), `test/pokemonmigration.test.js` (preview,
apply, re-run, revert over a temp DB through the admin router),
`test/pokemonmigrationapi.test.js` (pokemontcgapi.com target).

#### Riftbound

`riftcodexApi.js` reads RiftCodex (free, no key, `RIFTCODEX_BASE_URL`). The
catalogue is fetched whole (pages of 100) on first use — a search, the set list, an
id, a catalog build — cached through `cacheNormalizedCards` with `keepPrices` (it
carries no prices, so its re-cache must not null the swept ones), and refreshed by
the weekly set refresh only on installs that hold Riftbound cards. Search reads the
cache, with domain/type/rarity/supertype filters.

Ids are `riftbound-` + the lowercased `riftbound_id` with every character outside
`[a-z0-9-]` written as `.` + hex (`unl-229*-219` → `riftbound-unl-229.2a-219`),
which round-trips and needs no escaping in URLs, SQL or CSV. Records sharing a
`riftbound_id` are either one printing listed twice (identical faces; the record
with a TCGplayer product is kept) or distinct printings (OPP promo and Metal): the
canonical one keeps the plain id, the others get `~<RiftCodex id>`. Names never
merge printings. New card columns: `orientation` (battlefields are landscape),
`artist`, `card_text`, `attributes` (energy/might/power JSON; energy is also `cmc`).

Prices: `riftboundPrices.js` reads TCGCSV category 89 from `tcgcsvApi`'s cache
(same pacing, 403 cooldown and base URL). Category 89 is synced only once the
install has a Riftbound card, and backfilled into the current version the first
time. Match is by product id only; Normal → `price_normal`, Foil →
`price_holofoil`, trend prefers Normal; a missing quote leaves the stored price.
Own clock: `riftbound_prices_swept_at`.

Deck rules are the `riftbound` entry in `shared/deckRules.mjs`: per-zone copy
limits (enforced on add) and Riot's construction rules as deck warnings. Scan: `cardSets` lists
cached sets, `catalog.embedUrl` embeds Riot's full-width art; landscape art is
squashed into the square as printed, like the camera dewarp of a card held the way
it is printed. Real-model accuracy is unmeasured.

#### Two names per card, and which is which

`card_cache.name` is the **searchable** name and `printed_name` is the name **on the
card**. Display reads `printed_name || name` (`utils/languages.displayName`,
`langHelper.getCardDisplayName`); search reads both columns (`utils/cardSearchSql`,
`CollectionList`'s filter); logic that must not split a card across languages — the
four-copy deck rule, CSV export, marketplace links — reads `name` only.

Scryfall hands over both for free. TCGdex publishes one name per language, so
`normalizeCard` writes the localized name into both columns and
`tcgdexApi.learnEnglishName` fills `name` in from the card's own English printing
when a card is added (plus a backfill on the price sweep). A Japan-exclusive set has
no English printing and keeps the localized name in both columns.

A copy's language is chosen separately from the card that was picked — Quick Add's
dropdown, or a scan the English catalog answered — so `cardApi.printingInLanguage`
swaps the row for that language's printing inside `addCardToCollection`, which every
add path routes through. MTG resolves by set + collector number (language-invariant),
TCGdex by the language segment in its id. Null means keep what was picked: a card
never printed in that language, or a pokemontcg.io id, which is English-only and
whose set numbering does not map to TCGdex's.

### Image identification pipeline

Image-only, no OCR. Two ONNX models, both game-independent — a card is a card to
a corner detector and an embedder — so only the catalog differs per game and
language.

The browser does the first half. `utils/detectWorker.js` runs **cornelius**
(384×384, ~4.2 MB, fetched once from `GET /models/cornelius.onnx`) through
`onnxruntime-web` on a worker thread to draw the live outline, then
`CameraScanner.localDewarp` perspective-warps the captured frame to a 448×448
square using the shared `shared/imgproc.mjs` and uploads only that. Two reasons:
the previous version posted a JPEG per preview frame (~2.7 MB per minute of
pointing the camera at a card), and the outline on screen is now *by
construction* the crop that gets matched. Detection is ~80 ms per frame on the
wasm EP — name the EP explicitly, WebGPU measured 1075 ms for this model.

Server side, `cvScan.match(buffer, game, topK, opts)`:

1. **Dewarp.** An already-rectified upload (`cropped: true`) is only resized to
   448 — re-running cornelius on a crop that already *is* the card would find the
   same square again for the price of a decode and a forward pass. A whole frame
   goes through `detectAndDewarp`: cornelius on a 384 copy, then a homography onto
   a 448 square sampled from a 1200px decode. Below a sharpness of 0.02 the corner
   peaks are flat — nothing card-like in frame — and the raw frame is matched
   instead, which still recovers most of those.
2. **Embed.** **milo** turns the 448 square into a 128-d L2-normalised vector.
   One crop, one forward pass, reused by every catalog swept.
3. **Sweep.** A brute-force dot product against each catalog (both sides are unit
   vectors, so the dot product *is* the cosine). 21,775 rows costs ~6 ms, which is
   why there is no ANN index here: building one would cost more than it saves.
4. **Rank.** Hits from every catalog merge into one list sorted by score —
   comparable because it is the same model and the same normalisation — deduped by
   id, and cut to `topK`.

The route (`POST /api/scan-match`) hydrates each candidate from `card_cache`,
re-expresses it in the scanned language, and `CameraScanner` gates the result:
auto-add above the confidence bar, otherwise the candidate list for a manual pick.

#### Language is a fallback chain, not a filter

Artwork is identical across languages, so any catalog can answer *which card this
is*; only the printing differs. `loadAll` therefore sweeps the catalog for the
scanned language **and** the English one, and the route re-expresses the winner
(`getPrintingInLang` — by set + collector number for MTG, by id for Pokémon)
before it reaches the picker.

That second sweep is not a nicety. A non-English catalog is only as complete as
its provider: TCGdex serves card records for **28 of the 177 Japanese Pokémon
sets it lists**, so a Japanese catalog holds ~3.3k of ~16k cards. A cosine sweep
never returns nothing, so every card outside those 28 sets used to come back as
the nearest of the wrong 3.3k, sometimes confidently. The English catalog has a
row for nearly all of them — verified: Japanese スズナ → Candice at 0.863,
モンジャラ → Tangela, ダブラン → Duosion, from the English catalog alone. The right
card in the wrong language beats a wrong card in the right one.

#### Set scoping is a filter, and it is per catalog

Passing set ids skips every row that does not belong *before* scoring: the whole
point of scoping is that a runner-up from an unwanted set can no longer outrank
the right card. There is nothing to build — the ORB path needed a per-set index
first, which was the client's old "preparing set" wait.

The filter is evaluated per catalog, because set ids do not survive a language:
`SV4a` names no row in the English catalog. A catalog with no rows in scope is
**dropped** from the sweep rather than searched unscoped, since searching it
unscoped would reintroduce exactly the wrong-card answer the scope exists to
prevent. If no catalog has rows in scope the filter is ignored entirely — "no
match" for a card that is plainly there is the worse failure.

#### "Nothing here is your card"

A sweep always returns its nearest row, so a card the catalog has never heard of
arrives in the same shape as one it has. The gate is how far the winner stands
above **its own catalog's** ranks 2–11 (`GAP_FLOOR`, default 0.10, env
`CV_SCAN_GAP`) — not its absolute cosine, because absolute cosine tracks photo
quality and the gap does not. Measured by `scripts/measure-scan-floor.js` over 60
cards per catalog, each searched with its own row masked out so that it *is* a
missing card:

| strangers accepted | reference-quality input | blurred / tilted / dim input |
| --- | --- | --- |
| absolute cosine ≥ 0.65 | 31–41 of 60 | 15–19 of 60 |
| gap ≥ 0.10 | 12 of 60 | 11–12 of 60 |

One threshold, same behaviour on a good photo and a bad one, across both the
3,296 row Japanese catalog and the 21,771 row English one, and no correct answer
was rejected in any of the four runs (worst genuine gap 0.105). The gap is
measured within a single catalog on purpose: the same card sits in both the
Japanese and the English one, and its own twin a rank down would flatten a merged
neighbourhood and make every correct answer look like a stranger.

When it trips, the response carries `notInCatalog: true` **and** the candidates.
The client refuses to auto-add and says the card is not in the catalog, but still
shows the list: a bad photo and a missing card look identical from here, and one
of the candidates is right often enough to be worth the glance. The strangers
that do get through are cards whose *artwork* is reprinted elsewhere — right art,
wrong printing, which no similarity gate can separate and which the client's
same-name check already routes to the picker.

### Why embeddings replaced the ORB stack

The previous pipeline was a 64-bit dHash sweep plus a bag-of-visual-words lookup
for recall, then ORB descriptors with a RANSAC homography to verify. Measured
against CollectorVision on the same 100-card noisy MTG sample:

| pipeline | exact printing | right card | latency |
| --- | --- | --- | --- |
| hash 250 + BoVW 10 + ORB verify | **78.0%** | 88.0% | 1187 ms |
| cornelius + milo | 76.0% | **90.0%** | 310 ms |

Two points of exact printing for 3.8× the speed — and the reason to switch is
what went with it. ~2.6 GB of per-set ORB indexes plus two whole-game rollups
became two ONNX files and one catalog per (game, language) at ~5 MB per 10k
cards. There is no index build in the scan path at all, so set-scoped scanning
needs no preparation and a scan has no geometric verification stage to be slow in.

Both models are AGPL-3.0 ([milo](https://huggingface.co/HanClinto/milo),
[cornelius](https://huggingface.co/HanClinto/cornelius)) and Bindarr is MIT.
Shipping them enabled is a licensing decision, not only a technical one.

Test-time augmentation (two extra dewarps at 0.92×/1.08× crop tightness, averaged
as unit vectors) took exact printing from 76% to 81% with right-card unmoved, for
two more forward passes — ~100 ms of a ~255 ms scan. Removed for latency; the git
history has it if that trade ever looks different.

### Catalog builds

A catalog is one (game, language) pair, and building it has two phases:

1. **Cache** — walk every set the provider lists for that language and pull its
   cards into `card_cache` (`cardSets.cacheSetCards`).
2. **Embed** — run every cached card's artwork through milo and write the
   embedding table the scanner sweeps (`milo-<game>[-<lang>]-local.bin`, plus a
   `.json` carrying ids, dimensions and source urls).

They are one job rather than two buttons because phase 2 can only ever be as
complete as phase 1 — and phase 1 is the half that was missing for years.
Caching used to happen only as a side effect of building a scan index, so a set
nobody indexed, searched or browsed simply was not there: Pokémon held 7,118 of
20,460 English cards (35%), with 104 of 174 sets holding only the handful the
owner happened to have.

Both phases resume. Phase 1 is idempotent; phase 2 keeps every embedding whose
**embedded** source url is unchanged, and a cancelled build still writes what it
has, because a partial catalog is valid and resuming reuses all of it. A set with
no data in the chosen language raises an *absent* error rather than a failure —
per-language provider coverage is patchy enough that counting gaps as failures
would abort every non-English build partway through.

Admin → Catalogs drives it (`/api/admin/catalogs`, admin-only) and lists what
exists **with a denominator**, because "built, 3,297 cards" reads as complete and
is not. English is counted against the `sets` table; a non-English total comes
from the provider's own set list for that language, so Japanese Pokémon reads
*3,297 of 16,192*. A catalog can be perfectly built and still cover a fifth of the
game.

The scanner matches card **art**, so a build embeds the highest-resolution image
the provider offers rather than the one the UI shows: TCGdex's cached url is
`/low.png` (245×337, chosen so card grids do not pull 312 KB per thumbnail) and is
swapped to `/high.png` (600×825) at embed time only. Embedding the thumbnail meant
every TCGdex row was an upscaled blur while the camera handed over a sharp 448
crop. Because resume keys on the url actually embedded, raising the resolution
invalidates the old vectors instead of silently reusing them.

Locally built catalogs are keyed by `card_cache.id`, so every hit resolves by
construction. The published fallback catalogs (`milo-<game>.npz`, read by
`utils/npz.js`) are keyed by provider id — TCGplayer product ids for Pokémon, of
which only ~24% map to a card a given install has ever cached — which is why a
local build always wins when one is present.

### Measuring the scan gate

`GAP_FLOOR` decides whether an answer is presented as an answer at all, so it is
measured rather than guessed:

```bash
node scripts/measure-scan-floor.js pokemon Japanese 60
```

It samples catalog rows evenly (not the first N — ids are ordered by set, so the
first N would measure one set's internal confusability), degrades each card's own
art two ways, and reports two distributions per regime: **genuine**, searched
against the whole catalog, and **impostor**, the same image with its own row
masked out, which is exactly the missing-card case. It then sweeps candidate
thresholds for both the absolute cosine and the gap, printing what each would cost
in strangers accepted and correct answers rejected.

Read the two regimes against each other rather than in isolation: a threshold
whose columns move between them is measuring photo quality, not card identity.
Both are optimistic — neither models glare or a shadow across the art — so prefer
a gate that behaves the same in both over one tuned to either.

### Prices

`utils/priceHelpers.resolveCardPrice(row)` is the single answer to "what is this
worth", and its order is: `collection.market_value` (this copy's own value),
then the price column matching the row's `printing`, then `price_trend`. Any
query whose result reaches it must select `c.market_value` alongside the
`cc.price_*` columns, or a graded copy silently reverts to the raw card's price
in that one view — the failure is invisible, it just reads low.

Where the provider price itself comes from depends on the game AND the language,
because it depends on which marketplace sells that printing:

| Rows | Source | `price_source` | Currency |
|------|--------|----------------|----------|
| MTG, any language | Scryfall `prices.usd`, else `prices.eur` (reversed when `app_settings.mtg_price_source` is `cardmarket`) | `scryfall` | USD or EUR |
| Pokémon English / Japanese | TCGCSV (TCGplayer categories 3 / 85) | `tcgcsv` | USD |
| Pokémon other languages | the **English** TCGplayer product | `tcgcsv-en` | USD |
| Pokémon fallback | TCGdex's Cardmarket block | `tcgdex` | EUR |

Two rules hold that together. **A row is never mixed**: if a printing's USD price is
missing, the EUR normal *and* foil prices are used together, because a USD normal
next to a EUR foil is a pair nothing can compare. And **nothing is converted** — an
exchange rate is a live number this app has no source for, and a stale hardcoded one
misprices a collection silently — so `price_currency` travels with the row and the UI
prints the matching symbol (`utils/formatPrice.priceText`). Collection totals sum the
currencies as-is; `/api/stats/networth` reports `currencies` so a consumer can tell.
`price_history.currency` records each point's currency, and the chart and timeline
read only points in the card's current one, so a currency switch starts a new series
rather than drawing a price move.

`tcgcsv-en` exists because TCGplayer has no German, Korean or Chinese Pokémon
catalogue: those cards are priced off the English product for the same set and
number. That is the closest real quote and much better than 0.00, but it is not the
printing the user owns, so the inspector labels it "TCGplayer (English printing)"
rather than presenting it as this card's price.

Coverage is a function of the sweep's scope, not of the cache: `tcgcsvApi`'s daily
sweep runs over sets the user owns cards from (`scope: 'owned'`, one request per
set), so a browsed-but-unowned set reads 0.00 until a card from it is added.

`market_value` is written from two places and read as one number: the owner types
it (`PUT /collection/:id`, source `manual`) or fetches it
(`POST /collection/:id/market-value/fetch`, source `pokemonpricetracker`). The
fetch path lives in `gradedPrices.js` and exists because no card API prices
slabs. It is per-request and never swept: the only free provider meters at 100
lookups a day. `frontend/src/utils/resolveCardPrice.js` mirrors the same order
for cards not yet saved.

### Notifications

`notify.js` is the whole surface: `notify.emit({ type, ... })` returns at once
and never throws. Price sweeps, the auto-backup and catalog builds call it from
their failure paths (`price_sweep_failed`, `backup_failed`,
`catalog_build_failed`, sent only to channels of current admins), and the
scheduler's `price-sweeps` job emits `price_sweep_done` with the
`utils/priceSweeps` summary once a run finishes (a sweep that threw is reported
from that summary). That runs the price-move check: for each user with a price channel, every owned (and, if
enabled, wishlisted — `collection.list_type = 'wishlist'` or `card_lists` when
present) card's latest `price_history` point is compared with the price the user
was last told about (`notification_price_state`). Over either per-user bar
(`notification_prefs.price_pct` / `price_abs`, `min_price` floor) it joins one
digest message; a card is reported at most once per 20 h.

`notification_log` is both the record and the queue: messages are inserted
`pending` and a single-flight worker POSTs them with backoff (30 s × 4ⁿ, five
attempts), honouring Discord's `retry_after` and `X-RateLimit-*` headers.
Pending rows survive a restart. Admin failures are deduped per job and source
for 6 h. Every destination passes `utils/notifyGuard.js`: http(s) only, no
redirects, and loopback/private ranges refused (checked on save and again in the
socket's own DNS lookup) unless `NOTIFY_ALLOW_PRIVATE=true`; link-local is
always refused.

### Storage & sorting engine

`utils/compartmentSort.js` decides where a card physically files:

- A **location** (binder/box/etc.) contains ordered **compartments** (binder pages / box rows).
- `recommendSlot()` picks the compartment + slot for a card based on the location's `sort_order` scheme and per-compartment `rule_config` filters.
- **Slot encoding**: a card's `position` is `slot * 1000` (slot 1 → 1000, slot 2 → 2000). `Math.floor(position / 1000)` recovers the human slot number. The gaps leave room for manual reordering.
- Sort schemes are either `custom` (manual order, honored via stored `position`) or structured (name / set-number / price / type-color / language), optionally foil-aware (`foil_sorting`). Structured schemes also drive the visual set/category **dividers** in the binder view.

---

## Data model (SQLite)

| Table | Purpose / key columns |
|-------|-----------------------|
| `users` | `id`, `username`, `password_hash` (PBKDF2, iterations embedded), `role`, `share_token`, `share_enabled`, `tcg_api_key`, `psa_api_token`, `graded_price_api_key`, `api_key` (read-only external credential) |
| `sessions` | `user_id`, `token` (`sha256:` + hash of the bearer token), `expires_at` — Bearer-token auth |
| `card_cache` | Normalized card metadata keyed by provider `id`: `name` (searchable) and `printed_name` (as printed), `language`, `set_id`/`set_name`, `number`, `image_url`, `types`/`subtypes`/`supertype`, `rarity`, `cmc`, `color_identity`, `price_*` with `price_source`/`price_currency`, `tcgplayer_product_id`, `tcgplayer_url`/`cardmarket_url`, `game`, `last_updated`. Written only through `utils/cardCache.cacheNormalizedCards`, which upserts — `INSERT OR REPLACE` re-created the row and reset every column outside the provider's own list |
| `collection` | One row per owned stack: `id` (entry_id), `user_id`, `card_id`→card_cache, `quantity`, `condition`, `printing`, `language`, `purchase_price`, `location_id`, `compartment_id`, `position`, `list_type` (`collection`/`trade`), `is_trade`, `game`, `added_at`; per-copy grading (`grader`, `grade`, `cert_number`) and per-copy value (`market_value`, `market_value_source`, `market_value_at`) |
| `locations` | Physical containers: `user_id`, `name`, `type`, `sort_order`, `foil_sorting`, `rule_type`, `rule_config`, `game` |
| `compartments` | Pages/rows within a location: `location_id`, `idx`, `label`, `capacity`, `rule_config` |
| `compartment_assignments` | Maps sort categories to specific compartments (category→page filing) |
| `decks` | `user_id`, `name`, `description`, `checked_out`, `checked_out_at`, `created_at` |
| `deck_cards` | Deck contents: `deck_id`, `card_id`, `quantity` |
| `price_history` | Per-card price points over time, powering trend charts |
| `notification_channels` | Per-user destinations: `type`, `url`/`token` (secrets, never returned), ntfy `topic`, `enabled`, `events_price`, `events_admin` |
| `notification_prefs` / `notification_price_state` | Per-user price-move thresholds; the last price each user was notified about, per card |
| `notification_log` | Every delivery, and the outbound queue (`status`, `attempts`, `next_attempt_at`, `dedupe_key`) |
| `sets` | Set catalog (names/ordering) for dividers and set-scoped scan |
| `pokemontcgapi_cache` | Bounded persistent response cache: `request` (credential digest + path/query), `body`, `etag`, `fetched_at`; no API keys |
| `app_settings` | App-wide key/value settings (e.g. registration toggle) |
| `job_runs` | Background job clocks (`scheduler.js`): `name`, `last_run_at`, `last_status` (`ok`/`error`/`baseline`), `last_error` |
| `binder_artwork` | A user's uploaded binder picture: `user_id`, `mime`, `width`, `height`, `bytes`. The re-encoded file is `<db dir>/binder-art/<user_id>/<id>` |
| `binder_art_layers` | One per binder page: `compartment_id` (unique), `artwork_id`, placement in mm (`x_mm`, `y_mm`, `width_mm`, `rotation_deg`), `spread` (continues onto the next page), `mask` (JSON `[{side,row,col}]` of artwork pockets), `pocket_w_mm`/`pocket_h_mm`/`gap_mm`. Never joined to `collection` |

**Entry identity**: a `collection.id` (`entry_id`) uniquely identifies one
physical stack. Features that track individual copies (checkout locator, storage
highlighting) key on `entry_id`, never on `card_id + position` (which can collide
across compartments).

---

## Frontend

`App.jsx` holds auth state (`token`/`user` in `localStorage` under
`bindarr_*`), installs a `fetch` wrapper that injects the `Bearer` header on
`/api/*` calls and dispatches a logout event only on a `401` marked `session_expired` (`utils/sessionExpiry`), and tab-routes between
code-split view components. `/share/:token` renders the public view without auth.

### URL routing

Each tab has a path, and the deck, list and storage tabs carry what is open in
them: `/`, `/add`, `/collection`, `/sets/:game/:set[/:lang]`,
`/storage/:locationId`, `/decks/:id`, `/lists/:id`, `/notes`, `/sealed`,
`/settings`, `/admin` (`utils/routes.js`). The trash stays a modal.
The URL is the source of truth: `utils/router.js` is a small store over the
History API (no react-router), `useRouteSync` in `App.jsx` shows the tab the URL
names, and the components read their sub-view with `useTabParam`. A reload or a
link reopens the view; a link opened while signed out is kept in
`sessionStorage` through the login screen (and an SSO round trip) and opened
after sign-in, and a session lost to a 401 comes back to where it was. Hidden
tabs stay mounted and remember their last path, so returning to Decks lands on
the deck that was open. Switching storage containers replaces the entry rather
than stacking one per container.

Popups close on Back through `useBackGuard`, which pushes a guard entry.
`utils/navHistory.js` owns both kinds of entry and stamps each with its
position, so popstate knows the direction: Back closes the guards above where it
lands, Forward never closes anything and skips the entries of popups already
closed, and writes made while a silent step back is in flight wait for it. The
Android back button steps back while there is an entry to go to and exits the
app otherwise. The server's SPA fallback (`utils/staticCache.js`) serves
`index.html` for any non-`/api`, non-`/assets/` path, so nested routes reload.

| Component | Role |
|-----------|------|
| `Login` | Auth screen (login/register) |
| `Dashboard` | Collection value, net-worth trends, distributions, milestones |
| `AddCards` | Wrapper toggling **CameraScanner** vs **CardSearch** |
| `CameraScanner` | Camera capture, in-browser corner detection + dewarp, POST `/api/scan-match`, confidence gate + manual pick |
| `CardSearch` | Name/number text search against the card APIs |
| `CardInspectorModal` | Card detail: pricing, types, printing/rarity, location |
| `CollectionList` | Browse/filter/sort the collection; bulk actions |
| `LocationManager` | Manage containers; binder/box views; filing mode; storage select |
| `CompartmentView` | Renders one compartment (binder pocket grid or box coverflow); highlights cards by `entry_id`; greys checked-out cards |
| `BoxMap` | Every row of a box as a strip of card colors and rarities with divider tabs; seeks the row's coverflow (`seekTo`) and follows it (`onActiveSlotChange`) |
| `ContainerOverview` | "All cards": a container's cards in physical order, box rows split at dividers, binder pages with their pockets |
| `CreateContainerModal` | New-container wizard |
| `BinderArtworkEditor` | Binder artwork: upload, place over a page or spread, choose artwork pockets, print actual-size inserts (canvas pieces + `window.print()`) |
| `DeckBuilder` | Deck CRUD, composition charts, draw simulator, checkout/return |
| `CheckoutWizardModal` | Checkout **and** check-in locator (mode prop): grouped by container→page, grid highlight, select-all per page/container/all |
| `SortFilterBuilder` | Drag-and-drop sort scheme + filter rule builders |
| `CatalogPanel` | Scan catalogs: what is built per game/language, coverage against the provider's own totals, build/stop with live progress |
| `Settings`, `AdminPanel`, `SharedCollection`, `PriceHistoryChart` | Preferences, user admin, public view, price charts |

Client utils (`utils/`): `cardSort` (shared sort comparators + `sortCardsByOrder`),
`sortCategories` (divider categories and where they change, shared by every
storage view), `binderLayout` (page widths, pocket placement), `binderArtGeometry` (artwork placement, pocket crops, print packing), `boxStrip` +
`cardColors` (the box map's runs, gradient and tabs),
`resolveCardPrice`/`formatPrice` (pricing display), `cardPrinting`/`cardRarity`
(badge styling), `langHelper` (Japanese name handling), `cardOptions`
(condition/printing/language enums), `shuffle` (draw sim), `i18n`/`translate` (UI
language, React context rather than a library). Scanning adds
`cardDetector`/`detectWorker` (cornelius on a worker thread), `sharpness` (is the
frame worth capturing) and `autoCapture` (the steady-hand cadence); the geometry
they share with the server lives in `shared/imgproc.mjs`, with the detector itself
in `shared/cardDetectPure.mjs`.

---

## Deck checkout / check-in

Reserving a deck's physical cards. **Checkout and check-in never move cards in
the DB** — a card's stored slot is both where you grab it and where it returns;
only `decks.checked_out` changes.

- `PUT /api/decks/:id/checkout` validates availability (owned minus copies locked by other checked-out decks) and sets the flag.
- `GET /api/decks/:id/locations` returns, per card, the specific stored copies to pull (`entry_id`, container, compartment display, slot from `position`) plus any `missing` count.
- `GET /api/collection` annotates each entry with `checked_out_qty` (`checkedOutAllocation` greedily allocates checked-out decks' requirements onto owned entries), so `CompartmentView` greys those copies with an "In Play" badge.
- `CheckoutWizardModal` renders that payload as a grouped checklist with the compartment grid highlighting the pulled cards; `PUT /api/decks/:id/return` flips the flag and reopens the same modal in reverse (`mode="checkin"`).

---

## Conventions & gotchas

- **Backend has no auto-reload** in production/local `node src/server.js`; restart it after backend changes so new routes/data load. Frontend uses Vite HMR.
- **SQLite runs in WAL mode** — checkpoint/stop before file-level backups so `-wal`/`-shm` are flushed. A clean stop (SIGTERM/SIGINT) closes the connection, which does the checkpoint.
- **Background work goes in `server.js`'s scheduler job list**, not a new `setInterval`: an in-memory timer resets on every restart. A new price provider is one `utils/priceSweeps.js` entry plus its `SWEEP_COLUMN` key (`test/pricesweeplist.test.js` holds the two together).
- **Everything is game-scoped** (the values in `shared/games.json`); new card fields must be threaded through every provider's normalization, and a new game is a registry entry first.
- **`position = slot * 1000`** is the single source of truth for slot order; never assume packed array index equals slot.
- **Scanning needs a catalog**: the two ONNX models identify nothing on their own, and there is no second matcher to fall back to. `/api/scan-match` answers `503 notBuilt` with the fix in the message rather than an empty candidate list, which reads to the user as "your card could not be identified". A catalog is per (game, language) and only as complete as the provider's data for that language.
- **Frontend lint is strict**: CI runs `eslint --max-warnings 0`, so unused vars/imports and empty blocks fail the Docker build.

---

## Build, run, test

Setup and Docker deployment: see [README.md](README.md). Quick reference:

- Runtime: Node 24 in the image (`node:24-slim`, Debian/glibc) and in every workflow; Node 22.12+ works locally. Bump the Dockerfile, the workflows and these docs together.
- Backend: `cd backend && npm run dev` (nodemon) or `npm start`; port `3001`.
- Frontend: `cd frontend && npm run dev` (Vite, port `5173`, proxies `/api` → `3001`).
- Tests: `npm test` from the root runs every suite — the unit suites in `backend/test/`, the e2e suites under `backend/test/e2e/`, the frontend utility tests, the locale check and the TCGCSV mirror test — each whether or not an earlier one failed, then prints one summary (`scripts/test-all.mjs`). `cd backend && npm test` runs both backend runners the same way; `npm run test:unit` / `npm run test:e2e` run one. No framework — each file is a plain `node` script, and each e2e server takes a free port (`backend/test/freePort.js`), so two runs can overlap.
- Lint (matches CI): `cd frontend && npm run lint`.
