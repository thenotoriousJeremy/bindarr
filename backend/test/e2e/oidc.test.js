// Set here as well as in run.js: a suite run on its own boots a server on a fresh
// database, which would otherwise run a full TCGCSV sync (~800 requests) at boot.
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-oidc-test-${process.pid}.db`);
const linkDb = path.join(os.tmpdir(), `bindarr-oidc-link-${process.pid}.db`);
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

// The web sign-in as a browser performs it. /oidc/login sets the binding cookie;
// the IdP sends the browser back to the callback, cookie and all; the callback
// lands on /?oidc_code=... and the page redeems that one-time code by POST, with
// the same cookie, for the session. (It used to land on /?oidc_token=<session>.)
// `onLogin` sees the authorization URL, so a suite can echo its nonce.
function webFlow(base, onLogin) {
  const startLogin = async () => {
    const res = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    const authUrl = new URL(res.headers.get('location'));
    onLogin(authUrl);
    const setCookie = res.headers.get('set-cookie') || '';
    return { res, authUrl, state: authUrl.searchParams.get('state'), setCookie, cookie: setCookie.split(';')[0] };
  };
  const finishLogin = async (login, idpCode, cookie = login.cookie) => {
    const res = await fetch(`${base}/api/auth/oidc/callback?code=${idpCode}&state=${encodeURIComponent(login.state)}`, {
      redirect: 'manual',
      headers: cookie ? { Cookie: cookie } : {}
    });
    assert.strictEqual(res.status, 302, 'callback must redirect to frontend');
    const location = res.headers.get('location');
    return { location, params: new URL(location, base).searchParams };
  };
  const redeem = async (oidcCode, cookie) => {
    const res = await fetch(`${base}/api/auth/oidc/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ code: oidcCode })
    });
    return { status: res.status, body: await res.json() };
  };
  // Start to finish; token is null when the callback refused.
  const signIn = async (idpCode) => {
    const login = await startLogin();
    const { params } = await finishLogin(login, idpCode);
    if (!params.get('oidc_code')) return { params, token: null };
    const { body } = await redeem(params.get('oidc_code'), login.cookie);
    return { params, token: body.token || null };
  };
  return { startLogin, finishLogin, redeem, signIn };
}

async function runTests() {
  // 1. Start mock OIDC IdP
  let mockUserClaims = {
    sub: 'idp-sub-777',
    preferred_username: 'PalletTownTrainer',
    email: 'trainer@pallet.org'
  };
  // Echoed into the ID token, as a real IdP does with the nonce it was sent.
  let currentNonce = null;

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
        const payloadB64 = Buffer.from(JSON.stringify({
          iss: `http://${req.headers.host}`,
          aud: 'bindarr-test-id',
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: currentNonce,
          ...mockUserClaims
        })).toString('base64url');
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

  const { startLogin, finishLogin, redeem, signIn } = webFlow(base, (authUrl) => {
    currentNonce = authUrl.searchParams.get('nonce');
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

    // F7-TC2: GET /api/auth/oidc/login returns 302 redirect to IdP, and ties the
    // login to this browser with an HttpOnly cookie
    const login = await startLogin();
    assert.strictEqual(login.res.status, 302, 'login route must redirect to IdP');
    assert.strictEqual(login.authUrl.pathname, '/authorize');
    assert.strictEqual(login.authUrl.searchParams.get('client_id'), 'bindarr-test-id');
    assert(currentNonce, 'the authorization request must carry a nonce');
    assert(login.state, 'state parameter must be present');
    assert(/^bindarr_oidc=/.test(login.setCookie) && /HttpOnly/i.test(login.setCookie),
      'a web login must set the HttpOnly binding cookie');
    console.log('PASS: F7-TC2');

    // F7-TC3: the callback hands the page a one-time code -- never the session
    // token -- and only in the browser that started the login; the page trades the
    // code for the session, once.
    const elsewhere = await finishLogin(login, 'valid-auth-code', null);
    assert(elsewhere.params.get('oidc_error') && !elsewhere.params.get('oidc_code'),
      'a callback opened in a browser that did not start the login must be refused');
    const callback = await finishLogin(login, 'valid-auth-code');
    assert(!/oidc_token|[?&]token=/.test(callback.location), 'the session token must never be in the redirect');
    const oidcCode = callback.params.get('oidc_code');
    assert(oidcCode, `redirect must carry a one-time code, got ${callback.location}`);
    const redeemed = await redeem(oidcCode, login.cookie);
    assert.strictEqual(redeemed.status, 200, 'the code redeems with the cookie that started the login');
    const issuedToken = redeemed.body.token;
    assert(issuedToken, 'issued token must be non-empty');
    assert.strictEqual((await redeem(oidcCode, login.cookie)).status, 400, 'a code must not redeem twice');
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
    const { token: token2 } = await signIn('valid-auth-code-2');
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
    const { token: token3 } = await signIn('valid-auth-code-3');
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

    // F7-TC8: a NEW identity claiming an EXISTING account's username is refused.
    //
    // This is the account-takeover path. The owner account is always called
    // "admin", extractUserIdentity lower-cases whatever the IdP sends, and on any
    // IdP where a person can pick their own preferred_username, picking "admin"
    // used to bind their identity to the owner account and log them in as it --
    // no password anywhere in the flow. OIDC_ALLOW_USERNAME_LINK is unset here,
    // which is the default, so it must be refused and the owner left alone.
    mockUserClaims = {
      sub: 'idp-sub-attacker',
      preferred_username: 'admin',
      email: 'attacker@example.invalid'
    };
    const takeover = await signIn('valid-auth-code-4');
    assert.strictEqual(takeover.params.get('oidc_code'), null,
      'a username collision must not issue a session for the existing account');
    assert(takeover.params.get('oidc_error'),
      'a username collision must come back as an error');

    // And the owner is untouched: its oidc_sub is still the identity that
    // bootstrapped it, so the original owner can still sign in.
    mockUserClaims = {
      sub: 'idp-sub-777',
      preferred_username: 'admin',
      email: 'owner@pallet.org'
    };
    const { token: ownerToken } = await signIn('valid-auth-code-5');
    assert(ownerToken, 'the identity that bootstrapped the owner must still log in');
    const ownerMe = await (await fetch(`${base}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${ownerToken}` }
    })).json();
    assert.strictEqual(ownerMe.user.id, meData.user.id, 'must still be the same owner account');
    assert.strictEqual(ownerMe.user.oidc_sub, 'idp-sub-777', 'the attacker must not have re-bound the owner');
    console.log('PASS: F7-TC8');

    // F7-TC11: an ID token minted for a DIFFERENT login is refused.
    //
    // buildAuthorizationUrl has always generated a nonce, sent it to the IdP and
    // sealed it into the signed state token. Nothing ever compared it to the
    // claim that came back, so a token captured from an earlier exchange was as
    // good as a fresh one. This drives the real route rather than the validator
    // directly, because the bug was never in the checking -- it was that no one
    // called it.
    mockUserClaims = {
      sub: 'idp-sub-777',
      preferred_username: 'admin',
      email: 'owner@pallet.org'
    };
    const login6 = await startLogin();
    // The IdP answers with the nonce from some other login, not this one.
    currentNonce = 'a-nonce-from-a-different-login';
    const { params: replay } = await finishLogin(login6, 'valid-auth-code-6');
    assert.strictEqual(replay.get('oidc_code'), null, 'a mismatched nonce must not issue a session');
    assert(/nonce/i.test(replay.get('oidc_error') || ''), 'the refusal must name the nonce');
    console.log('PASS: F7-TC11');

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

// The other half of OIDC_ALLOW_USERNAME_LINK: with it ON, linking has to actually
// work, because that is the only way an install that predates SSO gets its
// existing accounts -- and their collections -- onto it. Its own server and its
// own database, because it needs a local 'admin' account created the ordinary way
// (password and all) rather than one bootstrapped by OIDC.
async function runUsernameLinkTests() {
  let mockUserClaims = {
    sub: 'idp-sub-link',
    preferred_username: 'admin',
    email: 'owner@pallet.org'
  };
  let currentNonce = null;

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
      req.on('data', () => {});
      req.on('end', () => {
        const payloadB64 = Buffer.from(JSON.stringify({
          iss: `http://${req.headers.host}`,
          aud: 'bindarr-test-id',
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: currentNonce,
          ...mockUserClaims
        })).toString('base64url');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          id_token: `eyJhbGciOiJub25lIn0.${payloadB64}.sig`,
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
  const idpIssuer = `http://127.0.0.1:${idpServer.address().port}`;

  const port = '3020';
  const base = `http://localhost:${port}`;
  const server = spawn('node', [path.join(projectRoot, 'backend/src/server.js')], {
    env: {
      ...process.env,
      // A pre-existing local account, exactly like an install upgrading into SSO.
      DEFAULT_ADMIN_PASSWORD: 'test-admin-password',
      PORT: port,
      DB_PATH: linkDb,
      HTTPS_PORT: '',
      OIDC_ENABLED: 'true',
      OIDC_PROVIDER_NAME: 'TestIdP',
      OIDC_ISSUER_URL: idpIssuer,
      OIDC_CLIENT_ID: 'bindarr-test-id',
      OIDC_CLIENT_SECRET: 'bindarr-test-secret',
      OIDC_AUTO_PROVISION: 'true',
      OIDC_ALLOW_USERNAME_LINK: 'true'
    }
  });

  const { signIn } = webFlow(base, (authUrl) => {
    currentNonce = authUrl.searchParams.get('nonce');
  });

  try {
    await waitForServer(`${base}/api/health`);

    // F7-TC9: with the flag on, the IdP identity attaches to the existing local
    // account rather than creating a second, empty one beside it.
    const { token: linkToken } = await signIn('link-code-1');
    assert(linkToken, 'OIDC_ALLOW_USERNAME_LINK=true must let the identity link and log in');
    const linkedMe = await (await fetch(`${base}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${linkToken}` }
    })).json();
    assert.strictEqual(linkedMe.user.username, 'admin', 'must be the existing account, not a new one');
    assert.strictEqual(linkedMe.user.oidc_sub, 'idp-sub-link');
    console.log('PASS: F7-TC9');

    // F7-TC10: a SECOND identity claiming the same username is still refused,
    // even with linking on -- the account is already bound, and handing it to
    // whoever logged in last is the takeover with an extra step.
    mockUserClaims = {
      sub: 'idp-sub-someone-else',
      preferred_username: 'admin',
      email: 'someone@example.invalid'
    };
    const second = await signIn('link-code-2');
    assert.strictEqual(second.params.get('oidc_code'), null,
      'an account already bound to another identity must not be re-bound');
    assert(second.params.get('oidc_error'), 'the refusal must come back as an error');

    // The first identity still owns it.
    mockUserClaims = {
      sub: 'idp-sub-link',
      preferred_username: 'admin',
      email: 'owner@pallet.org'
    };
    const again = await signIn('link-code-3');
    const againMe = await (await fetch(`${base}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${again.token}` }
    })).json();
    assert.strictEqual(againMe.user.oidc_sub, 'idp-sub-link');
    console.log('PASS: F7-TC10');

  } finally {
    server.kill('SIGKILL');
    if (typeof idpServer.closeAllConnections === 'function') {
      idpServer.closeAllConnections();
    }
    await new Promise(resolve => idpServer.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(linkDb + suffix); } catch { /* ignore */ }
    }
  }
}

runTests()
  .then(runUsernameLinkTests)
  .then(() => setTimeout(() => process.exit(0), 500))
  .catch(err => {
    console.error('FAIL: oidc.test.js -', err.message);
    setTimeout(() => process.exit(1), 500);
  });
