// The service worker's response headers (utils/serviceWorkerHeaders.js).
// Run: `node test/serviceworkerheaders.test.js`
const assert = require('assert');
const { PWA_FILES, workerCsp, setPwaHeaders } = require('../src/utils/serviceWorkerHeaders');

const PAGE = "default-src 'self';script-src 'self' 'wasm-unsafe-eval';connect-src 'self';"
  + "img-src 'self' data: blob: https://cards.scryfall.io https://images.pokemontcg.io;object-src 'none'";

// The worker may fetch exactly the https image hosts, on top of 'self'.
const sw = workerCsp(PAGE);
const connect = sw.split(';').find(d => d.startsWith('connect-src'));
assert.strictEqual(connect, "connect-src 'self' https://cards.scryfall.io https://images.pokemontcg.io");
// data:/blob: are img-src only; they mean nothing to fetch() and stay out.
assert.ok(!/connect-src[^;]*(data:|blob:)/.test(sw));
// Every other directive is untouched.
for (const d of PAGE.split(';')) {
  if (!d.startsWith('connect-src')) assert.ok(sw.split(';').includes(d), `${d} survives`);
}

// Idempotent: a host already allowed is not listed twice.
assert.strictEqual(workerCsp(sw), sw);

// No connect-src: it is spelled out from default-src plus the hosts.
const noConnect = workerCsp("default-src 'self';img-src https://cards.lorcast.io");
assert.ok(noConnect.includes("connect-src 'self' https://cards.lorcast.io"));

// Nothing to add, or no policy at all: unchanged.
assert.strictEqual(workerCsp("default-src 'self'"), "default-src 'self'");
assert.strictEqual(workerCsp(undefined), undefined);

// setPwaHeaders: both files revalidate; only the worker's policy is widened, and
// whichever of the enforced / report-only headers helmet set is the one changed.
function fakeRes(headers) {
  const h = { ...headers };
  return { getHeader: n => h[n], setHeader: (n, v) => { h[n] = v; }, headers: h };
}
const swRes = fakeRes({ 'Content-Security-Policy-Report-Only': PAGE });
setPwaHeaders({ path: '/sw.js' }, swRes);
assert.strictEqual(swRes.headers['Cache-Control'], 'no-cache');
assert.strictEqual(swRes.headers['Content-Security-Policy-Report-Only'], sw);
assert.strictEqual(swRes.headers['Content-Security-Policy'], undefined);

const enforced = fakeRes({ 'Content-Security-Policy': PAGE });
setPwaHeaders({ path: '/sw.js' }, enforced);
assert.strictEqual(enforced.headers['Content-Security-Policy'], sw);

const manifestRes = fakeRes({ 'Content-Security-Policy': PAGE });
setPwaHeaders({ path: '/manifest.webmanifest' }, manifestRes);
assert.strictEqual(manifestRes.headers['Cache-Control'], 'no-cache');
assert.strictEqual(manifestRes.headers['Content-Security-Policy'], PAGE);

assert.deepStrictEqual(PWA_FILES, ['/sw.js', '/manifest.webmanifest']);

console.log('serviceworkerheaders: all assertions passed');
