// Bindarr with no server: the phone app's own copy of the backend.
//
// The Capacitor app normally talks to a self-hosted Bindarr over HTTP. In device
// mode (MOBILE.md) it runs these same route modules inside its WebView, against
// a SQLite database on the phone: frontend/src/device hands every /api request
// to handle() below, and nothing listens on a port.
//
// This file is to that mode what server.js is to a server — the composition
// root. Both mount one table, routes/mounts.js: every router the phone runs too,
// in the server's order, and a 501 "not on this device" for the ones that exist
// for other people or other machines (share links, accounts and server backups,
// uploaded art, notifications, the health probe), so the UI can tell "not here"
// from "broken".
//
// Bundled for the app by frontend/scripts/build-device-backend.mjs, with the
// Node modules a phone lacks swapped per ./aliases.js.
'use strict';

// The Node globals a WebView lacks, before any module reads them (./globals.js).
require('./globals').installGlobals(globalThis);

// The few settings the bundled modules read from a server's environment at load
// time. DB_PATH is a name, not a path: the SQLite plugin decides where it lives.
// CV_MODEL_DIR only has to be set so nothing falls back to __dirname; the fs stub
// holds no models whatever it is. The pre-migration snapshot (db.js) is a VACUUM
// INTO a server's BACKUP_DIR, which a phone does not have; its backup is the full
// export in Settings.
const DEVICE_ENV = { DB_PATH: 'bindarr.db', CV_MODEL_DIR: '/device/models', BINDARR_SKIP_PRE_MIGRATION_SNAPSHOT: '1' };
for (const [key, value] of Object.entries(DEVICE_ENV)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

// TCGCSV on a phone (MOB-09). A server syncs it daily, and once a Pokémon card is
// owned each new TCGCSV version is every Pokémon group again: well over a
// thousand requests, over whatever connection the phone has. So the switch a
// server uses to turn the sync off (tcgcsvApi.syncIfUpdated reads it on every
// call) stays on here, and syncTcgcsv() below lifts it for two moments only: the
// weekly check, and the product-map build the Pokémon scan download starts. The
// hourly price sweep prices from whatever version is cached, which is what it
// does on a server when a sync fails. A switch someone else set (a test, a
// developer) is theirs, and is left alone.
const TCGCSV_SWITCH = 'BINDARR_DISABLE_TCGCSV_SYNC';
const ownsTcgcsvSwitch = process.env[TCGCSV_SWITCH] === undefined;
if (ownsTcgcsvSwitch) process.env[TCGCSV_SWITCH] = '1';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { inTransaction } = require('async_hooks');
const { createUnitLock } = require('./units');

// Turns at the database: one for each request, and for each background job that
// opens transactions (./units.js has why). Taken before any route module loads,
// so every caller of db.withTransaction goes through the version below.
const lock = createUnitLock();
const background = (name, job) => lock.run({ name, background: true }, job);

// A transaction outside any turn is background work this file did not start
// (nothing else runs code here), and it takes a turn for as long as it is open,
// so a request cannot start in the middle of it. Inside a turn, it belongs to
// the unit holding the lock; a background unit first lets a queued request go.
// A transaction already open makes this one a savepoint, as db.js decides.
const baseWithTransaction = db.withTransaction;
db.withTransaction = async function withTransaction(fn) {
  if (inTransaction()) return baseWithTransaction(fn);
  const unit = lock.holder();
  if (!unit) return background('transaction', () => baseWithTransaction(fn));
  if (unit.background) await lock.yieldTurn(unit);
  return baseWithTransaction(fn);
};

const scryfallApi = require('../scryfallApi');
const { authenticateToken } = require('../middleware/auth');
const { hashSessionToken } = require('../utils/authHelpers');
const { syncSets, checkSets, sweepPrices } = require('../utils/syncJobs');
const { mountOnDevice } = require('../routes/mounts');
const { dispatch } = require('./dispatch');
const cvScan = require('../cvScan');

const app = express.Router();

mountOnDevice(app, { public: true });
app.use('/api', authenticateToken);
// Scanning on a phone: the app downloads the models and a catalog per game
// (frontend/src/device/scanAssets.js: Bindarr's weekly release, or the model
// author's snapshot), runs milo itself and sends the route an embedding instead
// of a photo — the route reads a photo with Node's Buffer, which a phone does not
// have. Until that data is on the device the answer is the route's own 503
// notBuilt, worded for a phone. Which games have a catalog at all is the
// release's list, which the app shows; this route cannot know it offline. With
// the data there but the model failing to run on this phone (embedError, from
// frontend/src/device/runtime.js), it says that instead: downloading the data
// again would not help.
app.post('/api/scan-match', (req, res, next) => {
  const { game = 'pokemon', lang, embedding, embedError } = req.body || {};
  const langName = require('../utils/languages').toName(lang);
  const built = cvScan.isBuilt(game, langName);
  if (Array.isArray(embedding) && built) return next();
  if (embedError && built) {
    return res.status(503).json({
      game, lang: langName, candidates: [], verified: false, scanFailed: true, deviceMode: true,
      error: `Scanning failed on this phone: ${String(embedError).slice(0, 200)}`,
    });
  }
  const label = require('../utils/games').get(game)?.label || game;
  res.status(503).json({
    game, lang: langName, candidates: [], verified: false, notBuilt: true, deviceMode: true,
    error: `Download the ${label} scan data first: Add Cards → Scan.`,
  });
});
mountOnDevice(app, { public: false });

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
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Whether the job behind a device_state clock is due, `every` ms after it last ran.
const due = async (key, every) => Date.now() - (Number(await deviceState(key)) || 0) >= every;

// server.js refreshes the set tables on a weekly timer. An app is opened and
// closed all day and would never live to see that timer fire, so the date of the
// last forced refresh is kept, and whichever launch finds it a week old does one.
async function refreshSets() {
  const forced = await due('sets_refreshed_at', WEEK);
  await syncSets(forced);
  if (forced) {
    await deviceState('sets_refreshed_at', Date.now());
    await deviceState('sets_checked_at', Date.now());   // a forced refresh is also today's check
  }
  await require('../utils/compartmentSort').loadSetsCache(db);
}

// New sets between the weekly refreshes, as server.js's daily sets-check job: one
// set-list request per provider (utils/syncJobs.checkSets), at most once a day.
async function dailySetCheck() {
  if (!(await due('sets_checked_at', DAY))) return;
  await checkSets();
  await deviceState('sets_checked_at', Date.now());
  await require('../utils/compartmentSort').loadSetsCache(db);
}

// The TCGCSV sync with the switch lifted (top of this file). tcgcsvApi reads the
// switch synchronously when the call starts, so it is lifted for exactly that
// call: anything else that asks meanwhile still prices from the cache.
function syncTcgcsv(context, options) {
  const tcgcsv = require('../tcgcsvApi');
  if (!ownsTcgcsvSwitch) return tcgcsv.syncIfUpdatedSafely(context, options);
  delete process.env[TCGCSV_SWITCH];
  try {
    return tcgcsv.syncIfUpdatedSafely(context, options);
  } finally {
    process.env[TCGCSV_SWITCH] = '1';
  }
}

// A sync the phone made, weekly or for the product map, starts the week again.
// The clock moves only once something was actually synced or checked: a phone
// with no Pokémon card yet asks again next time (one indexed read), and a failed
// sync is retried at the next launch or hourly check.
async function syncTcgcsvForTheWeek(context, options) {
  const result = await syncTcgcsv(context, options);
  if (result && !result.skipped && !result.disabled) await deviceState('tcgcsv_synced_at', Date.now());
  return result;
}

// A game served from TCGplayer's catalogue (Yu-Gi-Oh!, One Piece...) switched on
// for the first time syncs its category now, with the switch lifted, instead of
// staying empty until the weekly sync (tcgcsvGameApi.setFirstUseSync).
require('../tcgcsvGameApi').setFirstUseSync((context) => syncTcgcsvForTheWeek(context));

async function weeklyTcgcsv() {
  if (!(await due('tcgcsv_synced_at', WEEK))) return;
  await syncTcgcsvForTheWeek('the device weekly sync');
}

// Deleted cards past their 30 days in the trash (utils/collectionTrash.js), as
// server.js's daily trash-purge job.
async function dailyTrashPurge() {
  if (!(await due('trash_purged_at', DAY))) return;
  const removed = await background('trash purge', () => require('../utils/collectionTrash').purgeExpiredTrash());
  await deviceState('trash_purged_at', Date.now());
  if (removed) console.log(`Trash: removed ${removed} card(s) deleted more than 30 days ago.`);
}

// Exchange rates, as the server's fx-rates job: hourly asks, at most one ECB fetch
// a day (fxRates.refreshIfDue keeps that clock in the database). Its write is a
// transaction, so it runs as a background unit, with the lock let go for the fetch.
function refreshFx() {
  if (process.env.BINDARR_DISABLE_FX_SYNC === '1') return Promise.resolve();
  const fx = require('../fxRates');
  const fetchXml = () => require('axios').get(fx.ECB_URL, {
    timeout: 15000,
    responseType: 'text',
    headers: { 'User-Agent': fx.USER_AGENT, Accept: 'application/xml, text/xml' },
  }).then(res => res.data);
  return background('exchange rates', (unit) => fx.refreshIfDue({ fetchXml: () => lock.outside(unit, fetchXml) }))
    .then((result) => { if (result && result.error) console.warn('FX refresh failed:', result.error); })
    .catch(err => console.warn('FX refresh failed:', err.message));
}

// The Pokémon product map (tcgplayerCatalog), which the Pokémon scan download
// starts and a provider switch in Settings restarts. Its build writes one
// transaction per TCGCSV group, from the cached TCGCSV data, for a minute or two
// on a phone; so it runs as a background unit, yielding to requests between
// groups (db.withTransaction above). Its network comes first, outside the lock:
// the TCGCSV data it is built from, and TCGdex's Japanese set list, which tcgdexApi
// keeps in memory for the build to read.
const productMap = require('../tcgplayerCatalog');
const startProductMapBuild = productMap.start;
const productMapSummary = productMap.summary;
// The build waiting for its data or its turn; reported as its progress, so the
// scan setup screen keeps showing (and polling) it as it would a running build.
let productMapQueued = null;
productMap.start = function startOnDevice(game = 'pokemon') {
  if (productMapQueued || productMap.state()) throw new Error('the product map is already building');
  productMapQueued = { game, phase: 'queued', done: 0, total: 0, rows: 0, message: '' };
  (async () => {
    await syncTcgcsvForTheWeek('product map', { explicit: true });
    if (game === 'pokemon') await require('../tcgdexApi').listSets('ja').catch(() => {});
    await background('product map', async () => {
      productMapQueued = null;
      startProductMapBuild(game);
      while (productMap.state()) await new Promise(resolve => setTimeout(resolve, 250));
    });
  })()
    .catch(err => console.error('product map build failed:', err.message))
    .finally(() => { productMapQueued = null; });
  return { ...productMapQueued };
};
productMap.summary = async function summaryOnDevice(game = 'pokemon') {
  const summary = await productMapSummary(game);
  if (!summary.progress && productMapQueued && productMapQueued.game === game) return { ...summary, progress: { ...productMapQueued } };
  return summary;
};

// One upkeep step. Each is caught on its own, so a launch with no network still
// purges the trash.
async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`Device ${name} failed:`, err.message);
  }
}

// What server.js does once the database is up, minus everything that exists for
// scanning or for other machines (catalog warm-up, session purge, server backups).
// Never awaited by a request: the app is usable while the set lists download.
// Stacked rows are split by initDb itself (db.splitStackedRows), as on a server.
async function warmUp() {
  await step('set refresh', refreshSets);
  await step('set check', dailySetCheck);
  await step('TCGCSV sync', weeklyTcgcsv);
  await step('trash purge', dailyTrashPurge);
}

// The background jobs' timers, so stop() can clear every one of them.
const timers = new Set();
let backgroundOn = false;

function every(ms, fn) {
  timers.add(setInterval(fn, ms));
}

function after(ms, fn) {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
}

function startBackground() {
  if (backgroundOn) return;
  backgroundOn = true;
  warmUp();
  // Prices on the server's cadence: soon after launch, then hourly while the app
  // stays open. Each provider decides for itself whether it is due.
  after(30000, sweepPrices);
  every(HOUR, sweepPrices);
  refreshFx();
  every(HOUR, refreshFx);
  // The weekly TCGCSV sync and the daily trash purge keep their clocks in
  // device_state, for an app left open across days.
  every(HOUR, () => step('upkeep', async () => {
    await dailySetCheck();
    await weeklyTcgcsv();
    await dailyTrashPurge();
  }));
}

// Leaving device mode for a server: the jobs stop with it (MOB-05). Work already
// running finishes; nothing new is started until start() is called again.
function stop() {
  for (const t of timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  timers.clear();
  backgroundOn = false;
}

let booted = null;

// Opens the database, migrates it, and makes sure the owner and their session
// exist, once; every later call returns the same promise. A failed boot (no
// SQLite plugin, a corrupt file) must be retryable: the next call tries again
// instead of replaying the same rejection forever.
function boot() {
  if (!booted) {
    booted = (async () => {
      await db.initDb();
      await scryfallApi.loadPriceSource();
      const userId = await ensureOwner();
      const token = await ensureSession(userId);
      return { token };
    })();
    booted.catch(() => { booted = null; });
  }
  return booted;
}

// Resolves { token } — the bearer credential for handle(). Idempotent.
//
// options.background: false skips the network jobs (set sync, price sweeps). With
// it (the default), the jobs start if they are not running, which after stop()
// is how they come back.
async function start({ background: withJobs = true } = {}) {
  const session = await boot();
  if (withJobs) startBackground();
  return session;
}

// request: { method, url, headers, body } — url is path + query, body the raw
// string fetch() was given. Resolves { status, headers, body }; never rejects.
// options.signal: aborting it while the request is still waiting for its turn
// drops it (status 499); once it runs, it runs to the end.
async function handle(request, { signal } = {}) {
  try {
    await boot();
  } catch (err) {
    console.error('Device backend failed to start:', err);
    return { status: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'The on-device database could not be opened.' }) };
  }
  const unit = { name: `${request.method || 'GET'} ${request.url}`, background: false };
  try {
    await lock.acquire(unit, { signal });
  } catch {
    return { status: 499, headers: {}, body: '', aborted: true };
  }
  try {
    return await dispatch(app, request);
  } finally {
    lock.release(unit);
  }
}

module.exports = {
  start,
  stop,
  handle,
  // Background work that opens transactions takes its turn through this.
  background,
  setDriver: require('sqlite3').setDriver,
  // Scanning: what can be downloaded (one descriptor table, shared with the
  // server's fetch-models script), where the app's downloaded catalogs come in,
  // and the TCGplayer product map the Pokémon catalog resolves its matches through.
  // `release`: where Bindarr's own catalogs are published, and the segment format
  // the app downloads and applies them with (catalogReleases.js is the server's
  // side of the same thing).
  scanAssets: {
    MODELS: require('../utils/modelAssets').MODELS,
    CATALOGS: require('../utils/modelAssets').CATALOGS,
    release: {
      base: require('../utils/releaseAssets').base(),
      segments: require('../utils/catalogSegments'),
      model: require('../utils/modelAssets').MODEL_ID,
      // Whether a game's release catalog fits this phone's card ids: a Pokémon one
      // is keyed by TCGdex ids (catalogReleases.fitsInstall on a server).
      fits: async (game) => game !== 'pokemon' || require('../utils/pokemonProvider').usesTcgdex('en'),
    },
  },
  setScanSource: cvScan.setSource,
  productMap,
  app,
};
