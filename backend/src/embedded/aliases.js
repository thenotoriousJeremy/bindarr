// Which modules the phone app swaps out, and for what.
//
// One table, read by both the app bundler (frontend/scripts/build-device-backend.mjs)
// and the test loader (backend/test/embedded.test.js), so the code under test is
// the code that ships. Only bare specifiers are listed: a route's own relative
// requires bundle as they are.
'use strict';

// Forward slashes on every platform: Node accepts them on Windows, and this file
// must not require('path') itself, since the test loader swaps that module too.
const shim = (file) => `${__dirname.replace(/\\/g, '/')}/shims/${file}`;
const unavailable = shim('unavailable.js');

module.exports = {
  // Stand-ins with real behaviour.
  express: shim('express.js'),
  'express-rate-limit': shim('rateLimit.js'),
  sqlite3: shim('sqlite3.js'),
  fs: shim('fs.js'),
  path: shim('path.js'),
  crypto: shim('crypto.js'),
  // db.js's connection lock; see the shim for what a WebView can and cannot track.
  async_hooks: shim('async_hooks.js'),
  // Node's high-resolution clock; WebView exposes the same API on performance.
  perf_hooks: shim('perfHooks.js'),
  // Native modules with no phone build, and server-only plumbing. Device mode
  // never calls into any of them; see shims/unavailable.js.
  sharp: unavailable,
  'onnxruntime-node': unavailable,
  zlib: unavailable,
  http: unavailable,
  https: unavailable,
  // notify.js's SSRF guard (utils/notifyGuard); device mode sends no notifications.
  net: unavailable,
  dns: unavailable,
  os: unavailable,
  assert: unavailable,
  selfsigned: unavailable,
  dotenv: unavailable,
  helmet: unavailable,
  cors: unavailable,
  compression: unavailable,
};
