# Changelog

All notable changes to this project will be documented in this file. Each
release also carries fuller notes on its
[GitHub release](https://github.com/thenotoriousJeremy/bindarr/releases).

## [1.8.1] - 2026-08-19

### Fixed
- **A row or page rename showed up nowhere.** The name saved to `compartments.label`
  correctly, but every place that displays one reads the computed `display_label`, and
  `compartmentLabel()` always built "Row N" / "Page N" from the index without ever
  checking for a custom label — so the saved name was discarded at display time in the
  row selector, the row header and the deck-checkout locator alike. Thanks
  [@JGHCode](https://github.com/JGHCode) ([#37](https://github.com/thenotoriousJeremy/bindarr/pull/37)).
- **A second copy of a card could not be added to a deck from Browse Collection.**
  `/api/collection` returns one row per physical entry while `/api/search` groups by
  `card_id`, and the browse path fed the ungrouped rows straight into the picker: every
  row for a card was marked "added" as soon as any one copy was, which made a second
  basic land or Energy unaddable. Browse results are grouped client-side now, summing
  quantities into one `owned_qty` per card, so both paths hand the picker the same
  shape. Thanks [@JGHCode](https://github.com/JGHCode) ([#37](https://github.com/thenotoriousJeremy/bindarr/pull/37)).
- **Card art left a gap under the coloured border.** The image rendered inline, which
  reserves descender space below the baseline. Thanks
  [@JGHCode](https://github.com/JGHCode) ([#37](https://github.com/thenotoriousJeremy/bindarr/pull/37)).
- **Catalog builds failed on Scryfall art.** Its image CDN rejects a request with no
  User-Agent — a 400, which reads like a bad URL rather than a missing header. Thanks
  [@JGHCode](https://github.com/JGHCode) ([#37](https://github.com/thenotoriousJeremy/bindarr/pull/37)).

## [1.8.0] - 2026-08-19

**Scanning is a different pipeline.** The perceptual-hash + bag-of-visual-words
recall stage and the ORB verify stage are gone, replaced by two small ONNX models:
`cornelius` finds the card's corners, `milo` embeds the dewarped card as a 128-d
unit vector, and a brute-force cosine sweep over a prebuilt catalog names it. On
the same 100-card noisy MTG sample the old stack scored 78.0% exact printing /
88.0% right card in 1187 ms; this scores 76.0% / 90.0% in 310 ms — and it replaces
~2.6 GB of per-set indexes and whole-game rollups with two model files and one
catalog per game and language, at roughly 5 MB per 10k cards. There is no index
build in the scan path at all, so scanning a set needs no "preparing set" wait.

Both models are AGPL-3.0 ([milo](https://huggingface.co/HanClinto/milo),
[cornelius](https://huggingface.co/HanClinto/cornelius)) while Bindarr is MIT, so
shipping them enabled is a licensing decision and not only a technical one.

**A card in another language is a card, not an English card with a label.** The
language of a copy now decides which printing it references, so it carries that
printing's name, artwork and price rather than the English row's; the name shows as
the card is printed everywhere it appears, while the English name stays searchable
alongside it. Prices for those printings improved in the same pass — Cardmarket
quotes are read where TCGplayer has no listing, the currency shown is the one the
marketplace quoted, and a price standing in from the English printing says so.

### Added
- **TCGdex is the Pokémon provider on a new install, and choosing is now possible.**
  `app_settings.pokemon_provider` has existed since 1.7.2 with no way to set it, and
  only half of the app read it — the card lookups followed the setting while the set
  catalogue always came from pokemontcg.io, so an install switched by hand browsed a
  set list numbered by a provider none of its cards came from. The setting now drives
  the set sync too (218 English sets with release dates and series, against
  pokemontcg.io's 174), and there is a selector in Admin → Instance Settings that
  re-syncs the set list and rebuilds the TCGplayer product map behind it. Measured
  per card lookup: 57-206 ms via TCGdex against 971-1963 ms via pokemontcg.io, which
  also answers 5xx often enough to need a retry policy. TCGdex needs no API key and
  is the only one of the two that carries non-English cards.

  **Upgrades keep pokemontcg.io.** The two providers number the same sets
  differently (sv1/sv01, pgo/swsh10.5, me1/me01), and every cached card, scan catalog
  and collection row was built against one of those numberings — so only a database
  with no Pokémon sets and no Pokémon cards starts on TCGdex. Switching an existing
  install is an explicit admin action, and the set rows its cards still reference are
  kept even when the new provider does not list them.
- **First run creates its own owner account.** A new install no longer generates an
  admin password and prints it to a log nobody reads (and few people then change).
  The users table starts empty, the login screen turns into a set-the-owner-password
  form, and `POST /api/auth/bootstrap` creates the account with admin rights, refusing
  the moment any account exists. `DEFAULT_ADMIN_PASSWORD` still seeds it up front for
  scripted deploys. Either way the account is named `admin` — the name is fixed, not
  the owner's to pick, so it is the same one whichever way the install started and the
  one the orphan-row adoption looks up. That adoption now runs from the bootstrap route
  too, so a database carrying pre-multi-user rows (`user_id IS NULL`) does not show an
  empty collection to an owner account created through the UI. Existing installs are
  untouched: they already have accounts.
- **The setup wizard covers the whole app, not just scanning.** Six steps: language,
  which games you collect, the scanner's models and catalog, the optional provider
  keys, your binders and boxes, then a one-page tour of what each tab is for. The
  language comes first and is translated like the rest of the app, so the steps that
  explain a decision arrive in the language the admin reads; it is the same setting as
  Settings → Language.
  Completion is stored on the server (`app_settings.setup_complete`) rather than in
  localStorage, so closing it halfway resumes at the next login on any device.
  Every install is offered it once, upgrades included — the wizard is where
  catalogs, games and the provider keys are explained, and an install that predates
  it has never seen that tour. "Skip setup" dismisses it permanently.
- **Catalogs replace scan indexes** (Admin → Catalogs). A catalog is one game and
  language, and building it does two things: walk every set the provider lists and
  pull its cards into `card_cache`, then embed each one's artwork. Those were never
  one job before, and the first half was the half nobody ran — card caching used to
  happen only as a side effect of indexing, so Pokémon held 7,118 of 20,460 English
  cards (35%), with 104 of 174 sets holding just the handful their owner happened to
  have. Both phases resume, a stop still writes the partial catalog, and a set with
  no data in the chosen language counts as a gap rather than a failure.
- **Coverage is shown with a denominator**, because "built, 3,297 cards" reads as
  complete and is not. English counts against the set catalogue; other languages
  count against the provider's own set list for that language, so a Japanese
  Pokémon catalog reads *3,297 of 16,192*.
- **Corner detection runs in the browser**, on a worker thread, using the same
  `cornelius` model the server dewarps with — so the outline on screen is by
  construction the crop that gets matched, and the client uploads one rectified
  448×448 square instead of a JPEG per preview frame (~2.7 MB per minute of pointing
  the camera at a card).
- **`scripts/measure-scan-floor.js`** — measures the scan gate instead of guessing
  it. For each sampled card it searches the catalog twice, once normally and once
  with the card's own row masked out (which is exactly what a card missing from the
  catalog looks like), under two degradation regimes, and prints what every
  candidate threshold would cost in wrong answers accepted and right answers
  rejected.

### Fixed
- **Non-English Magic cards were mostly unpriced.** Scryfall quotes `usd` from
  TCGplayer and `eur` from Cardmarket, and only the first was read — but TCGplayer
  lists English Magic almost completely and non-English barely at all, so whole
  languages sat at 0.00 while a Cardmarket price existed: measured against the real
  cache, 241 of 1,205 Spanish rows priced, 53 of 194 Italian, 11 of 61 Simplified
  Chinese, against 96,090 of 103,656 English. A printing with no USD price now takes
  its EUR one and records `price_currency` accordingly. Never a mix inside one row —
  a normal price in USD beside a foil price in EUR is a pair that cannot be compared.
  Owned cards pick this up on the next daily sweep.
- **Prices in another currency were shown with a dollar sign.** Stored prices are not
  converted (an exchange rate is a live number this app has no source for), so a
  Cardmarket-priced card was quoted at €4.50 and displayed as $4.50. The symbol now
  follows the row's `price_currency` everywhere a card price is shown, including the
  price-history axis and tooltip. Amounts the owner typed or paid still show in the
  app's default.
- **A German or Korean Pokémon card was priced as if it were English.** TCGplayer
  sells Pokémon in two catalogues, English and Japanese, so every other language is
  matched to the English product for the same set and number. That is the closest real
  number and better than 0.00, but it is not this printing's price — a German card
  usually trades below the English one, and a Korean one is often not listed at all.
  Such rows are recorded as their own price source and the card inspector now labels
  the price "TCGplayer (English printing)" instead of presenting it as a quote for the
  card in hand.
- **A card added in another language kept its English name.** The copy's language and
  the printing it points at were two separate things: the localized name lives on the
  card_cache row (`printed_name`), so picking a card from an English search and then
  setting Language to Japanese filed the copy against the ENGLISH printing — English
  name, English art, English price, permanently. Only the camera scan resolved the
  localized printing. Every add now routes through the same swap (search, Quick Add,
  bulk add, rapid add, slab add, scan), for all eleven languages in
  `shared/languages.json`. A card never printed in the language asked for keeps the
  printing that was picked, which is still what the user owns.
- **Names showed in English outside the collection grid.** Deck lists, the deck
  picker and preview, the checkout pull list and its "Missing …" warning, filing
  recommendations, the slab picker, the scanner's toasts and its debug candidates all
  read the English `name` column directly. They show the printed name now; `name`
  stays English where logic depends on it, so the four-copy deck rule still counts a
  Japanese and an English copy as the same card and CSV exports are unchanged.
- **A Japanese Pokémon card could only be found by typing Japanese.** TCGdex
  publishes one name per language, so a localized row carried the localized name in
  both `name` and `printed_name` and nothing English was left to search. A card being
  added now learns its English name from its own English printing when one exists (one
  request, cached), and the TCGdex price sweep backfills rows added before this.
  Display still reads `printed_name`; search reads both columns.
- **Re-caching a card silently reset columns no provider writes.** `card_cache` was
  written with `INSERT OR REPLACE`, which deletes the row and inserts a new one — so
  every column outside the provider's own list went back to its default, taking
  `price_1st_edition` (written only by tcgcsvApi) with it on every price sweep. It is
  an upsert now, which also protects the learned English name above.
- **Korean Pokémon scans found nothing at all.** The same photo scanned as English
  named the card immediately. A candidate from the ready-made Pokémon catalog is a
  TCGplayer product id, so it is resolved by set and collector number — and that set
  id is always an English one, while Korean, Japanese and Chinese Pokémon sets are
  their own releases (SM1M, S12, SV2a) rather than localised editions of the English
  ones. Asking TCGdex/ko about `base6` therefore returned nothing for every
  candidate, and a scan that had identified the card correctly reported "no confident
  match". The lookup now falls back to English when the scanned language has no such
  set, in the route and in the client's own retry, and the English card it hands back
  says so: the picker, the auto-add window and the add drawer all print a note that
  no card data exists in that language and this is the English printing standing in
  for it. The copy is still filed in the language being scanned, which it already
  was.
- **The scanned card now reads as the card.** Its name and collector number were the
  smallest text on screen in both the match picker and the add drawer, under a
  picture and a title that say nothing about which printing this is; they are now the
  largest, with the set name demoted beneath them. On a phone the add drawer was
  tuned to fit inside 80vh by shrinking everything — 65px of card art, 0.7rem labels,
  40px controls — which left a cramped strip at the bottom of a mostly empty screen;
  it now takes 92dvh (`dvh`, so the address bar cannot cut it off), with 104px of art
  and 44px touch targets. **"Different printing" is gone** from the drawer — it asked
  the provider for every printing of the name, which is a search, not a scan
  correction. "Other matches" stays: it is the escape for the scanner picking the
  wrong card.
- **Japanese Pokémon scans returned the wrong card.** Three causes, all of which
  had to go:
  - **A cosine sweep never returns nothing.** TCGdex serves card records for 28 of
    the 177 Japanese Pokémon sets it lists, so a Japanese catalog holds ~3.3k of
    ~16k cards — and every card outside those 28 sets was answered with the nearest
    of the wrong 3.3k, sometimes at a similarity high enough to auto-add. A scan in
    a non-English language now also sweeps the English catalog, because the artwork
    is identical across languages and English has a row for nearly every card the
    other catalog is missing; the answer is then re-expressed in the scanned
    language by set and collector number. The right card in the wrong language beats
    a wrong card in the right one. Verified on Japanese cards matched against the
    English catalog alone: スズナ → Candice, モンジャラ → Tangela, ダブラン → Duosion.
  - **A card the catalog has never seen now says so.** The response carries
    `notInCatalog` when the winner does not stand clear of ranks 2–11 of its own
    catalog, the client refuses to auto-add on it, and the candidate list is still
    shown — a bad photo and a missing card look identical from the server, and one
    of the candidates is right often enough to be worth the glance. The gate is that
    gap and not an absolute cosine because absolute cosine tracks photo quality:
    over 60 cards per catalog, a 0.65 cosine floor let 31–41 of 60 strangers through
    on clean input but 15–19 on degraded input, while a 0.10 gap held at 11–12 in
    both, rejecting no correct answer in any run.
  - **Non-English artwork was embedded at thumbnail resolution.** TCGdex's cached
    image url is `/low.png` (245×337, deliberately small so card grids stay cheap),
    so every TCGdex row was embedded from an upscaled blur while the camera handed
    over a sharp 448 crop. Builds now embed `/high.png` (600×825) without changing
    what the UI loads, and resume compares the url actually *embedded*, so raising
    the resolution rebuilds the old vectors instead of silently keeping them.
    Rebuild a Pokémon catalog to pick this up.
- **A set-scoped scan no longer widens itself.** Set ids do not survive a
  language — `SV4a` names no row in the English catalog — so a catalog with nothing
  in scope is dropped from the sweep rather than searched unscoped, which would have
  reintroduced the very wrong-card answer the scope exists to prevent. The filter is
  only ignored when *no* catalog has rows in scope, since "no match" for a card
  that is plainly there is the worse failure.

- **Scanning could not work in Docker at all.** The image never carried the two
  ONNX models and nothing fetched them, while `CV_MODEL_DIR` defaulted to a path
  inside the image — so a container had no models, and any catalog an admin did
  manage to build was discarded by the next image update. The image now sets
  `CV_MODEL_DIR=/app/database/models` on the persisted volume, `scripts/fetch-models.mjs`
  provisions the models (and optionally the published fallback catalogs) with their
  sizes verified, and startup names that command when they are missing instead of
  leaving the first scan to fail. `SETS_DIR` and `INDEX_DATA_DIR` are gone with the
  indexes they pointed at.
- **Removed the "let members build individual set indexes" setting.** There are no
  per-set indexes to build; catalog builds are admin-only because they walk an
  entire provider. The toggle, its API field and its strings are gone. The column
  stays unread — dropping it would mean a SQLite table rebuild for nothing.

### Changed
- **`opencv-wasm` is gone** from the scan path; the runtime is `onnxruntime-node`
  on the server and `onnxruntime-web` in a worker on the client. Name the execution
  provider explicitly in the browser: WebGPU measured 1075 ms per frame for
  `cornelius` against 80 ms on wasm.
- **The Scan Detail slider's recall knobs are inert.** Every scan is one 448px
  embed and one cosine sweep per catalog, so `recallK`/`orb` tune a pipeline that no
  longer exists; upload resolution and the auto-add confirm window still do what
  they say. The request keeps sending both fields so an older backend behaves.

## [1.7.2] - 2026-08-17

**This release is what an install carried over from an older version needs to
build scan indexes again.** A fresh 1.7.0 install was fine; one whose
`/app/database` volume predates it was not, and neither the panel nor the logs
said why. 1.7.1 made the failure legible and 1.7.2 repairs it, so upgrading an
old install to this version needs nothing from the operator — start it and the
volume is handed over on boot.

### Fixed
- **`EACCES: permission denied, mkdir '/app/database/index/.staging-mtg'` — a scan-index build could not write to its own data directory.** This is the upgrade case specifically: the entrypoint handed the volume to the `node` user only when `/app/database` itself was root-owned, so a root-owned *subdirectory* inside an already-handed-over volume was never fixed: the entrypoint's own `mkdir -p` creates `index/` and `sets/` as root, and on any volume that had already passed the old check they stayed that way. It now hands over whatever is not node-owned, which costs one stat walk and no writes on a healthy volume, and it no longer creates those subdirectories at all — the server creates them at startup as its own user, so they cannot be born root-owned. Startup also probes both directories with a real write and, where neither fix reaches (a bind mount whose `chown` no-ops, a compose file overriding `user:`), says so in one line instead of leaving a build to discover it hours later. Running installs can be fixed without upgrading: `docker exec -u root bindarr chown -R node:node /app/database`.

### Changed
- **The backend unit suites run under `node --test`** — one runner invocation for all 23 files instead of 23 chained `node test/*.js` calls, so a failure reports as a test result rather than as an exit code, and the whole suite is one summary. The e2e runner is unchanged and still runs after them (6 suites, 36 cases).
- **`test/crop.test.js` is gone**, and with it the `.bench-cache/` ignore rule. It was a benchmark, not a test: it downloaded card art to measure crop quality, so it needed the network, took the longest of anything in the suite, and could not fail in a way that meant "this build is broken".

## [1.7.1] - 2026-08-17

### Fixed
- **A scan-index build that could not start took the server down with it.** `globalIndex.startBuild` launched the build without catching its promise, and the staging-directory setup runs before `build()`'s own `try` — so an unwritable data directory rejected unhandled, which ends the process on Node 20. The click that started it got a dead connection, or a reverse proxy's HTML error page, instead of a message.
- **The scan-index panel reported every non-JSON response as `JSON.parse: unexpected character at line 1 column 1`.** It called `res.json()` unconditionally, so a 404 from an older backend, an HTML error page from a proxy, or an empty body all arrived as the same message naming neither the request nor the status. It now reports the status, the URL, and what actually came back.

## [1.7.0] - 2026-08-17

### Added
- **Read-only API keys** — a per-user key, generated in Settings, for reading a collection from outside Bindarr (a dashboard, a tracker) without a session that expires overnight. It never expires, and that is acceptable only because it is read-only: `authenticateToken` refuses any non-GET request made with it, `requireAdmin` refuses it outright, and `/auth/me` strips the account's other provider keys so a key pasted into a dashboard config cannot leak the PSA or TCG one.
- **`GET /api/stats/networth`** — value, spent, gain, `byGame`, and `currencies` as a *list*, in one pass over the collection. Providers quote in USD and EUR and the total sums them as-is, so naming a single currency would be a lie.
- **Per-copy card values** — `collection.market_value`, typed by the owner or fetched, which `resolveCardPrice` prefers over every provider column. One column, so net worth, set totals, price sort and exports all read the same number regardless of origin. Needed because every price source here (TCGplayer, Scryfall, Cardmarket) quotes the *raw* card, and a PSA 10 is not the raw price plus a bit.
- **Graded-slab price lookup** for Pokémon, from an optional PokemonPriceTracker key: PSA, BGS and CGC, half grades included, from `ebay.salesByGrade`. A button and never a sweep — that provider bills per card returned and the free tier is 100 credits a day. When a grade has no sales the refusal names the grades that do.
- **PSA cert lookup and slab grading**, TCGCSV pricing, and per-card art overrides.
- **Binder drag-and-drop** — drag a card from Unsorted into a pocket, drag a filed card to another pocket (empty moves, occupied swaps, across the spread included), or drag one back to the queue to unfile it. No backend change: `/collection/:id/place` already swapped and moved. Custom-order binders, mouse only; touch keeps filing by tap under Arrange, since a touch drag would swallow the page-swipe.

### Changed
- **Code-free scan matching recalls with BoVW** instead of CLIP, and the global index pipeline was rebuilt around it.
- README rewritten around Docker, with the non-setup material moved to PROJECT.md. Settings now keeps every provider key in one panel instead of four.

### Fixed
- **`/api/export` answered 500 on every current database.** It selected `c.sub_location_1`, a column `db.js` drops the table to remove, and its market price was `cc.price_trend` flat — wrong for every foil, 1st Edition and slab. Rebuilt from the compartment and priced through `resolveCardPrice`.
- **The card inspector showed the price resolved for the *saved* printing**, so switching foil type changed nothing until a save and a refetch. It resolves live now.
- The Pokémon provider is decided once, and by provider rather than by language.

## [1.6.1] - 2026-08-04

### Added
- **Eight new locales** — es, fr, it, ko, pt-BR, ru, zh-Hans, zh-Hant — plus German and Japanese completed, all ten reporting a full key count. Plurals follow each language's own CLDR categories rather than English's two: one form for ja/ko/zh, three for es/fr/it/pt-BR, four for ru with correct case declension.

### Fixed
- `container.type.other` and its sibling key are renamed. `check-locales.mjs` reads a key ending in a plural category as a counted phrase, so `other` made the checker demand a `container.type.one` from every language with more than two plural forms. The stored database value is unchanged; only the lookup key moved.

## [1.6.0] - 2026-08-04

### Added
- **Card languages** (#25) — language is recorded per copy. MTG printings come from Scryfall and non-English Pokémon cards from TCGdex, since pokemontcg.io has no data for them at all, prices included. Set indexes and scanning are per game *and* language, because the art and the set lists both differ.
- **Translatable interface** (#25) — every string lives in `frontend/src/locales/en.json`; a translation is that one file copied and translated, with no code or tooling, and untranslated keys fall back to English individually. See `docs/TRANSLATING.md`.
- **Hide games you don't collect** (#26) — a per-device Settings toggle removes a game from every picker, tab and filter. Display only: nothing is deleted and export is unchanged.
- **HTTPS listener** (#27) — browsers only hand the camera to a secure context, so `http://<lan-ip>:3001` could never scan and showed no prompt to accept. The image now serves the same app on 3443 with a self-signed certificate generated beside the database, so phones can scan without a reverse proxy. HSTS stays off while that certificate is self-signed, or clicking past the warning becomes impossible.
- `backend/test/crop.test.js`, a measured recall gate for scan cropping, which caught silent crop regressions.

## [1.5.2] - 2026-07-29

### Fixed
- **`latest` tracked `main` rather than the newest release, and pointed at a different digest than the version tags.** It was gated on `refs/heads/main` while the semver tags only apply on a tag ref, so the two were published by separate runs. The README tells self-hosters to run `:latest`, which handed them whatever was last merged — including states whose server binaries did not start. `latest` is now applied on `v*` tags alongside the version numbers, on one digest; `main` publishes **`edge`** for anyone tracking unreleased work. The Docker workflow gained `workflow_dispatch` so a release's image tags can be republished without moving its git tag, and the README documents what each tag points at.

No application code changed in this release.

## [1.5.1] - 2026-07-29

### Fixed
- **The self-hosted server binary exited immediately on launch** with `Cannot find module '../../../shared/cardOrder.json'`. `compartmentSort.js` reads the canonical card-order tables from the repo-root `shared/` directory, which the release job never copied into the packaged tree — so **every server binary from v1.4.x onward was affected**. Docker images and the mobile apps were never affected; both keep the repository layout, where the path resolves. Nothing caught it because the whole test suite runs from source.
- CI now **boots the assembled binary and polls `/api/health`**, failing the build if it exits or never answers. Source-based tests are structurally blind to packaging faults.
- The launcher no longer dies silently: it prints the failure, points at the issue tracker for a missing-file error, and waits for a keypress — while still exiting immediately when stdin is not a TTY, so running it as a service or piped into a log is unchanged.

## [1.5.0] - 2026-07-28

### Added
- **Search & Add paging** — 30/60/120/250 per page with a Load more button and the provider's real match count, replacing a hard 50-result cap. Scryfall's default collapse to one printing per name is off, so "Sol Ring" returns its 55 printings rather than 2. A set plus a collector number identifies exactly one card, so that pair opens Quick Add directly. Digital-only prints (Alchemy rebalances) are excluded — no physical card exists.
- **Multi-select with shift-click ranges** in Search & Add, using the same hook, long-press gesture and visuals as the collection, which gains range-select too. **Bulk add** puts a whole selection in with one action, sharing the single-add path so placement and price history behave identically.
- **Rapid Add** — pin a set, type a collector number, press Enter; the field keeps focus for the next card, with a running receipt and per-card undo. **Owned badges** show what is already in your binder while browsing a set, and set codes autocomplete over every known set for both games.
- **About Bindarr panel** — version, update check against GitHub releases, and one-click bug report or feature request with version, platform and browser prefilled (nothing is submitted until you review it on GitHub). The version is baked in at build time, so it shows even when the backend is unreachable, and a frontend/backend version disagreement is called out as a half-finished update.
- Full-screen card art in the Search & Add drawer, sharing one viewer with the collection inspector.

### Changed
- **`pokemon_cards.db` is renamed to `bindarr.db`** — a leftover from when this was PokeKeep, a Pokémon-only tracker. Upgrades migrate automatically on first start: the old file is renamed along with its `-wal`/`-shm` sidecars, never overwriting an existing `bindarr.db`, and falling back to the old file if the rename fails rather than opening an empty database. A pinned `DB_PATH` on the old filename keeps working, and existing `pokemon_cards.*.bak` backups still list and restore.
- **Price history ranges are now 30D and All.** 1Y and 5Y could never show anything different — no card API sells back-history, so they redrew the same line under a different label. Pokémon charts use Cardmarket's real `avg30`/`avg7`/`avg1` rolling averages, each plotted at the midpoint of the period it averages rather than its start.

### Fixed
- **Repeated Scryfall `429`s**, from two real faults: the published limits are per endpoint (`/cards/search` and `/cards/collection` allow 2/second, not the 10/second that covers other methods), and a `429` only backed off the request that received it while the queue behind it kept firing and renewed the penalty. All Scryfall traffic now pauses for the window Scryfall asks for.
- Price sweeps batch through `/cards/collection` at 75 identifiers per request — a 160-card sweep went from 160 requests over ~50s to **3 requests in 2.1s** — and run at most once daily, matching Scryfall's own price cadence. The boot sweep previously re-ran on every restart.
- **Snapshots are recorded only when the price changes**, and use millisecond timestamps. One card had accumulated 335 snapshots covering 3 distinct prices; flat runs now collapse on read to 14 plotted points without losing shape. `recorded_at` is part of the primary key, so two genuine moves inside one second silently dropped one.
- **MTG search reported a throttled or unreachable Scryfall as "no cards matched"** — the same misleading-empty-result class fixed for Pokémon in #23. It now serves cache, or reports the outage honestly. The MTG rate-limit banner no longer suggests a pokemontcg.io API key; Scryfall does not use one.
- Search & Add opened on Pokémon regardless of the Settings default game, and searching a Pokémon set with no card name returned nothing at all.

## [1.4.30] - 2026-07-21

### Added
- **Default Card Stacking** — collection views now default to stacking identical cards. Added stacking toggle filters (unstack, group by condition, group by printing) to the shared collection view.
- **Bidirectional Rarity Sort** — added `Rarity (High-Low)` and `Rarity (Low-High)` sorting to main and shared collection views.
- **Shared Theme Support** — share links now preserve and force active theme via `?theme=` URL query parameter (e.g. `?theme=lcars` or `?theme=light`).

### Fixed
- **Chart Tooltip Text Readability** — styled Recharts chart tooltips across all themes (Dark, LCARS, Light) so hover popups are always crisp and legible.
- **Single Card Quantity Badge** — hid the `x1` quantity tag on single cards in shared collection view.
- **Location Slot Number in Card Inspector** — fixed card inspector pop-up to accurately display slot number across 0-indexed and multiplier position encodings (e.g., `binder • Page 1 • Slot 1`).

## [1.4.25] - 2026-07-21

### Added
- **Notes** — a standalone notebook tab for free-form notes (wishlist ideas, deals, trade plans), separate from card entries. Create, edit (saves on blur), pin to top, and delete. Includes client-side search over title/body and sort by recently updated, recently created, or title.
- **Per-card notes** — collection entries now carry an optional free-text note (provenance, condition details, trade plans), editable in the card inspector and shown on the card's detail view.

## [1.4.21] - 2026-07-21

### Fixed
- **Sign Up button never appeared in the native app** even when the server had registration enabled. The login screen fetches `/api/auth/config` once on mount, but on a native cold start the WebView renders before the CapacitorHttp bridge/network is ready, so that fetch failed and `registrationEnabled` stayed `false` with no retry. The config check now retries on failure (up to 5x, 1.5s apart), refetches when the app resumes, and is debounced so a freshly-typed server address is checked once it settles. A genuine `200 {registrationEnabled:false}` still stops immediately, so invite-only servers are unaffected.

## [1.4.20] - 2026-07-21

### Fixed
- **Scan settings panel shifted the buttons when toggled.** Opening the gear panel pushed the whole action row (Stop / Auto / Capture / gear) down, so the gear moved out from under your finger. The panel now expands below the button row (`order: 2`); the buttons stay put whether settings are open or closed.
- **Manual exposure slider did nothing until you moved it *and* pressed Auto.** `changeExposure` set `exposureMode: 'manual'`, but `exposureCompensation` is an EV bias that only applies on top of continuous auto-exposure — in manual mode the camera drives exposure by exposureTime/ISO and ignores the compensation. The slider now applies compensation in `'continuous'` mode, so it takes effect live on the first move (Android back cameras).

### Changed
- **Camera preview is a consistent size across devices and the packaged app.** An inline `aspectRatio` override made the preview box jump to each camera stream's own ratio once it loaded, so the box was a different size on every device. Removed the override so the box stays locked to the trading-card 5/7 ratio, and switched `.camera-video` to `object-fit: cover` (with the crop mapping switched from `min` to `max` to match) so the live video fills the card box edge-to-edge with no letterbox bars.

## [1.4.18] - 2026-07-20

### Fixed
- **Scanning died after ~67 cards** with `preprocessCard failed: undefined` / `scan-match failed: undefined`, permanently until the backend restarted. Root cause: the ORB verify loops (`inlierCount` in `scanMatch.js`, `inliers` in `setIndex.js`) leaked an embind `DMatchVector` wrapper (`knn.get(i)`) on every match row — it was never `.delete()`d. The opencv-wasm heap grows and never shrinks, so the leak ratcheted memory up (128 MB → 1 GB+) until `memory.grow()` failed and OpenCV aborted with a numeric error (hence the `undefined` message). Every subsequent OpenCV call then failed instantly, and since the backend process held the dead heap, restarting the app didn't help. Fixed by deleting the wrapper each iteration; the heap now stays flat.

### Performance
- **Set-scoped scan verification is now parallel** across a warmed worker-thread pool (`backend/src/scanPool.js`, `scanWorker.js`), each worker holding its own opencv-wasm instance. The independent per-printing ORB verifies are sharded across cores; results are identical to the previous single-threaded ranking (lossless). Measured on a 771-card set: **7079 ms → 2306 ms (4 workers) → 1457 ms (8 workers)**. Configurable via the new `SCAN_WORKERS` env var (default `min(4, cores-1)`, `0` disables). `matchSet` is now async; the pool is warmed at server startup so the first scan doesn't pay worker spawn + wasm load.
- Faster candidate feature loading in the global path: `readOrb` builds descriptor Mats via `Mat.data.set()` instead of `matFromArray(Array.from(buf))` (~53 ms/scan saved on 250 candidates; identical bytes).
- Worker threads no longer open a SQLite connection each: `scryfallApi`/`tcgApi` (which pull in the DB) are lazy-required inside the build/preview paths only, keeping the verify path DB-free.

### Diagnostics
- Opt-in `SCAN_RANK_LOG=1` appends one line per confident scan to `backend/scan-rank.log` recording where the winning card sat in the CLIP recall list — for measuring whether the global-path `RECALL_K` (250) can be lowered. Off by default, zero overhead.

### Storage
- Removed the category-map filing feature from the storage view (`showCategoryMap` / category-to-page filing) in `LocationManager.jsx`.

## [1.4.0] - 2026-07-15

### Features
- Bulk-set condition and printing on selected cards from the collection long-press/select bar (`POST /api/collection/bulk` actions `condition` and `printing`).
- Split a total price paid for a pack or deck across cards into per-card `purchase_price` (`bulk` action `purchase_split`), weighted by market value or evenly, chosen at apply time. Integer-cent math keeps the parts summing to the exact total (`backend/src/utils/splitPrice.js`). Available in the collection bulk bar and the scanner's Recent Scans panel.

### Scanner
- Tap the auto-add countdown popup (Fast/Balanced/Accurate tiers) to pause and adjust condition/printing before the card is saved; ignoring it lets the normal auto-add proceed. Turbo remains instant.
- Quick-add fields: larger +/- quantity stepper; the rarely-changed Language field is dropped from the scanner quick-add.
- Tighter camera preview height on small screens.

### Storage
- Mobile filing: below 1024px, view the container detail and Unsorted queue one at a time via a segmented toggle; during filing the binder stays on screen (recommended slot blinks) with a compact pinned filing bar for Placed/Skip, and the view auto-follows the recommended slot.
- Custom (manual) container order is saved when all sort rules are removed; guidance text updated accordingly.
- Removed the Auto-Assign Categories action.

## [1.3.0] - 2026-07-14

### Fixed
- Replaced `COUNT(*)` with `COALESCE(SUM(quantity), 0)` in storage capacity calculations across `collectionHelpers.js`, `compartmentSort.js`, and `storage.js`.
- Fixed N+1 database access loops in multi-quantity card creation (`POST /api/collection`) and bulk operations (`POST /api/collection/bulk`).
- Fixed serial loop in deck checkout allocation (`checkedOutAllocation`) using a single SQL `JOIN` query.

### Performance & Memory
- Implemented `withTransaction` atomic SQLite transaction management in `db.js`.
- Refactored physical container re-sorting (`POST /api/locations/:id/resort`) using SQL `CASE ... WHEN` batch updates.
- Added single-pass JSON metadata pre-parsing (`types`, `subtypes`, `color_identity`) in `compartmentSort.js`.
- Added composite SQL performance indexes for compartment lookups, location ordering, card search, deck checkout, tag joins, and audit log ordering.

### Features
- Added custom user tags system (`tags` master table & `collection_tags` junction table, `/api/tags` endpoints).
- Added storage capacity alert warnings endpoint (`GET /api/locations/alerts`).
- Added append-only audit logging & action revert capabilities (`audit_logs` table, `/api/audit-logs`, `/api/audit-logs/:id/revert`).
- Added saved filter presets (`saved_filter_presets` table, `/api/collection/filters/presets`, dynamic query builder).
- Added third-party CSV strategy import mappers and hygiene export mappers for TCGPlayer, Dragon Shield, and ManaBox (`csvMappers.js`, `csvExporters.js`).

### Scanner
- Added a Scan Detail slider (Turbo/Fast/Balanced/Accurate) trading speed for accuracy per scan: upload resolution, auto-capture cadence, server-side CLIP recall depth (`recallK`) and ORB feature count (`orb`).
- Turbo runs a fixed 2-second capture cadence with an on-screen countdown ring; the metronome holds while a scan is in flight so captures never overlap.
- Instant capture cue (click + vibrate + border flash) fires the moment the frame is grabbed.
- Added manual exposure control (shown when the camera track supports `exposureCompensation`).
- Duplicate-scan handling: dedup guard set before the add request; the resolved-duplicate skip clears when the card leaves frame or a different card appears; Cancel in the candidate picker stops auto-capture.
