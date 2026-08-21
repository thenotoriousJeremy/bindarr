const crypto = require('crypto');

// Secret for HMAC state token signing — stable per process lifetime if not explicitly set
const STATE_SECRET = process.env.OIDC_SESSION_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let discoveryCache = null;
let discoveryExpiresAt = 0;

function isOidcEnabled() {
  return process.env.OIDC_ENABLED === 'true' || process.env.OIDC_ENABLED === '1';
}

function getProviderName() {
  return (process.env.OIDC_PROVIDER_NAME || 'Single Sign-On').trim();
}

function isAutoProvisionEnabled() {
  if (process.env.OIDC_AUTO_PROVISION === 'false' || process.env.OIDC_AUTO_PROVISION === '0') {
    return false;
  }
  return true;
}

function getDefaultRole() {
  return process.env.OIDC_DEFAULT_ROLE === 'admin' ? 'admin' : 'member';
}

function getUserClaimName() {
  return (process.env.OIDC_USER_CLAIM || 'preferred_username').trim();
}

function getScopes() {
  return (process.env.OIDC_SCOPES || 'openid profile email').trim();
}

function getClientId() {
  return (process.env.OIDC_CLIENT_ID || '').trim();
}

function getClientSecret() {
  return (process.env.OIDC_CLIENT_SECRET || '').trim();
}

function getIssuerUrl() {
  return (process.env.OIDC_ISSUER_URL || '').trim().replace(/\/+$/, '');
}

function resolveRedirectUri(req) {
  if (process.env.OIDC_REDIRECT_URI) {
    return process.env.OIDC_REDIRECT_URI.trim();
  }
  if (process.env.PUBLIC_BASE_URL) {
    const base = process.env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '');
    return `${base}/api/auth/oidc/callback`;
  }
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}/api/auth/oidc/callback`;
  }
  return 'http://localhost:3001/api/auth/oidc/callback';
}

function getTokenEndpointAuthMethod() {
  const method = (
    process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD || 'client_secret_basic'
  ).trim();

  const supported = [
    'client_secret_basic',
    'client_secret_post',
    'none'
  ];

  if (!supported.includes(method)) {
    throw new Error(
      `Unsupported OIDC_TOKEN_ENDPOINT_AUTH_METHOD: ${method}. ` +
      `Supported values: ${supported.join(', ')}`
    );
  }

  return method;
}

/**
 * Fetch and cache OpenID Connect Discovery document (.well-known/openid-configuration).
 */
async function getDiscovery(forceRefresh = false) {
  const issuer = getIssuerUrl();
  if (!issuer) {
    throw new Error('OIDC_ISSUER_URL is not configured');
  }

  const now = Date.now();
  if (!forceRefresh && discoveryCache && discoveryExpiresAt > now) {
    return discoveryCache;
  }

  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery from ${discoveryUrl} (HTTP ${res.status})`);
  }

  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error(`Invalid OIDC discovery response from ${discoveryUrl}: missing endpoints`);
  }

  discoveryCache = doc;
  discoveryExpiresAt = now + 60 * 60 * 1000; // Cache discovery for 1 hour
  return discoveryCache;
}

/**
 * Generate PKCE code_verifier and code_challenge (RFC 7636, S256).
 */
function generatePkce() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Create a signed, tamper-proof state token for CSRF protection and PKCE storage.
 */
function createStateToken(data = {}) {
  const payload = {
    ...data,
    t: Date.now(),
    r: crypto.randomBytes(8).toString('hex')
  };
  const jsonStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(jsonStr, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Verify and decode state token.
 */
function verifyStateToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', STATE_SECRET).update(payloadB64).digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadStr);
    if (!payload.t || Date.now() - payload.t > STATE_TTL_MS) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Build the full IdP authorization URL.
 */
async function buildAuthorizationUrl(req) {
  const discovery = await getDiscovery();
  const clientId = getClientId();
  if (!clientId) {
    throw new Error('OIDC_CLIENT_ID is not configured');
  }

  const { codeVerifier, codeChallenge } = generatePkce();
  const nonce = crypto.randomBytes(16).toString('hex');
  const redirectUri = resolveRedirectUri(req);

  const stateToken = createStateToken({
    cv: codeVerifier,
    n: nonce,
    ru: redirectUri
  });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', getScopes());
  url.searchParams.set('state', stateToken);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return url.toString();
}

/**
 * Decode JWT payload without verification (verification done by TLS + token_endpoint exchange).
 */
function parseJwtPayload(token) {
  if (!token || typeof token !== 'string') return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Exchange authorization code at token_endpoint and fetch user claims.
 */
async function exchangeCode({ code, stateToken, req }) {
  const stateData = verifyStateToken(stateToken);
  if (!stateData) {
    throw new Error('Invalid or expired OIDC state token. Please try logging in again.');
  }

  const discovery = await getDiscovery();
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const authMethod = getTokenEndpointAuthMethod();
  const redirectUri = stateData.ru || resolveRedirectUri(req);

  if (!clientId) {
    throw new Error('OIDC_CLIENT_ID is not configured');
  }

  if (
    ['client_secret_basic', 'client_secret_post'].includes(authMethod) &&
    !clientSecret
  ) {
    throw new Error(
      `OIDC_CLIENT_SECRET is required when using ${authMethod}`
    );
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: stateData.cv
  });

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json'
  };

  switch (authMethod) {
    case 'client_secret_basic':
      headers.Authorization =
        `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      break;

    case 'client_secret_post':
      params.set('client_id', clientId);
      params.set('client_secret', clientSecret);
      break;

    case 'none':
      params.set('client_id', clientId);
      break;
  }

  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
    signal: AbortSignal.timeout(15000)
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text().catch(() => '');
    throw new Error(`OIDC token exchange failed (HTTP ${tokenRes.status}): ${errorBody}`);
  }

  const tokens = await tokenRes.json();
  const idTokenClaims = tokens.id_token ? parseJwtPayload(tokens.id_token) : {};

  // Fetch from userinfo endpoint if available to ensure all profile claims are present
  let userInfoClaims = {};
  if (discovery.userinfo_endpoint && tokens.access_token) {
    try {
      const userinfoRes = await fetch(discovery.userinfo_endpoint, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (userinfoRes.ok) {
        userInfoClaims = await userinfoRes.json();
      }
    } catch (err) {
      console.warn('OIDC userinfo fetch failed, falling back to ID token claims:', err.message);
    }
  }

  const mergedClaims = { ...idTokenClaims, ...userInfoClaims };
  return {
    tokens,
    claims: mergedClaims,
    extracted: extractUserIdentity(mergedClaims)
  };
}

/**
 * Extract clean username and sub claim from claims object.
 */
function extractUserIdentity(claims) {
  const sub = claims.sub ? String(claims.sub).trim() : null;
  if (!sub) {
    throw new Error('OIDC response is missing the required "sub" claim.');
  }

  const configuredClaim = getUserClaimName();
  let rawUsername = claims[configuredClaim]
    || claims.preferred_username
    || claims.nickname
    || claims.name
    || (claims.email ? String(claims.email).split('@')[0] : null)
    || sub;

  rawUsername = String(rawUsername).trim().toLowerCase();
  // Sanitize username to alphanumeric, underscore, hyphen
  let cleanUsername = rawUsername.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (cleanUsername.length < 3) {
    cleanUsername = `user-${cleanUsername || 'oidc'}-${crypto.randomBytes(3).toString('hex')}`;
  }
  if (cleanUsername.length > 32) {
    cleanUsername = cleanUsername.slice(0, 32);
  }

  return {
    sub,
    username: cleanUsername,
    email: claims.email || null,
    displayName: claims.name || claims.preferred_username || cleanUsername
  };
}

module.exports = {
  isOidcEnabled,
  getProviderName,
  isAutoProvisionEnabled,
  getDefaultRole,
  getUserClaimName,
  getTokenEndpointAuthMethod,
  getDiscovery,
  generatePkce,
  createStateToken,
  verifyStateToken,
  buildAuthorizationUrl,
  exchangeCode,
  extractUserIdentity,
  resolveRedirectUri,
  _resetDiscoveryCache: () => { discoveryCache = null; discoveryExpiresAt = 0; }
};
