// One table of /api routes (src/routes/mounts.js), held to the two places that
// serve it: server.js on a server and src/embedded on the phone (MOB-11).
//
// The two used to keep separate hand-written lists, and the phone's fell behind:
// the trash routes, notifications, binder art and the health probe all 404'd in
// device mode. This fails when a route a server answers has neither a mount on
// the phone nor a 501 "needs a server" there.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadEmbedded } = require('./deviceHarness');

const SRC = path.join(__dirname, '..', 'src');
const mounts = require('../src/routes/mounts');
const { API_MOUNTS, SERVER_HANDLERS, devicePathsOf } = mounts;

// '/locations/:id/binder-art' -> a RegExp for the paths it covers as a mount prefix.
const prefixRe = (p) => new RegExp(`^${p.replace(/:\w+/g, '[^/]+')}(?:/|$)`);
// Concrete paths for a test request.
const sample = (p) => p.replace(/:\w+/g, '1');

function testTableIsWellFormed() {
  for (const entry of API_MOUNTS) {
    const where = `${entry.path} (${typeof entry.router === 'function' ? 'bundled' : entry.router})`;
    assert.ok(entry.path.startsWith('/api'), where);
    assert.ok(entry.device === 'mount' || entry.device === 501, `${where}: device is 'mount' or 501`);
    // A router the phone runs is required by the table (so the app bundles it);
    // a server-only one is only named (so the app never does).
    assert.strictEqual(typeof entry.router === 'function', entry.device === 'mount', `${where}: router matches its device policy`);
    if (entry.device === 501) {
      assert.ok(fs.existsSync(path.join(SRC, 'routes', `${entry.router}.js`)), `${where}: routes/${entry.router}.js exists`);
      assert.ok(entry.path !== '/api' || (entry.devicePaths && entry.devicePaths.length),
        `${where}: a server-only router on bare /api names the paths the phone answers 501 at`);
    }
  }
  for (const h of SERVER_HANDLERS) assert.strictEqual(h.device, 501, h.path);
  // Order is behaviour: the trash router ahead of the collection router.
  const at = (p) => API_MOUNTS.findIndex(e => e.path === p);
  assert.ok(at('/api/collection/trash') < API_MOUNTS.findIndex(e => e.path === '/api' && e.device === 'mount'));
}

// The paths a router file declares, read from its source: router.get('/x', ...).
function routePathsOf(file) {
  const src = fs.readFileSync(path.join(SRC, 'routes', `${file}.js`), 'utf8');
  return [...src.matchAll(/router\.(?:get|post|put|patch|delete|all|use)\(\s*['"`](\/[^'"`]*)['"`]/g)].map(m => m[1]);
}

// A server-only router mounted on bare /api names full paths inside; every one of
// them must fall under a path the phone answers 501 at, or it would 404 there.
function testDevicePathsCoverEveryServerRoute() {
  for (const entry of API_MOUNTS.filter(e => e.device === 501)) {
    const covers = devicePathsOf(entry).map(prefixRe);
    const paths = routePathsOf(entry.router);
    assert.ok(paths.length, `routes/${entry.router}.js declares routes`);
    for (const p of paths) {
      const full = entry.path === '/api' ? `/api${p === '/' ? '' : p}` : entry.path;
      assert.ok(covers.some(re => re.test(sample(full))), `${full} (routes/${entry.router}.js) has neither a mount nor a 501 on the phone`);
    }
  }
}

// Nothing in server.js serves /api except through the table: a router mounted
// there by hand is one the phone would never hear of.
function testServerMountsOnlyTheTable() {
  const src = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const literal = [...src.matchAll(/\bapp\.(use|get|post|put|patch|delete|all)\(\s*['"`](\/api[^'"`]*)['"`]/g)].map(m => m[2]);
  const allowed = new Set(['/api', ...SERVER_HANDLERS.map(h => h.path)]);
  assert.deepStrictEqual(literal.filter(p => !allowed.has(p)), [], 'every /api router is mounted from routes/mounts.js');
  for (const h of SERVER_HANDLERS) assert.ok(literal.includes(h.path), `server.js answers ${h.path} itself`);
  assert.match(src, /mountApi\(\{ public: true \}\)/);
  assert.match(src, /mountApi\(\{ public: false \}\)/);

  // The readiness gate (DATA-20) sits after the health probe and ahead of every
  // router, and the authentication gate between the public and private halves.
  const health = src.indexOf(`app.get('/api/health'`);
  const ready = src.indexOf('whenReady(');
  const publicMounts = src.indexOf('mountApi({ public: true })');
  const authGate = src.indexOf(`app.use('/api', authenticateToken)`);
  const privateMounts = src.indexOf('mountApi({ public: false })');
  assert.ok(health > 0 && health < ready && ready < publicMounts && publicMounts < authGate && authGate < privateMounts,
    'health, then the readiness gate, the public routes, the auth gate, the rest');
}

// /api answers 503 with Retry-After until the database is ready (DATA-20).
function testReadinessGate() {
  let ready = false;
  const gate = mounts.whenReady(() => ready);
  const res = {
    headers: {},
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let passed = 0;
  gate({}, res, () => { passed++; });
  assert.strictEqual(passed, 0);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.headers['retry-after'], String(mounts.RETRY_AFTER_SECONDS));
  assert.strictEqual(res.body.starting, true);
  ready = true;
  gate({}, {}, () => { passed++; });
  assert.strictEqual(passed, 1, 'once ready, requests go through');
}

// On the phone: every server-only path answers 501, and the routers the table
// mounts there are reachable (MOB-01: the trash).
async function testDeviceAnswersTheTable() {
  const { embedded, cleanup } = loadEmbedded('apimounts');
  try {
    const { token } = await embedded.start({ background: false });
    const call = async (method, url) => embedded.handle({ method, url, headers: { Authorization: `Bearer ${token}` } });
    const serverOnly = [
      ...API_MOUNTS.filter(e => e.device === 501).flatMap(devicePathsOf),
      ...SERVER_HANDLERS.map(h => h.path),
    ];
    for (const p of serverOnly) {
      for (const method of ['GET', 'POST']) {
        const res = await call(method, sample(p));
        assert.strictEqual(res.status, 501, `${method} ${sample(p)} on the phone`);
      }
    }
    assert.strictEqual((await call('GET', '/api/collection/trash')).status, 200, 'the trash is mounted on the phone');
    assert.strictEqual((await call('GET', '/api/fx')).status, 200, 'a public router mounted on the phone');
  } finally {
    await cleanup();
  }
}

async function main() {
  testTableIsWellFormed();
  testDevicePathsCoverEveryServerRoute();
  testServerMountsOnlyTheTable();
  testReadinessGate();
  await testDeviceAnswersTheTable();
}

main()
  .then(() => console.log('API mount table check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
