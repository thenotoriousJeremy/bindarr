// Bindarr with no server: the phone app's own copy of the backend.
//
// The Capacitor app normally talks to a self-hosted Bindarr over HTTP. In device
// mode (MOBILE.md) it runs these same route modules inside its WebView, against
// a SQLite database on the phone: frontend/src/device hands every /api request
// to handle() below, and nothing listens on a port.
//
// This file is to that mode what server.js is to a server — the composition
// root — and it mounts the same routers in the same order, minus the ones that
// exist for other people or other machines. Those answer 501, so the UI can
// tell "not on this device" from "broken":
//   /api/shared    public share links; nothing on the internet can reach a
//                  phone to follow one.
//   /api/admin     accounts, server backups and scan catalogs; there is one
//                  user, and the scan models run server-side.
//   /api/card-art  custom art is decoded with sharp, which has no phone build.
//
// Bundled for the app by frontend/scripts/build-device-backend.mjs, with the
// Node modules a phone lacks swapped per ./aliases.js.
'use strict';

// The few settings the bundled modules read from a server's environment at load
// time. DB_PATH is a name, not a path: the SQLite plugin decides where it lives.
// CV_MODEL_DIR only has to be set so nothing falls back to __dirname; the fs stub
// holds no models whatever it is. The pre-migration snapshot (db.js) is a VACUUM
// INTO a server's BACKUP_DIR, which a phone does not have; its backup is the full
// export in Settings.
if (typeof process === 'undefined') globalThis.process = { env: {} };
const DEVICE_ENV = { DB_PATH: 'bindarr.db', CV_MODEL_DIR: '/device/models', BINDARR_SKIP_PRE_MIGRATION_SNAPSHOT: '1' };
for (const [key, value] of Object.entries(DEVICE_ENV)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const scryfallApi = require('../scryfallApi');
const { authenticateToken } = require('../middleware/auth');
const { hashSessionToken } = require('../utils/authHelpers');
const { syncSets, sweepPrices } = require('../utils/syncJobs');
const { dispatch } = require('./dispatch');
const cvScan = require('../cvScan');

const app = express.Router();

app.use('/api/auth', require('../routes/auth'));
// ECB reference rates for the display currency, public as on the server.
app.use('/api/fx', require('../routes/fx'));
for (const prefix of ['/api/shared', '/api/admin', '/api/card-art']) {
  app.use(prefix, (req, res) => res.status(501).json({
    error: 'Not available when Bindarr runs on this device.',
    deviceMode: true,
  }));
}
app.use('/api', authenticateToken);
// Scanning on a phone: the app downloads the models and the published catalogs
// (frontend/src/device/scanAssets.js), runs milo itself and sends the route an
// embedding instead of a photo — the route reads a photo with Node's Buffer,
// which a phone does not have. Until that data is on the device, or for Lorcana,
// which has no published catalog, the answer is the route's own 503 notBuilt,
// worded for a phone.
app.post('/api/scan-match', (req, res, next) => {
  const { game = 'pokemon', lang, embedding } = req.body || {};
  const langName = require('../utils/languages').toName(lang);
  if (Array.isArray(embedding) && cvScan.isBuilt(game, langName)) return next();
  res.status(503).json({
    game, lang: langName, candidates: [], verified: false, notBuilt: true, deviceMode: true,
    error: game === 'lorcana'
      ? 'There is no downloadable scan catalog for Lorcana. Scanning Lorcana cards needs a Bindarr server.'
      : 'Download the scan data for this game first: Add Cards → Scan.',
  });
});
app.use('/api', require('../routes/collection'));
app.use('/api', require('../routes/storage'));
app.use('/api', require('../routes/stats'));
app.use('/api', require('../routes/importExport'));
app.use('/api', require('../routes/notes'));
app.use('/api', require('../routes/sealed'));
app.use('/api', require('../routes/backup'));
app.use('/api/sets', require('../routes/sets'));
app.use('/api/decks', require('../routes/decks'));
app.use('/api/settings', require('../routes/settings'));
app.use('/api/set-completion', require('../routes/setCompletion'));
app.use('/api/precons', require('../routes/precons'));
// Full paths inside (/lists, /decks/:id/missing-list, /cards/:id/decks), as on a server.
app.use('/api', require('../routes/lists'));

// The phone's one account. Named `admin` because that is the owner account's name
// on a server too, and db.js looks the owner up by it: initDb adopts orphaned rows
// and seeds the starter binder for `admin`, here exactly as there.
const OWNER = 'admin';
// Nobody signs in on a phone, so the session simply never ends. A real expiry
// would only ever log the owner out of their own device.
const NEVER = '9999-12-31 23:59:59';

async function ensureOwner() {
  const existing = await db.get(`SELECT id FROM users WHERE username = ?`, [OWNER]);
  if (existing) return existing.id;
  // '!' is not a hash verifyPassword can ever match (it wants iterations:salt:hash),
  // so the account has no password at all rather than a guessable one.
  const result = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, share_enabled) VALUES (?, '!', 'admin', ?, 0)`,
    [OWNER, crypto.randomBytes(16).toString('hex')]
  );
  await db.adoptOrphanRows(result.lastID);
  await db.seedStarterLocations(result.lastID);
  return result.lastID;
}

// Sessions are stored as a hash of the token (authHelpers.hashSessionToken), so
// the one saved on an earlier launch cannot be read back as a bearer token. Each
// launch replaces it instead: the token only ever lives in this process's memory,
// and the table still holds exactly one session for the device.
async function ensureSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.withTransaction(async () => {
    await db.run(`DELETE FROM sessions WHERE user_id = ? AND expires_at = ?`, [userId, NEVER]);
    await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [hashSessionToken(token), userId, NEVER]);
  });
  return token;
}

// Small persistent facts about this device's own upkeep. Its own table so that
// nothing here ever touches a column the server schema owns.
async function deviceState(key, value) {
  await db.run(`CREATE TABLE IF NOT EXISTS device_state (key TEXT PRIMARY KEY, value TEXT)`);
  if (value === undefined) {
    const row = await db.get(`SELECT value FROM device_state WHERE key = ?`, [key]);
    return row ? row.value : null;
  }
  await db.run(`INSERT OR REPLACE INTO device_state (key, value) VALUES (?, ?)`, [key, String(value)]);
  return value;
}

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;

// server.js refreshes the set tables on a weekly timer. An app is opened and
// closed all day and would never live to see that timer fire, so the date of the
// last forced refresh is kept, and whichever launch finds it a week old does one.
async function refreshSets() {
  const last = Number(await deviceState('sets_refreshed_at')) || 0;
  const due = Date.now() - last > WEEK;
  await syncSets(due);
  if (due) await deviceState('sets_refreshed_at', Date.now());
  await require('../utils/compartmentSort').loadSetsCache(db);
}

// What server.js does once the database is up, minus everything that exists for
// scanning or for other machines (catalog warm-up, session purge, server backups).
// Never awaited by a request: the app is usable while the set lists download.
async function warmUp() {
  try {
    const { splitStackedEntries } = require('../utils/collectionHelpers');
    await splitStackedEntries(db);
    await refreshSets();
    // The TCGCSV cache that sealed-product search and Pokémon prices read, as
    // server.js refreshes it at startup. Safe: it logs and gives up on failure.
    await require('../tcgcsvApi').syncIfUpdatedSafely('device startup');
  } catch (err) {
    console.error('Device warm-up failed:', err.message);
  }
  // Prices on the server's cadence: soon after launch, then hourly while the app
  // stays open. Each provider decides for itself whether it is due.
  setTimeout(sweepPrices, 30000);
  setInterval(sweepPrices, HOUR);
  // Exchange rates, as the server's fx-rates job: hourly asks, at most one ECB
  // fetch a day (fxRates.refreshIfDue keeps that clock in the database).
  const refreshFx = () => require('../fxRates').refreshIfDue().catch(err => console.warn('FX refresh failed:', err.message));
  refreshFx();
  setInterval(refreshFx, HOUR);
}

let booted = null;

// Idempotent: the first call opens the database, migrates it, and makes sure the
// owner and their session exist; every later call returns the same promise.
// Resolves { token } — the bearer credential for handle().
//
// options.background: false skips the network jobs (set sync, price sweeps).
function start({ background = true } = {}) {
  if (!booted) {
    booted = (async () => {
      await db.initDb();
      await scryfallApi.loadPriceSource();
      const userId = await ensureOwner();
      const token = await ensureSession(userId);
      if (background) warmUp();
      return { token };
    })();
    // A failed boot (no SQLite plugin, a corrupt file) must be retryable: the next
    // call tries again instead of replaying the same rejection forever.
    booted.catch(() => { booted = null; });
  }
  return booted;
}

// request: { method, url, headers, body } — url is path + query, body the raw
// string fetch() was given. Resolves { status, headers, body }; never rejects.
async function handle(request) {
  try {
    await start();
  } catch (err) {
    console.error('Device backend failed to start:', err);
    return { status: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'The on-device database could not be opened.' }) };
  }
  return dispatch(app, request);
}

module.exports = {
  start,
  handle,
  setDriver: require('sqlite3').setDriver,
  // Scanning: what can be downloaded (one descriptor table, shared with the
  // server's fetch-models script), where the app's downloaded catalogs come in,
  // and the TCGplayer product map the Pokémon catalog resolves its matches through.
  scanAssets: { MODELS: require('../utils/modelAssets').MODELS, CATALOGS: require('../utils/modelAssets').CATALOGS },
  setScanSource: cvScan.setSource,
  productMap: require('../tcgplayerCatalog'),
  app,
};
