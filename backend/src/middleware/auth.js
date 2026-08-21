const rateLimit = require('express-rate-limit');
const db = require('../db');

async function authenticateToken(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const columns = `u.username, u.role, u.share_token, u.share_enabled, u.share_locations,
                     u.tcg_api_key, u.psa_api_token, u.graded_price_api_key, u.api_key, u.oidc_sub`;
    let session = await db.get(`
      SELECT s.user_id, ${columns}
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > DATETIME('now')
    `, [token]);

    // Not a session? It may be an API key — a long-lived credential for scripts
    // and dashboards (issue #33). What makes that safe to hand out is the GET-only
    // rule below: a leaked key exposes the collection, it cannot edit or delete it.
    let viaApiKey = false;
    if (!session) {
      session = await db.get(`SELECT u.id AS user_id, ${columns} FROM users u WHERE u.api_key = ?`, [token]);
      if (session) {
        if (req.method !== 'GET') {
          return res.status(403).json({ error: 'API keys are read-only. Use a login session for this request.' });
        }
        viaApiKey = true;
      }
    }

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session token.' });
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
      via_api_key: viaApiKey
    };
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

// Throttle auth endpoints to slow down credential-stuffing/brute-force attempts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});

// The card search proxies to the external Pokémon TCG API. Bulk scanning fires
// one search per card, so the ceiling is generous — it exists to stop a logged-
// in client from hammering the upstream API, not to throttle normal use.
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches. Please slow down and try again shortly.' }
});

// Import is heavy (up to 5000 rows, many serial writes each) and rare in normal
// use, so it gets a tight ceiling.
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many imports. Please wait before importing again.' }
});

module.exports = { authenticateToken, requireAdmin, authLimiter, searchLimiter, importLimiter };
