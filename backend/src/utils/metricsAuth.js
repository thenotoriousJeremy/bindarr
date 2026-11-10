// Optional bearer token for the Prometheus listener. Required only by server.js,
// never on a path device mode bundles, so Node's crypto is safe here.
const crypto = require('crypto');

const digest = value => crypto.createHash('sha256').update(String(value)).digest();

// True when no token is configured, or when the Authorization header carries
// exactly "Bearer <token>". Hashing both sides first gives timingSafeEqual the
// equal-length inputs it needs without leaking the token's length.
function metricsRequestAuthorized(authorizationHeader, token) {
  if (!token) return true;
  const match = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader || '').trim());
  if (!match) return false;
  return crypto.timingSafeEqual(digest(match[1]), digest(token));
}

module.exports = { metricsRequestAuthorized };
