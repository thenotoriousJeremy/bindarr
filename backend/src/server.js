require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const db = require('./db');
const tcgApi = require('./tcgApi');
const scryfallApi = require('./scryfallApi');

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

const app = express();
const PORT = process.env.PORT || 3001;

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

// Content Security Policy. Card identification is server-side (the client just
// POSTs a photo to /api/scan-match), so the browser needs nothing beyond the
// app's own bundle plus the card-image hosts. Kept Report-Only for now: flip
// `reportOnly` to false to enforce once a production smoke test confirms the
// scan flow and card images load cleanly under these directives.
// ponytail: Report-Only ceiling — enforce after a prod verification pass.
app.use(helmet({
  contentSecurityPolicy: {
    reportOnly: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://images.pokemontcg.io', 'https://cards.scryfall.io', 'https://c1.scryfall.com', 'https://img.scryfall.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
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
// Default 100kb body limit is too small for the collection import/export
// feature: a JSON backup wraps the export payload in a string field, which
// added escaping overhead pushed a ~90-card collection past the default
// limit already. 15mb comfortably covers even large (multi-thousand card)
// collections.
app.use(express.json({ limit: '15mb' }));

// Initialize Database on startup
db.initDb()
  .then(async () => {
    console.log('Database tables verified/created successfully.');
    // Sync sets on startup (both games)
    await tcgApi.fetchAndCacheSets();
    await scryfallApi.fetchAndCacheSets();

    // Load sets into compartmentSort memory cache
    const { loadSetsCache } = require('./utils/compartmentSort');
    await loadSetsCache(db);
    
    // Weekly: refresh sets (picks up newly released ones), reload the in-memory
    // sets cache so chronological sorting stays current without a restart, then
    // update prices.
    setInterval(async () => {
      try {
        await tcgApi.fetchAndCacheSets(true);
        await scryfallApi.fetchAndCacheSets(true);
        await loadSetsCache(db);
      } catch (err) {
        console.error('Weekly sets refresh failed:', err);
      }
      tcgApi.updateCollectionPrices();
      scryfallApi.updateCollectionPrices();
    }, 1000 * 60 * 60 * 24 * 7);

    // Run a price update in the background shortly after startup (after 30 seconds to not bog down init)
    setTimeout(() => {
      tcgApi.updateCollectionPrices();
      scryfallApi.updateCollectionPrices();
    }, 30000);

    // Periodically purge expired sessions so the table doesn't grow unbounded
    setInterval(() => {
      db.run(`DELETE FROM sessions WHERE expires_at <= DATETIME('now')`).catch(err => {
        console.error('Failed to purge expired sessions:', err);
      });
    }, 1000 * 60 * 60 * 24);
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

// --- API ROUTES ---
app.use('/api/auth', authRoutes);
app.use('/api/shared', sharedRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', collectionRoutes);
app.use('/api', storageRoutes);
app.use('/api', statsRoutes);
app.use('/api', importExportRoutes);
app.use('/api/sets', setsRoutes);
app.use('/api/decks', decksRoutes);
app.use('/api/settings', settingsRoutes);

// Serve production static assets from Frontend
const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendBuildPath));

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
});
