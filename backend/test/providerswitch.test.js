// Switching the Pokémon provider switches Bindarr's Pokémon scan catalog with it
// (catalogReleases.applyProvider, from PUT /api/settings): off when the install
// leaves TCGdex, whose ids the catalog's rows are, and on again when it comes
// back. Even when the rest of the switch fails: here the new provider's set walk
// throws, as it does offline or with the provider down, and the catalog still
// follows — before, it stayed on until the next restart.
//
// The real settings router and auth gate in this process. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-providerswitch-'));
process.env.DB_PATH = path.join(ROOT, 'test.db');
process.env.CV_MODEL_DIR = path.join(ROOT, 'models');
process.env.CATALOG_RELEASE_URL = 'off';
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const { generateSession } = require('../src/utils/authHelpers');
const { authenticateToken } = require('../src/middleware/auth');
const pokemonProvider = require('../src/utils/pokemonProvider');
const { MODEL_ID } = require('../src/utils/modelAssets');
const releases = require('../src/catalogReleases');

// The provider's set walk fails, the step that runs before the product map.
let walks = 0;
pokemonProvider.apiFor = async () => ({
  async fetchAndCacheSets() { walks++; throw new Error('provider unreachable'); },
});

let server;
async function main() {
  await db.initDb();
  const adminId = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES ('boss', ?, 'admin', ?)`,
    [db.hashPassword('boss-password-1'), crypto.randomBytes(16).toString('hex')]
  )).lastID;
  const token = await generateSession(adminId);

  // A Bindarr Pokémon catalog, installed while the install used TCGdex.
  const dir = path.join(releases.ROOT, 'pokemon-en');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    key: 'pokemon-en', game: 'pokemon', lang: 'English', model: MODEL_ID, dim: 4,
    generation: 1, applied: [], rows: 0, provider: 'tcgdex',
  }));
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.strictEqual(releases.isInstalled('pokemon', 'English'), true);

  const app = express();
  app.use(express.json());
  app.use('/api', authenticateToken);
  app.use('/api/settings', require('../src/routes/settings'));
  const base = await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const put = async (body) => (await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })).status;
  // The follow-up runs after the response, in the background.
  const until = async (ok, what) => {
    for (let i = 0; i < 200; i++) {
      if (ok()) return;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.fail(what);
  };

  assert.strictEqual(await put({ pokemon_provider: 'pokemontcg' }), 200);
  await until(() => walks === 1, 'the new provider\'s set walk was tried');
  await until(() => state().disabled === true, 'the catalog is switched off although the set walk failed');
  assert.strictEqual(releases.isInstalled('pokemon', 'English'), false);

  assert.strictEqual(await put({ pokemon_provider: 'tcgdex' }), 200);
  await until(() => walks === 2, 'the set walk was tried again');
  await until(() => state().disabled === false, 'and back on with TCGdex');
  assert.strictEqual(releases.isInstalled('pokemon', 'English'), true);
}

main().then(() => {
  console.log('providerswitch.test.js: all assertions passed');
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  if (server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* a temp folder */ }
});
