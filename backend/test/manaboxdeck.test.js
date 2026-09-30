const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseManaboxText } = require('../src/utils/csvMappers');

const decklist = fs.readFileSync(path.join(__dirname, '..', '..', 'Zoraline’s Last Light.txt'), 'utf8');
const expected = parseManaboxText(decklist);
const tmpDb = path.join(os.tmpdir(), `bindarr-manabox-deck-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const deckRouter = require('../src/routes/decks');
const createDeck = deckRouter.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack[0].handle;

async function testManaBoxDeckCreation() {
  const originalBulkFetch = scryfallApi.bulkFetchByIdentifier;
  const originalCacheCards = scryfallApi.cacheCards;

  try {
    await db.initDb();
    scryfallApi.bulkFetchByIdentifier = async rows => {
      const cards = rows.map((row, index) => ({ id: `mtg-test-${index}`, name: row.name, game: 'mtg' }));
      return { cards, pairs: rows.map((row, index) => ({ row, card: cards[index] })) };
    };
    scryfallApi.cacheCards = async cards => {
      for (const card of cards) {
        await db.run('INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)', [card.id, card.name, card.game]);
      }
    };

    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await createDeck({
      body: { name: "Zoraline's Last Light", game: 'mtg', decklist_format: 'manabox', decklist_text: decklist },
      user: { id: 1 }
    }, res);

    assert.strictEqual(res.statusCode, 201);
    const imported = await db.all(`
      SELECT cc.name, dc.quantity FROM deck_cards dc
      JOIN card_cache cc ON cc.id = dc.card_id
      WHERE dc.deck_id = ? ORDER BY cc.name
    `, [res.body.id]);
    assert.strictEqual(imported.length, expected.length);
    assert.strictEqual(imported.reduce((sum, card) => sum + card.quantity, 0), expected.reduce((sum, card) => sum + card.quantity, 0));
    assert.deepStrictEqual(imported.find(card => card.name === 'Zoraline, Cosmos Caller'), { name: 'Zoraline, Cosmos Caller', quantity: 1 });
    assert.deepStrictEqual(imported.find(card => card.name === 'Plains'), { name: 'Plains', quantity: 8 });
  } finally {
    scryfallApi.bulkFetchByIdentifier = originalBulkFetch;
    scryfallApi.cacheCards = originalCacheCards;
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testManaBoxDeckCreation()
  .then(() => console.log('ManaBox deck creation self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
