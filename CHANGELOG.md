# Changelog

All notable changes to this project will be documented in this file.

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
