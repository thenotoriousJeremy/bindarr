const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-oidc-test-${process.pid}.db`);
const projectRoot = path.join(__dirname, '../../../');

async function waitForServer(url) {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server at ${url} did not start in time`);
}

async function runTests() {
  // 1. Start mock OIDC IdP
  let mockUserClaims = {
    sub: 'idp-sub-777',
    preferred_username: 'PalletTownTrainer',
    email: 'trainer@pallet.org'
  };

  const idpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: `http://${req.headers.host}`,
        authorization_endpoint: `http://${req.headers.host}/authorize`,
        token_endpoint: `http://${req.headers.host}/token`,
        userinfo_endpoint: `http://${req.headers.host}/userinfo`
      }));
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const payloadB64 = Buffer.from(JSON.stringify(mockUserClaims)).toString('base64url');
        const idToken = `eyJhbGciOiJub25lIn0.${payloadB64}.sig`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          id_token: idToken,
          expires_in: 3600
        }));
      });
      return;
    }

    if (url.pathname === '/userinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockUserClaims));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => idpServer.listen(0, '127.0.0.1', resolve));
  const idpPort = idpServer.address().port;
  const idpIssuer = `http://127.0.0.1:${idpPort}`;

  // 2. Start Bindarr backend server with OIDC configuration
  const bindarrPort = '3019';
  const base = `http://localhost:${bindarrPort}`;

  const server = spawn('node', [path.join(projectRoot, 'backend/src/server.js')], {
    env: {
      ...process.env,
      DEFAULT_ADMIN_PASSWORD: '',
      PORT: bindarrPort,
      DB_PATH: tmpDb,
      HTTPS_PORT: '',
      OIDC_ENABLED: 'true',
      OIDC_PROVIDER_NAME: 'TestIdP',
      OIDC_ISSUER_URL: idpIssuer,
      OIDC_CLIENT_ID: 'bindarr-test-id',
      OIDC_CLIENT_SECRET: 'bindarr-test-secret',
      OIDC_AUTO_PROVISION: 'true'
    }
  });

  try {
    await waitForServer(`${base}/api/health`);

    // F7-TC1: Public config exposes OIDC status and provider name
    const configRes = await fetch(`${base}/api/auth/config`);
    assert.strictEqual(configRes.status, 200);
    const config = await configRes.json();
    assert.strictEqual(config.oidcEnabled, true, 'oidcEnabled must be true');
    assert.strictEqual(config.oidcProviderName, 'TestIdP', 'provider name must match');
    console.log('PASS: F7-TC1');

    // F7-TC2: GET /api/auth/oidc/login returns 302 redirect to IdP
    const loginRes = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    assert.strictEqual(loginRes.status, 302, 'login route must redirect to IdP');
    const redirectLocation = loginRes.headers.get('location');
    assert(redirectLocation, 'Location header must exist');

    const authUrl = new URL(redirectLocation);
    assert.strictEqual(authUrl.pathname, '/authorize');
    assert.strictEqual(authUrl.searchParams.get('client_id'), 'bindarr-test-id');
    const state = authUrl.searchParams.get('state');
    assert(state, 'state parameter must be present');
    console.log('PASS: F7-TC2');

    // F7-TC3: GET /api/auth/oidc/callback handles code exchange and returns token
    const callbackRes = await fetch(`${base}/api/auth/oidc/callback?code=valid-auth-code&state=${encodeURIComponent(state)}`, {
      redirect: 'manual'
    });
    assert.strictEqual(callbackRes.status, 302, 'callback must redirect to frontend');
    const callbackRedirect = callbackRes.headers.get('location');
    assert(callbackRedirect.includes('oidc_token='), 'redirect must include oidc_token');

    const callbackUrl = new URL(callbackRedirect, base);
    const issuedToken = callbackUrl.searchParams.get('oidc_token');
    assert(issuedToken, 'issued token must be non-empty');
    console.log('PASS: F7-TC3');

    // F7-TC4: First OIDC user on fresh instance is bootstrapped as instance owner admin
    const meRes = await fetch(`${base}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${issuedToken}` }
    });
    assert.strictEqual(meRes.status, 200, '/me with OIDC session must succeed');
    const meData = await meRes.json();
    assert.strictEqual(meData.user.username, 'admin', 'first user must be bootstrapped as admin');
    assert.strictEqual(meData.user.role, 'admin', 'first user must have admin role');
    assert.strictEqual(meData.user.oidc_sub, 'idp-sub-777');
    console.log('PASS: F7-TC4');

    // F7-TC5: Second OIDC user is auto-provisioned as a member account
    mockUserClaims = {
      sub: 'idp-sub-888',
      preferred_username: 'PalletTownTrainer',
      email: 'trainer@pallet.org'
    };
    const loginRes2 = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    const state2 = new URL(loginRes2.headers.get('location')).searchParams.get('state');
    const callbackRes2 = await fetch(`${base}/api/auth/oidc/callback?code=valid-auth-code-2&state=${encodeURIComponent(state2)}`, {
      redirect: 'manual'
    });
    const token2 = new URL(callbackRes2.headers.get('location'), base).searchParams.get('oidc_token');
    const meRes2 = await fetch(`${base}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token2}` }
    });
    const meData2 = await meRes2.json();
    assert.strictEqual(meData2.user.username, 'pallettowntrainer');
    assert.strictEqual(meData2.user.role, 'member');
    assert.strictEqual(meData2.user.oidc_sub, 'idp-sub-888');
    assert.notStrictEqual(meData2.user.id, meData.user.id, 'must be separate user account');
    console.log('PASS: F7-TC5');

    // F7-TC6: Repeated login with same sub logs into existing member without duplicating rows
    const loginRes3 = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    const state3 = new URL(loginRes3.headers.get('location')).searchParams.get('state');
    const callbackRes3 = await fetch(`${base}/api/auth/oidc/callback?code=valid-auth-code-3&state=${encodeURIComponent(state3)}`, {
      redirect: 'manual'
    });
    const token3 = new URL(callbackRes3.headers.get('location'), base).searchParams.get('oidc_token');
    const meRes3 = await fetch(`${base}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token3}` }
    });
    const meData3 = await meRes3.json();
    assert.strictEqual(meData3.user.id, meData2.user.id, 'must log into same user account');
    console.log('PASS: F7-TC6');

    // F7-TC7: Callback with tampered/invalid state rejects gracefully
    const badStateRes = await fetch(`${base}/api/auth/oidc/callback?code=abc&state=bad.state`, {
      redirect: 'manual'
    });
    assert.strictEqual(badStateRes.status, 302);
    const badRedirect = badStateRes.headers.get('location');
    assert(badRedirect.includes('oidc_error='), 'invalid state must redirect with oidc_error');
    console.log('PASS: F7-TC7');

  } finally {
    server.kill('SIGKILL');
    if (typeof idpServer.closeAllConnections === 'function') {
      idpServer.closeAllConnections();
    }
    await new Promise(resolve => idpServer.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ }
    }
  }
}

runTests()
  .then(() => setTimeout(() => process.exit(0), 500))
  .catch(err => {
    console.error('FAIL: oidc.test.js -', err.message);
    setTimeout(() => process.exit(1), 500);
  });
