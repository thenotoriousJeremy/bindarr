// SSO in the browser hands off a one-time code, not the session.
//
// The web callback used to redirect to /?oidc_token=<the 7-day session token>,
// and the page signed in with whatever token a link carried -- a credential in the
// URL and the history, and a way to sign someone into an account of the sender's
// choosing with nothing checking that a login had been started. Now:
//
//   - /oidc/login sets an HttpOnly cookie and seals its hash into the signed state;
//   - the callback refuses a state whose cookie is not in this browser (login
//     CSRF), and redirects with a short-lived single-use code bound to it;
//   - the page redeems that code by POST, together with the same cookie.
//
// The real auth router in this process against a stub IdP, like oidcnative.test.js.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-oidcweb-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const oidc = require('../src/utils/oidc');
const { hashSessionToken } = require('../src/utils/authHelpers');

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

function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

const decodeState = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

function testCodeStore() {
  const binding = oidc.createWebBinding();
  assert.strictEqual(binding.hash, crypto.createHash('sha256').update(binding.secret).digest('base64url'));

  // Single use.
  const code = oidc.issueWebCode(7, binding.hash);
  assert.strictEqual(oidc.consumeWebCode(code, binding.secret), 7, 'a fresh code redeems with its cookie');
  assert.strictEqual(oidc.consumeWebCode(code, binding.secret), null, 'a code must not redeem twice');

  // Short-lived: a minute from issue.
  const t0 = Date.now();
  const late = oidc.issueWebCode(7, binding.hash, t0);
  assert.strictEqual(oidc.consumeWebCode(late, binding.secret, t0 + oidc.HANDOFF_CODE_TTL_MS + 1), null, 'an expired code must not redeem');
  assert.ok(oidc.HANDOFF_CODE_TTL_MS <= 60 * 1000);
  const inTime = oidc.issueWebCode(7, binding.hash, t0);
  assert.strictEqual(oidc.consumeWebCode(inTime, binding.secret, t0 + oidc.HANDOFF_CODE_TTL_MS - 1000), 7);

  // Bound to the attempt: another login's cookie cannot redeem it -- and the try
  // burns it, so it cannot be retried with a better guess.
  const other = oidc.createWebBinding();
  const stolen = oidc.issueWebCode(7, binding.hash);
  assert.strictEqual(oidc.consumeWebCode(stolen, other.secret), null, "another attempt's cookie must fail");
  assert.strictEqual(oidc.consumeWebCode(stolen, binding.secret), null, 'a failed attempt must burn the code');
  assert.strictEqual(oidc.consumeWebCode(oidc.issueWebCode(7, binding.hash), undefined), null, 'no cookie, no session');

  // Web and native codes are not interchangeable, either way round.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.strictEqual(oidc.consumeNativeCode(oidc.issueWebCode(7, binding.hash), verifier), null);
  assert.strictEqual(oidc.consumeWebCode(oidc.issueNativeCode(7, challenge), binding.secret), null);
  assert.throws(() => oidc.issueWebCode(7, ''), /binding/);
  console.log('PASS: web hand-off codes are single-use, expire, and need the cookie of the login that made them');
}

function testCookieParsing() {
  assert.strictEqual(oidc.readCookie('a=1; bindarr_oidc=xyz; b=2', 'bindarr_oidc'), 'xyz');
  assert.strictEqual(oidc.readCookie('bindarr_oidc_x=1', 'bindarr_oidc'), null, 'a longer name is a different cookie');
  assert.strictEqual(oidc.readCookie(undefined, 'bindarr_oidc'), null);
  assert.strictEqual(oidc.readCookie('bindarr_oidc=%E0%A4%A', 'bindarr_oidc'), null, 'malformed escapes do not throw');
  console.log('PASS: the binding cookie is read out of a Cookie header');
}

async function testFlowThroughRouter() {
  let nonce = null;
  let sub = 'web-user-1';
  const issuer = await listen((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const host = `http://${req.headers.host}`;
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issuer: host, authorization_endpoint: `${host}/auth`, token_endpoint: `${host}/token` }));
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        const claims = { iss: host, aud: 'bindarr-test-client', exp: Math.floor(Date.now() / 1000) + 3600, nonce, sub, preferred_username: 'WebTrainer' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'at', token_type: 'Bearer', id_token: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig` }));
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

  const startLogin = async (query = '') => {
    const res = await fetch(`${base}/api/auth/oidc/login${query}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    const authUrl = new URL(res.headers.get('location'));
    const setCookie = res.headers.get('set-cookie');
    return {
      state: authUrl.searchParams.get('state'),
      nonce: authUrl.searchParams.get('nonce'),
      setCookie,
      cookie: setCookie ? setCookie.split(';')[0] : null
    };
  };
  // The stub IdP answers with the nonce of the login whose callback this is, as a
  // real one does.
  const callback = async (attempt, cookie) => {
    nonce = attempt.nonce;
    const res = await fetch(`${base}/api/auth/oidc/callback?code=idp-code&state=${encodeURIComponent(attempt.state)}`, {
      redirect: 'manual', headers: cookie ? { Cookie: cookie } : {}
    });
    assert.strictEqual(res.status, 302);
    const location = res.headers.get('location');
    return { location, params: new URL(location).searchParams };
  };
  const exchange = (code, cookie) => fetch(`${base}/api/auth/oidc/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ code })
  });
  const sessionCount = async () => (await db.get(`SELECT COUNT(*) AS n FROM sessions`)).n;

  // 1. Starting a web login binds it to this browser.
  const a = await startLogin();
  assert.ok(a.setCookie, 'a web login must set the binding cookie');
  assert.match(a.setCookie, /^bindarr_oidc=/);
  assert.match(a.setCookie, /HttpOnly/i, 'page script must never see it');
  assert.match(a.setCookie, /SameSite=Lax/i, 'Lax: still sent on the IdP\'s top-level redirect back');
  assert.match(a.setCookie, /Path=\/api\/auth\/oidc/i, 'scoped to the OIDC routes');
  const secretA = decodeURIComponent(a.cookie.slice('bindarr_oidc='.length));
  assert.strictEqual(decodeState(a.state).wb, crypto.createHash('sha256').update(secretA).digest('base64url'),
    'the state carries the hash of the cookie, never the cookie itself');
  assert.ok(!a.state.includes(secretA));
  // The native flow has its verifier and gets no cookie.
  const challenge = crypto.createHash('sha256').update(crypto.randomBytes(32).toString('base64url')).digest('base64url');
  assert.strictEqual((await startLogin(`?client=native&challenge=${challenge}`)).setCookie, null);

  // 2. Login CSRF: someone else's callback link, opened in a browser that did not
  // start that login, signs nobody in.
  const b = await startLogin();
  for (const cookie of [null, b.cookie]) {
    const refused = await callback(a, cookie);
    assert.ok(refused.location.startsWith('https://cards.example.com/?oidc_error='), `refused, got ${refused.location}`);
    assert.strictEqual(refused.params.get('oidc_code'), null);
  }
  assert.strictEqual(await sessionCount(), 0);

  // 3. The real browser gets a one-time code -- not the session.
  const first = await callback(a, a.cookie);
  const code1 = first.params.get('oidc_code');
  assert.ok(code1, `the callback must hand back a code, got ${first.location}`);
  assert.ok(!/oidc_token|[?&]token=/.test(first.location), 'no session token in the URL');
  assert.strictEqual(await sessionCount(), 0, 'no session exists until the page redeems the code');

  // 4. A code minted for one attempt cannot be redeemed with another's cookie, or
  // with none -- and that try spends it.
  assert.strictEqual((await exchange(code1, b.cookie)).status, 400, "another attempt's cookie");
  assert.strictEqual((await exchange(code1, a.cookie)).status, 400, 'burned by the failed try');
  const second = await callback(a, a.cookie);
  assert.strictEqual((await exchange(second.params.get('oidc_code'), null)).status, 400, 'no cookie');

  // 5. Redeemed properly: the same answer as POST /login, once.
  const third = await callback(a, a.cookie);
  const code3 = third.params.get('oidc_code');
  const ok = await exchange(code3, a.cookie);
  assert.strictEqual(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.token, 'the exchange returns the session token, in a response body');
  assert.ok('has_api_key' in body.user && !('api_key' in body.user), 'the same user shape as a password login');
  const owner = await db.get(`SELECT id, username FROM users WHERE oidc_sub = ?`, ['web-user-1']);
  const session = await db.get(`SELECT user_id FROM sessions WHERE token = ?`, [hashSessionToken(body.token)]);
  assert.ok(owner && session && session.user_id === owner.id, 'the session belongs to the SSO user');
  assert.strictEqual(body.user.username, owner.username);
  assert.match(ok.headers.get('set-cookie') || '', /^bindarr_oidc=;/, 'the spent binding cookie is cleared');
  assert.strictEqual((await exchange(code3, a.cookie)).status, 400, 'a code redeems once');
  assert.strictEqual((await exchange('never-issued', a.cookie)).status, 400);
  console.log('PASS: web SSO returns a one-time code bound to the browser that started the login');
}

async function main() {
  await db.initDb();
  testCodeStore();
  testCookieParsing();
  await testFlowThroughRouter();
  console.log('PASS: oidcweb.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
