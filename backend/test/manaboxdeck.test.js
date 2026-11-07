const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseManaboxText } = require('../src/utils/csvMappers');

const decklist = fs.readFileSync(path.join(__dirname, 'fixtures', 'manabox', 'Zoraline’s Last Light.txt'), 'utf8');
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

    // A plain decklist pasted from MTG Arena, Moxfield or XMage. Its set codes,
    // collector numbers and *F* markers used to be read as part of the name, so
    // those lines matched nothing and the deck came up short without a word.
    for (const [id, name, set, number] of [
      ['mtg-sol-c21', 'Sol Ring', 'c21', '263'],
      ['mtg-sol-ltc', 'Sol Ring', 'ltc', '3'],
      ['mtg-transmuter', 'Master Transmuter', 'plst', 'CON-31'],
      ['mtg-bolt', 'Lightning Bolt', 'm10', '146'],
    ]) {
      await db.run(`INSERT INTO card_cache (id, name, set_id, number, game, language) VALUES (?, ?, ?, ?, 'mtg', 'English')`,
        [id, name, set, number]);
    }
    await createDeck({
      body: {
        name: 'Pasted', game: 'mtg', decklist_format: 'plain',
        decklist_text: '1 Sol Ring (C21) 263 *F*\n1 Master Transmuter (PLST) CON-31\n4 [M10:146] Lightning Bolt\n2 Lightning Bolt\n0 Counterspell',
      },
      user: { id: 1 }
    }, res);
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(await db.all(
      `SELECT card_id, quantity FROM deck_cards WHERE deck_id = ? ORDER BY card_id`, [res.body.id]
    ), [
      { card_id: 'mtg-bolt', quantity: 6 },
      { card_id: 'mtg-sol-c21', quantity: 1 },      // the printing the line names, not just any Sol Ring
      { card_id: 'mtg-transmuter', quantity: 1 },
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

testManaBoxDeckCreation()
  .then(() => console.log('ManaBox deck creation self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
