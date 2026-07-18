const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

// Isolated temp DB and unique port
const tmpDb = path.join(os.tmpdir(), `bindarr-storage-settings-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3014';

const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');

async function waitForServer(port) {
  const url = `http://localhost:${port}/api/health`;
  for (let i = 0; i < 150; i++) {
    try { const res = await fetch(url); if (res.ok) return; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server on port ${port} did not start in time`);
}
async function waitForDatabase() {
  for (let i = 0; i < 150; i++) {
    try { const a = await db.get(`SELECT id FROM users WHERE username = ?`, ['admin']); if (a) return a.id; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Database did not initialize in time');
}

async function runTests() {
  const mockScript = path.join(__dirname, 'scryfall-mock.js');
  const serverScript = path.join(projectRoot, 'backend/src/server.js');
  const server = spawn('node', ['-r', mockScript, serverScript], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb }
  });

  try {
    await waitForServer(port);
    const adminId = await waitForDatabase();

    const token = 'storage-settings-token';
    const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 1);
    await db.run(`INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
      [token, adminId, expiresAt.toISOString()]);
    const H = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    const base = `http://localhost:${port}`;

    const seedCard = (id, name, types) => db.run(
      `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, 'Pokémon', '[]', JSON.stringify(types || []), 'Common', 's1', 'Set One', '1', '', 1]
    );
    const addEntry = (cardId, compId, locId, position) => db.run(
      `INSERT INTO collection (card_id, quantity, condition, printing, language, location_id, compartment_id, position, user_id)
       VALUES (?, 1, 'Near Mint', 'Normal', 'English', ?, ?, ?, ?)`,
      [cardId, locId, compId, position, adminId]
    ).then(r => r.lastID);

    // Two rows, capacity 400 each. Cards go into one row.
    const loc = await db.run(`INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
      ['Cfg Box', 'Box', 'name-asc', 'normals_first', 'any', adminId]);
    const r1 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [loc.lastID, 1, 400]);
    const r2 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [loc.lastID, 2, 400]);
    for (let i = 0; i < 3; i++) { await seedCard(`c${i}`, `Card ${'CBA'[i]}`, []); await addEntry(`c${i}`, r1.lastID, loc.lastID, (i + 1) * 1000); }

    // F9-TC1: total_capacity must be 800 (2*400), not fanned out by the card count.
    try {
      const locs = await (await fetch(`${base}/api/locations`, { headers: H })).json();
      const box = locs.find(l => l.id === loc.lastID);
      assert.strictEqual(box.total_capacity, 800, `total_capacity must be 800, got ${box.total_capacity}`);
      assert.strictEqual(box.total_cards, 3, `total_cards must be 3, got ${box.total_cards}`);
      assert.strictEqual(box.compartment_count, 2, `compartment_count must be 2, got ${box.compartment_count}`);
      console.log('PASS: F9-TC1');
    } catch (err) { console.error('FAIL: F9-TC1 -', err.message); throw err; }

    // F9-TC2: flat PATCH /compartments/:id?updateAll=true applies capacity to every row.
    try {
      const res = await fetch(`${base}/api/compartments/${r1.lastID}?updateAll=true`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ capacity: 42 })
      });
      assert.strictEqual(res.status, 200, 'flat PATCH must exist (200)');
      const caps = (await db.all(`SELECT capacity FROM compartments WHERE location_id = ?`, [loc.lastID])).map(c => c.capacity);
      assert.deepStrictEqual(caps, [42, 42], `both rows must be 42, got ${caps}`);
      console.log('PASS: F9-TC2');
    } catch (err) { console.error('FAIL: F9-TC2 -', err.message); throw err; }

    // F9-TC3: switching a structured container to custom bakes sorted order into
    // dense positions (name-asc => A,B,C at 1000,2000,3000).
    try {
      const res = await fetch(`${base}/api/locations/${loc.lastID}`, {
        method: 'PUT', headers: H, body: JSON.stringify({ sort_order: 'custom' })
      });
      assert.strictEqual(res.status, 200);
      const rows = await db.all(`SELECT cc.name, c.position FROM collection c JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.compartment_id = ? ORDER BY c.position ASC`, [r1.lastID]);
      assert.deepStrictEqual(rows.map(r => r.name), ['Card A', 'Card B', 'Card C'], `frozen order must be A,B,C, got ${rows.map(r => r.name)}`);
      assert.deepStrictEqual(rows.map(r => r.position), [1000, 2000, 3000], `positions must densify, got ${rows.map(r => r.position)}`);
      console.log('PASS: F9-TC3');
    } catch (err) { console.error('FAIL: F9-TC3 -', err.message); throw err; }

  } finally {
    try { server.kill('SIGKILL'); } catch {}
    try { await new Promise(resolve => { db.dbConnection.close(() => resolve()); }); } catch {}
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
  }
}

runTests().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
