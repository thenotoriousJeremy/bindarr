// Load .env from the CWD first (how a normal `npm start` from backend/ behaves),
// then from backend/ explicitly. dotenv never overwrites an already-set variable,
// so the first one to define a key still wins and nothing changes for existing
// deployments — this only rescues the case where the server was launched by
// absolute path from some other directory, which silently ignored the file and
// left settings like HTTPS_PORT looking as though they had no effect.
// dotenv 17+ reads DOTENV_OVERRIDE from the environment and logs each load, so
// both are pinned here: never override, and no startup line per file.
const DOTENV = { override: false, quiet: true };
require('dotenv').config(DOTENV);
require('dotenv').config({ ...DOTENV, path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const db = require('./db');
const metrics = require('./utils/metrics');
const getCollectionMetrics = require('./utils/collectionMetrics');
const tcgApi = require('./tcgApi');
const scryfallApi = require('./scryfallApi');
const backup = require('./backup');
const { createScheduler } = require('./scheduler');
const { runPriceSweeps, requestStop: stopPriceSweeps } = require('./utils/priceSweeps');
const { createShutdown, whenTrue } = require('./utils/shutdown');
const { serveFrontend } = require('./utils/staticCache');
const { sendFileAt } = require('./utils/sendFileAt');

// Say the provider deprecation out loud at boot, to the installs it applies to.
//
// It is written down everywhere already — README, .env.example, the Admin
// provider hint — and none of that reaches the person who set this up two years
// ago and has not opened Settings since. The startup log is what a self-hoster
// actually reads, and it is where they will be looking the morning it breaks.
//
// The decision lives in utils/pokemonProvider with the rest of the provider
// policy; this only prints it.
async function warnIfProviderSunsetting() {
  try {
    const provider = require('./utils/pokemonProvider');
    const notice = provider.sunsetNotice(await provider.configured());
    if (notice) console.warn(notice);
  } catch { /* a boot-time notice must never be the thing that stops the boot */ }
}

const authRoutes = require('./routes/auth');
const sharedRoutes = require('./routes/shared');
const adminRoutes = require('./routes/admin');
const collectionRoutes = require('./routes/collection');
const storageRoutes = require('./routes/storage');
const statsRoutes = require('./routes/stats');
const importExportRoutes = require('./routes/importExport');
const setsRoutes = require('./routes/sets');
const decksRoutes = require('./routes/decks');
const listsRoutes = require('./routes/lists');
const settingsRoutes = require('./routes/settings');
const notesRoutes = require('./routes/notes');
const cardArtRoutes = require('./routes/cardArt');
const sealedRoutes = require('./routes/sealed');
const backupRoutes = require('./routes/backup');
const trashRoutes = require('./routes/trash');
const binderArtRoutes = require('./routes/binderArt');
const notificationRoutes = require('./routes/notifications');
const notify = require('./notify');
const fxRoutes = require('./routes/fx');
const { authenticateToken } = require('./middleware/auth');
const { startHttps, selfSignedTls } = require('./utils/tls');
const { PWA_FILES, setPwaHeaders } = require('./utils/serviceWorkerHeaders');


const app = express();
// A rejected promise nobody awaited is a bug in one request, not a reason to
// drop every other user's connection: Node's default turns it into an exit.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason && reason.stack ? reason.stack : reason);
});

const PORT = process.env.PORT || 3001;
app.use(metrics.middleware);

// The model directory is created here, at startup, as the app's own user —
// deliberately not by the root entrypoint. A directory root creates inside a
// volume that has already been handed over to `node` is one this process can
// never write into, and the first thing to notice was a build dying hours later
// with `EACCES` on its own output.
//
// Probed with a real write rather than fs.access(W_OK): access reports the
// permission bits, which is not the same question as whether this filesystem
// will accept a file (NFS/SMB squash a root-owned mount's bits into a yes it
// does not honour). Neither problem here is fatal — everything except scanning
// still works — so both say so plainly and carry on. Scanning's own failure is a
// 503 from /api/scan-match, which whoever is holding the phone meets long before
// anyone reads these logs.
function checkScanModels() {
  const fs = require('fs');
  const dir = process.env.CV_MODEL_DIR || path.join(__dirname, '..', 'data', 'models');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (err) {
    console.error(`STARTUP: ${dir} is not writable (${err.code}) — catalog builds will fail.`);
    console.error('STARTUP: fix it with  docker exec -u root <container> chown -R node:node /app/database');
    return;
  }
  // The models ship in neither the image nor the repository: they are AGPL-3.0
  // while Bindarr is MIT, so fetching them is the operator's deliberate step. That
  // makes "no models" the ordinary state of a fresh install rather than a fault,
  // and it deserves the command that fixes it instead of silence until someone
  // points a camera at a card.
  const missing = ['cornelius.onnx', 'milo.onnx'].filter(f => !fs.existsSync(path.join(dir, f)));
  if (missing.length) {
    console.warn(`STARTUP: scan models missing from ${dir} (${missing.join(', ')}) — card scanning is disabled.`);
    console.warn('STARTUP: fetch them with  node scripts/fetch-models.mjs   (Docker: docker exec <container> node scripts/fetch-models.mjs)');
  }
  const modelAssets = require('./utils/modelAssets');
  const outdated = modelAssets.MODELS.filter(modelAssets.isOutdated).map(a => a.name);
  if (outdated.length) {
    console.warn(`STARTUP: ${outdated.join(', ')} is an older release's model — scanning works, but the live card outline is ~4x slower than it needs to be.`);
    console.warn('STARTUP: update it from Admin → Catalog (Update), or  node scripts/fetch-models.mjs');
  }
}
checkScanModels();

// Behind a reverse proxy (nginx/Traefik/Caddy terminating TLS — effectively
// required, since mobile camera access needs HTTPS), set TRUST_PROXY so req.ip
// and the rate limiters use the real client IP from X-Forwarded-For instead of
// the proxy's. Leave it UNSET when the app is directly exposed: trusting that
// header otherwise lets any client spoof its IP and defeat the rate limiter.
// Accepts a hop count ("1"), "true", or an express trust-proxy string ("loopback").
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? true : (Number.isNaN(Number(tp)) ? tp : Number(tp)));
}

// Content Security Policy, enforced. Identification is server-side (the client
// POSTs a photo to /api/scan-match); the browser only runs the corner model that
// draws the aiming outline. So the page needs nothing beyond the app's own bundle,
// the card-image hosts and Google Fonts -- checked against a production build with
// every view and the scanner open, not just read off the code.
//
// What it does not allow is the point: no inline or third-party script, so markup
// injected into the page cannot run. The one inline script index.html had (the
// pre-paint theme) is public/theme-init.js now for that reason.
//
// CSP_REPORT_ONLY=true sends the same policy as Report-Only: the browser logs what
// it would block instead of blocking it. It is the escape hatch for an install
// whose card art comes from a host not listed below -- a provider moving to a new
// CDN, say -- until the list is updated.
const cspReportOnly = process.env.CSP_REPORT_ONLY === 'true';
if (cspReportOnly) {
  console.warn('CSP_REPORT_ONLY=true: the Content-Security-Policy is reported, not enforced.');
}
app.use(helmet({
  // HSTS pins the host to HTTPS in the browser. When we terminate TLS ourselves
  // with a self-signed certificate that is a lockout: Chrome stops offering the
  // "proceed anyway" bypass, and http://<host>:3001 gets upgraded too. Left at
  // helmet's default (on) for every other deployment, including a reverse proxy
  // with a real certificate.
  hsts: !selfSignedTls(),
  contentSecurityPolicy: {
    reportOnly: cspReportOnly,
    directives: {
      defaultSrc: ["'self'"],
      // 'wasm-unsafe-eval' is what lets the browser compile WebAssembly. The card
      // scanner runs the cornelius corner model locally through onnxruntime-web to
      // find the card in the frame, and without this the wasm is refused outright.
      // The worker that runs it, and the onnxruntime glue it imports from /ort/,
      // are same-origin files that get this same header.
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      // blob: for canvas-confetti, which draws on an OffscreenCanvas in a worker it
      // builds from a Blob. Only script already running here can make a blob: URL.
      workerSrc: ["'self'", 'blob:'],
      // Every request the page itself makes is to this server; provider APIs are
      // called server-side, so no key or API host ever appears here.
      connectSrc: ["'self'"],
      // Card art, set symbols and logos, straight from each provider's CDN (the
      // URLs are whatever the provider's API returned):
      //   pokemontcg.io      images.pokemontcg.io, and images.scrydex.com for its newer sets
      //   TCGdex             assets.tcgdex.net
      //   Scryfall           cards.scryfall.io, svgs.scryfall.io (set icons), and
      //                      c1/img.scryfall.com, still in rows cached years ago
      //   Lorcast            cards.lorcast.io
      //   pokemontcgapi.com  media.rarebit.app
      //   Riftbound          cmsassets.rgpub.io
      // data: and blob: are the scanner's captures and previews.
      imgSrc: [
        "'self'", 'data:', 'blob:',
        'https://images.pokemontcg.io', 'https://images.scrydex.com', 'https://assets.tcgdex.net',
        'https://cards.scryfall.io', 'https://svgs.scryfall.io', 'https://c1.scryfall.com', 'https://img.scryfall.com',
        'https://cards.lorcast.io', 'https://media.rarebit.app', 'https://cmsassets.rgpub.io'
      ],
      // index.html loads Antonio, Outfit and Plus Jakarta Sans from Google Fonts,
      // which is two separate origins: the stylesheet comes from fonts.googleapis
      // .com and the .woff2 files it then references come from fonts.gstatic.com.
      // 'unsafe-inline' because React renders a few <style> blocks (the scanner and
      // the deck builder); style cannot run script, so it is the cheap one to allow.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));

// Restrict cross-origin access to known frontend origins. Localhost + private-
// LAN origins are ALWAYS allowed (see PRIVATE_ORIGIN below); CORS_ORIGIN adds
// public origins on top (e.g. a reverse-proxy domain) rather than replacing the
// LAN allowance, so a self-hosted instance behind a proxy stays reachable both
// ways without listing the LAN IP. The Vite dev server runs with host:true +
// HTTPS so the mobile scanner can reach it over the LAN, which makes the
// browser send an Origin like https://192.168.1.20:5173 on writes (PUT/POST/
// DELETE) — GETs are same-origin and send none, which is why only writes were
// being rejected before.
const explicitOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// The reverse-proxy domain is already configured as PUBLIC_BASE_URL for share
// links, so reuse its origin as an allowed CORS origin — setting it alone is
// enough for proxied logins, no separate CORS_ORIGIN needed.
if (process.env.PUBLIC_BASE_URL) {
  try { explicitOrigins.push(new URL(process.env.PUBLIC_BASE_URL).origin); }
  catch { /* malformed URL — ignore */ }
}

// Loopback + RFC1918 private ranges (10/8, 172.16-31/12, 192.168/16) and
// *.local, with any scheme/port. Not internet-routable, so this is safe for a
// self-hosted app while still blocking arbitrary public websites.
const PRIVATE_ORIGIN = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|[a-z0-9-]+\.local)(:\d+)?$/i;

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / non-browser client
  if (PRIVATE_ORIGIN.test(origin)) return true; // localhost + private LAN, always
  return explicitOrigins.includes(origin);
}

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
// Two endpoints legitimately carry megabytes, and only two. An import wraps its
// payload in a JSON string field, which added escaping overhead pushed a ~90-card
// collection past the 100kb default already; a scan carries a photo base64'd into
// JSON, which costs a third again on top of the image.
//
// Everything else is ids and short strings, so the global ceiling stays small.
// Applying 15mb to every route means an UNAUTHENTICATED POST /api/auth/login can
// hand the process 15 MB, which is a free memory amplifier for anyone who can
// reach the port. body-parser skips a request whose body is already parsed, so
// registering the big one first and the small default after is all the scoping
// needed — but the big one is registered below the auth gate, not here, so an
// unauthenticated request to those paths is refused before its body is read
// rather than after 15 MB of it is buffered. Here they are only skipped.
const BIG_BODY_PATHS = ['/api/import', '/api/scan-match', '/api/search'];
// A full backup restore (routes/backup.js) can be far larger still; it gets its own
// limit below the gate, like the paths above.
const BACKUP_BODY_PATH = '/api/backup';
const isBigBodyPath = (p) => [...BIG_BODY_PATHS, BACKUP_BODY_PATH].some(b => p === b || p.startsWith(`${b}/`));
const smallJson = express.json({ limit: '1mb' });
app.use((req, res, next) => (isBigBodyPath(req.path) ? next() : smallJson(req, res, next)));
// Express 5's parsers leave req.body undefined when a request has no JSON body;
// Express 4 left {}. Routes destructure req.body, so keep the 4 default: a missing
// body then fails validation with a 400 instead of a TypeError's 500. The big-body
// parsers below the gate still replace it with what they parse.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Rebuild any catalog that has fallen behind, right after the weekly set refresh
// discovers new releases.
//
// Without this, a released set lands in the set list and the catalog silently keeps
// answering: a scan of a brand-new card does not fail, it returns the nearest wrong
// card at a confident-looking score. Nobody presses Update because nothing tells
// them to.
//
// Deliberately conservative. It only touches catalogs that ALREADY exist — it never
// creates one, because that is an hours-long job nobody asked for — and it skips
// entirely while a build is running, since catalog.start refuses a second one
// anyway. The embed phase reuses every unchanged vector, so the real cost is
// downloading and embedding only the new cards.
//
// ponytail: env var rather than an app_settings column + settings UI + eleven
// translations. Promote it if users want per-install control from the web UI.
async function autoUpdateCatalogs() {
  if (process.env.CATALOG_AUTO_UPDATE === '0') return;
  const catalog = require('./catalog');
  if (catalog.state()) return;
  try {
    for (const c of await catalog.list()) {
      if (!c.built || !c.newSets) continue;
      console.log(`catalog: ${c.game}/${c.lang} is ${c.newSets} set(s) behind — updating (CATALOG_AUTO_UPDATE=0 to disable)`);
      catalog.start(c.game, c.lang);
      return;   // one at a time; the next tick picks up the next one
    }
  } catch (err) {
    console.error('Catalog auto-update check failed:', err.message);
  }
}

// Every game's set list (utils/syncJobs, shared with device mode's embedded/).
const { syncSets } = require('./utils/syncJobs');

const HOUR = 60 * 60 * 1000;

// Background work, on clocks kept in the database (scheduler.js) and checked
// every 15 minutes rather than on in-memory timers: a restart resets nothing, and
// whatever fell due while the server was down runs at the first check after boot.
const scheduler = createScheduler({
  jobs: [
    {
      // Weekly: refresh sets (picks up newly released ones), reload the
      // in-memory sets cache so chronological sorting stays current without a
      // restart, and catch any built scan catalog up with what the refresh found.
      // Scryfall's guidance is that gameplay/set data changes rarely and weekly is
      // plenty — prices are on their own schedule below.
      name: 'sets-refresh',
      every: () => 7 * 24 * HOUR,
      run: async () => {
        await syncSets(true);
        await require('./utils/compartmentSort').loadSetsCache(db);
        await autoUpdateCatalogs();
      },
    },
    {
      // The local TCGCSV cache the Pokémon prices and the scan product map read.
      // Hourly, because tcgcsvApi decides for itself: it asks TCGCSV's
      // last-updated.txt at most once a day (tcgcsv_last_checked_at), downloads
      // only a new dataset, and resumes one that a failed or interrupted run left
      // half-synced. Between those, a call is one indexed read. The TCGCSV price
      // sweep syncs too, and joins a sync already in progress.
      name: 'tcgcsv-sync',
      every: () => (process.env.BINDARR_DISABLE_TCGCSV_SYNC === '1' ? 0 : HOUR),
      run: async () => {
        const tcgcsvApi = require('./tcgcsvApi');
        try {
          await tcgcsvApi.syncIfUpdated();
        } catch (err) {
          // TCGCSV answered 403 and asked to be left alone. tcgcsvApi has said
          // until when, and prices come from the existing cache meanwhile.
          if (!tcgcsvApi.isCooldownError(err)) throw err;
        }
      },
    },
    {
      // Prices. Hourly, and NOT forced — shouldSweepPrices decides whether each
      // provider is actually due, from the admin's price_refresh_days.
      //
      // This used to tick daily and pass `force: true`, on the reasoning that the
      // timer was itself the right cadence. Two things came of that. The interval
      // could not be configured, which is a problem now that one selectable
      // provider charges credits per card refreshed. And because the forced path
      // never called shouldSweepPrices, a provider missing from its SWEEP_COLUMN
      // map still looked like it was working: Lorcana has been in that state
      // since it was added, and nobody could have noticed from the outside.
      //
      // Hourly rather than daily because a daily tick against a daily interval
      // skips on any clock drift at all — "23h 59m elapsed" is not due, so the
      // refresh silently becomes every other day. An hourly run that refuses in
      // one indexed read per provider costs nothing and has no such edge. Nor is
      // a restart a reason to sweep again: under nodemon that was a full sweep on
      // every code edit, for data that cannot have changed since the last one.
      //
      // utils/priceSweeps owns the list and its order, and runs the sweeps one
      // after another. Its summary goes to notify.js, which looks for price moves
      // worth telling users about and reports a failed sweep to the admins.
      name: 'price-sweeps',
      every: () => HOUR,
      run: () => runPriceSweeps().then(summary => notify.emit({ type: 'price_sweep_done', summary })),
    },
    {
      // ECB exchange rates for showing prices in the owner's display currency.
      // Hourly, like tcgcsv-sync, because fxRates.refreshIfDue decides: it asks
      // the ECB at most once a day (the last stored fetch), and between those a
      // run is one indexed read. A daily job against a daily guard would skip on
      // the few seconds between the two clocks and fetch every other day. A
      // failed fetch throws, so the scheduler records it and retries.
      // BINDARR_DISABLE_FX_SYNC=1 switches it off; the e2e suites set it, so no
      // test talks to the ECB.
      name: 'fx-rates',
      every: () => (process.env.BINDARR_DISABLE_FX_SYNC === '1' ? 0 : HOUR),
      run: async () => {
        const result = await require('./fxRates').refreshIfDue();
        if (result.error) throw new Error(result.error);
      },
    },
    {
      // Expired sessions, so the table doesn't grow unbounded. Lookups already
      // ignore them; this is housekeeping.
      name: 'session-purge',
      every: () => 24 * HOUR,
      run: () => db.run(`DELETE FROM sessions WHERE expires_at <= DATETIME('now')`),
    },
    {
      // Deleted cards past their 30 days in the trash (utils/collectionTrash.js).
      name: 'trash-purge',
      every: () => 24 * HOUR,
      run: () => require('./utils/collectionTrash').purgeExpiredTrash(),
    },
    {
      // BACKUP_INTERVAL_HOURS (default 24; 0 disables). backup.js explains where
      // the first period is counted from.
      name: 'backup',
      every: backup.intervalMs,
      since: backup.lastBackupAt,
      run: backup.runScheduledBackup,
    },
  ],
});

// The HTTP and (optional) HTTPS listeners, assigned at the bottom of this file.
let httpServer = null;
let httpsServer = null;

// SIGTERM (docker stop) and SIGINT (Ctrl+C) stop the listeners and the job
// timers, give running work a bounded few seconds to reach a safe point, close
// the database and exit 0; a second signal exits at once. utils/shutdown.js has
// the sequence and the reasons.
const shutdown = createShutdown({
  servers: () => [httpServer, httpsServer],
  stopJobs: () => {
    scheduler.stop();
    // Between two sweeps, not mid-sweep; a catalog build after its in-flight
    // images, writing what it has (atomically) so a resume reuses all of it.
    stopPriceSweeps();
    require('./catalog').stop();
    notify.stop();
  },
  pendingWork: () => {
    const catalog = require('./catalog');
    return [
      { name: 'database startup', promise: dbInit },
      ...scheduler.inFlight(),
      { name: 'backup', promise: backup.pending() },
      { name: 'catalog build', promise: catalog.state() ? whenTrue(() => !catalog.state()) : null },
    ];
  },
  closeDb: () => new Promise((resolve, reject) => db.dbConnection.close(err => (err ? reject(err) : resolve()))),
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Warm the scan models and catalogs. Two ONNX sessions plus an embedding table
// take ~400 ms to load; paying that on the first scan instead would make the
// slowest scan of a session the one a user is most likely to judge. Not awaited
// — listening must not wait on it, and a scan arriving before it finishes just
// pays the load itself.
function warmScanCatalogs() {
  try {
    const cvScan = require('./cvScan');
    const warm = require('./utils/games').withFeature('scan').filter(g => cvScan.isBuilt(g));
    for (const g of warm) {
      cvScan.load(g).catch(err => console.warn(`cvScan ${g} warm-up failed:`, err.message));
      // Locally built non-English catalogs too (e.g. German Pokémon, #80): they
      // were only loaded by the first scan in that language, which then paid the
      // whole catalog read.
      for (const lang of cvScan.builtLangs(g).filter(l => l !== 'English')) {
        cvScan.load(g, lang).catch(err => console.warn(`cvScan ${g} ${lang} warm-up failed:`, err.message));
      }
    }
    // There is no second matcher to fall back to, so say what is missing. The
    // models alone identify nothing.
    if (!warm.length) console.warn('cvScan: no catalogs present — scanning is disabled until one is built (Admin → Catalogs)');
  } catch (err) {
    console.warn('cvScan unavailable:', err.message);
  }
}

// Once the database is up, before the scheduler's first check. None of it is
// what the server needs in order to answer requests, so a failure here is logged
// and the boot carries on.
async function startupTasks() {
  // Sets, first, as they always have been. When the weekly refresh is overdue —
  // on the first boot that has never run it, and on an install that restarts
  // more often than weekly, which the old in-memory timer never refreshed at all
  // — it runs here, forced, in place of the boot fill. Otherwise the fill only
  // fetches a game whose set table is still empty.
  if (!(await scheduler.runIfDue('sets-refresh'))) await syncSets(false);

  // pokemontcg.io has an end date, and static documentation does not reach
  // someone who set this up two years ago and has not opened Settings since.
  // The startup log is the surface self-hosters actually read, so say it there
  // — once per boot, only to the installs it applies to, and only until the
  // date passes, after which it is no longer a warning but a description of
  // why things stopped working, which the provider's own errors will cover.
  await warnIfProviderSunsetting();

  // Load sets into compartmentSort memory cache
  const { loadSetsCache } = require('./utils/compartmentSort');
  await loadSetsCache(db);

  warmScanCatalogs();
}

// Initialize Database on startup
let dbReady = false;
const dbInit = db.initDb()
  // Before dbReady, so no request can normalize a Magic card against the
  // default price source on an install configured for Cardmarket. One indexed
  // read, and it never throws (see scryfallApi.loadPriceSource).
  .then(() => scryfallApi.loadPriceSource());

dbInit.then(async () => {
  dbReady = true;
  console.log('Database tables verified/created successfully.');

  try {
    await startupTasks();
  } catch (err) {
    console.error('Startup tasks failed:', err);
  }
  // Started regardless: the jobs retry on their own clocks.
  backup.logPolicy();
  scheduler.start();
  // Deliver any notifications still queued from before the restart.
  notify.start();
}, (err) => {
  // Fatal, and said so. This used to log and carry on listening: /api/health
  // answered 503 forever, an orchestrator saw a live process, and nothing
  // restarted it. Without its schema the server has nothing to serve, so it
  // exits non-zero and leaves the restart to whatever supervises it (Docker's
  // restart policy, systemd) — which is also what makes the operator look.
  // Explicit rather than an exit on unhandled rejection: that one is a
  // log-and-continue on purpose (top of this file).
  console.error('Failed to initialize database:', err);
  console.error(`STARTUP: cannot serve without the database at ${db.dbPath}; exiting.`);
  shutdown('Database initialisation failed', 1);
});

// Readiness/liveness probe for orchestrators (Docker HEALTHCHECK, etc.).
// Unauthenticated; pings the DB so a wedged database reads as unhealthy.
// Declared before the /api collection mount so nothing shadows it.
app.get('/api/health', async (req, res) => {
  res.setHeader('X-App-Name', 'Bindarr');
  if (!dbReady) {
    return res.status(503).json({ status: 'db_initializing' });
  }
  try {
    await db.get('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

// gzip. Mounted HERE, above the routes, because it has to see a response to
// compress it: sitting below the /api mounts it only ever reached the static
// bundle, and every JSON body — a 5000-row collection among them — went out raw.
//
// It matters for the bundle too. The onnxruntime wasm the in-browser detector
// loads is ~13 MB uncompressed, which is a long wait on a phone over wifi and,
// worse, a stall that looks like a hang.
app.use(compression());

app.get('/metrics', (_req, res) => res.sendStatus(404));

// --- PUBLIC API ROUTES ---
// Everything mounted above the gate below is reachable without a session, and
// each one is deliberate: login/register, a public shared collection, and the
// card art that shared collection renders.
app.use('/api/auth', authRoutes);
app.use('/api/shared', sharedRoutes);
// Admin carries its own authenticateToken + requireAdmin, so it sits above the
// gate rather than being authenticated twice.
app.use('/api/admin', adminRoutes);
// Ahead of the bare '/api' mounts so nothing shadows it. Its reads are
// deliberately unauthenticated — a public shared collection renders card art too.
app.use('/api/card-art', cardArtRoutes);
// ECB reference rates: public data, and a shared collection converts with them.
app.use('/api/fx', fxRoutes);

// --- AUTHENTICATION GATE ---
// ONE gate for every remaining /api route, rather than a router.use in each file.
//
// Per-router auth was both a hole and a cost. The hole: routers that forgot it
// (tags, importExport, the audit-log handlers) were protected only because the
// collection router is ALSO mounted at '/api' and its middleware ran first on the
// way past — so authentication depended on the order of the lines below, and
// reordering them would have silently exposed GET /api/export. Worse, an
// unauthenticated request reaching one of those handlers threw on `req.user.id`
// inside an async handler, which Express 4 does not catch: unhandled rejection,
// and launch.js turns that into a process exit.
//
// The cost: /api/notes passed through the collection, storage and stats routers
// on its way to notes, so it ran authenticateToken — and its sessions⋈users
// SELECT — four times per request.
app.use('/api', authenticateToken);
app.use(BIG_BODY_PATHS, express.json({ limit: '15mb' }));
app.use(BACKUP_BODY_PATH, express.json({ limit: '200mb' }));

// --- AUTHENTICATED API ROUTES ---
app.use('/api/collection/trash', trashRoutes);
app.use('/api', collectionRoutes);
app.use('/api', storageRoutes);
app.use('/api', statsRoutes);
app.use('/api', importExportRoutes);
app.use('/api', notesRoutes);
app.use('/api', sealedRoutes);
app.use('/api', backupRoutes);
app.use('/api', binderArtRoutes);
app.use('/api/sets', setsRoutes);
app.use('/api/decks', decksRoutes);
// Full paths inside (/lists, /decks/:id/missing-list, /cards/:id/decks), like collectionRoutes.
app.use('/api', listsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/set-completion', require('./routes/setCompletion'));
app.use('/api/precons', require('./routes/precons'));
app.use('/api/notifications', notificationRoutes);

// The service worker and the web app manifest: revalidated rather than cached
// for a year, and the worker gets a policy that lets it cache card art. See
// utils/serviceWorkerHeaders.js. A build without them falls through to the
// catch-all like any other unknown path.
app.get(PWA_FILES, (req, res, next) => {
  setPwaHeaders(req, res);
  sendFileAt(res, path.join(__dirname, '../../frontend/dist', req.path), (err) => {
    if (err && !res.headersSent) next();
  });
});

// The live overlay runs the SAME corner model the scan does, in the browser, so
// what the user aims with and what the server matches cannot disagree. That
// means the browser has to be able to fetch the model — unauthenticated, because
// the outline runs before login is relevant and the file is public weights.
// Revalidated, NOT immutable. This used to say "immutable: the filename changes
// when the model does" — and then 1.8.3 swapped cornelius for fastweb-single
// under the same name, so every browser that had loaded the old one kept it for
// 30 days. The ETag sendFile sets makes a revalidation a ~200-byte 304, and the
// native app keys its own cache off that same ETag (cardDetector.fetchModel).
// Only the corner model. Serving the whole directory would also expose the
// 56 MB embedding catalog, which the browser never needs and which nobody
// should be able to pull off an install by guessing a filename.
app.get('/models/cornelius.onnx', (req, res) => {
  res.setHeader('Cache-Control', 'public, no-cache');
  // MODEL_DIR, not a hardcoded backend/data: the container keeps the models on
  // the persisted volume (CV_MODEL_DIR=/app/database/models). Hardcoded, this
  // 404'd in every Docker install, the worker fell back to the pure-JS contour
  // detector, and detection went from ~80ms to 200ms+ with the CPU pegged.
  sendFileAt(res, path.join(require('./utils/modelAssets').MODEL_DIR, 'cornelius.onnx'), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// The built SPA, and index.html for every client-side route. Vite's hashed
// /assets/ are cached for a year, immutable; everything with a fixed name —
// /ort/'s wasm, the manifest, index.html — is revalidated, so an upgrade is
// picked up on the next load. utils/staticCache.js has the reasons.
const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
app.use(serveFrontend(frontendBuildPath));

// Generic error handler (e.g. rejected CORS origins) — never leak stack traces to clients
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Upload too large. Try exporting/importing in smaller batches.' });
  }
  // body-parser's other refusals (broken JSON, a body that is a bare string,
  // number or null, an unsupported charset) are the client's mistake and carry a
  // 4xx. Answering them 500 blamed the server and logged a stack per request.
  if (err && err.expose && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.type === 'entity.parse.failed' ? 'Request body is not valid JSON' : 'Bad request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start Express Server
if (metrics.prometheusEnabled) {
  const prometheusPort = Number(process.env.PROMETHEUS_PORT || 9100);
  if (!Number.isInteger(prometheusPort) || prometheusPort < 1 || prometheusPort > 65535) {
    throw new Error('PROMETHEUS_PORT must be an integer between 1 and 65535');
  }
  const otherPorts = [Number(PORT), Number(process.env.HTTPS_PORT)].filter(port => port > 0);
  if (otherPorts.includes(prometheusPort)) {
    throw new Error('PROMETHEUS_PORT must differ from PORT and HTTPS_PORT');
  }

  const prometheusApp = express();
  prometheusApp.get('/metrics', async (req, res) => {
    try {
      const collection = await getCollectionMetrics(db);
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(metrics.toPrometheus(collection));
    } catch (error) {
      console.error('PROMETHEUS METRICS ERROR:', error);
      res.status(500).type('text/plain').send('Failed to collect metrics\n');
    }
  });
  prometheusApp.all('*', (req, res) => res.sendStatus(404));

  const prometheusServer = prometheusApp.listen(prometheusPort, '0.0.0.0', () => {
    console.log(`Prometheus metrics listener running on port ${prometheusPort}`);
  });
  prometheusServer.on('error', error => {
    console.error(`Prometheus metrics listener failed on port ${prometheusPort}:`, error);
  });
}

httpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`=========================================`);
  console.log(`Bindarr Server running on port ${PORT}`);
  console.log(`Access local: http://localhost:${PORT}`);
  console.log(`=========================================`);
  // Camera scanning needs a secure context, so a LAN/Docker install serves TLS
  // too when HTTPS_PORT is set. Certificates live beside the database.
  httpsServer = await startHttps(app, path.join(path.dirname(db.dbPath), 'ssl'));
});
