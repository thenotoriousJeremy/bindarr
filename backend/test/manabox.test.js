// ManaBox plaintext must preserve the exact set/collector printing needed for Scryfall.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseManaboxText } = require('../src/utils/csvMappers');

const cards = parseManaboxText(fs.readFileSync(path.join(__dirname, '..', '..', 'Patrick.txt'), 'utf8'));
const card = (set, number, printing = 'Normal') => cards.find(c =>
  c.set_code === set && c.collector_number === number && c.printing === printing
);

assert.deepStrictEqual(card('PLS', '58'), {
  name: 'Caldera Kavu',
  set_code: 'PLS',
  collector_number: '58',
  quantity: 2,
  condition: 'Near Mint',
  printing: 'Normal',
  game: 'mtg'
});
assert.strictEqual(card('POR', '118').printing, 'Normal', 'non-foil annotation must not make a card foil');
assert.strictEqual(card('7ED', '339', 'Holofoil').quantity, 1, 'ManaBox foil markers must be retained');
assert.ok(cards.length > 0, 'the supplied ManaBox export must yield cards');

async function testImportRoute() {
  const os = require('os');
  const tmpDb = path.join(os.tmpdir(), `bindarr-manabox-test-${process.pid}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

  const db = require('../src/db');
  const scryfallApi = require('../src/scryfallApi');
  const importRouter = require('../src/routes/importExport');
  const originalBulkFetch = scryfallApi.bulkFetchByIdentifier;
  const originalCacheCards = scryfallApi.cacheCards;
  const handler = importRouter.stack.find(layer => layer.route?.path === '/import').route.stack[0].handle;

  try {
    await db.initDb();
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-caldera', 'Caldera Kavu', 'mtg']);
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-mountain', 'Mountain', 'mtg']);

    scryfallApi.bulkFetchByIdentifier = async (rows) => ({
      cards: [],
      pairs: rows.map(row => ({
        row,
        card: { id: row.name === 'Caldera Kavu' ? 'mtg-caldera' : 'mtg-mountain' }
      }))
    });
    scryfallApi.cacheCards = async () => {};

    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await handler({
      body: { format: 'manabox', data: '2 Caldera Kavu (PLS) 58\n1 Mountain (7ED) 339★ *F*' },
      user: { id: 1 }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.count, 2);
    assert.deepStrictEqual(await db.all(
      `SELECT card_id, quantity, printing, game FROM collection ORDER BY card_id`
    ), [
      { card_id: 'mtg-caldera', quantity: 2, printing: 'Normal', game: 'mtg' },
      { card_id: 'mtg-mountain', quantity: 1, printing: 'Holofoil', game: 'mtg' }
    ]);
  } finally {
    scryfallApi.bulkFetchByIdentifier = originalBulkFetch;
    scryfallApi.cacheCards = originalCacheCards;
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testImportRoute()
  .then(() => console.log('ManaBox parser and import self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
