const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseManaboxText } = require('../src/utils/csvMappers');

const data = fs.readFileSync(path.join(__dirname, '..', '..', 'Patrick.txt'), 'utf8');
const expected = parseManaboxText(data);
const expectedCopies = expected.reduce((total, card) => total + card.quantity, 0);
const tmpDb = path.join(os.tmpdir(), `bindarr-container-import-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const importRouter = require('../src/routes/importExport');
const importContainer = importRouter.stack.find(layer => layer.route?.path === '/import-container').route.stack[0].handle;

async function testContainerImport() {
  const originalBulkFetch = scryfallApi.bulkFetchByIdentifier;

  try {
    await db.initDb();
    scryfallApi.bulkFetchByIdentifier = async rows => ({
      pairs: rows.map((row, index) => ({ row, card: { id: `mtg-test-${index}` } }))
    });
    for (let index = 0; index < expected.length; index++) {
      const item = expected[index];
      const cardId = `mtg-test-${index}`;
      await db.run('INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)', [cardId, item.name, 'mtg']);
      for (let copy = 0; copy < item.quantity; copy++) {
        await db.run(`
          INSERT INTO collection (card_id, quantity, condition, printing, language, game, user_id)
          VALUES (?, 1, ?, ?, ?, 'mtg', ?)
        `, [cardId, item.condition, item.printing, item.language, 1]);
      }
    }
    const collectionCount = (await db.get('SELECT COUNT(*) AS count FROM collection WHERE user_id = 1')).count;

    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await importContainer({ body: { name: 'Black Box', data }, user: { id: 1 } }, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.count, expectedCopies);
    assert.strictEqual(res.body.missing, 0);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection WHERE user_id = 1')).count, collectionCount,
      'container import must move owned cards, not add new collection rows');
    const location = await db.get('SELECT name, type, game FROM locations WHERE id = ?', [res.body.id]);
    assert.deepStrictEqual(location, { name: 'Black Box', type: 'Box', game: 'mtg' });
    const compartment = await db.get('SELECT capacity FROM compartments WHERE location_id = ?', [res.body.id]);
    assert.strictEqual(compartment.capacity, expectedCopies);
    const cards = await db.all('SELECT quantity, location_id, compartment_id, position FROM collection WHERE location_id = ? ORDER BY position', [res.body.id]);
    assert.strictEqual(cards.length, expectedCopies);
    assert.ok(cards.every(card => card.quantity === 1 && card.compartment_id && card.location_id === res.body.id));
    assert.deepStrictEqual(cards.map(card => card.position), cards.map((_, index) => (index + 1) * 1000));
  } finally {
    scryfallApi.bulkFetchByIdentifier = originalBulkFetch;
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testContainerImport()
  .then(() => console.log('ManaBox container import self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
