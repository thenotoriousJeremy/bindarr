# Architectural Review Plan & Quality Enhancement Specification
## Card Collection and Storage Management Engine — `pokedexrr`

**Document Version**: 1.0.0  
**Target Subsystem**: Backend Collection Router (`collection.js`), Storage Manager (`storage.js`), Compartment Helper (`collectionHelpers.js`), Sorting Engine (`compartmentSort.js`), Import Engine (`importExport.js`), and Database Migration System (`db.js`).  
**Author**: Subagent `worker_planner`  
**Execution Context**: Comprehensive, Non-Destructive Code Quality & Missing Feature Plan  

---

## 1. Executive Summary & Review Scope

This document defines the architectural review, bug fix plan, performance refactoring strategy, and missing feature specification for the card collection and physical storage management subsystem in `pokedexrr`. 

### Key Findings Summary
1. **N+1 Database Access Patterns & Un-batched Write Loops**: Multiple core operational endpoints (bulk movements, card additions with `quantity > 1`, physical container re-sorting, and rule-based evictions) issue single-row `INSERT` or `UPDATE` SQL queries sequentially inside JavaScript loops.
2. **Physical Storage Capacity Undercount Bug**: Capacity evaluation across `collectionHelpers.js`, `compartmentSort.js`, and `storage.js` counts database *rows* (`COUNT(*)`) rather than aggregate card quantities (`SUM(quantity)`). When cards with `quantity > 1` exist, physical containers overfill past designated physical limits.
3. **Missing SQL Transaction Scoping**: Multi-statement DML routines operate without atomic transaction bounds (`BEGIN TRANSACTION` / `COMMIT`), risking database corruption or inconsistent state on execution failure.
4. **In-Memory Sorting & Deserialization Latency**: Complex card sorting runs entirely within Node.js process memory while repeatedly invoking `JSON.parse` on card metadata fields (`types`, `subtypes`, `color_identity`, `rule_config`, `sort_order`) inside sorting comparator loops.
5. **Missing Enterprise Collection Features**: The application lacks normalized custom user tags, proactive storage capacity monitoring/alerts, audit log change tracking with revert capabilities, saved filter presets, and third-party CSV import adapters (TCGPlayer, Dragon Shield, ManaBox).

---

## 2. Comprehensive Architectural Assessment

```
+---------------------------------------------------------------------------------------------------+
|                                      FRONTEND LAYER (React/Vite)                                  |
|  [CollectionList.jsx]          [LocationManager.jsx]          [CompartmentView.jsx]               |
+---------------------------------------------------------------------------------------------------+
                                                   |  HTTP REST / JSON API
                                                   v
+---------------------------------------------------------------------------------------------------+
|                                  BACKEND ROUTER LAYER (Node.js/Express)                           |
|  /api/collection               /api/locations                 /api/import                       |
|  (`collection.js`)             (`storage.js`)                 (`importExport.js`)               |
+---------------------------------------------------------------------------------------------------+
         |                                         |                                  |
         v                                         v                                  v
+-----------------------+       +-----------------------------------+       +-----------------------+
|  COLLECTION HELPERS   |       |        COMPARTMENT SORTING        |       |    THIRD-PARTY API    |
| (`collectionHelpers`) | <---> |       RECOMMENDATION ENGINE       | <---> | (`tcgApi`/`scryfall`) |
|                       |       |       (`compartmentSort.js`)      |       |                       |
+-----------------------+       +-----------------------------------+       +-----------------------+
         |                                         |
         +--------------------+--------------------+
                              | SQLite3 Promises (`db.js`)
                              v
+---------------------------------------------------------------------------------------------------+
|                                    SQLITE DATABASE ENGINE (WAL Mode)                              |
|   Tables: `collection`, `locations`, `compartments`, `compartment_assignments`, `card_cache`       |
+---------------------------------------------------------------------------------------------------+
```

### Table 2.1: Key Components & Code Locations Overview

| File Path | Functional Responsibility | Key Methods / Endpoints | Architectural Role |
|---|---|---|---|
| `backend/src/db.js` | SQLite Schema & Migrations | `initDb`, `run`, `get`, `all` | Data access layer, table DDL, WAL & FK setup |
| `backend/src/routes/collection.js` | Collection Management API | `GET /`, `POST /`, `PUT /:id`, `POST /bulk` | CRUD actions, filtering, bulk operations |
| `backend/src/routes/storage.js` | Storage & Location Management API | `GET /locations`, `POST /locations/:id/resort` | Container lifecycle, capacity maintenance, filing |
| `backend/src/utils/collectionHelpers.js` | Allocation & Pricing Business Logic | `resolveCompartmentAndPosition`, `checkedOutAllocation`, `resolveCardPrice` | Physical slot resolution & deck checkout calculations |
| `backend/src/utils/compartmentSort.js` | Recommendation & Sorting Engine | `sortCards`, `recommendSlot`, `rebalanceCompartmentByScheme` | Sorting algorithms, category matching, slot predictions |
| `backend/src/routes/importExport.js` | Bulk CSV & JSON Processing | `POST /import/csv`, `GET /export/csv` | File ingestion and export rendering |

---

## 3. Code Quality, Bug Fixes & Refactoring Action Plan

### 3.1 Defect 1: Storage Capacity Undercounting Bug (`SUM(quantity)` vs. `COUNT(*)`)

#### Exact Code Locations
- `backend/src/utils/collectionHelpers.js:71`
- `backend/src/utils/compartmentSort.js:346`
- `backend/src/routes/storage.js:14`

#### Issue Analysis
The capacity evaluation logic checks whether a physical compartment has reached its limits using:
```js
SELECT COUNT(*) as cnt FROM collection WHERE compartment_id = ?
```
When cards are added via bulk CSV import (`importExport.js:256`) or updated manually, a single row in `collection` can have `quantity > 1` (e.g. `quantity = 10`). Counting rows (`COUNT(*)`) reports `1` card stored instead of `10`, allowing compartments to overfill up to 10x past their maximum allowed physical capacity.

#### Refactoring Specification & Code Blueprint

Replace `COUNT(*)` with `COALESCE(SUM(quantity), 0)` in all compartment capacity checks.

**File**: `backend/src/utils/collectionHelpers.js:68-76`
```javascript
// EXISTING (Defective):
const cardCount = await db.get(
  `SELECT COUNT(*) as cnt FROM collection WHERE compartment_id = ?`,
  [compartmentId]
);
if (cardCount && cardCount.cnt >= comp.capacity) { ... }

// PROPOSED REFACTORED BLUEPRINT:
const cardCount = await db.get(
  `SELECT COALESCE(SUM(quantity), 0) AS total_cards FROM collection WHERE compartment_id = ?`,
  [compartmentId]
);
if (cardCount && cardCount.total_cards >= comp.capacity) {
  // Compartment is physically full based on actual card count
  return null;
}
```

**File**: `backend/src/utils/compartmentSort.js:340-350`
```javascript
// PROPOSED REFACTORED BLUEPRINT:
async function getCompartmentOccupancy(db, compartmentId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(quantity), 0) AS total_cards FROM collection WHERE compartment_id = ?`,
    [compartmentId]
  );
  return row ? row.total_cards : 0;
}
```

---

### 3.2 Defect 2: N+1 Serial Insertion Loop on Multi-Quantity Card Addition

#### Exact Code Location
- `backend/src/routes/collection.js:226-258`

#### Issue Analysis
When adding multiple copies of a card (`quantity > 1`), the handler executes a single-step `for` loop that issues individual SQL `INSERT` statements and calls `rebalanceCompartmentByScheme` on every single iteration:

```js
// Existing defective loop:
for (let i = 0; i < quantity; i++) {
  const res = await db.run(`INSERT INTO collection ...`);
  if (resolvedCompId) {
    await rebalanceCompartmentByScheme(db, resolvedCompId, location.sort_order, location.foil_sorting);
  }
}
```
If `quantity = 50`, this results in 50 separate SQL inserts and 50 compartment rebalances, freezing the SQLite database and degrading API response times from milliseconds to seconds.

#### Refactoring Specification & Code Blueprint

1. Insert a single database row with `quantity = N` if unstacked items are not explicitly forced, OR execute a multi-row parameterized `INSERT INTO collection ... VALUES (...), (...)...` in a single SQL statement inside a single transaction.
2. Trigger `rebalanceCompartmentByScheme` **once** after all insertions finish.

```javascript
// REFACTORED BLUEPRINT FOR backend/src/routes/collection.js:226-258
app.post('/api/collection', async (req, res) => {
  const { card_id, user_id, quantity = 1, condition, printing, language, purchase_price, location_id, compartment_id, is_trade, favorite, list_type, game } = req.body;

  await withTransaction(db, async (tx) => {
    // If location allows quantity stacking or auto-resolved slot:
    const resolved = await resolveCompartmentAndPosition(tx, location_id, card_id, user_id);
    const resolvedCompId = compartment_id || (resolved ? resolved.compartment_id : null);
    const resolvedPos = (resolved && resolved.position) ? resolved.position : Date.now();

    // Single multi-row insert execution or single row with quantity count
    if (req.body.stackable) {
      await tx.run(
        `INSERT INTO collection (card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, is_trade, favorite, list_type, game)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, resolvedCompId, resolvedPos, is_trade || 0, favorite || 0, list_type || 'collection', game || 'pokemon']
      );
    } else {
      // Parameterized bulk multi-row single query
      const placeholders = [];
      const params = [];
      for (let i = 0; i < quantity; i++) {
        placeholders.push('(?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        params.push(card_id, user_id, condition, printing, language, purchase_price, location_id, resolvedCompId, resolvedPos + (i * 0.001), is_trade || 0, favorite || 0, list_type || 'collection', game || 'pokemon');
      }

      await tx.run(
        `INSERT INTO collection (card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, is_trade, favorite, list_type, game)
         VALUES ${placeholders.join(', ')}`,
        params
      );
    }

    // Rebalance location compartment EXCLUSIVELY ONCE post-insertion
    if (resolvedCompId && location_id) {
      const loc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ?`, [location_id]);
      if (loc) {
        await rebalanceCompartmentByScheme(tx, resolvedCompId, loc.sort_order, loc.foil_sorting);
      }
    }
  });

  return res.json({ success: true, message: `Successfully added ${quantity} card(s)` });
});
```

---

### 3.3 Defect 3: Un-batched Bulk Actions and Serial Move Loop

#### Exact Code Location
- `backend/src/routes/collection.js:522-537`

#### Issue Analysis
The `POST /api/collection/bulk` endpoint processes bulk operations (such as `move`) by looping through array elements sequentially and executing individual `db.get` and `db.run` statements per item:

```js
for (const id of ids) {
  const item = await db.get('SELECT * FROM collection WHERE id = ?', [id]);
  await db.run('UPDATE collection SET location_id = ?, compartment_id = ? WHERE id = ?', [locId, compId, id]);
}
```

#### Refactoring Specification & Code Blueprint

1. Replace individual `UPDATE` statements with an `IN (...)` SQL query clause.
2. Scope execution inside an explicit SQL transaction context.

```javascript
// REFACTORED BLUEPRINT FOR backend/src/routes/collection.js:522-537
app.post('/api/collection/bulk', async (req, res) => {
  const { ids, action, target_location_id, target_compartment_id, target_list_type, is_trade } = req.body;
  
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }

  await withTransaction(db, async (tx) => {
    const placeholders = ids.map(() => '?').join(',');

    if (action === 'move') {
      await tx.run(
        `UPDATE collection 
         SET location_id = ?, compartment_id = ?, position = strftime('%s%f', 'now') 
         WHERE id IN (${placeholders})`,
        [target_location_id || null, target_compartment_id || null, ...ids]
      );
    } else if (action === 'delete') {
      await tx.run(`DELETE FROM collection WHERE id IN (${placeholders})`, ids);
    } else if (action === 'set_trade') {
      await tx.run(`UPDATE collection SET is_trade = ? WHERE id IN (${placeholders})`, [is_trade ? 1 : 0, ...ids]);
    } else if (action === 'set_list_type') {
      await tx.run(`UPDATE collection SET list_type = ? WHERE id IN (${placeholders})`, [target_list_type, ...ids]);
    }
  });

  return res.json({ success: true, count: ids.length });
});
```

---

### 3.4 Defect 4: Serial Physical Container Re-Sorting & Rule Eviction Loops

#### Exact Code Locations
- `backend/src/routes/storage.js:141-149` (Location Rule Eviction)
- `backend/src/routes/storage.js:241-248` (Compartment Rule Eviction)
- `backend/src/routes/storage.js:576-593` (Physical Re-sorting Loop)

#### Issue Analysis
During container re-sorting (`POST /api/locations/:id/resort`), cards are sorted in JavaScript memory and updated via a `for` loop executing an individual SQL `UPDATE` statement per card:

```js
// Existing line 584-590 in backend/src/routes/storage.js:
for (let i = 0; i < sorted.length; i++) {
  const c = sorted[i];
  await db.run(
    `UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ?`,
    [locationId, targetCompId, (i + 1) * 1000, c.id]
  );
}
```
For a binder containing 1,000 cards, 1,000 independent network IPC and SQL update execution cycles take place.

#### Refactoring Specification & Code Blueprint

Batch updates using SQLite `CASE ... WHEN` conditional statements or a single transaction with pre-compiled statement reuse.

```javascript
// REFACTORED BLUEPRINT FOR backend/src/routes/storage.js:576-593
app.post('/api/locations/:id/resort', async (req, res) => {
  const locationId = req.params.id;

  await withTransaction(db, async (tx) => {
    const cards = await tx.all(`SELECT c.*, cc.name, cc.set_code, cc.collector_number, cc.types, cc.rarity 
                                FROM collection c 
                                LEFT JOIN card_cache cc ON c.card_id = cc.id 
                                WHERE c.location_id = ?`, [locationId]);
    
    const location = await tx.get(`SELECT * FROM locations WHERE id = ?`, [locationId]);
    const sortedCards = sortCards(cards, location.sort_order, location.foil_sorting);

    // Group updates into chunks of 100 using CASE statement batching
    const CHUNK_SIZE = 100;
    for (let i = 0; i < sortedCards.length; i += CHUNK_SIZE) {
      const chunk = sortedCards.slice(i, i + CHUNK_SIZE);
      const ids = chunk.map(c => c.id);
      
      let compCaseStr = 'CASE id ';
      let posCaseStr = 'CASE id ';
      const params = [];

      chunk.forEach((card, idx) => {
        const globalIndex = i + idx;
        const targetCompId = calculateCompartmentForIndex(globalIndex, location);
        compCaseStr += `WHEN ? THEN ? `;
        posCaseStr += `WHEN ? THEN ? `;
        params.push(card.id, targetCompId, card.id, (globalIndex + 1) * 1000);
      });

      compCaseStr += 'END';
      posCaseStr += 'END';

      const placeholders = ids.map(() => '?').join(',');
      const sql = `UPDATE collection 
                   SET compartment_id = (${compCaseStr}), 
                       position = (${posCaseStr}) 
                   WHERE id IN (${placeholders})`;

      await tx.run(sql, [...params, ...ids]);
    }
  });

  return res.json({ success: true, count: cards.length });
});
```

---

### 3.5 Defect 5: N+1 Query in Deck Checkout Allocation Logic

#### Exact Code Location
- `backend/src/utils/collectionHelpers.js:28-52`

#### Issue Analysis
`checkedOutAllocation(userId)` finds distinct checked-out cards and then executes a separate `SELECT` statement inside a JS loop for every distinct card ID:

```js
for (const row of distinctCards) {
  const compCards = await db.all(`SELECT id, location_id, compartment_id, quantity FROM collection WHERE card_id = ? AND user_id = ?`, [row.card_id, userId]);
  ...
}
```

#### Refactoring Specification & Code Blueprint

Combine the query into a single SQL `JOIN` between `deck_cards`, `decks`, and `collection`.

```javascript
// REFACTORED BLUEPRINT FOR backend/src/utils/collectionHelpers.js:28-52
async function checkedOutAllocation(db, userId) {
  const sql = `
    SELECT 
      dc.card_id,
      dc.quantity AS checked_out_qty,
      c.id AS collection_id,
      c.location_id,
      c.compartment_id,
      c.quantity AS collection_qty
    FROM deck_cards dc
    JOIN decks d ON dc.deck_id = d.id
    JOIN collection c ON dc.card_id = c.card_id AND c.user_id = d.user_id
    WHERE d.user_id = ? AND dc.checked_out = 1
    ORDER BY dc.card_id, c.id ASC
  `;
  
  const rows = await db.all(sql, [userId]);
  const map = new Map();

  for (const r of rows) {
    if (!map.has(r.card_id)) {
      map.set(r.card_id, { required: r.checked_out_qty, allocated: [] });
    }
    const item = map.get(r.card_id);
    item.allocated.push({
      collection_id: r.collection_id,
      location_id: r.location_id,
      compartment_id: r.compartment_id,
      quantity: r.collection_qty
    });
  }

  return map;
}
```

---

### 3.6 Defect 6: Repeated In-Memory JSON Parsing Overhead

#### Exact Code Locations
- `backend/src/utils/compartmentSort.js:146-246`
- `backend/src/utils/compartmentSort.js:382-687`

#### Issue Analysis
Fields such as `types`, `subtypes`, `color_identity`, `rule_config`, and `sort_order` are stored as JSON strings. During array sorting and slot recommendation operations, `JSON.parse` is repeatedly called inside nested comparison functions for every pair comparison:

```js
// In sortCards comparison callback:
const typesA = typeof a.types === 'string' ? JSON.parse(a.types) : (a.types || []);
const typesB = typeof b.types === 'string' ? JSON.parse(b.types) : (b.types || []);
```

#### Refactoring Specification & Code Blueprint

1. Pre-parse JSON strings into normalized JavaScript arrays/objects **once** prior to initiating sort routines.
2. Cache deserialized values on the object during array processing.

```javascript
// REFACTORED BLUEPRINT FOR backend/src/utils/compartmentSort.js:146-246
function prepareCardMetadata(card) {
  return {
    ...card,
    parsed_types: Array.isArray(card.types) ? card.types : safeJsonParse(card.types, []),
    parsed_subtypes: Array.isArray(card.subtypes) ? card.subtypes : safeJsonParse(card.subtypes, []),
    parsed_color_identity: Array.isArray(card.color_identity) ? card.color_identity : safeJsonParse(card.color_identity, [])
  };
}

function sortCards(cards, sortOrder, foilSorting) {
  const parsedOrder = typeof sortOrder === 'string' ? safeJsonParse(sortOrder, [{ by: 'name', dir: 'asc' }]) : sortOrder;
  
  // Single pass pre-parse transform
  const preparedCards = cards.map(prepareCardMetadata);

  return preparedCards.sort((a, b) => {
    for (const rule of parsedOrder) {
      const cmp = compareCardByRule(a, b, rule, foilSorting);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}
```

---

## 4. Missing Feature Implementation Blueprints & Concrete Design Patterns

### 4.1 Feature Pattern 1: Custom User Tagging

#### Architecture Pattern
**Many-to-Many Junction Table Pattern** using normalized `tags` master table and `collection_tags` mapping table with parameterized SQL filtering.

```
+-------------------+       +-----------------------+       +-------------------+
|       tags        |       |    collection_tags    |       |    collection     |
|-------------------|       |-----------------------|       |-------------------|
| id (PK)           | <----+| collection_id (FK,PK) |+----->| id (PK)           |
| user_id (FK)      |       | tag_id (FK,PK)        |       | card_id           |
| name              |       +-----------------------+       | quantity          |
| color             |                                       | list_type         |
+-------------------+                                       +-------------------+
```

#### Database DDL Migration Blueprint (`backend/src/db.js`)
```sql
-- Create Master Tags Table
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#3B82F6',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, name)
);

-- Create Collection-Tags Junction Table
CREATE TABLE IF NOT EXISTS collection_tags (
  collection_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (collection_id, tag_id),
  FOREIGN KEY (collection_id) REFERENCES collection(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collection_tags_tag_id ON collection_tags(tag_id);
```

#### API Route Contracts & Code Specification (`backend/src/routes/tags.js`)
- `GET /api/tags`: List all tags created by user.
- `POST /api/tags`: Create a new custom tag.
- `POST /api/collection/:id/tags`: Attach/detach tags to a collection item.

```javascript
// ROUTE BLUEPRINT FOR backend/src/routes/tags.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// List user tags with count of tagged items
router.get('/api/tags', async (req, res) => {
  const userId = req.user.id;
  const tags = await db.all(
    `SELECT t.*, COUNT(ct.collection_id) AS item_count 
     FROM tags t 
     LEFT JOIN collection_tags ct ON t.id = ct.tag_id 
     WHERE t.user_id = ? 
     GROUP BY t.id 
     ORDER BY t.name ASC`,
    [userId]
  );
  res.json({ tags });
});

// Attach tag array to collection item
router.post('/api/collection/:id/tags', async (req, res) => {
  const collectionId = req.params.id;
  const { tag_ids } = req.body; // Array of tag IDs

  await db.run(`DELETE FROM collection_tags WHERE collection_id = ?`, [collectionId]);
  
  if (Array.isArray(tag_ids) && tag_ids.length > 0) {
    const placeholders = tag_ids.map(() => '(?, ?)').join(',');
    const params = [];
    tag_ids.forEach(tagId => params.push(collectionId, tagId));
    
    await db.run(
      `INSERT INTO collection_tags (collection_id, tag_id) VALUES ${placeholders}`,
      params
    );
  }
  
  res.json({ success: true });
});

module.exports = router;
```

---

### 4.2 Feature Pattern 2: Storage Capacity Warnings & Alert System

#### Architecture Pattern
**Reactive Observer / Threshold Monitoring Pattern** utilizing SQL `SUM(quantity)` aggregate metrics against compartment and container capacity caps.

```
+----------------------------------------------------------------------------------+
|                            CAPACITY WARNING THRESHOLDS                           |
|  [ Occupancy Ratio ] = SUM(collection.quantity) / SUM(compartments.capacity)    |
|                                                                                  |
|   0% --------------- 80% (WARNING - AMBER) --------------- 100% (CRITICAL - RED) |
+----------------------------------------------------------------------------------+
```

#### SQL Aggregate Metric Queries (`backend/src/routes/storage.js`)
```sql
-- Aggregate Container Occupancy Query
SELECT 
  l.id AS location_id,
  l.name AS location_name,
  l.type AS location_type,
  COALESCE(SUM(c.quantity), 0) AS total_cards,
  COALESCE(comp.total_capacity, 0) AS max_capacity,
  ROUND((CAST(COALESCE(SUM(c.quantity), 0) AS REAL) / NULLIF(comp.total_capacity, 0)) * 100, 2) AS fill_percentage
FROM locations l
LEFT JOIN compartments comp_tbl ON l.id = comp_tbl.location_id
LEFT JOIN collection c ON comp_tbl.id = c.compartment_id
LEFT JOIN (
  SELECT location_id, SUM(capacity) AS total_capacity 
  FROM compartments 
  GROUP BY location_id
) comp ON l.id = comp.location_id
WHERE l.user_id = ?
GROUP BY l.id;
```

#### Alert Metric Router Blueprint (`backend/src/routes/storage.js`)
```javascript
// ROUTE BLUEPRINT FOR GET /api/locations/alerts
app.get('/api/locations/alerts', async (req, res) => {
  const userId = req.user.id;
  
  const alerts = await db.all(`
    SELECT 
      l.id AS location_id,
      l.name AS location_name,
      comp.id AS compartment_id,
      comp.label AS compartment_label,
      comp.idx AS compartment_idx,
      COALESCE(SUM(c.quantity), 0) AS current_cards,
      comp.capacity AS max_capacity,
      ROUND((CAST(COALESCE(SUM(c.quantity), 0) AS REAL) / comp.capacity) * 100, 1) AS usage_percent
    FROM compartments comp
    JOIN locations l ON comp.location_id = l.id
    LEFT JOIN collection c ON comp.id = c.compartment_id
    WHERE l.user_id = ?
    GROUP BY comp.id
    HAVING usage_percent >= 80.0
    ORDER BY usage_percent DESC
  `, [userId]);

  const formattedAlerts = alerts.map(row => ({
    location_id: row.location_id,
    location_name: row.location_name,
    compartment_id: row.compartment_id,
    label: row.compartment_label || `Compartment ${row.compartment_idx}`,
    current_cards: row.current_cards,
    max_capacity: row.max_capacity,
    usage_percent: row.usage_percent,
    severity: row.usage_percent >= 100.0 ? 'CRITICAL' : 'WARNING',
    message: row.usage_percent >= 100.0 
      ? `Container ${row.location_name} (${row.compartment_label}) is at 100% capacity!`
      : `Container ${row.location_name} (${row.compartment_label}) has reached ${row.usage_percent}% capacity.`
  }));

  return res.json({ alerts: formattedAlerts });
});
```

---

### 4.3 Feature Pattern 3: Audit Logging & Action Revert History

#### Architecture Pattern
**Event-Sourced Audit Middleware Pattern** recording append-only mutation events into `audit_logs` table with state snapshots (`before_state`, `after_state`) allowing historical inspection and point-in-time revert operations.

#### Database DDL Migration Blueprint (`backend/src/db.js`)
```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  action_type TEXT NOT NULL, -- 'ADD', 'DELETE', 'UPDATE', 'BULK_MOVE', 'RESORT'
  entity_type TEXT NOT NULL, -- 'COLLECTION', 'LOCATION', 'COMPARTMENT'
  entity_id INTEGER,
  before_state TEXT, -- Serialized JSON object snapshot before operation
  after_state TEXT,  -- Serialized JSON object snapshot after operation
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_date ON audit_logs(user_id, created_at DESC);
```

#### Audit Middleware & Revert Endpoint Specification (`backend/src/utils/auditLogger.js`)
```javascript
// AUDIT LOG HELPER MODULE BLUEPRINT
const db = require('../db');

async function logAuditEvent(userId, actionType, entityType, entityId, beforeState, afterState) {
  await db.run(
    `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, before_state, after_state)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      actionType,
      entityType,
      entityId,
      beforeState ? JSON.stringify(beforeState) : null,
      afterState ? JSON.stringify(afterState) : null
    ]
  );
}

// REVERT LOG ROUTE HANDLER
async function revertAuditEvent(req, res) {
  const auditId = req.params.id;
  const userId = req.user.id;

  const log = await db.get(`SELECT * FROM audit_logs WHERE id = ? AND user_id = ?`, [auditId, userId]);
  if (!log || !log.before_state) {
    return res.status(400).json({ error: 'Audit event cannot be reverted or not found' });
  }

  const snapshot = JSON.parse(log.before_state);

  await withTransaction(db, async (tx) => {
    if (log.action_type === 'DELETE') {
      // Re-insert deleted row
      await tx.run(
        `INSERT INTO collection (id, card_id, user_id, quantity, condition, printing, language, location_id, compartment_id, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [snapshot.id, snapshot.card_id, snapshot.user_id, snapshot.quantity, snapshot.condition, snapshot.printing, snapshot.language, snapshot.location_id, snapshot.compartment_id, snapshot.position]
      );
    } else if (log.action_type === 'UPDATE' || log.action_type === 'BULK_MOVE') {
      // Restore previous state
      await tx.run(
        `UPDATE collection SET location_id = ?, compartment_id = ?, position = ?, quantity = ? WHERE id = ?`,
        [snapshot.location_id, snapshot.compartment_id, snapshot.position, snapshot.quantity, snapshot.id]
      );
    }

    // Write inverted audit entry
    await logAuditEvent(userId, 'REVERT', log.entity_type, log.entity_id, JSON.parse(log.after_state), snapshot);
  });

  return res.json({ success: true, message: 'Operation successfully reverted' });
}

module.exports = { logAuditEvent, revertAuditEvent };
```

---

### 4.4 Feature Pattern 4: Saved Filter Presets

#### Architecture Pattern
**Parameterized Filter Strategy Pattern** serializing filter criteria state objects in `saved_filter_presets` table and dynamically expanding query predicate trees in `collection.js`.

#### Database DDL Migration Blueprint (`backend/src/db.js`)
```sql
CREATE TABLE IF NOT EXISTS saved_filter_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  filter_config TEXT NOT NULL, -- Serialized JSON containing search, type, game, condition, price ranges
  sort_config TEXT NOT NULL,   -- Serialized JSON containing sort order rules
  is_default INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, name)
);
```

#### Dynamic SQL Expansion Blueprint (`backend/src/routes/collection.js`)
```javascript
// DYNAMIC QUERY BUILDER INTEGRATION FOR GET /api/collection
function buildFilterWhereClause(userId, filters) {
  const conditions = ['c.user_id = ?'];
  const params = [userId];

  if (filters.game) {
    conditions.push('c.game = ?');
    params.push(filters.game);
  }
  if (filters.search) {
    conditions.push('(cc.name LIKE ? OR cc.set_name LIKE ? OR cc.collector_number LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.condition) {
    conditions.push('c.condition = ?');
    params.push(filters.condition);
  }
  if (filters.printing) {
    conditions.push('c.printing = ?');
    params.push(filters.printing);
  }
  if (filters.min_price) {
    conditions.push('c.purchase_price >= ?');
    params.push(filters.min_price);
  }
  if (filters.tag_id) {
    conditions.push('c.id IN (SELECT collection_id FROM collection_tags WHERE tag_id = ?)');
    params.push(filters.tag_id);
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  };
}
```

---

### 4.5 Feature Pattern 5: Third-Party CSV Import Mappers

#### Architecture Pattern
**Adapter / Strategy Mapper Pattern** normalizing disparate third-party CSV headers into standard internal collection creation payload schemas (`card_id`, `quantity`, `condition`, `printing`, `language`, `game`).

```
+------------------+       +-------------------+       +--------------------+
|  TCGPlayer CSV   |       |  Dragon Shield    |       |    ManaBox CSV     |
| (Card Name, Set) |       | (Card Name, Set)  |       | (Name, Set code)   |
+------------------+       +-------------------+       +--------------------+
         |                           |                           |
         +---------------------------+---------------------------+
                                     |
                                     v
                  +-------------------------------------+
                  |   THIRD-PARTY CSV MAPPER STRATEGY   |
                  |     (`backend/src/utils/importers`) |
                  +-------------------------------------+
                                     |
                                     v
                  +-------------------------------------+
                  | Internal Standardized Schema        |
                  | { card_id, set_code, qty, ... }     |
                  +-------------------------------------+
```

#### Header Mapping Table Specification

| Ecosystem | Card Name Field | Set Code Field | Card Number Field | Quantity Field | Condition Map Strategy | Printing Map Strategy |
|---|---|---|---|---|---|---|
| **Internal Standard** | `name` | `set_code` | `collector_number` | `quantity` | Raw condition string | `Normal`/`Holofoil`/`Reverse Holofoil` |
| **TCGPlayer App** | `Card Name` | `Set Code` | `Number` | `Quantity` | `"Near Mint"` -> `"Near Mint"` | `"Foil"` -> `"Holofoil"` |
| **Dragon Shield** | `Card Name` | `Set Code` | `Card Number` | `Quantity` | `"NM"` -> `"Near Mint"` | `"Foil"` -> `"Holofoil"` |
| **ManaBox** | `Name` | `Set code` | `Card number` | `Quantity` | `"near_mint"` -> `"Near Mint"` | `Foil: "true"` -> `"Holofoil"` |

#### Code Blueprint Implementation (`backend/src/utils/csvMappers.js`)
```javascript
// STRATEGY MAPPER MODULE BLUEPRINT
const CONDITION_MAP = {
  'near mint': 'Near Mint', 'nm': 'Near Mint', 'near_mint': 'Near Mint',
  'lightly played': 'Lightly Played', 'lp': 'Lightly Played', 'lightly_played': 'Lightly Played',
  'moderately played': 'Moderately Played', 'mp': 'Moderately Played',
  'heavily played': 'Heavily Played', 'hp': 'Heavily Played',
  'damaged': 'Damaged', 'dmg': 'Damaged'
};

const STRATEGIES = {
  tcgplayer: (row) => ({
    name: row['Card Name'],
    set_code: row['Set Code'],
    collector_number: row['Number'],
    quantity: parseInt(row['Quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: row['Printing'] === 'Foil' ? 'Holofoil' : 'Normal',
    game: 'pokemon'
  }),
  dragonshield: (row) => ({
    name: row['Card Name'],
    set_code: row['Set Code'],
    collector_number: row['Card Number'],
    quantity: parseInt(row['Quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: row['Printing'] === 'Foil' ? 'Holofoil' : 'Normal',
    game: 'pokemon'
  }),
  manabox: (row) => ({
    name: row['Name'],
    set_code: row['Set code'],
    collector_number: row['Card number'],
    quantity: parseInt(row['Quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: (row['Foil'] === 'true' || row['Foil'] === '1') ? 'Holofoil' : 'Normal',
    game: 'mtg'
  })
};

function parseThirdPartyCSV(rows, formatType) {
  const strategy = STRATEGIES[formatType.toLowerCase()];
  if (!strategy) {
    throw new Error(`Unsupported CSV format mapper: ${formatType}`);
  }
  return rows.map(strategy);
}

module.exports = { parseThirdPartyCSV };
```

---

### 4.6 Feature Pattern 6: Export Hygiene & Third-Party Export Mappers

#### Architecture Pattern
**Reverse Adapter / Export Strategy Pattern** translating internal `collection` schemas into strictly formatted CSV strings required by third-party ecosystems. This ensures "export hygiene" (preventing mismatched sets, invalid condition strings, and missing columns) when migrating data out of the app.

#### Export Mapping Specification

| Ecosystem | Card Name Field | Set Code Field | Card Number Field | Quantity Field | Condition Map Strategy | Printing Map Strategy |
|---|---|---|---|---|---|---|
| **TCGPlayer App** | `Card Name` | `Set Code` | `Number` | `Quantity` | `"Near Mint"` -> `"Near Mint"` | `"Holofoil"` -> `"Foil"` |
| **Dragon Shield** | `Card Name` | `Set Code` | `Card Number` | `Quantity` | `"Near Mint"` -> `"NM"` | `"Holofoil"` -> `"Foil"` |
| **ManaBox** | `Name` | `Set code` | `Card number` | `Quantity` | `"Near Mint"` -> `"near_mint"` | `"Holofoil"` -> `"true"` |

#### Code Blueprint Implementation (`backend/src/utils/csvExporters.js`)
```javascript
// STRATEGY EXPORT MAPPER MODULE BLUEPRINT
const REVERSE_CONDITION_MAP = {
  dragonshield: { 'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP', 'Heavily Played': 'HP', 'Damaged': 'POOR' },
  manabox: { 'Near Mint': 'near_mint', 'Lightly Played': 'lightly_played', 'Moderately Played': 'moderately_played', 'Heavily Played': 'heavily_played', 'Damaged': 'damaged' }
};

const EXPORT_STRATEGIES = {
  tcgplayer: (item) => ({
    'Card Name': item.name,
    'Set Code': item.set_code,
    'Number': item.collector_number,
    'Quantity': item.quantity,
    'Condition': item.condition, // TCGPlayer matches our internal standard
    'Printing': item.printing === 'Holofoil' ? 'Foil' : 'Normal'
  }),
  dragonshield: (item) => ({
    'Card Name': item.name,
    'Set Code': item.set_code,
    'Card Number': item.collector_number,
    'Quantity': item.quantity,
    'Condition': REVERSE_CONDITION_MAP.dragonshield[item.condition] || 'NM',
    'Printing': item.printing === 'Holofoil' ? 'Foil' : 'Normal'
  }),
  manabox: (item) => ({
    'Name': item.name,
    'Set code': item.set_code,
    'Card number': item.collector_number,
    'Quantity': item.quantity,
    'Condition': REVERSE_CONDITION_MAP.manabox[item.condition] || 'near_mint',
    'Foil': item.printing === 'Holofoil' ? 'true' : 'false'
  })
};

function generateExportCSV(collectionItems, formatType) {
  const strategy = EXPORT_STRATEGIES[formatType.toLowerCase()];
  if (!strategy) {
    throw new Error(`Unsupported CSV export format: ${formatType}`);
  }
  
  const mappedRows = collectionItems.map(strategy);
  
  if (mappedRows.length === 0) return '';
  
  // Extract headers from the first mapped object
  const headers = Object.keys(mappedRows[0]);
  const csvRows = [headers.join(',')];
  
  for (const row of mappedRows) {
    const values = headers.map(header => {
      const val = row[header] || '';
      // Escape commas and quotes for CSV hygiene
      return `"${String(val).replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(','));
  }
  
  return csvRows.join('\n');
}

module.exports = { generateExportCSV };
```

---

## 5. System Performance & Scalability Enhancement Roadmap

### 5.1 SQLite Driver Optimization & Atomic Transaction Wrappers

Create a helper function `withTransaction` in `backend/src/db.js` to standardize transaction management:

```javascript
// PROPOSED REFACTORED METHOD FOR backend/src/db.js
async function withTransaction(db, asyncFn) {
  await db.run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await asyncFn(db);
    await db.run('COMMIT');
    return result;
  } catch (error) {
    await db.run('ROLLBACK');
    throw error;
  }
}
```

### 5.2 Performance Indexing Strategy

Execute the following DDL index creation statements to speed up filtering, sorting, tag joins, and physical position lookups:

```sql
-- Composite index for fast compartment occupancy lookups
CREATE INDEX IF NOT EXISTS idx_collection_comp_user_qty 
ON collection(compartment_id, user_id, quantity);

-- Composite index for location listing and positioning
CREATE INDEX IF NOT EXISTS idx_collection_loc_pos 
ON collection(location_id, position);

-- Search index for card cache lookups
CREATE INDEX IF NOT EXISTS idx_card_cache_set_num 
ON card_cache(set_code, collector_number);

-- Deck allocation filter optimization index
CREATE INDEX IF NOT EXISTS idx_deck_cards_checkout 
ON deck_cards(deck_id, checked_out);
```

---

## 6. Step-by-Step Implementation & Verification Roadmap

### Phased Delivery Matrix

```
+-----------------------------------------------------------------------------------+
| PHASE 1: Critical Bug Fixes & DB Stability                                        |
|   - Fix capacity undercounting (`COUNT(*)` -> `SUM(quantity)`)                     |
|   - Add atomic `withTransaction` helper and wrap bulk endpoints                   |
|   - Replace N+1 loops in collection addition & relocation                         |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| PHASE 2: Performance Optimization & Memory Refactoring                            |
|   - Batch resort update loops using CASE statements                               |
|   - Pre-parse JSON metadata inside card comparison routines                        |
|   - Apply database performance indexes                                             |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| PHASE 3: Feature Integration & Ecosystem Expansion                                |
|   - Implement Tags (`tags`, `collection_tags`)                                    |
|   - Deploy Storage Capacity Warning System                                        |
|   - Build Audit Log Middleware and Revert Route                                   |
|   - Implement Saved Filter Presets                                                |
|   - Add Third-Party CSV Import Mappers                                            |
+-----------------------------------------------------------------------------------+
```

### Verification & Testing Suite Requirements

1. **Unit Verification Tests**:
   - Verify `SUM(quantity)` accurately reports capacity full when single rows have `quantity > 1`.
   - Verify CSV mappers successfully normalize TCGPlayer, Dragon Shield, and ManaBox headers.
2. **Transaction Rollback Integration Tests**:
   - Simulate artificial failure mid-way through a bulk move or re-sort operation and assert database reverts state completely without leaving orphaned items.
3. **Execution Command Suite**:
   ```bash
   # Execute existing test runner
   npm test
   # Run end-to-end integration suite
   node backend/test/e2e/run.js
   ```

---
*End of Architectural Review Plan.*
