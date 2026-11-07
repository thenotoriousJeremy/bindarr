// Set here as well as in run.js: a suite run on its own boots a server on a fresh
// database, which would otherwise run a full TCGCSV sync (~800 requests) at boot.
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
process.env.BINDARR_DISABLE_FX_SYNC = '1';

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const net = require('net');

// Isolated temp DB and unique port
const tmpDb = path.join(os.tmpdir(), `bindarr-scryfall-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

let currentPort = 3030;
function getNextPort() {
  return (currentPort++).toString();
}

function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(Number(port));
  });
}

const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');
const { hashSessionToken } = require('../../src/utils/authHelpers');

async function waitForServer(port) {
  const url = `http://localhost:${port}/api/health`;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server on port ${port} did not start in time`);
}

async function stopServer(proc, port) {
  if (proc && proc.exitCode === null && !proc.killed) {
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          setTimeout(resolve, 500);
        }
      };
      proc.once('close', finish);
      proc.once('exit', finish);
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        finish();
      }
    });
  }
  if (port) {
    for (let i = 0; i < 50; i++) {
      if (await isPortFree(port)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

async function waitForDatabase() {
  for (let i = 0; i < 150; i++) {
    try {
      const admin = await db.get(`SELECT id FROM users WHERE username = ?`, ['admin']);
      if (admin) return admin.id;
    } catch (e) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Database did not initialize in time');
}

async function runTests() {
  // Start server preloading scryfall-mock.js
  const mockScript = path.join(__dirname, 'scryfall-mock.js');
  const serverScript = path.join(projectRoot, 'backend/src/server.js');
  let port = getNextPort();
  const server = spawn('node', ['-r', mockScript, serverScript], {
    env: {
      ...process.env,
      PORT: port,
      DB_PATH: tmpDb
    }
  });

  try {
    await waitForServer(port);
    const adminId = await waitForDatabase();

    // Insert a valid session token for authentication
    const token = 'test-token-123';
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 1);
    await db.run(
      `INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
      [hashSessionToken(token), adminId, expiresAt.toISOString()]
    );

    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // F3-TC1: Verify search proxy to Scryfall API by name
    try {
      const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lotus`, { headers: authHeaders });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.length > 0);
      assert.strictEqual(data[0].name, 'Black Lotus');
      console.log('PASS: F3-TC1');
    } catch (err) {
      console.error('FAIL: F3-TC1 -', err.message);
      throw err;
    }

    // F3-TC2: Verify search proxy automatically inserts/caches card in card_cache
    try {
      const cachedCard = await db.get(`SELECT * FROM card_cache WHERE id = ?`, ['mtg-lea-232']);
      assert.ok(cachedCard, 'Card must be saved in cache after search');
      assert.strictEqual(cachedCard.name, 'Black Lotus');
      assert.strictEqual(cachedCard.game, 'mtg');
      console.log('PASS: F3-TC2');
    } catch (err) {
      console.error('FAIL: F3-TC2 -', err.message);
      throw err;
    }

    // F3-TC3: Verify local cache read when Scryfall is offline (mocked error state)
    try {
      // Re-create server process with mock error
      await stopServer(server, port);
      
      port = getNextPort();
      const serverErr = spawn('node', ['-r', mockScript, serverScript], {
        env: {
          ...process.env,
          PORT: port,
          DB_PATH: tmpDb,
          MOCK_SCRYFALL_ERROR: 'true'
        }
      });

      await waitForServer(port);

      // Search Lightning Bolt which is already cached in F3-TC2? No, Black Lotus was cached.
      const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lotus`, { headers: authHeaders });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.length > 0);
      assert.strictEqual(data[0].name, 'Black Lotus');
      console.log('PASS: F3-TC3');
      
      await stopServer(serverErr, port);
    } catch (err) {
      console.error('FAIL: F3-TC3 -', err.message);
      throw err;
    }

    // F3-TC4: Verify proxy rate limiting returns 429
    try {
      port = getNextPort();
      const serverRate = spawn('node', ['-r', mockScript, serverScript], {
        env: {
          ...process.env,
          PORT: port,
          DB_PATH: tmpDb
        }
      });
      await waitForServer(port);

      let rateLimited = false;
      for (let i = 0; i < 350; i++) {
        const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Spam`, { headers: authHeaders });
        const status = res.status;
        await res.text();
        if (status === 429) {
          rateLimited = true;
          break;
        }
      }
      assert.ok(rateLimited, 'Rapid search requests must be rate limited with 429 status code');
      console.log('PASS: F3-TC4');
      await stopServer(serverRate, port);
    } catch (err) {
      console.error('FAIL: F3-TC4 -', err.message);
      throw err;
    }

    // F3-TC5: Verify mapped fields contract
    try {
      port = getNextPort();
      const serverField = spawn('node', ['-r', mockScript, serverScript], {
        env: {
          ...process.env,
          PORT: port,
          DB_PATH: tmpDb
        }
      });
      await waitForServer(port);

      const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lightning`, { headers: authHeaders });
      const data = await res.json();
      const card = data[0];
      
      assert.strictEqual(card.id, 'mtg-54321');
      assert.strictEqual(card.supertype, 'MTG');
      assert.strictEqual(card.game, 'mtg');
      assert.ok(card.subtypes.includes('Instant'));
      assert.ok(card.types.includes('Red'));
      assert.strictEqual(card.rarity, 'Common');
      assert.strictEqual(card.price_normal, 0.50);
      assert.strictEqual(card.price_holofoil, 2.50);
      console.log('PASS: F3-TC5');
      await stopServer(serverField, port);
    } catch (err) {
      console.error('FAIL: F3-TC5 -', err.message);
      throw err;
    }

    // F3-TC6: Verify empty search results return 200 with empty array
    try {
      port = getNextPort();
      const serverEmpty = spawn('node', ['-r', mockScript, serverScript], {
        env: {
          ...process.env,
          PORT: port,
          DB_PATH: tmpDb
        }
      });
      await waitForServer(port);

      const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=NonExistentCardName`, { headers: authHeaders });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.deepStrictEqual(data, []);
      console.log('PASS: F3-TC6');
      await stopServer(serverEmpty, port);
    } catch (err) {
      console.error('FAIL: F3-TC6 -', err.message);
      throw err;
    }

    // F3-TC7: Verify API timeout returns 504 Gateway Timeout or fallback cached data
    try {
      port = getNextPort();
      const serverTime = spawn('node', ['-r', mockScript, serverScript], {
        env: {
          ...process.env,
          PORT: port,
          DB_PATH: tmpDb,
          MOCK_SCRYFALL_DELAY: 'true'
        }
      });
      await waitForServer(port);

      const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lightning`, { headers: authHeaders });
      assert.ok(res.status === 504 || res.status === 200);
      console.log('PASS: F3-TC7');
      await stopServer(serverTime, port);
    } catch (err) {
      console.error('FAIL: F3-TC7 -', err.message);
      throw err;
    }

    // F3-TC8: Verify cache expiration (3 days) triggers background refresh
    try {
      port = getNextPort();
      const serverExp = spawn('node', ['-r', mockScript, serverScript], {
        env: {
          ...process.env,
          PORT: port,
          DB_PATH: tmpDb
        }
      });
      await waitForServer(port);

      // Insert lightning bolt to cache first
      await db.run(
        `INSERT OR REPLACE INTO card_cache (id, name, game, last_updated) VALUES (?, ?, ?, ?)`,
        ['mtg-54321', 'Lightning Bolt', 'mtg', new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()]
      );

      const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lightning`, { headers: authHeaders });
      assert.strictEqual(res.status, 200);
      
      // Poll for the background refresh: it runs detached after the response, so a
      // single fixed wait is flaky under CI load. Check freshness for up to ~5s.
      let fresh = false;
      for (let i = 0; i < 25 && !fresh; i++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const cached = await db.get(`SELECT last_updated FROM card_cache WHERE id = ?`, ['mtg-54321']);
        fresh = Date.now() - new Date(cached.last_updated).getTime() < 10000;
      }
      assert.ok(fresh, 'Background refresh should update last_updated to now');
      console.log('PASS: F3-TC8');
      await stopServer(serverExp, port);
    } catch (err) {
      console.error('FAIL: F3-TC8 -', err.message);
      throw err;
    }

    // F3-TC9: Verify foreign language mappings.
    // The contract changed with issue #25: `name` stays ENGLISH (deck lists,
    // marketplace links and the next Scryfall lookup all need it) and the
    // localized name lives in `printed_name`. The mock only answers in Japanese
    // when the request uses the real syntax — `lang:ja` in q plus
    // include_multilingual — so this also guards the query construction.
    try {
      port = getNextPort();
      const serverLang = spawn('node', ['-r', mockScript, serverScript], {
        env: {
          ...process.env,
          PORT: port,
          DB_PATH: tmpDb
        }
      });
      await waitForServer(port);

      const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lotus&lang=ja&scope=internet`, { headers: authHeaders });
      const data = await res.json();
      assert.ok(data.length > 0, 'a Japanese search must return the Japanese printing');
      assert.strictEqual(data[0].language, 'Japanese');
      assert.strictEqual(data[0].printed_name, '黒き蓮', 'localized name is carried for display');
      assert.strictEqual(data[0].name, 'Black Lotus', 'name stays English for search/links');
      assert.strictEqual(data[0].id, 'mtg-jp123', 'the Japanese printing is its own cache row');

      // An English search must still be answered in English — the language-scoped
      // cache read is what stops the Japanese row above from shadowing it.
      const resEn = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lotus&scope=internet`, { headers: authHeaders });
      const dataEn = await resEn.json();
      assert.ok(dataEn.length > 0);
      assert.strictEqual(dataEn[0].language, 'English');
      assert.strictEqual(dataEn[0].name, 'Black Lotus');
      console.log('PASS: F3-TC9');
      await stopServer(serverLang, port);
    } catch (err) {
      console.error('FAIL: F3-TC9 -', err.message);
      throw err;
    }

    // F3-TC10: Verify double-faced transform cards resolve using front face
    try {
      port = getNextPort();
      const serverDF = spawn('node', ['-r', mockScript, serverScript], {
        env: {
          ...process.env,
          PORT: port,
          DB_PATH: tmpDb
        }
      });
      await waitForServer(port);

      const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Delver`, { headers: authHeaders });
      const data = await res.json();
      const card = data[0];
      
      assert.strictEqual(card.name, 'Delver of Secrets');
      assert.strictEqual(card.image_url, 'https://images.scryfall.com/delver.png');
      console.log('PASS: F3-TC10');
      await stopServer(serverDF, port);
    } catch (err) {
      console.error('FAIL: F3-TC10 -', err.message);
      throw err;
    }

    // F3-TC11: bulk add, owned_qty stamping, and the X-Total-Count header —
    // the three things a set browse relies on to add many cards without
    // re-adding what is already in the binder.
    try {
      port = getNextPort();
      const serverBulk = spawn('node', ['-r', mockScript, serverScript], {
        env: { ...process.env, PORT: port, DB_PATH: tmpDb }
      });
      await waitForServer(port);

      // Total match count is surfaced as a header, body stays a bare array.
      // Needs scope=internet: a cache hit has no upstream total to report.
      const searchUrl = `http://localhost:${port}/api/search?game=mtg&name=Lotus&scope=internet`;
      const searchRes = await fetch(searchUrl, { headers: authHeaders });
      assert.strictEqual(searchRes.headers.get('x-total-count'), '1', 'total match count should be reported');
      const before = await searchRes.json();
      assert.strictEqual(before[0].owned_qty, 0, 'nothing owned yet');

      // Bulk add: one real card and one bogus id, so partial failure is covered.
      const bulkRes = await fetch(`http://localhost:${port}/api/collection/bulk-add`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_ids: ['mtg-lea-232', 'mtg-does-not-exist'], quantity: 2, game: 'mtg' })
      });
      assert.strictEqual(bulkRes.status, 200);
      const bulk = await bulkRes.json();
      assert.strictEqual(bulk.added, 1, 'the one real card should be added');
      assert.strictEqual(bulk.failed.length, 1, 'the bogus id should be reported, not swallowed');

      // The same search now reports what is already owned (quantity 2).
      const afterRes = await fetch(searchUrl, { headers: authHeaders });
      const after = await afterRes.json();
      assert.strictEqual(after[0].owned_qty, 2, 'owned copies should show on later searches');

      // An empty request is rejected rather than silently doing nothing.
      const emptyRes = await fetch(`http://localhost:${port}/api/collection/bulk-add`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_ids: [] })
      });
      assert.strictEqual(emptyRes.status, 400);
      await emptyRes.text();

      console.log('PASS: F3-TC11');
      await stopServer(serverBulk, port);
    } catch (err) {
      console.error('FAIL: F3-TC11 -', err.message);
      throw err;
    }

  } finally {
    // Teardown everything
    try { await stopServer(server, port); } catch {}
    try {
      await new Promise(resolve => {
        db.dbConnection.close(() => resolve());
      });
    } catch {}
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  }
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    process.exit(1);
  });
