const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

// Isolated temp DB and unique port
const tmpDb = path.join(os.tmpdir(), `bindarr-scryfall-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3010';

const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');

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
      [token, adminId, expiresAt.toISOString()]
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
      server.kill('SIGKILL');
      
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
      
      serverErr.kill('SIGKILL');
    } catch (err) {
      console.error('FAIL: F3-TC3 -', err.message);
      throw err;
    }

    // F3-TC4: Verify proxy rate limiting returns 429
    try {
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
        if (res.status === 429) {
          rateLimited = true;
          break;
        }
      }
      assert.ok(rateLimited, 'Rapid search requests must be rate limited with 429 status code');
      console.log('PASS: F3-TC4');
      serverRate.kill('SIGKILL');
    } catch (err) {
      console.error('FAIL: F3-TC4 -', err.message);
      throw err;
    }

    // F3-TC5: Verify mapped fields contract
    try {
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
      serverField.kill('SIGKILL');
    } catch (err) {
      console.error('FAIL: F3-TC5 -', err.message);
      throw err;
    }

    // F3-TC6: Verify empty search results return 200 with empty array
    try {
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
      serverEmpty.kill('SIGKILL');
    } catch (err) {
      console.error('FAIL: F3-TC6 -', err.message);
      throw err;
    }

    // F3-TC7: Verify API timeout returns 504 Gateway Timeout or fallback cached data
    try {
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
      serverTime.kill('SIGKILL');
    } catch (err) {
      console.error('FAIL: F3-TC7 -', err.message);
      throw err;
    }

    // F3-TC8: Verify cache expiration (3 days) triggers background refresh
    try {
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
      
      // Wait a moment for background refresh
      await new Promise(resolve => setTimeout(resolve, 300));
      const cached = await db.get(`SELECT last_updated FROM card_cache WHERE id = ?`, ['mtg-54321']);
      const lastUpdated = new Date(cached.last_updated);
      assert.ok(Date.now() - lastUpdated.getTime() < 10000, 'Background refresh should update last_updated to now');
      console.log('PASS: F3-TC8');
      serverExp.kill('SIGKILL');
    } catch (err) {
      console.error('FAIL: F3-TC8 -', err.message);
      throw err;
    }

    // F3-TC9: Verify foreign language mappings
    try {
      const serverLang = spawn('node', ['-r', mockScript, serverScript], {
        env: {
          ...process.env,
          PORT: port,
          DB_PATH: tmpDb
        }
      });
      await waitForServer(port);

      const res = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lotus&lang=ja`, { headers: authHeaders });
      const data = await res.json();
      assert.ok(data.length > 0);
      assert.strictEqual(data[0].language, 'Japanese');
      assert.strictEqual(data[0].name, '黒き蓮');
      console.log('PASS: F3-TC9');
      serverLang.kill('SIGKILL');
    } catch (err) {
      console.error('FAIL: F3-TC9 -', err.message);
      throw err;
    }

    // F3-TC10: Verify double-faced transform cards resolve using front face
    try {
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
      serverDF.kill('SIGKILL');
    } catch (err) {
      console.error('FAIL: F3-TC10 -', err.message);
      throw err;
    }

  } finally {
    // Teardown everything
    try { server.kill('SIGKILL'); } catch {}
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
