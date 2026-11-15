// A precon imported into a full container overflows into the next one with room,
// and that container's compartment has to end up in ITS order. The import used to
// renumber every compartment it filed into by the scheme of the container it was
// asked to file into, so a price-sorted box that took the overflow came out sorted
// by name.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-preconoverflow-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const mtgjsonApi = require('../src/mtgjsonApi');

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
  app.use('/api/precons', require('../src/routes/precons'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api`));
  });
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function main() {
  await db.initDb();
  userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('importer', 'x', 'admin', 'tok')`)).lastID;
  const base = await startApp();

  const cards = [[1, 'Zed', 1], [2, 'Xavier', 5], [3, 'Yara', 50], [4, 'Alpha', 20], [5, 'Beta', 1]];
  for (const [n, name, price] of cards) {
    await db.run(`INSERT INTO card_cache (id, name, game, language, price_trend) VALUES (?, ?, 'mtg', 'English', ?)`, [`mtg-${uuid(n)}`, name, price]);
  }
  // The container asked for: name order, one slot, taken.
  const full = (await db.run(`INSERT INTO locations (name, type, sort_order, user_id) VALUES ('Full Box', 'Box', 'name-asc', ?)`, [userId])).lastID;
  const fullRow = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 1)`, [full])).lastID;
  await db.run(`INSERT INTO collection (card_id, user_id, location_id, compartment_id, position, game) VALUES (?, ?, ?, ?, 1000, 'mtg')`, [`mtg-${uuid(1)}`, userId, full, fullRow]);
  // The one that takes the overflow: most valuable first.
  const box = (await db.run(`INSERT INTO locations (name, type, sort_order, user_id) VALUES ('Value Box', 'Box', 'price-desc', ?)`, [userId])).lastID;
  const row = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 10)`, [box])).lastID;
  await db.run(`INSERT INTO collection (card_id, user_id, location_id, compartment_id, position, game) VALUES (?, ?, ?, ?, 1000, 'mtg')`, [`mtg-${uuid(3)}`, userId, box, row]);
  await db.run(`INSERT INTO collection (card_id, user_id, location_id, compartment_id, position, game) VALUES (?, ?, ?, ?, 2000, 'mtg')`, [`mtg-${uuid(2)}`, userId, box, row]);

  mtgjsonApi.getDeck = async () => ({
    name: 'Test Precon', code: 'TST', type: 'Commander Deck', releaseDate: '2026-01-01',
    boards: {
      commander: [],
      mainBoard: [
        { name: 'Alpha', scryfallId: uuid(4), count: 1, setCode: 'TST', number: '4' },
        { name: 'Beta', scryfallId: uuid(5), count: 1, setCode: 'TST', number: '5' },
      ],
      sideBoard: [],
    },
  });

  const res = await fetch(`${base}/precons/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'TestPrecon_TST', mode: 'collection', location_id: full }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.added, 2);
  assert.strictEqual(body.unplaced, 0, 'both overflowed into the box with room');

  const order = await db.all(`
    SELECT cc.name, c.position FROM collection c JOIN card_cache cc ON cc.id = c.card_id
     WHERE c.compartment_id = ? ORDER BY c.position`, [row]);
  assert.deepStrictEqual(order.map(r => r.name), ['Yara', 'Alpha', 'Xavier', 'Beta'],
    "the box is renumbered by its own order (value, high to low), not the full box's (name)");
  assert.deepStrictEqual(order.map(r => r.position), [1000, 2000, 3000, 4000]);
  const filed = await db.all(`SELECT location_id FROM collection WHERE card_id IN (?, ?)`, [`mtg-${uuid(4)}`, `mtg-${uuid(5)}`]);
  assert.ok(filed.every(r => r.location_id === box), 'and the copies are filed under the box');
  console.log('PASS: a precon overflow is renumbered by the order of the container it landed in');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
