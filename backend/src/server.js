// Load .env from the CWD first (how a normal `npm start` from backend/ behaves),
// then from backend/ explicitly. dotenv never overwrites an already-set variable,
// so the first one to define a key still wins and nothing changes for existing
// deployments — this only rescues the case where the server was launched by
// absolute path from some other directory, which silently ignored the file and
// left settings like HTTPS_PORT looking as though they had no effect.
require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const db = require('./db');
const tcgApi = require('./tcgApi');
const scryfallApi = require('./scryfallApi');
const lorcastApi = require('./lorcastApi');

// Which module owns the Pokémon `sets` table. Asked per call rather than resolved
// once: the provider is a setting an admin can change while the server is up, and
// the weekly refresh has to follow it without a restart.
const pokemonSetSource = async () =>
  (await require('./utils/pokemonProvider').usesTcgdex('English'))
    ? require('./tcgdexApi')
    : tcgApi;

const authRoutes = require('./routes/auth');
const sharedRoutes = require('./routes/shared');
const adminRoutes = require('./routes/admin');
const collectionRoutes = require('./routes/collection');
const storageRoutes = require('./routes/storage');
const statsRoutes = require('./routes/stats');
const importExportRoutes = require('./routes/importExport');
const setsRoutes = require('./routes/sets');
const decksRoutes = require('./routes/decks');
const settingsRoutes = require('./routes/settings');
const notesRoutes = require('./routes/notes');
const cardArtRoutes = require('./routes/cardArt');
const { authenticateToken } = require('./middleware/auth');
const { startHttps, selfSignedTls } = require('./utils/tls');


const app = express();
const PORT = process.env.PORT || 3001;

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

// Content Security Policy. Identification is server-side (the client POSTs a
// photo to /api/scan-match); the browser only runs the corner model that draws
// the aiming outline. Either way it needs nothing beyond the app's own bundle
// plus the card-image hosts. Kept Report-Only for now: flip
// `reportOnly` to false to enforce once a production smoke test confirms the
// scan flow and card images load cleanly under these directives.
// ponytail: Report-Only ceiling — enforce after a prod verification pass.
app.use(helmet({
  // HSTS pins the host to HTTPS in the browser. When we terminate TLS ourselves
  // with a self-signed certificate that is a lockout: Chrome stops offering the
  // "proceed anyway" bypass, and http://<host>:3001 gets upgraded too. Left at
  // helmet's default (on) for every other deployment, including a reverse proxy
  // with a real certificate.
  hsts: !selfSignedTls(),
  contentSecurityPolicy: {
    reportOnly: true,
    directives: {
      defaultSrc: ["'self'"],
      // 'wasm-unsafe-eval' is what lets the browser compile WebAssembly. The card
      // scanner runs the cornelius corner model locally through onnxruntime-web to
      // find the card in the frame, and without this the wasm is refused outright.
      // Harmless today because the policy is report-only, but it would silently
      // break scanning the moment that flips.
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://images.pokemontcg.io', 'https://cards.scryfall.io', 'https://c1.scryfall.com', 'https://img.scryfall.com', 'https://assets.tcgdex.net', 'https://cards.lorcast.io'],
      // index.html loads Antonio, Outfit and Plus Jakarta Sans from Google Fonts,
      // which is two separate origins: the stylesheet comes from fonts.googleapis
      // .com and the .woff2 files it then references come from fonts.gstatic.com.
      // Neither was listed, so every font on every page was a CSP violation —
      // survivable only because the policy is report-only. Enforced as it stood,
      // the whole app would have dropped to the fallback system font.
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
// registering these first and the small default after is all the scoping needed.
const bigJson = express.json({ limit: '15mb' });
app.use('/api/import', bigJson);
app.use('/api/scan-match', bigJson);
app.use(express.json({ limit: '1mb' }));

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

// Initialize Database on startup
db.initDb()
  .then(async () => {
    console.log('Database tables verified/created successfully.');

    // Un-stack legacy multi-quantity entries so every copy is its own row (one
    // physical card = one storage slot). No-op once migrated.
    const { splitStackedEntries } = require('./utils/collectionHelpers');
    const splitCount = await splitStackedEntries(db);
    if (splitCount > 0) console.log(`Split ${splitCount} stacked collection copies into individual rows.`);

    // Sync sets on startup (both games). WHICH Pokémon provider fills the `sets`
    // table follows the same setting the cards do — this used to be pokemontcg.io
    // unconditionally, so a TCGdex install browsed a set list numbered by a
    // provider none of its cards came from.
    await (await pokemonSetSource()).fetchAndCacheSets();
    await scryfallApi.fetchAndCacheSets();
    await lorcastApi.fetchAndCacheSets();

    // Load sets into compartmentSort memory cache
    const { loadSetsCache } = require('./utils/compartmentSort');
    await loadSetsCache(db);

    // Warm the scan models and catalogs. Two ONNX sessions plus an embedding table
    // take ~400 ms to load; paying that on the first scan instead would make the
    // slowest scan of a session the one a user is most likely to judge. Not awaited
    // — listening must not wait on it, and a scan arriving before it finishes just
    // pays the load itself.
    try {
      const cvScan = require('./cvScan');
      const warm = ['mtg', 'pokemon', 'lorcana'].filter(g => cvScan.isBuilt(g));
      for (const g of warm) {
        cvScan.load(g).catch(err => console.warn(`cvScan ${g} warm-up failed:`, err.message));
      }
      // There is no second matcher to fall back to, so say what is missing. The
      // models alone identify nothing.
      if (!warm.length) console.warn('cvScan: no catalogs present — scanning is disabled until one is built (Admin → Catalogs)');
    } catch (err) {
      console.warn('cvScan unavailable:', err.message);
    }

    // Weekly: refresh sets (picks up newly released ones) and reload the
    // in-memory sets cache so chronological sorting stays current without a
    // restart. Scryfall's guidance is that gameplay/set data changes rarely and
    // weekly is plenty — prices are on their own schedule below.
    setInterval(async () => {
      try {
        await (await pokemonSetSource()).fetchAndCacheSets(true);
        await scryfallApi.fetchAndCacheSets(true);
        await lorcastApi.fetchAndCacheSets(true);
        await loadSetsCache(db);
        await autoUpdateCatalogs();
      } catch (err) {
        console.error('Weekly sets refresh failed:', err);
      }
    }, 1000 * 60 * 60 * 24 * 7);

    // Daily: prices. Scryfall refreshes prices once a day, so this is both the
    // most often worth doing and the most often allowed. `force` because the
    // interval itself is already the right cadence.
    setInterval(() => {
      tcgApi.updateCollectionPrices(true);
      scryfallApi.updateCollectionPrices(true);
      lorcastApi.updateCollectionPrices(true);
      // Non-English Pokémon cards: their ids 404 on pokemontcg.io, so tcgApi's
      // sweep skips them and this is their only price refresh. No-op until the
      // user actually owns one.
      require('./tcgdexApi').updateCollectionPrices(true);
      // TCGCSV runs LAST of the Pokémon sweeps on purpose. It writes the same
      // columns as the other two and is the better source — TCGplayer market
      // prices in USD, and 97% coverage against TCGdex's 8% — so it should have
      // the final say on any card it can place.
      require('./tcgcsvApi').updateCollectionPrices(true);
    }, 1000 * 60 * 60 * 24);

    // Shortly after startup, catch up if the last sweep was over a day ago.
    // NOT forced: without that gate this re-ran on every restart, which under
    // nodemon meant a full sweep on every code edit — for data that cannot have
    // changed since the last one.
    setTimeout(() => {
      tcgApi.updateCollectionPrices();
      scryfallApi.updateCollectionPrices();
      lorcastApi.updateCollectionPrices();
      require('./tcgdexApi').updateCollectionPrices();
      require('./tcgcsvApi').updateCollectionPrices();
    }, 30000);

    // Periodically purge expired sessions so the table doesn't grow unbounded
    setInterval(() => {
      db.run(`DELETE FROM sessions WHERE expires_at <= DATETIME('now')`).catch(err => {
        console.error('Failed to purge expired sessions:', err);
      });
    }, 1000 * 60 * 60 * 24);

    // Periodic auto-backup (BACKUP_INTERVAL_HOURS, default 24; 0 disables)
    require('./backup').startAutoBackup();
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
  });

// Readiness/liveness probe for orchestrators (Docker HEALTHCHECK, etc.).
// Unauthenticated; pings the DB so a wedged database reads as unhealthy.
// Declared before the /api collection mount so nothing shadows it.
app.get('/api/health', async (req, res) => {
  res.setHeader('X-App-Name', 'Bindarr');
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

// --- AUTHENTICATED API ROUTES ---
app.use('/api', collectionRoutes);
app.use('/api', storageRoutes);
app.use('/api', statsRoutes);
app.use('/api', importExportRoutes);
app.use('/api', notesRoutes);
app.use('/api/sets', setsRoutes);
app.use('/api/decks', decksRoutes);
app.use('/api/settings', settingsRoutes);

// The live overlay runs the SAME corner model the scan does, in the browser, so
// what the user aims with and what the server matches cannot disagree. That
// means the browser has to be able to fetch the model — unauthenticated, because
// the outline runs before login is relevant and the file is public weights.
// Immutable: the filename changes when the model does.
// Only the corner model. Serving the whole directory would also expose the
// 56 MB embedding catalog, which the browser never needs and which nobody
// should be able to pull off an install by guessing a filename.
app.get('/models/cornelius.onnx', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  // MODEL_DIR, not a hardcoded backend/data: the container keeps the models on
  // the persisted volume (CV_MODEL_DIR=/app/database/models). Hardcoded, this
  // 404'd in every Docker install, the worker fell back to the pure-JS contour
  // detector, and detection went from ~80ms to 200ms+ with the CPU pegged.
  res.sendFile(path.join(require('./utils/modelAssets').MODEL_DIR, 'cornelius.onnx'), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
// A year, immutable. Vite content-hashes every asset filename, so a changed file
// is a changed URL and a stale cache cannot happen. Without this the browser
// revalidated the entire bundle on every reload — the megabyte-scale wasm
// included — which on a phone is the difference between an instant open and a
// wait. index.html is served by the catch-all below and stays uncached, so a
// deploy is still picked up immediately.
app.use(express.static(frontendBuildPath, { maxAge: '1y', immutable: true, index: false }));

// Catch-all route to serve Index.html in production
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

// Generic error handler (e.g. rejected CORS origins) — never leak stack traces to clients
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Upload too large. Try exporting/importing in smaller batches.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`Bindarr Server running on port ${PORT}`);
  console.log(`Access local: http://localhost:${PORT}`);
  console.log(`=========================================`);
  // Camera scanning needs a secure context, so a LAN/Docker install serves TLS
  // too when HTTPS_PORT is set. Certificates live beside the database.
  startHttps(app, path.join(path.dirname(db.dbPath), 'ssl'));
});
