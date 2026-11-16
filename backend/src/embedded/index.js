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
// call) stays on here, and syncTcgcsv() below lifts it for three moments only:
// the weekly check, the product-map build the Pokémon scan download starts, and
// the first use of a game served from TCGplayer's catalogue. The hourly price
// sweep prices from whatever version is cached, which is what it does on a server
// when a sync fails. A switch someone else set (a test, a developer) is theirs,
// and is left alone.
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

// A transaction outside any turn is background work no unit owns: every job this
// file schedules is a unit, and so is work a request starts and does not wait for
// (utils/backgroundWork, below), so this is only ever something that slipped past
// both. It takes a turn for as long as it is open, so a request cannot start in
// the middle of it. Inside a turn, it belongs to
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

// A background unit's provider requests go out with the turn let go (lock.away),
// so requests are not queued behind a download: a price sweep or a set refresh
// holds the turn only while it reads and writes. Every provider client is an axios
// instance, and every get/post/... of every instance, made before or after this
// line, calls Axios.prototype.request, which is wrapped here. Not inside a
// transaction: letting the turn go there would let a request's statements into
// it, so that download keeps the turn. A request keeps its turn through its own
// provider calls, as ./units.js describes. An axios without that method (a future
// major version) keeps every download inside the turn: slower, never wrong.
//
// Safe only because the code that holds a background unit's turn is that unit's
// own: work a request leaves running is a unit of its own (backgroundWork.start),
// so no stray download can let a running job's turn go.
const awayFromTurn = (fn) => {
  const unit = lock.holder();
  return unit && unit.background && !inTransaction() ? lock.away(unit, fn) : fn();
};
const { Axios } = require('axios');
if (Axios && Axios.prototype && typeof Axios.prototype.request === 'function') {
  const requestOverNetwork = Axios.prototype.request;
  Axios.prototype.request = function requestOutsideTheTurn(...args) {
    return awayFromTurn(() => requestOverNetwork.apply(this, args));
  };
} else {
  console.warn('Device mode: axios has no Axios.prototype.request; background jobs keep their turn while they download.');
}

// Work a request starts and does not wait for, and work several callers share
// (utils/backgroundWork has the whole story). start: a background unit of its own.
// join: the caller — request or job — lets its turn go while it waits for work
// someone else is running, which may need that turn to finish; inside a
// transaction it cannot, and keeps it. away: awayFromTurn, for what is not axios.
require('../utils/backgroundWork').installDevice({
  start: (name, fn) => background(name, () => fn()),
  join: (promise) => {
    const unit = lock.holder();
    return unit && !inTransaction() ? lock.away(unit, () => promise) : promise;
  },
  away: awayFromTurn,
});

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

// Every job this file schedules (the set refresh and check, the price sweeps, the
// trash purge, exchange rates, the TCGCSV syncs, the product map) runs as one
// background unit from start to end, clock included. So each transaction it opens
// is its own: it waits for a request holding the turn instead of opening under it,
// which is what a job run outside any unit did (db.withTransaction above takes
// whatever opens while a request holds the turn for that request's own). Its
// provider requests let the turn go meanwhile (the axios hook above).

// server.js refreshes the set tables on a weekly timer. An app is opened and
// closed all day and would never live to see that timer fire, so the date of the
// last forced refresh is kept, and whichever launch finds it a week old does one.
// Reaches the TCGplayer-catalogue games' catalogues too (tcgcsvGameApi.fetchAndCacheSets).
function refreshSets() {
  return background('set refresh', async () => {
    const forced = await due('sets_refreshed_at', WEEK);
    await syncSets(forced);
    if (forced) {
      await deviceState('sets_refreshed_at', Date.now());
      await deviceState('sets_checked_at', Date.now());   // a forced refresh is also today's check
    }
    await require('../utils/compartmentSort').loadSetsCache(db);
  });
}

// New sets between the weekly refreshes, as server.js's daily sets-check job: one
// set-list request per provider (utils/syncJobs.checkSets), at most once a day.
function dailySetCheck() {
  return background('set check', async () => {
    if (!(await due('sets_checked_at', DAY))) return;
    await checkSets();
    await deviceState('sets_checked_at', Date.now());
    await require('../utils/compartmentSort').loadSetsCache(db);
  });
}

// Every provider's price sweep, in utils/priceSweeps' order (the TCGplayer-catalogue
// games' included: tcgcsvGameApi.updateCollectionPrices). runPriceSweeps is
// single-flight, so a tick that finds the last run still going skips.
const sweepPricesInTurn = () => background('price sweeps', () => sweepPrices());

// Each TCGCSV sync the phone makes is a background unit (./units.js), like the
// product map's build: its reads and writes take turns with requests, and its
// downloads from the mirror go out with the turn let go (the axios hook above).
//
// One sync unit at a time, in the order asked. Two at once would deadlock:
// syncIfUpdated hands a second caller the run already going, and a second unit
// waiting on that run while holding the turn would never let the first back in.
let tcgcsvTurns = Promise.resolve();
function inTcgcsvTurn(name, job) {
  const run = tcgcsvTurns.then(() => lock.run({ name, background: true, tcgcsv: true }, job));
  tcgcsvTurns = run.catch(() => {});
  return run;
}
const inATcgcsvTurn = () => !!(lock.holder() && lock.holder().tcgcsv);

// The TCGCSV sync with the switch lifted (top of this file). tcgcsvApi reads the
// switch synchronously when the call starts, so it is lifted for exactly that
// call: anything else that asks meanwhile still prices from the cache. Called
// only inside a TCGCSV turn (inTcgcsvTurn).
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
// staying empty until the weekly sync (tcgcsvGameApi.setFirstUseSync). Not inside
// the request that asked, which would hold every other request through the sync
// and the thousands of card rows written after it: the catalogue is brought up to
// date in a TCGCSV turn of its own, while the request answers from the cache and
// says so (tcgcsvGameApi.setBackgroundUpdates). Called inside that turn, the
// first-use sync is the plain call. Called from anywhere else (another job that
// needs a category filled in), it is a TCGCSV turn of its own, waited for with the
// caller's turn let go (backgroundWork.join): one sync at a time, as above.
const tcgcsvGames = require('../tcgcsvGameApi');
tcgcsvGames.setFirstUseSync((context) => (inATcgcsvTurn()
  ? syncTcgcsvForTheWeek(context)
  : require('../utils/backgroundWork').join(inTcgcsvTurn(`TCGCSV sync: ${context}`, () => syncTcgcsvForTheWeek(context)))));
tcgcsvGames.setBackgroundUpdates((game, update) => inTcgcsvTurn(`${game} catalogue`, () => update()));

async function weeklyTcgcsv() {
  if (!(await due('tcgcsv_synced_at', WEEK))) return;
  // Asked again in its turn: a sync queued ahead of it may have been this week's.
  await inTcgcsvTurn('TCGCSV weekly sync', async () => {
    if (await due('tcgcsv_synced_at', WEEK)) await syncTcgcsvForTheWeek('the device weekly sync');
  });
}

// Deleted cards past their 30 days in the trash (utils/collectionTrash.js), as
// server.js's daily trash-purge job.
function dailyTrashPurge() {
  return background('trash purge', async () => {
    if (!(await due('trash_purged_at', DAY))) return;
    const removed = await require('../utils/collectionTrash').purgeExpiredTrash();
    await deviceState('trash_purged_at', Date.now());
    if (removed) console.log(`Trash: removed ${removed} card(s) deleted more than 30 days ago.`);
  });
}

// Exchange rates, as the server's fx-rates job: hourly asks, at most one ECB fetch
// a day (fxRates.refreshIfDue keeps that clock in the database). Its write is a
// transaction, so it runs as a background unit, with the lock let go for the
// fetch (the axios hook above: it is made outside the transaction).
function refreshFx() {
  if (process.env.BINDARR_DISABLE_FX_SYNC === '1') return Promise.resolve();
  const fx = require('../fxRates');
  const fetchXml = () => require('axios').get(fx.ECB_URL, {
    timeout: 15000,
    responseType: 'text',
    headers: { 'User-Agent': fx.USER_AGENT, Accept: 'application/xml, text/xml' },
  }).then(res => res.data);
  return background('exchange rates', () => fx.refreshIfDue({ fetchXml }))
    .then((result) => { if (result && result.error) console.warn('FX refresh failed:', result.error); })
    .catch(err => console.warn('FX refresh failed:', err.message));
}

// The Pokémon product map (tcgplayerCatalog), which the Pokémon scan download
// starts and a provider switch in Settings restarts. Its build writes one
// transaction per TCGCSV group, from the cached TCGCSV data, for a minute or two
// on a phone; so it runs as a background unit, yielding to requests between
// groups (db.withTransaction above). Its data comes first: the TCGCSV data it is
// built from, synced in a TCGCSV turn, then TCGdex's Japanese set list, which
// tcgdexApi keeps in memory for the build to read, in a unit of its own; both
// download with the turn let go.
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
    await inTcgcsvTurn('product map data', () => syncTcgcsvForTheWeek('product map', { explicit: true }));
    if (game === 'pokemon') {
      await background('product map: Japanese sets', () => require('../tcgdexApi').listSets('ja').catch(() => {}));
    }
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

// The background jobs' timers, so stop() can clear every one of them, and the
// jobs they started that are still queued or running.
const timers = new Set();
const running = new Set();
let backgroundOn = false;

// Runs fn now and keeps its promise while it is pending (stop() returns them).
function tracked(fn) {
  const p = Promise.resolve().then(fn);
  running.add(p);
  p.catch(() => {}).finally(() => running.delete(p));
  return p;
}

function every(ms, fn) {
  timers.add(setInterval(() => tracked(fn), ms));
}

function after(ms, fn) {
  const t = setTimeout(() => { timers.delete(t); tracked(fn); }, ms);
  timers.add(t);
}

function startBackground() {
  if (backgroundOn) return;
  backgroundOn = true;
  tracked(warmUp);
  // Prices on the server's cadence: soon after launch, then hourly while the app
  // stays open. Each provider decides for itself whether it is due.
  after(30000, sweepPricesInTurn);
  every(HOUR, sweepPricesInTurn);
  tracked(refreshFx);
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
// running finishes; nothing new is started until start() is called again. The
// promise says when that work is done (a caller may ignore it).
function stop() {
  for (const t of timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  timers.clear();
  backgroundOn = false;
  return Promise.allSettled([...running]).then(() => {});
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
    // As lock.run ends a unit: a request whose turn was let go and not yet taken
    // back (backgroundWork.join used where the request did not wait for it) is
    // never handed the turn again, rather than holding it with nobody to let go.
    unit.finished = true;
    if (lock.holder() === unit) lock.release(unit);
    else console.warn(`Device: ${unit.name} ended without its turn (backgroundWork.join outside an await?).`);
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
