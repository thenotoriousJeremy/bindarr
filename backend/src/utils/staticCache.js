// How browsers may cache the built frontend (frontend/dist).
//
// Only Vite's output under assets/ is content-hashed: a changed file is a
// changed URL, so a year and `immutable` is safe there, and it is what keeps a
// reload from revalidating the whole bundle on a phone.
//
// Everything else in dist/ keeps its name across releases — /ort/ (the
// onnxruntime-web .wasm and .mjs that scripts/copy-ort.mjs stages under fixed
// names), the manifest, the logo, index.html itself. They used to get the same
// year-long immutable header as assets/. After an onnxruntime upgrade a
// returning browser would keep last release's .wasm beside this release's
// loader, session creation would fail, and the scanner would drop to the pure-JS
// contour detector at 200 ms+ a frame without a word. These are revalidated
// instead: `no-cache` plus the ETag and Last-Modified serve-static sets, so an
// unchanged file costs a ~200-byte 304. /models/cornelius.onnx, served by its own
// route in server.js, already worked this way for the same reason.
const path = require('path');
const express = require('express');

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, no-cache';

function cacheControlFor(distPath, filePath) {
  return path.relative(distPath, filePath).split(path.sep)[0] === 'assets' ? IMMUTABLE : REVALIDATE;
}

// The built SPA: its files, then index.html for any other GET outside /api, so a
// client-side route survives a reload.
function serveFrontend(distPath) {
  const router = express.Router();
  router.use(express.static(distPath, {
    index: false,
    setHeaders: (res, filePath) => res.setHeader('Cache-Control', cacheControlFor(distPath, filePath)),
  }));
  router.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    // Revalidated like everything unhashed: it names the hashed bundle, so a copy
    // kept without asking would hold a browser on the previous release.
    res.sendFile(path.join(distPath, 'index.html'), { headers: { 'Cache-Control': REVALIDATE } });
  });
  return router;
}

module.exports = { serveFrontend, cacheControlFor, IMMUTABLE, REVALIDATE };
