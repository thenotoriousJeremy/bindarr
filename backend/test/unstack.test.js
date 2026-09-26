// A copy is a row (#64). Two places used to stack copies onto one row with a
// quantity: the import route, for backups and third-party CSVs that carry a
// Quantity column, and older Rapid Add. This covers both fixes: the import
// expands quantity into rows, and the startup migration splits rows that an
// older build already stacked, keeping graded slabs to one row.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-unstack-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const importRouter = require('../src/routes/importExport');
const importHandler = importRouter.stack.find(layer => layer.route?.path === '/import').route.stack[0].handle;

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function main() {
  await db.initDb();
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('mtg-a', 'Card A', 'mtg')`);
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('mtg-b', 'Card B', 'mtg')`);

  // --- import expands quantity into rows ------------------------------------
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await importHandler({
    body: { format: 'json', data: [{ card_id: 'mtg-a', quantity: 3, game: 'mtg', condition: 'Lightly Played' }] },
    user: { id: 1 }
  }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.count, 3, 'count reports copies, not source lines');
  const imported = await db.all(`SELECT quantity, condition FROM collection WHERE card_id = 'mtg-a' AND user_id = 1`);
  assert.strictEqual(imported.length, 3, 'quantity 3 becomes three rows');
  assert.ok(imported.every(r => r.quantity === 1 && r.condition === 'Lightly Played'), 'each row is one copy with the imported fields');

  // --- migration splits rows an older build stacked ---------------------------
  const raw = await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, condition, printing, language, game, position, compartment_id)
     VALUES ('mtg-b', 1, 4, 'Near Mint', 'Holofoil', 'English', 'mtg', 2000, 7)`
  );
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, game, grader, grade, cert_number)
     VALUES ('mtg-b', 1, 2, 'mtg', 'PSA', '10', '12345678')`
  );

  assert.strictEqual(await db.splitStackedRows(), 2, 'both stacked rows are reported');

  const split = await db.all(`SELECT id, quantity, printing, position, compartment_id FROM collection WHERE card_id = 'mtg-b' AND cert_number IS NULL ORDER BY position`);
  assert.strictEqual(split.length, 4, 'a stacked raw row becomes one row per copy');
  assert.ok(split.every(r => r.quantity === 1 && r.printing === 'Holofoil' && r.compartment_id === 7), 'copies keep every field and stay in the slot');
  assert.strictEqual(split[0].id, raw.lastID, 'the original row keeps its id');
  assert.deepStrictEqual(split.map(r => r.position), [2000, 2000.001, 2000.002, 2000.003], 'copies sit next to the original');

  const slab = await db.all(`SELECT quantity FROM collection WHERE cert_number = '12345678'`);
  assert.deepStrictEqual(slab, [{ quantity: 1 }], 'a graded row collapses to one copy instead of duplicating the cert');

  assert.strictEqual(await db.splitStackedRows(), 0, 'second run finds nothing');
  const remaining = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE quantity > 1`);
  assert.strictEqual(remaining.n, 0);

  console.log('unstack ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
