// Unit tests for OIDC / SSO utility functions.
// Run via `npm test`.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const oidc = require('../src/utils/oidc');

function testPkce() {
  const pkce1 = oidc.generatePkce();
  assert(pkce1.codeVerifier && typeof pkce1.codeVerifier === 'string', 'verifier must be string');
  assert(pkce1.codeChallenge && typeof pkce1.codeChallenge === 'string', 'challenge must be string');
  assert.strictEqual(pkce1.codeVerifier.length, 43, '32 bytes base64url is 43 chars');

  // Verify S256 challenge derivation
  const expectedChallenge = crypto.createHash('sha256').update(pkce1.codeVerifier).digest('base64url');
  assert.strictEqual(pkce1.codeChallenge, expectedChallenge, 'challenge must match SHA256 of verifier');

  const pkce2 = oidc.generatePkce();
  assert.notStrictEqual(pkce1.codeVerifier, pkce2.codeVerifier, 'subsequent PKCEs must be random');
  console.log('PASS: PKCE generation and S256 verification');
}

function testStateTokens() {
  const testData = { cv: 'verifier-123', n: 'nonce-456', ru: 'http://localhost/callback' };
  const token = oidc.createStateToken(testData);
  assert(token && token.includes('.'), 'token must have signature part');

  const verified = oidc.verifyStateToken(token);
  assert(verified, 'valid state token must verify');
  assert.strictEqual(verified.cv, testData.cv);
  assert.strictEqual(verified.n, testData.n);
  assert.strictEqual(verified.ru, testData.ru);

  // Tampered payload
  const [b64, sig] = token.split('.');
  const tamperedB64 = Buffer.from(JSON.stringify({ ...testData, cv: 'evil' })).toString('base64url');
  assert.strictEqual(oidc.verifyStateToken(`${tamperedB64}.${sig}`), null, 'tampered payload must fail verification');

  // Tampered signature
  assert.strictEqual(oidc.verifyStateToken(`${b64}.badsignature`), null, 'tampered signature must fail verification');

  // Malformed input
  assert.strictEqual(oidc.verifyStateToken(''), null, 'empty token must return null');
  assert.strictEqual(oidc.verifyStateToken('not.valid.token'), null, '3-part token must return null');
  assert.strictEqual(oidc.verifyStateToken(null), null, 'null token must return null');

  console.log('PASS: State token signing, verification, and tamper rejection');
}

function testExtractUserIdentity() {
  // 1. Standard preferred_username
  const id1 = oidc.extractUserIdentity({ sub: 'sub-101', preferred_username: 'AshKetchum' });
  assert.strictEqual(id1.sub, 'sub-101');
  assert.strictEqual(id1.username, 'ashketchum');

  // 2. Email fallback
  const id2 = oidc.extractUserIdentity({ sub: 'sub-102', email: 'Misty.Waterflower@cerulean.gym' });
  assert.strictEqual(id2.sub, 'sub-102');
  assert.strictEqual(id2.username, 'misty-waterflower');

  // 3. Username with special characters sanitized
  const id3 = oidc.extractUserIdentity({ sub: 'sub-103', name: 'Brock #1 Rock-Trainer!' });
  assert.strictEqual(id3.sub, 'sub-103');
  assert.strictEqual(id3.username, 'brock-1-rock-trainer');

  // 4. Short username padded
  const id4 = oidc.extractUserIdentity({ sub: 'sub-104', preferred_username: 'a' });
  assert(id4.username.startsWith('user-a-') || id4.username.length >= 3, 'short username must be padded to valid length');

  // 5. Missing sub throws
  assert.throws(() => oidc.extractUserIdentity({ preferred_username: 'foo' }), /missing the required "sub"/);

  console.log('PASS: User claim extraction, normalization, and sanitization');
}

async function testMockOidcFlow() {
  // Start temporary mock OIDC server
  let authCodeReceived = null;
  let codeVerifierReceived = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: `http://${req.headers.host}`,
        authorization_endpoint: `http://${req.headers.host}/auth`,
        token_endpoint: `http://${req.headers.host}/token`,
        userinfo_endpoint: `http://${req.headers.host}/userinfo`
      }));
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        authCodeReceived = params.get('code');
        codeVerifierReceived = params.get('code_verifier');

        const mockIdTokenPayload = {
          sub: 'auth-user-999',
          preferred_username: 'RedChampion',
          email: 'red@kanto.org'
        };
        const mockIdToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(mockIdTokenPayload)).toString('base64url')}.sig`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'mock-access-token-123',
          token_type: 'Bearer',
          id_token: mockIdToken,
          expires_in: 3600
        }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockIssuer = `http://127.0.0.1:${port}`;

  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ISSUER_URL = mockIssuer;
  process.env.OIDC_CLIENT_ID = 'bindarr-test-client';
  process.env.OIDC_CLIENT_SECRET = 'secret123';
  oidc._resetDiscoveryCache();

  try {
    // 1. Test buildAuthorizationUrl
    const authUrl = await oidc.buildAuthorizationUrl();
    const parsedAuth = new URL(authUrl);
    assert.strictEqual(parsedAuth.pathname, '/auth');
    assert.strictEqual(parsedAuth.searchParams.get('client_id'), 'bindarr-test-client');
    assert.strictEqual(parsedAuth.searchParams.get('response_type'), 'code');
    assert.strictEqual(parsedAuth.searchParams.get('code_challenge_method'), 'S256');

    const stateToken = parsedAuth.searchParams.get('state');
    assert(stateToken, 'state param must be set');

    // 2. Test exchangeCode
    const exchangeResult = await oidc.exchangeCode({
      code: 'test-auth-code-xyz',
      stateToken,
      req: null
    });

    assert.strictEqual(authCodeReceived, 'test-auth-code-xyz', 'token endpoint must receive authorization code');
    assert(codeVerifierReceived, 'token endpoint must receive PKCE code_verifier');
    assert.strictEqual(exchangeResult.extracted.sub, 'auth-user-999');
    assert.strictEqual(exchangeResult.extracted.username, 'redchampion');

    console.log('PASS: Mock OIDC authorization URL and code exchange');
  } finally {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  testPkce();
  testStateTokens();
  testExtractUserIdentity();
  await testMockOidcFlow();
  console.log('PASS: oidc.test.js');
}

main().catch(err => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
