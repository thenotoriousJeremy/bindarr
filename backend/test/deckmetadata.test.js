const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-deck-metadata-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const deckRouter = require('../src/routes/decks');
const updateDeck = deckRouter.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.put).route.stack[0].handle;

async function testDeckMetadataUpdate() {
  try {
    await db.initDb();
    const created = await db.run(`
      INSERT INTO decks (name, description, game, format, category, accent_color, target_size, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, ['Old Deck', 'Old description', 'mtg', 'Commander / EDH', 'Casual', '#eab308', 100, 1]);
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await updateDeck({
      params: { id: created.lastID },
      body: { name: 'Updated Deck', description: 'Updated description', format: 'Modern', category: 'Tournament', accent_color: '#3b82f6', target_size: 60 },
      user: { id: 1 }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(await db.get(`
      SELECT name, description, game, format, category, accent_color, target_size
      FROM decks WHERE id = ?
    `, [created.lastID]), {
      name: 'Updated Deck', description: 'Updated description', game: 'mtg', format: 'Modern',
      category: 'Tournament', accent_color: '#3b82f6', target_size: 60
    });
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testDeckMetadataUpdate()
  .then(() => console.log('Deck metadata update self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
