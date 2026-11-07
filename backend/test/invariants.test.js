// Rules PROJECT.md and AGENTS.md state about the backend, checked against the app
// server.js actually composes rather than against anyone's reading of it.
//
//   1. Every rate limiter middleware/auth.js exports is mounted on some route. A
//      limiter that is defined, exported and documented but never mounted reads
//      as protection in review and protects nothing — importLimiter sat in that
//      state until the import routes picked it up.
//   2. The auth gate order. Only the deliberate public mounts sit above the one
//      `/api` authenticateToken gate, and each of those guards itself: admin
//      behind authenticateToken + requireAdmin, card-art's writes behind the
//      same, shared read-only, and every /api/auth route outside a short public
//      list carrying authenticateToken.
//   3. card_cache is written only through utils/cardCache.cacheNormalizedCards.
//      An INSERT (or INSERT OR REPLACE) anywhere else re-creates rows with every
//      column outside that caller's list reset to its default.
//
// The app is captured in-process: express.application.listen is replaced before
// server.js loads, so the composed app is handed here instead of binding a port,
// and the whole check runs synchronously before any startup job gets a turn.
//
// No framework — plain node + assert. Run: `node test/invariants.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The database in the shape test/run.js sweeps up if this process dies before
// cleaning it; the model directory (startup probes it with a write) on its own.
const tmpDb = path.join(os.tmpdir(), `bindarr-invariants-${process.pid}.db`);
const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-invariants-models-${process.pid}-`));
process.env.DB_PATH = tmpDb;
process.env.CV_MODEL_DIR = modelDir;
process.env.HTTPS_PORT = '';
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';

// Limiters that are knowingly unmounted, each with the change that mounts it. An
// entry here that turns out to be mounted fails the test, so the list cannot go
// stale and quietly excuse a regression later. Empty: #117 mounted importLimiter.
const KNOWN_UNMOUNTED = {};

// The only things allowed above the /api gate, and why each is safe there.
const PUBLIC_API_MOUNTS = {
  '/api/auth': 'login, register, bootstrap, OIDC; its other routes carry authenticateToken themselves',
  '/api/shared': 'the public share view, by share token, read-only',
  '/api/admin': 'starts with its own authenticateToken + requireAdmin',
  '/api/card-art': 'public reads; its writes sit behind authenticateToken + requireAdmin',
};
const PUBLIC_API_ROUTES = ['/api/health'];
// /api/auth routes reachable with no session. Everything else on that router must
// carry authenticateToken in its own middleware chain.
const PUBLIC_AUTH_ROUTES = ['/config', '/oidc/login', '/oidc/callback', '/oidc/exchange', '/bootstrap', '/register', '/login'];

const express = require('express');
let app = null;
express.application.listen = function captureInsteadOfListening() {
  app = this;
  return { close() {}, on() {}, address: () => null };
};
require('../src/server');
assert.ok(app && app._router, 'server.js never called app.listen, so there is no app to inspect');

const auth = require('../src/middleware/auth');
const { authenticateToken, requireAdmin } = auth;

const isRouter = (layer) => Array.isArray(layer.handle && layer.handle.stack);
// Express 4 keeps a mount only as a regexp: /^\/api\/auth\/?(?=\/|$)/i.
function mountPath(layer) {
  if (layer.regexp && layer.regexp.fast_slash) return '/';
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/');
}
const methodsOf = (route) => Object.keys(route.methods).filter(m => route.methods[m]).map(m => (m === '_all' ? 'ALL' : m.toUpperCase()));

// Every middleware function reachable from the app, with where it is mounted.
function collect(stack, prefix, out) {
  for (const layer of stack) {
    const here = prefix + (mountPath(layer) === '/' ? '' : mountPath(layer));
    if (layer.route) {
      for (const inner of layer.route.stack) {
        out.push({ fn: inner.handle, where: `${methodsOf(layer.route).join('/')} ${prefix}${layer.route.path}` });
      }
    } else if (isRouter(layer)) {
      collect(layer.handle.stack, here, out);
    } else {
      out.push({ fn: layer.handle, where: `use ${here || '/'}` });
    }
  }
  return out;
}

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
};

// --- 1. Every exported limiter is mounted ------------------------------------
check('every rate limiter exported by middleware/auth.js is mounted', () => {
  // express-rate-limit marks its middleware with resetKey/getKey; the name catches
  // a limiter someone builds another way.
  const limiters = Object.entries(auth)
    .filter(([name, fn]) => typeof fn === 'function' && (typeof fn.resetKey === 'function' || /Limiter$/.test(name)));
  assert.ok(limiters.length >= 3, `expected the three documented limiters, found ${limiters.map(([n]) => n).join(', ')}`);

  const mounted = collect(app._router.stack, '', []);
  const unmounted = [];
  for (const [name, fn] of limiters) {
    const sites = mounted.filter(m => m.fn === fn).map(m => m.where);
    if (sites.length) console.log(`  ${name}: ${sites.join(', ')}`);
    if (name in KNOWN_UNMOUNTED) {
      assert.strictEqual(sites.length, 0,
        `${name} is mounted now (${sites.join(', ')}); drop it from KNOWN_UNMOUNTED`);
      console.log(`  ${name}: SKIP, known unmounted (${KNOWN_UNMOUNTED[name]})`);
      continue;
    }
    if (!sites.length) unmounted.push(name);
  }
  assert.deepStrictEqual(unmounted, [], `exported but never mounted: ${unmounted.join(', ')}`);
  for (const name of Object.keys(KNOWN_UNMOUNTED)) {
    assert.ok(limiters.some(([n]) => n === name), `KNOWN_UNMOUNTED names ${name}, which middleware/auth.js does not export`);
  }
});

// --- 2. Nothing new sits above the /api gate -----------------------------------
const stack = app._router.stack;
const gateIndex = stack.findIndex(l => l.handle === authenticateToken && !l.route && mountPath(l) === '/api');

check('one authenticateToken gate is mounted at /api', () => {
  assert.notStrictEqual(gateIndex, -1, 'no app.use("/api", authenticateToken) found');
  const gates = stack.filter(l => l.handle === authenticateToken && !l.route);
  assert.strictEqual(gates.length, 1, `expected one app-level authenticateToken, found ${gates.length}`);
});

check('only the deliberate public mounts precede the /api gate', () => {
  const above = stack.slice(0, gateIndex);
  const apiRouters = above.filter(isRouter).map(mountPath).filter(p => p.startsWith('/api'));
  assert.deepStrictEqual(apiRouters.sort(), Object.keys(PUBLIC_API_MOUNTS).sort(),
    `routers mounted above the gate: ${apiRouters.join(', ')}. A new one is reachable without a session; `
    + 'mount it below the gate or add it to PUBLIC_API_MOUNTS with the reason it is safe');
  const apiRoutes = above.filter(l => l.route && l.route.path.startsWith('/api')).map(l => l.route.path);
  assert.deepStrictEqual(apiRoutes, PUBLIC_API_ROUTES, `routes declared above the gate: ${apiRoutes.join(', ')}`);
  // Everything after the gate is behind it; nothing after it may be a router that
  // re-exposes a public path under /api.
  for (const layer of stack.slice(gateIndex + 1).filter(isRouter)) {
    assert.ok(!Object.keys(PUBLIC_API_MOUNTS).includes(mountPath(layer)),
      `${mountPath(layer)} is mounted again below the gate`);
  }
});

const routerAt = (p) => stack.slice(0, gateIndex).find(l => isRouter(l) && mountPath(l) === p).handle.stack;

check('the admin router authenticates and requires admin before any route', () => {
  const admin = routerAt('/api/admin');
  const firstRoute = admin.findIndex(l => l.route);
  const guards = admin.slice(0, firstRoute).map(l => l.handle);
  assert.ok(guards.includes(authenticateToken) && guards.includes(requireAdmin),
    'admin routes must come after router.use(authenticateToken, requireAdmin)');
  assert.ok(guards.indexOf(authenticateToken) < guards.indexOf(requireAdmin), 'authenticate before checking the role');
});

check('card-art: only reads are public, every write is admin-gated', () => {
  const art = routerAt('/api/card-art');
  const gate = art.findIndex(l => !l.route && l.handle === requireAdmin);
  assert.notStrictEqual(gate, -1, 'card-art has no requireAdmin gate');
  assert.ok(art.slice(0, gate).some(l => !l.route && l.handle === authenticateToken), 'card-art gate must authenticate first');
  for (const layer of art.slice(0, gate).filter(l => l.route)) {
    assert.deepStrictEqual(methodsOf(layer.route), ['GET'], `${layer.route.path} is public and not a GET`);
  }
  assert.ok(art.slice(gate).some(l => l.route), 'card-art writes are expected below its gate');
});

check('shared is read-only', () => {
  for (const layer of routerAt('/api/shared').filter(l => l.route)) {
    assert.deepStrictEqual(methodsOf(layer.route), ['GET'], `/api/shared${layer.route.path} must be GET-only`);
  }
});

check('every /api/auth route outside the public list authenticates itself', () => {
  const routes = routerAt('/api/auth').filter(l => l.route);
  const seen = routes.map(l => l.route.path);
  for (const p of PUBLIC_AUTH_ROUTES) assert.ok(seen.includes(p), `public auth route ${p} no longer exists; update the list`);
  for (const layer of routes) {
    if (PUBLIC_AUTH_ROUTES.includes(layer.route.path)) continue;
    assert.ok(layer.route.stack.some(l => l.handle === authenticateToken),
      `${methodsOf(layer.route).join('/')} /api/auth${layer.route.path} is above the gate and does not authenticate`);
  }
});

// --- 3. card_cache has one writer ---------------------------------------------
check('card_cache rows are created only by utils/cardCache.js', () => {
  const SRC = path.join(__dirname, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(c?js|mjs)$/.test(entry.name)) {
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return; // prose about the rule is not a breach of it
          if (/\b(INSERT(\s+OR\s+\w+)?|REPLACE)\s+INTO\s+card_cache\b/i.test(line)) {
            offenders.push(`${path.relative(SRC, full)}:${i + 1}`);
          }
        });
      }
    }
  };
  walk(SRC);
  const elsewhere = offenders.filter(o => !o.startsWith(path.join('utils', 'cardCache.js') + ':'));
  assert.ok(offenders.length > elsewhere.length, 'utils/cardCache.js no longer inserts into card_cache — has the writer moved?');
  assert.deepStrictEqual(elsewhere, [],
    `card_cache written outside cacheNormalizedCards: ${elsewhere.join(', ')}`);
});

console.log(`invariants.test.js: all ${passed} checks passed`);
// Exit here, synchronously: one more turn of the event loop and server.js's
// startup chain would migrate the database and go after the card APIs' set lists.
try { fs.rmSync(modelDir, { recursive: true, force: true }); } catch { /* best effort */ }
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* not created yet, or held open: test/run.js clears it */ }
}
process.exit(0);
