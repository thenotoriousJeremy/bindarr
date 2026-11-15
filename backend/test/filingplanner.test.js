// Filing many cards at once (utils/compartmentSort FilingPlan), through the real
// storage and collection routes on a temp SQLite:
//
//   - Re-sorting a container is one pass. It used to reload and re-sort every card
//     in the container for each card it filed, inside one transaction on the only
//     connection: 1,000 cards took 33 seconds, with every other request waiting.
//     The test bounds the statements a re-sort of 1,000 cards may run, so that
//     per-card cost cannot come back unnoticed.
//   - "File all" writes each card under the container its slot is in (an overflow
//     used to be filed under the one asked for), renumbers what it filed into, and
//     lands whole or not at all.
//   - A stacking container counts pockets, not rows: a three-pocket page holding a
//     stacked pair and one other card has a pocket left, and keeps the pair
//     together when it is re-sorted.
//   - A Custom binder page is never renumbered: pockets the owner left empty stay
//     empty, and a new card takes the first empty one.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-filingplanner-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const { recommendSlot, rebalanceCompartmentByScheme, loadSetsCache } = require('../src/utils/compartmentSort');

let server;
let userId;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/storage'));
  app.use('/api', require('../src/routes/collection'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api`));
  });
}

let base;
const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const mkLocation = async (name, type, sortOrder, extra = {}) => (await db.run(
  `INSERT INTO locations (name, type, sort_order, foil_sorting, allow_stacking, user_id) VALUES (?, ?, ?, 'normals_first', ?, ?)`,
  [name, type, sortOrder, extra.stacking ? 1 : 0, userId]
)).lastID;
const mkPages = async (locId, count, capacity) => {
  const ids = [];
  for (let i = 1; i <= count; i++) ids.push((await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [locId, i, capacity])).lastID);
  return ids;
};
const card = (id, name, extra = {}) => db.run(
  `INSERT OR REPLACE INTO card_cache (id, name, game, set_id, set_name, number, rarity, price_trend) VALUES (?, ?, 'pokemon', ?, ?, ?, 'Common', ?)`,
  [id, name, extra.set_id || 'x', extra.set_name || 'Set X', extra.number || '1', extra.price || 1]
);
const copy = async (cardId, locId, compId, position, extra = {}) => (await db.run(
  `INSERT INTO collection (card_id, user_id, quantity, printing, language, location_id, compartment_id, position, game)
   VALUES (?, ?, 1, ?, 'English', ?, ?, ?, 'pokemon')`,
  [cardId, userId, extra.printing || 'Normal', locId, compId, position]
)).lastID;
const placements = (locId) => db.all(
  `SELECT c.id, c.compartment_id, c.position, cc.name, cp.idx FROM collection c
     JOIN card_cache cc ON cc.id = c.card_id JOIN compartments cp ON cp.id = c.compartment_id
    WHERE c.location_id = ? ORDER BY cp.idx, c.position, c.id`, [locId]);

// Count the statements a block runs on the shared connection.
async function countStatements(fn) {
  const counts = { n: 0 };
  const originals = { run: db.run, get: db.get, all: db.all };
  for (const name of Object.keys(originals)) {
    db[name] = (...args) => { counts.n++; return originals[name](...args); };
  }
  try {
    const result = await fn();
    return { result, statements: counts.n };
  } finally {
    Object.assign(db, originals);
  }
}

async function resortAtScale() {
  // Hundreds of sets in release order: the set sort used to scan this list twice
  // per comparison.
  for (let i = 0; i < 400; i++) {
    await db.run(`INSERT INTO sets (id, name, release_date) VALUES (?, ?, ?)`, [`set${i}`, `Set ${i}`, new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10)]);
  }
  await loadSetsCache(db);
  const binder = await mkLocation('Big Binder', 'Binder', 'set-number');
  const pages = await mkPages(binder, 120, 9);
  await db.withTransaction(async () => {
    for (let i = 0; i < 1000; i++) {
      const id = `scale-${i}`;
      await card(id, `Card ${i}`, { set_id: `set${(i * 37) % 400}`, set_name: `Set ${(i * 37) % 400}`, number: String((i % 50) + 1) });
      // Filed anywhere, in no order: the re-sort has to move them all.
      await copy(id, binder, pages[(i * 7) % pages.length], ((i * 13) % 9 + 1) * 1000);
    }
  });

  const started = Date.now();
  const { result: res, statements } = await countStatements(() => api('POST', `/locations/${binder}/resort`));
  const elapsed = Date.now() - started;
  assert.strictEqual(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  assert.strictEqual(res.body.length, 1000);
  assert.ok(res.body.every(p => p.recommended), 'every card found a slot');
  // A handful of reads, then one statement per hundred cards written. Per-card
  // work would be thousands.
  assert.ok(statements < 60, `a 1,000-card re-sort ran ${statements} statements`);
  assert.ok(elapsed < 20000, `a 1,000-card re-sort took ${elapsed} ms`);

  const rows = await placements(binder);
  assert.strictEqual(rows.length, 1000);
  const setRank = (name) => Number(String(name).replace('Set ', ''));
  const ordered = await db.all(`
    SELECT cc.set_name FROM collection c JOIN card_cache cc ON cc.id = c.card_id JOIN compartments cp ON cp.id = c.compartment_id
     WHERE c.location_id = ? ORDER BY cp.idx, c.position`, [binder]);
  const releaseOrder = ordered.map(r => setRank(r.set_name));
  assert.deepStrictEqual(releaseOrder, [...releaseOrder].sort((a, b) => a - b), 'pages hold the cards in release order, page after page');
  const byPage = new Map();
  for (const r of rows) {
    if (!byPage.has(r.compartment_id)) byPage.set(r.compartment_id, []);
    byPage.get(r.compartment_id).push(r.position);
  }
  for (const positions of byPage.values()) {
    assert.deepStrictEqual(positions, positions.map((_, i) => (i + 1) * 1000), 'each page is filled pocket by pocket, no gaps, no doubles');
  }
  console.log(`PASS: a 1,000-card re-sort is one pass (${statements} statements, ${elapsed} ms)`);
  // Out of the way of the tests below, which overflow into whatever container has room.
  await db.run(`UPDATE locations SET locked = 1 WHERE id = ?`, [binder]);
}

async function applyAllOverflow() {
  // A full one-page binder, and the box its cards overflow into.
  const full = await mkLocation('Full Binder', 'Binder', 'name-asc');
  const [page] = await mkPages(full, 1, 2);
  const box = await mkLocation('Overflow Box', 'Box', 'name-asc');
  const [row] = await mkPages(box, 1, 20);
  for (const [id, name] of [['f1', 'Aaron'], ['f2', 'Abel'], ['b1', 'Bravo'], ['b3', 'Delta'], ['b5', 'Foxtrot'], ['u2', 'Charlie'], ['u4', 'Echo'], ['u6', 'Golf']]) {
    await card(id, name);
  }
  await copy('f1', full, page, 1000);
  await copy('f2', full, page, 2000);
  await copy('b1', box, row, 1000);
  await copy('b3', box, row, 2000);
  await copy('b5', box, row, 3000);
  const unsorted = [await copy('u2', null, null, 0), await copy('u4', null, null, 0), await copy('u6', null, null, 0)];

  // A failure part way: nothing is filed.
  await db.run(`CREATE TRIGGER fail_echo BEFORE UPDATE OF compartment_id ON collection
                WHEN NEW.id = ${unsorted[1]} AND NEW.compartment_id IS NOT NULL
                BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  let res = await api('POST', `/locations/${full}/apply-all`, { entry_ids: unsorted });
  assert.strictEqual(res.status, 500);
  const untouched = await db.all(`SELECT location_id, compartment_id FROM collection WHERE id IN (${unsorted.join(',')})`);
  assert.ok(untouched.every(r => r.location_id === null && r.compartment_id === null), 'a failed batch files nothing');
  await db.run(`DROP TRIGGER fail_echo`);

  res = await api('POST', `/locations/${full}/apply-all`, { entry_ids: unsorted });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.filed, 3);
  const filed = await db.all(`SELECT location_id, compartment_id FROM collection WHERE id IN (${unsorted.join(',')})`);
  assert.ok(filed.every(r => r.location_id === box && r.compartment_id === row),
    'each card is filed under the container its slot is in, not the one it was sent to');
  const order = await placements(box);
  assert.deepStrictEqual(order.map(r => r.name), ['Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'], 'the box keeps its name order');
  assert.deepStrictEqual(order.map(r => r.position), [1000, 2000, 3000, 4000, 5000, 6000], 'and no two cards share a slot');
  console.log('PASS: file-all lands overflow under its own container, renumbered, all or nothing');
}

async function stackingCountsPockets() {
  const binder = await mkLocation('Stack Binder', 'Binder', 'name-asc', { stacking: true });
  const [page] = await mkPages(binder, 1, 3);
  for (const [id, name] of [['sa', 'Abra'], ['sb', 'Bulbasaur'], ['sc', 'Charmander']]) await card(id, name);
  const twinA = await copy('sa', binder, page, 1000);
  const twinB = await copy('sa', binder, page, 1000);
  await copy('sb', binder, page, 2000);

  const location = await db.get(`SELECT * FROM locations WHERE id = ?`, [binder]);
  const rec = await recommendSlot(db, location, { card_id: 'sc', name: 'Charmander', printing: 'Normal', language: 'English', types: [] });
  assert.ok(rec, 'a page with a stacked pair and one other card still has a pocket');
  assert.deepStrictEqual([rec.compartment_id, rec.position], [page, 3000], 'the third pocket');

  await rebalanceCompartmentByScheme(db, page, 'name-asc', 'normals_first');
  const after = await db.all(`SELECT id, card_id, position FROM collection WHERE compartment_id = ? ORDER BY position, id`, [page]);
  assert.deepStrictEqual(after.map(r => [r.card_id, r.position]), [['sa', 1000], ['sa', 1000], ['sb', 2000]],
    'renumbering keeps the stacked pair in one pocket');
  assert.ok([twinA, twinB].every(id => after.find(r => r.id === id).position === 1000));
  console.log('PASS: a stacking page counts pockets and keeps stacks together');
}

async function customBinderKeepsGaps() {
  const binder = await mkLocation('Custom Binder', 'Binder', 'custom');
  const [page] = await mkPages(binder, 1, 9);
  for (const [id, name] of [['c1', 'One'], ['c5', 'Five'], ['c9', 'Nine'], ['cn', 'New']]) await card(id, name);
  const one = await copy('c1', binder, page, 1000);
  const five = await copy('c5', binder, page, 5000);
  const nine = await copy('c9', binder, page, 9000);

  const res = await api('POST', '/collection', { card_id: 'cn', location_id: binder });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const pos = async (id) => (await db.get(`SELECT position FROM collection WHERE id = ?`, [id])).position;
  assert.strictEqual(await pos(res.body.id), 2000, 'a new card takes the first empty pocket');
  assert.deepStrictEqual([await pos(one), await pos(five), await pos(nine)], [1000, 5000, 9000], 'the pockets the owner chose stay as they were');

  const moved = await api('PUT', `/collection/${five}`, { location_id: null });
  assert.strictEqual(moved.status, 200);
  assert.deepStrictEqual([await pos(one), await pos(res.body.id), await pos(nine)], [1000, 2000, 9000], 'taking a card out leaves the rest where they are');
  console.log('PASS: a Custom binder page is never renumbered');
}

async function main() {
  await db.initDb();
  userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('filer', 'x', 'admin', 'tok')`)).lastID;
  base = await startApp();
  await resortAtScale();
  await applyAllOverflow();
  await stackingCountsPockets();
  await customBinderKeepsGaps();
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
