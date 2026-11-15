// SSO sign-in hardening.
//
//   - The PKCE verifier is no longer in the state token (SEC-12). The state is
//     signed, not encrypted, and rides in the same callback URL as the
//     authorization code, so whoever held that URL held both halves PKCE keeps
//     apart. Only a seed travels; the server derives the verifier from it.
//   - UserInfo claims count only when their `sub` is the ID token's (OIDC Core
//     5.3.2, SEC-12). Merged unchecked, a UserInfo answer could swap the subject
//     accounts are matched on.
//   - The callback's redirect carries a fixed error code, never the identity
//     provider's error text or an exception's message (SEC-10).
//   - The first SSO sign-in on an empty install creates the owner, so it takes the
//     setup code, sealed into the state at /oidc/login, unless it comes straight
//     from the server's machine (SEC-06).
//
// The real auth router against a stub identity provider, both on 127.0.0.1; a
// request "from elsewhere" carries X-Forwarded-For. Native-app flow, so no cookie
// handling is needed. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-oidchardening-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;
process.env.SETUP_CODE = 'OIDC-SETUP-CODE';
process.env.OIDC_ENABLED = 'true';
process.env.OIDC_CLIENT_ID = 'hardening-client';
process.env.OIDC_CLIENT_SECRET = 'hardening-secret';
process.env.PUBLIC_BASE_URL = 'https://cards.example.com';

const express = require('express');
const db = require('../src/db');
const oidc = require('../src/utils/oidc');

const servers = [];
async function cleanup() {
  for (const s of servers) {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    if (s.listening) await new Promise(resolve => s.close(resolve));
  }
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const listen = (handler) => new Promise(resolve => {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const ELSEWHERE = { 'X-Forwarded-For': '203.0.113.9' };
const decodeState = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');

async function main() {
  await db.initDb();

  // --- the stub identity provider ---
  let nonce = null;
  let idClaims = {};
  let userinfoClaims = {};
  let tokenStatus = 200;
  const verifiers = [];
  const issuer = await listen((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const host = `http://${req.headers.host}`;
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issuer: host, authorization_endpoint: `${host}/auth`, token_endpoint: `${host}/token`, userinfo_endpoint: `${host}/userinfo` }));
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        verifiers.push(new URLSearchParams(body).get('code_verifier'));
        if (tokenStatus !== 200) {
          res.writeHead(tokenStatus, { 'Content-Type': 'text/plain' });
          res.end('secret-idp-detail: client misconfigured at https://idp.internal/admin');
          return;
        }
        const claims = { iss: host, aud: 'hardening-client', exp: Math.floor(Date.now() / 1000) + 3600, nonce, ...idClaims };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'at', token_type: 'Bearer',
          id_token: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`,
        }));
      });
      return;
    }
    if (url.pathname === '/userinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(userinfoClaims));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  process.env.OIDC_ISSUER_URL = issuer;
  oidc._resetDiscoveryCache();

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  const base = await listen(app);
  const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
  const appReturn = (res) => new URLSearchParams(res.headers.get('location').split('?')[1] || '');
  const challenge = s256(crypto.randomBytes(32).toString('base64url'));

  // One native sign-in, started with `query` and finished with `headers`.
  async function signIn({ query = '', headers = {} } = {}) {
    const login = await get(`/api/auth/oidc/login?client=native&challenge=${challenge}${query}`, headers);
    assert.strictEqual(login.status, 302);
    const location = login.headers.get('location');
    if (location.startsWith('bindarr://')) return { refusedAtLogin: appReturn(login) };
    const authUrl = new URL(location);
    nonce = authUrl.searchParams.get('nonce');
    const state = authUrl.searchParams.get('state');
    const cb = await get(`/api/auth/oidc/callback?code=idp-code&state=${encodeURIComponent(state)}`, headers);
    assert.strictEqual(cb.status, 302);
    return { authUrl, state, back: appReturn(cb), location: cb.headers.get('location') };
  }
  const users = async () => (await db.get(`SELECT COUNT(*) AS n FROM users`)).n;

  // --- 1. The first sign-in from elsewhere, without the code, creates nothing ----
  idClaims = { sub: 'owner-sub', preferred_username: 'owner' };
  userinfoClaims = { ...idClaims };
  let flow = await signIn({ headers: ELSEWHERE });
  assert.strictEqual(flow.back.get('oidc_error'), 'setup_code_required');
  assert.strictEqual(flow.back.get('code'), null);
  assert.strictEqual(await users(), 0, 'no owner without the setup code');

  // ...a wrong code is refused before the identity provider is involved...
  flow = await signIn({ query: '&setup_code=WRONG-CODE', headers: ELSEWHERE });
  assert.ok(flow.refusedAtLogin, 'a wrong setup code never reaches the IdP');
  assert.strictEqual(flow.refusedAtLogin.get('oidc_error'), 'setup_code_invalid');

  // ...and the right one is sealed into the state and creates the owner.
  flow = await signIn({ query: '&setup_code=oidc-setup-code', headers: ELSEWHERE });
  assert.strictEqual(decodeState(flow.state).su, 1, 'the yes travels in the signed state');
  assert.ok(flow.back.get('code'), `the owner signs in: ${flow.location}`);
  const owner = await db.get(`SELECT username, role, oidc_sub FROM users`);
  assert.deepStrictEqual({ ...owner }, { username: 'admin', role: 'admin', oidc_sub: 'owner-sub' });
  console.log('PASS: the first SSO sign-in from elsewhere takes the setup code');

  // --- 2. PKCE: no verifier in the state, and the one sent matches the challenge --
  const payload = decodeState(flow.state);
  assert.strictEqual(payload.cv, undefined, 'the state carries no verifier');
  assert.ok(typeof payload.ps === 'string' && payload.ps.length >= 16, 'only the seed it is derived from');
  const sent = verifiers[verifiers.length - 1];
  assert.ok(/^[A-Za-z0-9_-]{43,128}$/.test(sent), 'a valid RFC 7636 verifier reaches the token endpoint');
  assert.ok(!JSON.stringify(payload).includes(sent), 'the verifier appears nowhere in the state');
  assert.strictEqual(s256(sent), flow.authUrl.searchParams.get('code_challenge'), 'and it is the one the challenge was made from');
  console.log('PASS: the PKCE verifier stays out of the readable state');

  // --- 3. UserInfo for another subject is not merged -------------------------------
  idClaims = { sub: 'member-sub', preferred_username: 'realname' };
  userinfoClaims = { sub: 'someone-else', preferred_username: 'impostor' };
  flow = await signIn();
  assert.ok(flow.back.get('code'), flow.location);
  const member = await db.get(`SELECT username, oidc_sub FROM users WHERE oidc_sub IN ('member-sub', 'someone-else')`);
  assert.deepStrictEqual({ ...member }, { username: 'realname', oidc_sub: 'member-sub' },
    'the account is the ID token\'s subject, named from the ID token');
  console.log('PASS: UserInfo claims for a different sub are ignored');

  // --- 4. Error redirects carry codes, never text -----------------------------------
  const state = (await get(`/api/auth/oidc/login?client=native&challenge=${challenge}`)).headers.get('location');
  const liveState = new URL(state).searchParams.get('state');
  const injected = await get(`/api/auth/oidc/callback?state=${encodeURIComponent(liveState)}&error=server_error`
    + `&error_description=${encodeURIComponent('Your account is locked, call 555-0100 <b>now</b>')}`);
  assert.strictEqual(appReturn(injected).get('oidc_error'), 'idp_error');
  assert.ok(!/555|locked/.test(injected.headers.get('location')), 'the IdP\'s description is not reflected');
  const denied = await get(`/api/auth/oidc/callback?state=${encodeURIComponent(liveState)}&error=access_denied`);
  assert.strictEqual(appReturn(denied).get('oidc_error'), 'access_denied');

  tokenStatus = 400;
  flow = await signIn();
  assert.strictEqual(flow.back.get('oidc_error'), 'sign_in_failed');
  assert.ok(!/secret-idp-detail|idp\.internal/.test(flow.location), 'the token endpoint\'s answer stays in the log');
  tokenStatus = 200;

  const login = await get(`/api/auth/oidc/login?client=native&challenge=${challenge}`);
  const authUrl = new URL(login.headers.get('location'));
  nonce = 'a-nonce-from-some-other-login';
  const replay = await get(`/api/auth/oidc/callback?code=idp-code&state=${encodeURIComponent(authUrl.searchParams.get('state'))}`);
  assert.strictEqual(appReturn(replay).get('oidc_error'), 'nonce_mismatch', 'an ID token check names which check, as a code');
  console.log('PASS: the callback redirects with error codes only');

  console.log('PASS: oidchardening.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
