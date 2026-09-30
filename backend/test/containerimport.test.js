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
  const originalCacheCards = scryfallApi.cacheCards;

  try {
    await db.initDb();
    scryfallApi.bulkFetchByIdentifier = async rows => {
      const cards = rows.map((row, index) => ({ id: `mtg-test-${index}`, name: row.name, game: 'mtg' }));
      return { cards, pairs: rows.map((row, index) => ({ row, card: cards[index] })) };
    };
    scryfallApi.cacheCards = async cards => {
      for (const card of cards) await db.run('INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)', [card.id, card.name, card.game]);
    };

    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await importContainer({ body: { name: 'Black Box', data }, user: { id: 1 } }, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.count, expectedCopies);
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
    scryfallApi.cacheCards = originalCacheCards;
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testContainerImport()
  .then(() => console.log('ManaBox container import self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
