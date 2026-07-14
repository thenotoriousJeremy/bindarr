# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-07-14

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
