# Bindarr — Architecture & Developer Guide

Developer-facing reference for the codebase. For install/run/deploy and end-user
features, see [README.md](README.md); this document explains **how the system is
built and why**.

Bindarr is a self-hosted trading-card collection manager for **Pokémon** and
**Magic: The Gathering**. It identifies cards from a phone photo (no typing),
tracks their real-world physical location (which binder page / box row slot),
values the collection over time, and helps you pull and re-file the cards for a
deck.

- **Backend**: Node.js + Express, SQLite (single file), served together with the built frontend from one container.
- **Frontend**: React + Vite SPA.
- **Auth**: opaque session tokens in a server-side `sessions` table, sent as a `Bearer` header.
- **Card data**: Pokémon TCG API (Pokémon) and Scryfall (MTG), cached locally in `card_cache`.
- **Image ID**: CLIP embeddings (recall) + ORB feature matching with RANSAC homography (verify), all server-side via `opencv-wasm` and `@huggingface/transformers`.

---

## Repository layout

```
backend/
  src/
    server.js              Express app: middleware, route mounts, static SPA, health, admin bootstrap
    db.js                  SQLite connection (promisified run/get/all), schema init, password hashing
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
    scanMatch.js           Image ID pipeline: detect/rectify -> CLIP recall -> ORB+homography verify
    embedMatch.js          CLIP encoder + embedding DB (lazy ESM import, cached singleton)
    setIndex.js            On-demand per-set ORB index (set-scoped MTG matching), built from Scryfall
    utils/
      compartmentSort.js   Placement engine: which compartment/slot a card files into; sort comparators
      priceHelpers.js      Price resolution across printings; vintage-set detection; UTC parsing
      authHelpers.js       Auth-related helpers
      backup.js            DB backup helpers
  scripts/                 One-off builders for the global scan DBs (embeddings, ORB) + scan test harnesses
  test/                    Node test suites (sort, auth) and an e2e runner under test/e2e/
frontend/
  src/
    main.jsx, App.jsx      Entry + root: auth state, fetch wrapper (injects Bearer), tab routing, code-split views
    components/            One component per screen/widget (see Frontend section)
    utils/                 Pure helpers: sorting, pricing, printing/rarity styling, language, shuffle
Dockerfile, docker-compose.yml, .github/workflows/docker-build.yml   Container build + CI publish to GHCR
```

Regenerable/large artifacts live in `backend/data/` (scan embeddings, ORB indexes, per-set caches) and the SQLite DB — both gitignored.

---

## Backend

### Request lifecycle

`server.js` wires Helmet (with a Report-Only CSP that allow-lists the card-image
hosts), JSON body limits, the API routers, then serves the
built SPA and a SPA fallback. `GET /api/health` is unauthenticated and backs the
Docker `HEALTHCHECK`. On first startup with an empty DB it creates the default
`admin` user and prints the generated password once (or uses `DEFAULT_ADMIN_PASSWORD`).

### Auth

Authentication is DB-backed session tokens, not JWTs:

- `POST /api/auth/login` verifies a PBKDF2 password hash and inserts a row into `sessions` (`user_id`, `token`, `expires_at`).
- `authenticateToken` (`middleware/auth.js`) reads the `Bearer` token, looks it up in `sessions` where `expires_at > now`, and sets `req.user = { id, username, role, tcg_api_key, ... }`.
- `requireAdmin` gates admin-only routes on `req.user.role === 'admin'`.
- Rate limiters (`authLimiter`, `searchLimiter`, `importLimiter`) protect login and expensive endpoints.

`collection.js` applies `router.use(authenticateToken)` up front, so every
collection/location/deck-adjacent route requires a valid session.

### Route map

| Mount | File | Responsibility |
|-------|------|----------------|
| `/api/auth` | auth.js | `register`, `login`, `logout`, `me`, `PUT /settings` (per-user, e.g. `tcg_api_key`) |
| `/api` | collection.js | Card `search`, `scan-match`, `prepare-set`; `collection` CRUD + `bulk`; `locations` & `compartments` CRUD; category auto-assign, `recommend(-batch)`, `apply-all`, `resort`; `stats`, `stats/history`, `export`, `import`; `cards/:id/price-history` |
| `/api/decks` | decks.js | Deck CRUD, `:id/cards`, `:id/checkout`, `:id/return`, `:id/locations` (checkout/check-in locator payload) |
| `/api/sets` | sets.js | Set catalog (used for set dividers and set-scoped scan) |
| `/api/settings` | settings.js | App-wide settings (read any; write requires admin) |
| `/api/shared` | shared.js | Public, read-only collection view by `share_token` (no auth) |
| `/api/admin` | admin.js | User management, card cache seeding (admin) |

### Card data sources

`tcgApi.js` (Pokémon) and `scryfallApi.js` (MTG) both normalize provider cards
into one shape and upsert into `card_cache` so the rest of the app is
game-agnostic. Every card carries a `game` field (`pokemon` | `mtg`). A user's
Pokémon TCG API key (stored per-user) is passed through where available.

### Image identification pipeline

Server-side, image-only (no OCR). Entry point `scanMatch.match(buffer, game, topK, setCode)`:

1. **Detect & rectify** (`scanMatch.detectCard`/`preprocessCard`): OpenCV Canny + contour analysis scores card-like regions by `size × aspect-fit × centrality`, then perspective-warps a clean 4-point quad flat or crops the best bounding box; falls back to a centered guide-box crop.
2. **Recall** (`embedMatch.js`): CLIP image embedding (`@huggingface/transformers`, ONNX, lazy-loaded singleton) → top ~250 candidates by cosine similarity against the prebuilt embedding DB.
3. **Verify** (`scanMatch.inlierCount`): ORB descriptors matched with a brute-force Hamming matcher + Lowe ratio (0.75), then a RANSAC homography (5px); rank by geometric **inlier** count. Only the true printing yields many consistent matches.
4. **Game auto-detect**: verifies the requested game first; if weak (< 25 inliers) it also tries the other game and keeps the higher score.
5. **Set-scoped fast path** (`setIndex.js`): if an MTG set code is supplied, match ORB inliers against just that set's ~300 printings (index built on demand from Scryfall, cached under `backend/data/sets/`) — no global recall needed.

The client (`CameraScanner.jsx`) gates the result: auto-fill above threshold
(≥12 ORB inliers, or ≥0.55 CLIP similarity when ORB didn't run), otherwise show
candidates for a manual pick. See README "Card Scanning & Match Data" for the
build scripts and thresholds.

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
| `users` | `id`, `username`, `password_hash` (PBKDF2, iterations embedded), `role`, `share_token`, `share_enabled`, `tcg_api_key` |
| `sessions` | `user_id`, `token`, `expires_at` — Bearer-token auth |
| `card_cache` | Normalized card metadata keyed by provider `id`: `name`, `set_id`/`set_name`, `number`, `image_url`, `types`/`subtypes`/`supertype`, `rarity`, `cmc`, `color_identity`, `price_*`, `game` |
| `collection` | One row per owned stack: `id` (entry_id), `user_id`, `card_id`→card_cache, `quantity`, `condition`, `printing`, `language`, `purchase_price`, `location_id`, `compartment_id`, `position`, `list_type` (`collection`/`trade`), `is_trade`, `game`, `added_at` |
| `locations` | Physical containers: `user_id`, `name`, `type`, `sort_order`, `foil_sorting`, `rule_type`, `rule_config`, `game` |
| `compartments` | Pages/rows within a location: `location_id`, `idx`, `label`, `capacity`, `rule_config` |
| `compartment_assignments` | Maps sort categories to specific compartments (category→page filing) |
| `decks` | `user_id`, `name`, `description`, `checked_out`, `checked_out_at`, `created_at` |
| `deck_cards` | Deck contents: `deck_id`, `card_id`, `quantity` |
| `price_history` | Per-card price points over time, powering trend charts |
| `sets` | Set catalog (names/ordering) for dividers and set-scoped scan |
| `app_settings` | App-wide key/value settings (e.g. registration toggle) |

**Entry identity**: a `collection.id` (`entry_id`) uniquely identifies one
physical stack. Features that track individual copies (checkout locator, storage
highlighting) key on `entry_id`, never on `card_id + position` (which can collide
across compartments).

---

## Frontend

`App.jsx` holds auth state (`token`/`user` in `localStorage` under
`bindarr_*`), installs a `fetch` wrapper that injects the `Bearer` header on
`/api/*` calls and dispatches a logout event on `401`, and tab-routes between
code-split view components. `/share/:token` renders the public view without auth.

| Component | Role |
|-----------|------|
| `Login` | Auth screen (login/register) |
| `Dashboard` | Collection value, net-worth trends, distributions, milestones |
| `AddCards` | Wrapper toggling **CameraScanner** vs **CardSearch** |
| `CameraScanner` | Camera capture, guide box, POST `/api/scan-match`, confidence gate + manual pick |
| `CardSearch` | Name/number text search against the card APIs |
| `CardInspectorModal` | Card detail: pricing, types, printing/rarity, location |
| `CollectionList` | Browse/filter/sort the collection; bulk actions |
| `LocationManager` | Manage containers; binder/box views; filing mode; storage select |
| `CompartmentView` | Renders one compartment (binder pocket grid or box coverflow); highlights cards by `entry_id`; greys checked-out cards |
| `CreateContainerModal` | New-container wizard |
| `DeckBuilder` | Deck CRUD, composition charts, draw simulator, checkout/return |
| `CheckoutWizardModal` | Checkout **and** check-in locator (mode prop): grouped by container→page, grid highlight, select-all per page/container/all |
| `SortFilterBuilder` | Drag-and-drop sort scheme + filter rule builders |
| `Settings`, `AdminPanel`, `SharedCollection`, `PriceHistoryChart` | Preferences, user admin, public view, price charts |

Client utils (`utils/`): `cardSort` (shared sort comparators + `sortCardsByOrder`),
`resolveCardPrice`/`formatPrice` (pricing display), `cardPrinting`/`cardRarity`
(badge styling), `langHelper`/`pokemonTranslation` (Japanese name handling),
`cardOptions` (condition/printing/language enums), `shuffle` (draw sim).

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
- **SQLite runs in WAL mode** — checkpoint/stop before file-level backups so `-wal`/`-shm` are flushed.
- **Everything is game-scoped** (`pokemon` | `mtg`); new card fields must be threaded through both `tcgApi.js` and `scryfallApi.js` normalization.
- **`position = slot * 1000`** is the single source of truth for slot order; never assume packed array index equals slot.
- **Scan DBs are optional**: without the prebuilt global embedding/ORB data, set-scoped MTG matching still works (builds on demand); global/code-free matching and game auto-detection need the pre-built data.
- **Frontend lint is strict**: CI runs `eslint --max-warnings 0`, so unused vars/imports and empty blocks fail the Docker build.

---

## Build, run, test

Setup and Docker deployment: see [README.md](README.md). Quick reference:

- Backend: `cd backend && npm run dev` (nodemon) or `npm start`; port `3001`.
- Frontend: `cd frontend && npm run dev` (Vite, port `5173`, proxies `/api` → `3001`).
- Tests: `cd backend && npm test` (runs `test/sort.test.js` + `test/auth.test.js`); broader end-to-end suites live in `backend/test/e2e/` with `run.js`.
- Lint (matches CI): `cd frontend && npm run lint`.
