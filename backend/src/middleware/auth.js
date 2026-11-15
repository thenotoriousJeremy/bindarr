const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashSessionToken } = require('../utils/authHelpers');

// The marker on a 401 that means "this request carries no usable session". The
// SPA signs out on this and nothing else (frontend/src/utils/sessionExpiry.js), so
// a route answering 401 for some other reason can never log anyone out. Only this
// gate sends it.
const SESSION_EXPIRED = 'session_expired';

async function authenticateToken(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.', code: SESSION_EXPIRED });
  }

  try {
    const columns = `u.username, u.role, u.share_token, u.share_enabled, u.share_locations,
                     u.tcg_api_key, u.psa_api_token, u.graded_price_api_key, u.api_key, u.oidc_sub,
                     u.nav_tabs`;
    // Sessions are stored hashed (authHelpers.hashSessionToken), so it is the
    // hash that is looked up -- the stored value itself is not a credential.
    const tokenHash = hashSessionToken(token);
    let session = await db.get(`
      SELECT s.user_id, ${columns}
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > DATETIME('now')
    `, [tokenHash]);

    // Not a session? It may be an API key — a long-lived credential for scripts
    // and dashboards (issue #33). What makes that safe to hand out is the GET-only
    // rule below: a leaked key exposes the collection, it cannot edit or delete it.
    // Keys are stored as the same SHA-256 a session is (authHelpers.hashApiKey),
    // so the hash already computed above is what names the row.
    let viaApiKey = false;
    if (!session) {
      session = await db.get(`SELECT u.id AS user_id, ${columns} FROM users u WHERE u.api_key = ?`, [tokenHash]);
      if (session) {
        if (req.method !== 'GET') {
          return res.status(403).json({ error: 'API keys are read-only. Use a login session for this request.' });
        }
        viaApiKey = true;
      }
    }

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session token.', code: SESSION_EXPIRED });
    }

    req.user = {
      id: session.user_id,
      username: session.username,
      role: session.role,
      share_token: session.share_token,
      share_enabled: session.share_enabled,
      share_locations: session.share_locations,
      tcg_api_key: session.tcg_api_key || '',
      psa_api_token: session.psa_api_token || '',
      graded_price_api_key: session.graded_price_api_key || '',
      api_key: session.api_key || '',
      oidc_sub: session.oidc_sub || null,
      nav_tabs: session.nav_tabs ?? null,
      via_api_key: viaApiKey
    };
    // Which session this is, for the routes that end it (logout) or keep it while
    // ending the others (a password change). Beside req.user, not in it, because
    // req.user is what GET /me serializes. Null for an API key, which has none.
    req.sessionTokenHash = viaApiKey ? null : tokenHash;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

// Restrict to admin role only. Must run after authenticateToken.
function requireAdmin(req, res, next) {
  // Read-only or not, an API key is not an admin credential: it lives in a config
  // file on some other machine, and the admin surface reads other people's
  // accounts. Admin work needs an actual login.
  if (req.user && req.user.via_api_key) {
    return res.status(403).json({ error: 'API keys cannot access admin endpoints. Use a login session.' });
  }
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
  }
}

// TRUST_PROXY, as Express's `trust proxy` setting: a hop count ("1"), or an
// Express trust string ("loopback", a subnet list).
//
// "true" is the exception. Express reads `true` as "trust every hop", which makes
// req.ip the LEFT-most X-Forwarded-For entry -- a value the client writes itself,
// so rotating it defeated every IP rate limit, login included. Someone writing
// "true" means "there is a proxy in front", so it is taken as one hop, which is
// what the docs always described, and the boot log says so (`warning`).
function trustProxySetting(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: undefined };
  const tp = String(raw).trim();
  if (tp.toLowerCase() === 'true') {
    return {
      value: 1,
      warning: 'TRUST_PROXY=true is read as TRUST_PROXY=1 (one reverse proxy). Trusting every hop would let any client '
        + 'choose its own IP through X-Forwarded-For and walk past the rate limits. Set the hop count to silence this.',
    };
  }
  return { value: Number.isNaN(Number(tp)) ? tp : Number(tp) };
}

// Signed-in limiters count per account rather than per address: a household
// behind one router is several people, and one of them importing should not
// spend everyone else's budget. A request without an account (none of the routes
// these are mounted on take one) falls back to its address.
function perUserKey(req) {
  if (req.user && req.user.id != null) return `user:${req.user.id}`;
  return rateLimit.ipKeyGenerator(req.ip || '');
}

// Throttle auth endpoints to slow down credential-stuffing/brute-force attempts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});

// Password sign-in: the same ceiling, spent only by FAILED attempts. Guessing
// still gets 20 tries a window, and a household sharing one address no longer
// locks itself out by signing in.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});

// Changing a password checks the current one, which is a password guess like any
// sign-in, made with a session someone may have stolen. Per account, and only a
// wrong current password counts (the route marks it in res.locals): a typo in the
// new one, or a save that changes no password, costs nothing.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: perUserKey,
  skip: (req) => !req.body || req.body.password === undefined,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => !(res.locals && res.locals.wrongPassword),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password attempts. Please try again later.' }
});

// The card search proxies to the external Pokémon TCG API. Bulk scanning fires
// one search per card, so the ceiling is generous — it exists to stop a logged-
// in client from hammering the upstream API, not to throttle normal use.
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  keyGenerator: perUserKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches. Please slow down and try again shortly.' }
});

// Import is heavy (up to 5000 rows, many serial writes each) and rare in normal
// use, so it gets a tight ceiling. A backup restore shares it, and is counted
// before its body is read (server.js).
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: perUserKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many imports. Please wait before importing again.' }
});

// Public share links (routes/shared.js). No account, so per address. Each view
// builds a whole collection and its stats; this is far above what reading one
// takes and well below what scraping one in a loop would.
const shareLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  // Binder artwork images are a row lookup and a file each, and a shared binder
  // can show dozens of them on one page.
  skip: (req) => /\/art\/[^/]+$/.test(req.path),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' }
});

module.exports = {
  authenticateToken, requireAdmin, authLimiter, loginLimiter, passwordLimiter, searchLimiter, importLimiter,
  shareLimiter, trustProxySetting
};
