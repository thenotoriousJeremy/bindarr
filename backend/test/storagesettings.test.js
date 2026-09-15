// Storage container configuration: capacity summaries, bulk capacity edits, and
// freezing a sorted layout into manual positions.
//
// Replaces test/e2e/storage_settings.test.js, which asserted the same three
// behaviours but spawned the whole server as a child process, seeded a session row
// by hand, and then 401'd on it — so it had been failing for as long as anyone had
// been running the e2e suite, and reported the failure as "locs.find is not a
// function". These are route-level behaviours, not full-stack ones: mounting the
// real router in THIS process with a stub req.user tests the same handlers and the
// same SQL, cannot 401, and needs no port, no mock and no child.
//
// It has to go through the router rather than re-running the queries here. The bug
// F9-TC1 guards is IN the SQL — joining compartments to collection fanned each
// compartment row out once per card and inflated total_capacity by the card count
// (see the comment on GET /locations) — and a test that copies the query only
// asserts against its own copy.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-storagesettings-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');

let server;

// Close the handles and let the event loop drain — no process.exit anywhere.
//
// Forcing an exit while the listening socket and the sqlite handle were still open
// aborted the process on Windows every time, with a libuv assertion from
// src/win/async.c ("!(handle->flags & UV_HANDLE_CLOSING)") raised
// AFTER all three assertions had already printed PASS. The suite then reported a
// green test as a failure, which is the worst kind of red. Closing both first and
// THEN exiting only made it intermittent; not exiting at all makes it correct, and
// node still exits 0 on its own once nothing is left pending.
async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

// The router expects authenticateToken to have run. In the app that is one gate in
// server.js; here it is one line, which is the whole reason this file needs no
// session, no token and no login.
function startApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/storage'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function main() {
  await db.initDb();

  const user = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['storage-test', db.hashPassword('x'), 'admin', `share-${process.pid}`]
  );
  const userId = user.lastID;
  const base = await startApp(userId);

  // Two compartments, capacity 400 each. All three cards go into the FIRST one —
  // that asymmetry is the point: it is what a fanned-out join multiplies by.
  const loc = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Cfg Box', 'Box', 'name-asc', 'normals_first', 'any', userId]
  );
  const r1 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [loc.lastID, 1, 400]);
  await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [loc.lastID, 2, 400]);

  // Named C, B, A but inserted in that order, so "sorted" and "inserted" differ and
  // the name-asc bake below has something to actually reorder.
  for (let i = 0; i < 3; i++) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
       VALUES (?, ?, 'Pokémon', '[]', '[]', 'Common', 's1', 'Set One', '1', '', 1)`,
      [`c${i}`, `Card ${'CBA'[i]}`]
    );
    await db.run(
      `INSERT INTO collection (card_id, quantity, condition, printing, language, location_id, compartment_id, position, user_id)
       VALUES (?, 1, 'Near Mint', 'Normal', 'English', ?, ?, ?, ?)`,
      [`c${i}`, loc.lastID, r1.lastID, (i + 1) * 1000, userId]
    );
  }

  // 1. Capacity is the sum over compartments, not multiplied by the card count.
  const locs = await (await fetch(`${base}/api/locations`)).json();
  const box = locs.find(l => l.id === loc.lastID);
  assert.ok(box, 'the location must come back from GET /locations');
  assert.strictEqual(box.total_capacity, 800, `total_capacity must be 2*400, got ${box.total_capacity}`);
  assert.strictEqual(box.total_cards, 3, `total_cards must be 3, got ${box.total_cards}`);
  assert.strictEqual(box.compartment_count, 2, `compartment_count must be 2, got ${box.compartment_count}`);
  console.log('PASS: total_capacity sums compartments once, not once per card');

  // 2. ?updateAll=true applies a capacity to every compartment in the container.
  const patch = await fetch(`${base}/api/compartments/${r1.lastID}?updateAll=true`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capacity: 42 }),
  });
  assert.strictEqual(patch.status, 200, 'flat PATCH /compartments/:id must exist');
  const caps = (await db.all(`SELECT capacity FROM compartments WHERE location_id = ? ORDER BY idx`, [loc.lastID])).map(c => c.capacity);
  assert.deepStrictEqual(caps, [42, 42], `updateAll must set both rows, got ${caps}`);
  console.log('PASS: ?updateAll=true sets capacity on every compartment');

  // 3. Switching a sorted container to Custom freezes the CURRENT sorted order into
  //    dense positions, rather than leaving the stale ones that would render
  //    jumbled the moment sorting stops being applied.
  const put = await fetch(`${base}/api/locations/${loc.lastID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sort_order: 'custom' }),
  });
  assert.strictEqual(put.status, 200, 'PUT /locations/:id must accept sort_order custom');
  const rows = await db.all(
    `SELECT cc.name, c.position FROM collection c JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.compartment_id = ? ORDER BY c.position ASC`, [r1.lastID]
  );
  assert.deepStrictEqual(rows.map(r => r.name), ['Card A', 'Card B', 'Card C'], `name-asc order must be baked in, got ${rows.map(r => r.name)}`);
  assert.deepStrictEqual(rows.map(r => r.position), [1000, 2000, 3000], `positions must densify, got ${rows.map(r => r.position)}`);
  console.log('PASS: switching to Custom bakes the sorted order into dense positions');

  // 4. Inserting a new compartment at a specific index should not just append to the end.
  const binderLoc = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Insert Binder', 'Binder', 'custom', 'normals_first', 'any', userId]
  );
  const binderPage1 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [binderLoc.lastID, 1, 9]);
  const binderPage2 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [binderLoc.lastID, 2, 9]);
  const binderPage3 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [binderLoc.lastID, 3, 9]);

  const insertResp = await fetch(`${base}/api/locations/${binderLoc.lastID}/compartments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ before_id: binderPage2.lastID, capacity: 9 })
  });
  assert.strictEqual(insertResp.status, 201, 'POST /locations/:id/compartments with before_id must work');
  const inserted = await insertResp.json();
  const pageOrder = (await db.all(`SELECT id, idx FROM compartments WHERE location_id = ? ORDER BY idx`, [binderLoc.lastID])).map(c => c.id);
  assert.deepStrictEqual(pageOrder, [binderPage1.lastID, inserted.id, binderPage2.lastID, binderPage3.lastID], `insert before id must produce order 1, new, 2, 3, got ${pageOrder}`);
  assert.strictEqual(inserted.idx, 2, 'inserted page should take the target index');
  console.log('PASS: inserting a new page before an existing one keeps the binder order stable');

  // 5. Reordering and moving a page to another binder should update the owning location and index sequence.
  const destBinder = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Destination Binder', 'Binder', 'custom', 'normals_first', 'any', userId]
  );
  const destPage1 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [destBinder.lastID, 1, 9]);
  const moveResp = await fetch(`${base}/api/compartments/${inserted.id}/reorder`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: destBinder.lastID, idx: 1 })
  });
  assert.strictEqual(moveResp.status, 200, 'PATCH /compartments/:id/reorder must move a page to another binder');
  const moved = await db.get(`SELECT location_id, idx FROM compartments WHERE id = ?`, [inserted.id]);
  assert.strictEqual(moved.location_id, destBinder.lastID, 'page must belong to the destination binder after move');
  assert.strictEqual(moved.idx, 1, 'page must be inserted at the requested index');
  const destOrder = (await db.all(`SELECT id, idx FROM compartments WHERE location_id = ? ORDER BY idx`, [destBinder.lastID])).map(c => c.id);
  assert.deepStrictEqual(destOrder, [inserted.id, destPage1.lastID], `destination binders must reindex after a move, got ${destOrder}`);
  console.log('PASS: moving a page to another binder preserves the binder order and reindexes both sides');

  // 6. Moving a page to a binder that already contains the same idx value should
  //    still succeed — the destination row must be reindexed before the move is
  //    committed to avoid UNIQUE(location_id, idx) conflicts.
  const sourceBinder = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Source Binder', 'Binder', 'custom', 'normals_first', 'any', userId]
  );
  const sourcePage1 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [sourceBinder.lastID, 27, 9]);
  const sourcePage2 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [sourceBinder.lastID, 28, 9]);
  const targetBinderSameIdx = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Target Binder Same Index', 'Binder', 'custom', 'normals_first', 'any', userId]
  );
  const targetPage1 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [targetBinderSameIdx.lastID, 27, 9]);
  const sameIndexResp = await fetch(`${base}/api/compartments/${sourcePage1.lastID}/reorder`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: targetBinderSameIdx.lastID, idx: 27 })
  });
  assert.strictEqual(sameIndexResp.status, 200, 'PATCH /compartments/:id/reorder must handle destination idx collisions without violating uniqueness');
  const sameIndexMoved = await db.get(`SELECT location_id, idx FROM compartments WHERE id = ?`, [sourcePage1.lastID]);
  assert.strictEqual(sameIndexMoved.location_id, targetBinderSameIdx.lastID, 'moved page must belong to the destination binder');
  const targetPostMove = (await db.all(`SELECT id, idx FROM compartments WHERE location_id = ? ORDER BY idx`, [targetBinderSameIdx.lastID])).map(c => c.id);
  assert.deepStrictEqual(targetPostMove, [targetPage1.lastID, sourcePage1.lastID], `same-index destination reorders must preserve insertion semantics, got ${targetPostMove}`);
  console.log('PASS: moving a page onto a destination binder that already owns the same idx value still succeeds');

  // 7. Moving a page to a binder with restrictive rules should fail if the cards
  //    on that page would violate the target location's rules.
  const rulesSourceBinder = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Rules Source', 'Binder', 'custom', 'normals_first', 'any', userId]
  );
  const rulesSourcePage = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [rulesSourceBinder.lastID, 1, 9]);
  const rulesTargetBinder = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, rule_config, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['Rules Target', 'Binder', 'custom', 'normals_first', 'compound', JSON.stringify([{ field: 'types', operator: 'equals', value: 'Water', action: 'include' }]), userId]
  );
  await db.run(`INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
       VALUES (?, ?, 'Pokémon', '[]', ?, 'Common', 's1', 'Set One', '1', '', 1, 'pokemon')`,
    ['rules-fire-card', 'Fire Card', JSON.stringify(['Fire'])]
  );
  await db.run(
    `INSERT INTO collection (card_id, quantity, condition, printing, language, location_id, compartment_id, position, user_id)
       VALUES (?, 1, 'Near Mint', 'Normal', 'English', ?, ?, ?, ?)`,
    ['rules-fire-card', rulesSourceBinder.lastID, rulesSourcePage.lastID, 1000, userId]
  );
  const invalidMoveResp = await fetch(`${base}/api/compartments/${rulesSourcePage.lastID}/reorder`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: rulesTargetBinder.lastID, idx: 1 })
  });
  assert.strictEqual(invalidMoveResp.status, 400, 'PATCH /compartments/:id/reorder must reject a move when cards do not match target binder rules');
  const invalidMoveBody = await invalidMoveResp.json();
  assert.match(invalidMoveBody.error || '', /rule|match|cards/i, 'error should describe the rule mismatch');
  const unchangedRulesPage = await db.get(`SELECT location_id FROM compartments WHERE id = ?`, [rulesSourcePage.lastID]);
  assert.strictEqual(unchangedRulesPage.location_id, rulesSourceBinder.lastID, 'rejected move must leave the page in the source binder');
  console.log('PASS: rejecting a page move when destination rules reject the cards on that page');

  // 8. Reordering two pages inside the same binder should work via before/after.
  const reorderBinder = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Reorder Binder', 'Binder', 'custom', 'normals_first', 'any', userId]
  );
  const reorderPage1 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [reorderBinder.lastID, 1, 9]);
  const reorderPage2 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [reorderBinder.lastID, 2, 9]);
  const reorderPage3 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [reorderBinder.lastID, 3, 9]);
  const reorderResp = await fetch(`${base}/api/compartments/${reorderPage3.lastID}/reorder`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: reorderBinder.lastID, before_id: reorderPage1.lastID })
  });
  assert.strictEqual(reorderResp.status, 200, 'PATCH /compartments/:id/reorder must reorder pages within the same binder');
  const sameBinderOrder = (await db.all(`SELECT id, idx FROM compartments WHERE location_id = ? ORDER BY idx`, [reorderBinder.lastID])).map(c => c.id);
  assert.deepStrictEqual(sameBinderOrder, [reorderPage3.lastID, reorderPage1.lastID, reorderPage2.lastID], `same-binder reorders must preserve order, got ${sameBinderOrder}`);
  console.log('PASS: pages can be reordered within the same binder');
}

main()
  .then(() => cleanup())
  .catch(async err => {
    console.error('FAIL:', err.stack || err.message);
    await cleanup();
    process.exitCode = 1;
  });
