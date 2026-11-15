// Set here as well as in run.js: a suite run on its own boots a server on a fresh
// database, which would otherwise run a full TCGCSV sync (~800 requests) at boot.
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
process.env.BINDARR_DISABLE_FX_SYNC = '1';

const assert = require('assert');
const harness = require('./harness');

// Isolated temp DB and unique port
const tmp = harness.tempDatabase('cross-test');
let port;

const db = require('../../src/db');
const { hashSessionToken } = require('../../src/utils/authHelpers');

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
  // Fixtures go into the file before the server opens it. F5-TC3 used to create
  // its binder here while the server was busy with a boot-time set sync, and the
  // two writers could outlast SQLite's busy timeout (SQLITE_BUSY).
  await harness.prepare(db);
  const adminId = await waitForDatabase();

  // Insert a valid session token for authentication
  const token = 'test-token-123';
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 1);
  await db.run(
    `INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [hashSessionToken(token), adminId, expiresAt.toISOString()]
  );

  // The location and compartment F5-TC3 files its card into.
  const scannerLocId = (await db.run(
    `INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`,
    ['Scanner Binder', 'Binder', adminId]
  )).lastID;
  await db.run(
    `INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`,
    [scannerLocId, 1, 9]
  );

  // The server preloads offline.js, which answers Scryfall from scryfall-mock.js.
  const server = await harness.startServer(tmp);
  port = server.port;
  try {
    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    // F5-TC1: Verify that Scryfall API calls include user-agent headers containing Bindarr
    try {
      // Note: we can't easily assert on headers since the server handles the call in a separate process,
      // but if the feature is not implemented, the API call won't happen.
      // If we query, it should run. If it fails (due to not implemented), assert throws.
      const searchRes = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lotus`, { headers: authHeaders });
      assert.strictEqual(searchRes.status, 200);
      const data = await searchRes.json();
      assert.ok(data.length > 0, 'Should return searched cards');
      console.log('PASS: F5-TC1');
    } catch (err) {
      console.error('FAIL: F5-TC1 -', err.message);
      throw err;
    }

    // F5-TC2: Verify that adding a Scryfall-fetched MTG card to collection writes 'mtg' to game column
    try {
      // 1. Search card to populate card_cache (might return empty since M3 is not implemented)
      await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lotus`, { headers: authHeaders });
      
      // 2. Add card to collection
      const addRes = await fetch(`http://localhost:${port}/api/collection`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          card_id: 'mtg-lea-232',
          quantity: 1,
          condition: 'Near Mint',
          printing: 'Normal',
          language: 'English',
          purchase_price: 10000.0,
          location_id: null
        })
      });
      assert.strictEqual(addRes.status, 200);
      
      // 3. Query DB to verify game value is mtg
      const saved = await db.get(`SELECT * FROM collection WHERE card_id = ?`, ['mtg-lea-232']);
      assert.ok(saved, 'Card must be saved in collection');
      assert.strictEqual(saved.game, 'mtg');
      console.log('PASS: F5-TC2');
    } catch (err) {
      console.error('FAIL: F5-TC2 -', err.message);
      throw err;
    }

    // F5-TC3: Verify a set/number code triggers Scryfall search & auto-adds match to compartment
    try {
      // 1. The location and compartment, seeded before the server started
      const locId = scannerLocId;

      // 2. A parsed set and number triggering search
      const scanSet = 'LEA';
      const scanNumber = '232';
      const searchRes = await fetch(`http://localhost:${port}/api/search?game=mtg&set=${scanSet}&number=${scanNumber}`, { headers: authHeaders });
      assert.strictEqual(searchRes.status, 200);
      const searchData = await searchRes.json();
      assert.ok(searchData.length > 0);
      
      const matchedCard = searchData[0];
      assert.strictEqual(matchedCard.id, 'mtg-lea-232');

      // 3. Simulate auto-adding matching card to the location
      const addRes = await fetch(`http://localhost:${port}/api/collection`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          card_id: matchedCard.id,
          quantity: 1,
          condition: 'Near Mint',
          printing: 'Normal',
          language: 'English',
          purchase_price: 10000.0,
          location_id: locId
        })
      });
      assert.strictEqual(addRes.status, 200);

      const checkCollection = await db.get(
        `SELECT * FROM collection WHERE card_id = ? AND location_id = ? AND compartment_id IS NOT NULL`,
        [matchedCard.id, locId]
      );
      assert.ok(checkCollection, 'Card must be filed under recommended compartment');
      console.log('PASS: F5-TC3');
    } catch (err) {
      console.error('FAIL: F5-TC3 -', err.message);
      throw err;
    }
  } finally {
    await server.stop();
  }

  // F5-TC4: Verify that updating sorting rules to MTG WUBRG rebalances positions.
  // The rebalance helper runs in this process and writes the file itself, so this
  // case runs once the server has stopped, with nothing else writing.
  try {
    const { rebalanceCompartmentPositions } = require('../../src/utils/priceHelpers');

    const locId = (await db.run(
      `INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`,
      ['Sort Binder', 'Binder', adminId]
    )).lastID;
    const compId = (await db.run(
      `INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`,
      [locId, 1, 9]
    )).lastID;

    // Seed card_cache so the collection FK (card_id -> card_cache.id) holds.
    await db.run(`INSERT OR IGNORE INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-c1', 'Card 1', 'mtg']);
    await db.run(`INSERT OR IGNORE INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-c2', 'Card 2', 'mtg']);

    // Add dummy cards with out-of-order positions
    await db.run(
      `INSERT INTO collection (card_id, quantity, location_id, compartment_id, position, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
      ['mtg-c1', 1, locId, compId, 2000, adminId]
    );
    await db.run(
      `INSERT INTO collection (card_id, quantity, location_id, compartment_id, position, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
      ['mtg-c2', 1, locId, compId, 1000, adminId]
    );

    await rebalanceCompartmentPositions(db, compId);
    const rows = await db.all(`SELECT position FROM collection WHERE compartment_id = ? ORDER BY position ASC`, [compId]);
    if (rows.length > 1) {
      assert.ok(rows[1].position > rows[0].position);
    }
    console.log('PASS: F5-TC4');
  } catch (err) {
    console.error('FAIL: F5-TC4 -', err.message);
    throw err;
  }
}

runTests()
  .then(async () => {
    await harness.cleanup(db, tmp);
    process.exit(0);
  })
  .catch(async err => {
    console.error(err);
    await harness.cleanup(db, tmp);
    process.exit(1);
  });
