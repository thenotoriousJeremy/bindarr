// SSO from the Android/iOS app (issue #94): the login runs in the system browser,
// and the callback has to get back into the app instead of opening the web page.
//
// What it must NOT do is put the session token in bindarr://oidc?..., because any
// app on the device can register that scheme. So the callback hands out a one-time
// code bound to a challenge the app sent at the start, and the app redeems it with
// the verifier only it holds. These tests drive the real auth router, in this
// process, against a stub IdP: the flag has to survive the round trip through the
// signed state, the code has to be single-use and short-lived, and a code without
// its verifier has to be worthless.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-oidcnative-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const oidc = require('../src/utils/oidc');
const { hashSessionToken } = require('../src/utils/authHelpers');

const servers = [];

// Close the handles and let the event loop drain -- no process.exit, for the
// Windows libuv abort described in storagesettings.test.js.
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

function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

// What the app does: a random verifier it keeps, and the S256 challenge it sends.
function makeVerifier() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function decodeState(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

function testCodeStore() {
  const { verifier, challenge } = makeVerifier();

  // Single use: the second presentation of a code that worked finds nothing.
  const code = oidc.issueNativeCode(42, challenge);
  assert.strictEqual(oidc.consumeNativeCode(code, verifier), 42, 'a fresh code redeems for its user');
  assert.strictEqual(oidc.consumeNativeCode(code, verifier), null, 'a code must not redeem twice');

  // Expiry: a minute, measured from issue.
  const t0 = Date.now();
  const late = oidc.issueNativeCode(42, challenge, t0);
  assert.strictEqual(oidc.consumeNativeCode(late, verifier, t0 + oidc.NATIVE_CODE_TTL_MS + 1), null,
    'an expired code must not redeem');
  const inTime = oidc.issueNativeCode(42, challenge, t0);
  assert.strictEqual(oidc.consumeNativeCode(inTime, verifier, t0 + oidc.NATIVE_CODE_TTL_MS - 1000), 42,
    'a code inside its lifetime redeems');

  // The interception case: an app that claimed bindarr:// has the code but not
  // the verifier. And the attempt burns the code, so it cannot keep guessing.
  const stolen = oidc.issueNativeCode(42, challenge);
  assert.strictEqual(oidc.consumeNativeCode(stolen, makeVerifier().verifier), null, 'wrong verifier must fail');
  assert.strictEqual(oidc.consumeNativeCode(stolen, verifier), null, 'a failed attempt must burn the code');
  const noVerifier = oidc.issueNativeCode(42, challenge);
  assert.strictEqual(oidc.consumeNativeCode(noVerifier, undefined), null, 'a missing verifier must fail');

  assert.strictEqual(oidc.consumeNativeCode('never-issued', verifier), null);
  assert.strictEqual(oidc.consumeNativeCode(undefined, verifier), null);
  assert.strictEqual(oidc.consumeNativeCode({ code }, verifier), null, 'non-string input must not throw');

  assert.throws(() => oidc.issueNativeCode(42, 'too-short'), /challenge/);
  console.log('PASS: native exchange codes are single-use, expire, and need the verifier');
}

function testStateCarriesNativeFlag() {
  const { challenge } = makeVerifier();
  const token = oidc.createStateToken({ cv: 'v', n: 'n', ru: 'r', nat: 1, nc: challenge });
  const verified = oidc.verifyStateToken(token);
  assert.strictEqual(verified.nat, 1);
  assert.strictEqual(verified.nc, challenge);

  // Signed like everything else in the state: a web login cannot be turned into
  // a native one -- or handed a different challenge -- on the way through the IdP.
  const [, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...verified, nc: makeVerifier().challenge })).toString('base64url');
  assert.strictEqual(oidc.verifyStateToken(`${forged}.${sig}`), null, 'a swapped challenge must fail verification');

  assert.strictEqual(oidc.isValidNativeChallenge(challenge), true);
  assert.strictEqual(oidc.isValidNativeChallenge('x'.repeat(42)), false);
  assert.strictEqual(oidc.isValidNativeChallenge(`${'x'.repeat(42)}!`), false);
  assert.strictEqual(oidc.isValidNativeChallenge(['a']), false);
  console.log('PASS: the native flag and challenge round-trip through the signed state');
}

async function testFlowThroughRouter() {
  // Stub IdP: discovery plus a token endpoint that echoes the nonce it was asked
  // for, exactly as a real one does.
  let nonce = null;
  const issuer = await listen((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const host = `http://${req.headers.host}`;
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: host,
        authorization_endpoint: `${host}/auth`,
        token_endpoint: `${host}/token`
      }));
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        const claims = {
          iss: host,
          aud: 'bindarr-test-client',
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce,
          sub: 'native-user-1',
          preferred_username: 'MobileTrainer'
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'at',
          token_type: 'Bearer',
          id_token: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ISSUER_URL = issuer;
  process.env.OIDC_CLIENT_ID = 'bindarr-test-client';
  process.env.OIDC_CLIENT_SECRET = 'secret123';
  process.env.PUBLIC_BASE_URL = 'https://cards.example.com';
  oidc._resetDiscoveryCache();

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  const base = await listen(app);
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const exchange = (body) => fetch(`${base}/api/auth/oidc/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  // client=native without a usable challenge is refused up front, not at the end.
  assert.strictEqual((await get('/api/auth/oidc/login?client=native')).status, 400);

  // 1. Start the login the way the app does.
  const { verifier, challenge } = makeVerifier();
  const login = await get(`/api/auth/oidc/login?client=native&challenge=${challenge}`);
  assert.strictEqual(login.status, 302);
  const authUrl = new URL(login.headers.get('location'));
  // The IdP still sees the server's own https callback -- no extra redirect URI
  // to register for the app.
  assert.strictEqual(authUrl.searchParams.get('redirect_uri'), 'https://cards.example.com/api/auth/oidc/callback');
  const state = authUrl.searchParams.get('state');
  nonce = authUrl.searchParams.get('nonce');
  assert.strictEqual(decodeState(state).nat, 1);
  assert.strictEqual(decodeState(state).nc, challenge);

  // A web login carries neither, whatever else is in the query.
  const webLogin = await get('/api/auth/oidc/login?client=nativeish');
  const webState = new URL(webLogin.headers.get('location')).searchParams.get('state');
  assert.strictEqual(decodeState(webState).nat, undefined, 'only the literal client=native is native');

  // 2. The IdP sends the browser back. The answer goes to the app, as a code.
  const cb = await get(`/api/auth/oidc/callback?code=idp-code&state=${encodeURIComponent(state)}`);
  assert.strictEqual(cb.status, 302);
  const back = cb.headers.get('location');
  assert(back.startsWith('bindarr://oidc?'), `native callback must return to the app, got ${back}`);
  const appCode = new URLSearchParams(back.slice('bindarr://oidc?'.length)).get('code');
  assert(appCode, 'the app link must carry a code');
  assert(!/oidc_token/.test(back), 'the session token must never travel through the custom scheme');
  const sessionsBefore = (await db.get(`SELECT COUNT(*) AS n FROM sessions`)).n;
  assert.strictEqual(sessionsBefore, 0, 'no session exists until the app redeems the code');

  // 3. The app redeems it: same shape as POST /login.
  const ok = await exchange({ code: appCode, verifier });
  assert.strictEqual(ok.status, 200);
  const body = await ok.json();
  assert(body.token, 'exchange must return a session token');
  assert.strictEqual(typeof body.user.username, 'string');
  assert('share_token' in body.user && 'has_api_key' in body.user, 'user payload must match POST /login');
  assert(!('api_key' in body.user) && !('tcg_api_key' in body.user), 'and carry no key the app would store');
  const session = await db.get(`SELECT user_id FROM sessions WHERE token = ?`, [hashSessionToken(body.token)]);
  const owner = await db.get(`SELECT id, username FROM users WHERE oidc_sub = ?`, ['native-user-1']);
  assert(session && owner && session.user_id === owner.id, 'the session must belong to the SSO user');
  assert.strictEqual(body.user.username, owner.username);

  // Reused and unknown codes are refused.
  assert.strictEqual((await exchange({ code: appCode, verifier })).status, 400, 'reused code');
  assert.strictEqual((await exchange({ code: 'nope', verifier })).status, 400, 'unknown code');
  assert.strictEqual((await exchange({})).status, 400, 'empty body');

  // Errors reach the app too, as long as the state says who asked.
  const denied = await get(`/api/auth/oidc/callback?error=access_denied&state=${encodeURIComponent(state)}`);
  assert(denied.headers.get('location').startsWith('bindarr://oidc?oidc_error='), 'native IdP error must return to the app');
  const noCode = await get(`/api/auth/oidc/callback?state=${encodeURIComponent(state)}`);
  assert(noCode.headers.get('location').startsWith('bindarr://oidc?oidc_error='), 'native missing-code error must return to the app');

  // ...and anything that cannot prove it is native gets the web page, as before.
  const anon = await get('/api/auth/oidc/callback?error=access_denied');
  assert(anon.headers.get('location').startsWith('https://cards.example.com/?oidc_error='));
  const webErr = await get(`/api/auth/oidc/callback?error=access_denied&state=${encodeURIComponent(webState)}`);
  assert(webErr.headers.get('location').startsWith('https://cards.example.com/?oidc_error='));

  console.log('PASS: native SSO returns to the app with a one-time code the app redeems');
}

async function main() {
  await db.initDb();
  testCodeStore();
  testStateCarriesNativeFlag();
  await testFlowThroughRouter();
  console.log('PASS: oidcnative.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
