// Storage writes that take several statements land whole or not at all: creating
// a container with its pages, and re-sorting one. Each used to commit statement
// by statement, so a failure part way left a container with no pages, or a
// re-sorted container whose remaining cards had been pulled out of their slots
// and never put back. A trigger stands in for the failure, part way through.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-storageatomic-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const express = require('express');
const db = require('../src/db');

let server;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/storage'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function post(base, url, body) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  await db.initDb();
  const { id: userId } = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  const base = await startApp(userId);

  // --- creating a container: the container and all its pages, or nothing -------
  await db.run(`CREATE TRIGGER fail_third_page BEFORE INSERT ON compartments WHEN NEW.idx = 3
                BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  let res = await post(base, '/api/locations', { name: 'Atomic Binder', type: 'Binder', compartmentPlan: { count: 5, capacity: 9 } });
  assert.strictEqual(res.status, 500, JSON.stringify(res.body));
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM locations WHERE name = 'Atomic Binder'`)).n, 0, 'no container without its pages');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM compartments WHERE location_id NOT IN (SELECT id FROM locations)`)).n, 0, 'no orphaned pages');
  await db.run(`DROP TRIGGER fail_third_page`);

  res = await post(base, '/api/locations', { name: 'Atomic Binder', type: 'Binder', compartmentPlan: { count: 5, capacity: 9 } });
  assert.strictEqual(res.status, 200, 'the failed attempt left nothing behind to collide with');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM compartments WHERE location_id = ?`, [res.body.id])).n, 5);

  res = await post(base, '/api/locations', { name: 'Atomic Binder', type: 'Binder' });
  assert.strictEqual(res.status, 400, 'the name check still runs');

  res = await post(base, '/api/locations', { name: 'Huge', type: 'Box', compartmentPlan: { count: 1000001, capacity: 1 } });
  assert.strictEqual(res.status, 400, 'a plan of a million pages is refused before anything is written');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM locations WHERE name = 'Huge'`)).n, 0);

  // --- re-sorting: every card keeps its slot unless the whole re-sort lands -------
  const box = (await db.run(`INSERT INTO locations (name, type, sort_order, user_id) VALUES ('Resort Box', 'Box', 'name-asc', ?)`, [userId])).lastID;
  const row = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 10)`, [box])).lastID;
  const ids = {};
  // Filed in reverse name order, so a name-asc re-sort has to move every card.
  for (const [name, position] of [['Charlie', 1000], ['Bravo', 2000], ['Alpha', 3000]]) {
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, 'pokemon')`, [`card-${name}`, name]);
    ids[name] = (await db.run(
      `INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id, position, game)
       VALUES (?, ?, 1, ?, ?, ?, 'pokemon')`, [`card-${name}`, userId, box, row, position]
    )).lastID;
  }
  const before = await db.all(`SELECT id, compartment_id, position FROM collection WHERE location_id = ? ORDER BY id`, [box]);

  // Alpha is placed first, then Bravo — whose placement fails.
  await db.run(`CREATE TRIGGER fail_bravo BEFORE UPDATE OF compartment_id ON collection
                WHEN NEW.id = ${ids.Bravo} AND NEW.compartment_id IS NOT NULL
                BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  res = await post(base, `/api/locations/${box}/resort`);
  assert.strictEqual(res.status, 500, JSON.stringify(res.body));
  assert.deepStrictEqual(
    await db.all(`SELECT id, compartment_id, position FROM collection WHERE location_id = ? ORDER BY id`, [box]),
    before,
    'a failed re-sort leaves every card where it was'
  );
  await db.run(`DROP TRIGGER fail_bravo`);

  res = await post(base, `/api/locations/${box}/resort`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const after = await db.all(`SELECT c.position, cc.name FROM collection c JOIN card_cache cc ON cc.id = c.card_id WHERE c.location_id = ? ORDER BY c.position`, [box]);
  assert.deepStrictEqual(after.map(r => r.name), ['Alpha', 'Bravo', 'Charlie'], 'and a re-sort that succeeds still re-sorts');

  res = await post(base, `/api/locations/999999/resort`);
  assert.strictEqual(res.status, 404);

  console.log('storageatomic ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
