// A list can be scoped to any game in the registry (utils/games), and checking
// the game loads no part of the scan stack. routes/lists.js used to validate
// against the scan catalog's GAMES, which pulled in sharp and onnxruntime just to
// read a list of names (on the phone, the unavailable stand-ins for them), and
// tied which games a list could take to which ones can be scanned.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-lists-games-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const games = require('../src/utils/games');
const listsRouter = require('../src/routes/lists');

const handler = (method, routePath) => listsRouter.stack
  .find(layer => layer.route?.path === routePath && layer.route.methods[method]).route.stack[0].handle;

async function call(handle, req) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handle({ params: {}, body: {}, user: { id: 1 }, ...req }, res);
  return res;
}

// Whether a backend source file has been required by anything so far.
const loaded = (file) => Object.keys(require.cache).some(k => k.replace(/\\/g, '/').endsWith(`/src/${file}`));

async function main() {
  try {
    await db.initDb();
    const create = handler('post', '/lists');
    const update = handler('put', '/lists/:id');

    for (const game of games.VALUES) {
      const res = await call(create, { body: { name: `${game} wants`, game } });
      assert.strictEqual(res.statusCode, 201, `${game}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.game, game);
    }
    assert.ok(games.VALUES.includes('riftbound'), 'the registry lists Riftbound');

    const anyGame = await call(create, { body: { name: 'Anything', game: 'any' } });
    assert.strictEqual(anyGame.statusCode, 201);
    assert.strictEqual(anyGame.body.game, null);

    const unknown = await call(create, { body: { name: 'Chess', game: 'chess' } });
    assert.strictEqual(unknown.statusCode, 400);
    assert.strictEqual(unknown.body.error, 'Invalid game');

    const narrowed = await call(update, { params: { id: anyGame.body.id }, body: { game: 'riftbound' } });
    assert.strictEqual(narrowed.statusCode, 200, JSON.stringify(narrowed.body));
    assert.strictEqual(narrowed.body.game, 'riftbound');

    assert.ok(!loaded('catalog.js'), 'checking a list game loaded the scan catalog module (src/catalog.js)');
    assert.ok(!loaded('cvScan.js'), 'checking a list game loaded the scanner (src/cvScan.js)');
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

main()
  .then(() => console.log('List game validation self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
