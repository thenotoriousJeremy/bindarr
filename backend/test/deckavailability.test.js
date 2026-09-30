const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-deck-availability-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const deckRouter = require('../src/routes/decks');
const getDeck = deckRouter.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.get).route.stack[0].handle;

async function testCheckedOutCardsAreUnavailable() {
  try {
    await db.initDb();
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('goblin', 'Goblin', 'mtg')`);
    await db.run(`INSERT INTO collection (card_id, quantity, game, user_id) VALUES ('goblin', 2, 'mtg', 1)`);
    const testing = await db.run(`INSERT INTO decks (name, game, user_id) VALUES ('Testing', 'mtg', 1)`);
    const stampede = await db.run(`INSERT INTO decks (name, game, checked_out, user_id) VALUES ('Goblin Stampede', 'mtg', 1, 1)`);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'goblin', 1)`, [testing.lastID]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'goblin', 2)`, [stampede.lastID]);

    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await getDeck({ params: { id: testing.lastID }, user: { id: 1 } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.cards[0].owned_qty, 2);
    assert.deepStrictEqual(res.body.cards[0].locked_qty, 2);
    assert.strictEqual(res.body.cards[0].locked_decks, 'Goblin Stampede');
    assert.strictEqual(res.body.cards[0].quantity > res.body.cards[0].owned_qty - res.body.cards[0].locked_qty, true,
      'Testing must mark cards in checked-out Goblin Stampede unavailable');
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testCheckedOutCardsAreUnavailable()
  .then(() => console.log('Deck checkout availability self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
