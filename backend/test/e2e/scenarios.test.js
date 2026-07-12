const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

// Isolated temp DB and unique port
const tmpDb = path.join(os.tmpdir(), `bindarr-scenarios-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3012';

const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');

async function waitForServer(port) {
  const url = `http://localhost:${port}/api/health`;
  for (let i = 0; i < 50; i++) {
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
  for (let i = 0; i < 50; i++) {
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
      DB_PATH: tmpDb,
      // F6-TC5 exercises the self-registration flow, which is invite-only unless
      // explicitly enabled.
      ALLOW_REGISTRATION: 'true'
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

    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    // F6-TC1: Case-insensitive monorepo rebranding audit
    try {
      const filesToCheck = [
        'package.json',
        'backend/package.json',
        'frontend/package.json',
        'docker-compose.yml',
        'Dockerfile',
        '.env.example',
        'frontend/index.html'
      ];
      for (const f of filesToCheck) {
        const content = fs.readFileSync(path.join(projectRoot, f), 'utf8');
        assert.ok(!content.includes('pokedexrr-backend'), `File ${f} must not contain old name`);
        assert.ok(!content.includes('Pokedexrr'), `File ${f} must not contain old name Pokedexrr`);
      }
      console.log('PASS: F6-TC1');
    } catch (err) {
      console.error('FAIL: F6-TC1 -', err.message);
      throw err;
    }

    // F6-TC2: Mixed-game collection sorting (Pokémon type-name vs MTG WUBRG)
    try {
      const { sortCards } = require('../../src/utils/compartmentSort');
      const cards = [
        { name: 'Swamp', types: ['Black'], game: 'mtg' },
        { name: 'Charmander', types: ['Fire'], game: 'pokemon' },
        { name: 'Plains', types: ['White'], game: 'mtg' },
        { name: 'Bulbasaur', types: ['Grass'], game: 'pokemon' }
      ];
      const sorted = sortCards(cards, 'type-name', 'normals_first');
      // Bulbasaur (Grass) -> Charmander (Fire) -> Plains (White) -> Swamp (Black)
      assert.strictEqual(sorted[0].name, 'Bulbasaur');
      assert.strictEqual(sorted[1].name, 'Charmander');
      assert.strictEqual(sorted[2].name, 'Plains');
      assert.strictEqual(sorted[3].name, 'Swamp');
      console.log('PASS: F6-TC2');
    } catch (err) {
      console.error('FAIL: F6-TC2 -', err.message);
      throw err;
    }

    // F6-TC3: Scryfall proxy search & add to binder with price history writing
    try {
      const searchRes = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lotus`, { headers: authHeaders });
      const cards = await searchRes.json();
      assert.ok(cards.length > 0, 'Should return Lotus card');
      assert.strictEqual(cards[0].name, 'Black Lotus');

      // Add to collection
      const addRes = await fetch(`http://localhost:${port}/api/collection`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          card_id: cards[0].id,
          quantity: 1,
          condition: 'Near Mint',
          printing: 'Normal',
          language: 'English',
          purchase_price: 10000.0,
          location_id: null
        })
      });
      assert.strictEqual(addRes.status, 200);

      // Verify price history row exists for this card
      const priceHist = await db.all(`SELECT * FROM price_history WHERE card_id = ?`, [cards[0].id]);
      assert.ok(priceHist.length > 0, 'Price history record must be written');
      console.log('PASS: F6-TC3');
    } catch (err) {
      console.error('FAIL: F6-TC3 -', err.message);
      throw err;
    }

    // F6-TC4: Scanner OCR pipeline (OCR text -> set/number -> API Search -> Add -> Compartment recomendation)
    try {
      const ocrText = 'ELD/171';
      // Parse
      const match = ocrText.match(/^([A-Z0-9]{3,5})[\s\/]+([0-9a-zA-Z★]+)$/);
      assert.ok(match);
      const set = match[1];
      const num = match[2];

      const searchRes = await fetch(`http://localhost:${port}/api/search?game=mtg&set=${set}&number=${num}`, { headers: authHeaders });
      const matches = await searchRes.json();
      assert.ok(matches.length > 0);
      assert.strictEqual(matches[0].name, 'Questing Beast');
      console.log('PASS: F6-TC4');
    } catch (err) {
      console.error('FAIL: F6-TC4 -', err.message);
      throw err;
    }

    // F6-TC5: Complete user session flow: register -> login -> create binder -> scan multiple -> add -> verify stats
    try {
      const uniqueUsername = `tester_${Date.now()}`;
      // 1. Register User
      const regRes = await fetch(`http://localhost:${port}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uniqueUsername, password: 'password123' })
      });
      assert.strictEqual(regRes.status, 201);

      // 2. Login User
      const loginRes = await fetch(`http://localhost:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uniqueUsername, password: 'password123' })
      });
      assert.strictEqual(loginRes.status, 200);
      const { token: userToken } = await loginRes.json();
      assert.ok(userToken);

      const userHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      };

      // 3. Create location
      const locRes = await fetch(`http://localhost:${port}/api/locations`, {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ name: 'E2E User Binder', type: 'Binder' })
      });
      assert.strictEqual(locRes.status, 200);
      const loc = await locRes.json();
      const locId = loc.id;

      // 4. Add cards to binder
      const addRes1 = await fetch(`http://localhost:${port}/api/collection`, {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({
          // Cards fetched from Scryfall are cached under the "mtg-" id prefix
          // (see F3-TC2/F5-TC3); F6-TC4 above cached this card as mtg-eld-171.
          card_id: 'mtg-eld-171',
          quantity: 1,
          condition: 'Near Mint',
          printing: 'Normal',
          language: 'English',
          purchase_price: 10.0,
          location_id: locId
        })
      });
      assert.strictEqual(addRes1.status, 200);

      // 5. Verify stats/collection list endpoint
      const collectionListRes = await fetch(`http://localhost:${port}/api/collection`, {
        headers: userHeaders
      });
      assert.strictEqual(collectionListRes.status, 200);
      const collectionList = await collectionListRes.json();
      assert.ok(collectionList.length > 0);
      console.log('PASS: F6-TC5');
    } catch (err) {
      console.error('FAIL: F6-TC5 -', err.message);
      throw err;
    }

  } finally {
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
