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
    tcgdexApi.js           TCGdex client: non-English Pokémon cards (the only source for them)
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
      pokemonProvider.js   The single answer to "pokemontcg.io or TCGdex for this language"
      languages.js         Language code/name resolution
    backup.js              DB backup helpers
  scripts/                 fetch-models.mjs, catalog builders, the scan-gate measurement harness
  data/models/             cornelius.onnx, milo.onnx and the built catalogs (CV_MODEL_DIR)
  test/                    Node test suites and an e2e runner under test/e2e/
frontend/
  src/
    main.jsx, App.jsx      Entry + root: auth state, fetch wrapper (injects Bearer), tab routing, code-split views
    components/            One component per screen/widget (see Frontend section)
    utils/                 Pure helpers: sorting, pricing, printing/rarity styling, language, shuffle
Dockerfile, docker-compose.yml, .github/workflows/docker-build.yml   Container build + CI publish to GHCR
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

`server.js` wires Helmet (with a Report-Only CSP that allow-lists the card-image
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

### Auth

Authentication is DB-backed session tokens, not JWTs:

- `POST /api/auth/login` verifies a PBKDF2 password hash and inserts a row into `sessions` (`user_id`, `token`, `expires_at`).
- `authenticateToken` (`middleware/auth.js`) reads the `Bearer` token, looks it up in `sessions` where `expires_at > now`, and sets `req.user = { id, username, role, tcg_api_key, ... }`.
- `requireAdmin` gates admin-only routes on `req.user.role === 'admin'`.
- A bearer token that matches no session is then checked against `users.api_key` — a long-lived read-only credential for external scripts (issue #33). It sets `req.user.via_api_key`, which makes `authenticateToken` refuse any non-GET (403) and `requireAdmin` refuse it outright, and makes `/auth/me` strip the account's other provider keys. Read-only is the whole reason a non-expiring credential is acceptable here; anything that weakens it has to replace it with something scoped.
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
| `/api/shared` | shared.js | Public, read-only collection view by `share_token` (no auth) |
| `/api/admin` | admin.js | User management, card cache seeding, `catalogs` (list / `build` / `stop` / `progress`), DB backups (admin) |

### Card data sources

`tcgApi.js` (Pokémon), `tcgdexApi.js` (non-English Pokémon) and `scryfallApi.js`
(MTG) all normalize provider cards into one shape and upsert into `card_cache`, so
the rest of the app is game-agnostic. Every card carries a `game` field
(`pokemon` | `mtg`) and a `language`. A user's Pokémon TCG API key (stored
per-user) is passed through where available.

`utils/pokemonProvider.js` owns the pokemontcg.io-vs-TCGdex decision. It is asked,
never re-derived from the language: four call sites once derived it themselves and
four of them disagreed, which is how 21,828 rows were cached with the wrong
normalizer and ended up with no image and no collector number.

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
| MTG, any language | Scryfall `prices.usd`, else `prices.eur` | `scryfall` | USD or EUR |
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
| `sessions` | `user_id`, `token`, `expires_at` — Bearer-token auth |
| `card_cache` | Normalized card metadata keyed by provider `id`: `name` (searchable) and `printed_name` (as printed), `language`, `set_id`/`set_name`, `number`, `image_url`, `types`/`subtypes`/`supertype`, `rarity`, `cmc`, `color_identity`, `price_*` with `price_source`/`price_currency`, `tcgplayer_product_id`, `tcgplayer_url`/`cardmarket_url`, `game`, `last_updated`. Written only through `utils/cardCache.cacheNormalizedCards`, which upserts — `INSERT OR REPLACE` re-created the row and reset every column outside the provider's own list |
| `collection` | One row per owned stack: `id` (entry_id), `user_id`, `card_id`→card_cache, `quantity`, `condition`, `printing`, `language`, `purchase_price`, `location_id`, `compartment_id`, `position`, `list_type` (`collection`/`trade`), `is_trade`, `game`, `added_at`; per-copy grading (`grader`, `grade`, `cert_number`) and per-copy value (`market_value`, `market_value_source`, `market_value_at`) |
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
| `CameraScanner` | Camera capture, in-browser corner detection + dewarp, POST `/api/scan-match`, confidence gate + manual pick |
| `CardSearch` | Name/number text search against the card APIs |
| `CardInspectorModal` | Card detail: pricing, types, printing/rarity, location |
| `CollectionList` | Browse/filter/sort the collection; bulk actions |
| `LocationManager` | Manage containers; binder/box views; filing mode; storage select |
| `CompartmentView` | Renders one compartment (binder pocket grid or box coverflow); highlights cards by `entry_id`; greys checked-out cards |
| `CreateContainerModal` | New-container wizard |
| `DeckBuilder` | Deck CRUD, composition charts, draw simulator, checkout/return |
| `CheckoutWizardModal` | Checkout **and** check-in locator (mode prop): grouped by container→page, grid highlight, select-all per page/container/all |
| `SortFilterBuilder` | Drag-and-drop sort scheme + filter rule builders |
| `CatalogPanel` | Scan catalogs: what is built per game/language, coverage against the provider's own totals, build/stop with live progress |
| `Settings`, `AdminPanel`, `SharedCollection`, `PriceHistoryChart` | Preferences, user admin, public view, price charts |

Client utils (`utils/`): `cardSort` (shared sort comparators + `sortCardsByOrder`),
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
- **SQLite runs in WAL mode** — checkpoint/stop before file-level backups so `-wal`/`-shm` are flushed.
- **Everything is game-scoped** (`pokemon` | `mtg`); new card fields must be threaded through both `tcgApi.js` and `scryfallApi.js` normalization.
- **`position = slot * 1000`** is the single source of truth for slot order; never assume packed array index equals slot.
- **Scanning needs a catalog**: the two ONNX models identify nothing on their own, and there is no second matcher to fall back to. `/api/scan-match` answers `503 notBuilt` with the fix in the message rather than an empty candidate list, which reads to the user as "your card could not be identified". A catalog is per (game, language) and only as complete as the provider's data for that language.
- **Frontend lint is strict**: CI runs `eslint --max-warnings 0`, so unused vars/imports and empty blocks fail the Docker build.

---

## Build, run, test

Setup and Docker deployment: see [README.md](README.md). Quick reference:

- Backend: `cd backend && npm run dev` (nodemon) or `npm start`; port `3001`.
- Frontend: `cd frontend && npm run dev` (Vite, port `5173`, proxies `/api` → `3001`).
- Tests: `npm test` from the root (or `cd backend && npm test`) runs every unit suite in `backend/test/` plus the e2e suites under `backend/test/e2e/`. `npm run test:e2e` runs only the latter. No framework — each file is a plain `node` script.
- Lint (matches CI): `cd frontend && npm run lint`.
