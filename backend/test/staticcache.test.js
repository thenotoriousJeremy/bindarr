// Cache headers on the built frontend (utils/staticCache.js), checked over real
// HTTP against a stand-in dist/ directory.
//
// /ort/ holds the onnxruntime-web wasm under fixed filenames and used to be
// served `max-age=1y, immutable` like Vite's hashed assets/, so after an
// onnxruntime upgrade returning browsers kept the old .wasm with the new loader
// and the scanner silently fell back to the slow detector. Only assets/ may be
// immutable; everything else must revalidate, and does so with a 304.
//
// No framework — plain node + assert. Run: `node test/staticcache.test.js`
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { serveFrontend, IMMUTABLE, REVALIDATE } = require('../src/utils/staticCache');

// http.get rather than fetch. fetch follows the Fetch spec, which adds
// `Cache-Control: no-cache` to any request carrying If-None-Match — and a
// request that says no-cache is never answered 304. A browser revalidating its
// own cached copy sends no such header, and that is the request to test.
function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { get: (name) => res.headers[name.toLowerCase()] || null },
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-staticcache-'));
const files = {
  'index.html': '<!doctype html><script type="module" src="/assets/index-Ab12Cd.js"></script>',
  'assets/index-Ab12Cd.js': 'console.log("bundle")',
  'assets/index-Ab12Cd.js.map': '{}',
  'ort/ort-wasm-simd-threaded.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  'ort/ort-wasm-simd-threaded.mjs': 'export default {}',
  'manifest.webmanifest': '{"name":"Bindarr"}',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'assetsfoo/not-hashed.js': 'only a directory named assets/ is hashed',
};
for (const [rel, body] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
  fs.writeFileSync(path.join(dist, rel), body);
}

async function main() {
  const app = express();
  app.use(serveFrontend(dist));
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers) => request(base + p, headers);

  try {
    for (const p of ['/assets/index-Ab12Cd.js', '/assets/index-Ab12Cd.js.map']) {
      const res = await get(p);
      assert.strictEqual(res.status, 200, p);
      assert.strictEqual(res.headers.get('cache-control'), IMMUTABLE, `${p}: hashed, so a year and immutable`);
    }

    for (const p of ['/ort/ort-wasm-simd-threaded.wasm', '/ort/ort-wasm-simd-threaded.mjs', '/manifest.webmanifest', '/logo.svg', '/index.html', '/assetsfoo/not-hashed.js']) {
      const res = await get(p);
      assert.strictEqual(res.status, 200, p);
      assert.strictEqual(res.headers.get('cache-control'), REVALIDATE, `${p}: a fixed name, so revalidated`);
      const etag = res.headers.get('etag');
      assert.ok(etag, `${p} carries an ETag`);
      assert.ok(res.headers.get('last-modified'), `${p} carries Last-Modified`);
      const again = await get(p, { 'If-None-Match': etag });
      assert.strictEqual(again.status, 304, `${p}: an unchanged file revalidates to a 304`);
    }

    // A new onnxruntime release changes the file under the same name; the next
    // revalidation must get it rather than the 304.
    const wasm = '/ort/ort-wasm-simd-threaded.wasm';
    const oldTag = (await get(wasm)).headers.get('etag');
    fs.writeFileSync(path.join(dist, wasm), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 2, 3]));
    const upgraded = await get(wasm, { 'If-None-Match': oldTag });
    assert.strictEqual(upgraded.status, 200, 'a replaced wasm is served again, not a 304 for the old one');
    assert.strictEqual(upgraded.body.length, 11);

    for (const p of ['/', '/collection', '/decks/12/edit']) {
      const res = await get(p);
      assert.strictEqual(res.status, 200, p);
      assert.match(res.body.toString(), /<!doctype html>/, `${p}: the SPA's index.html`);
      assert.strictEqual(res.headers.get('cache-control'), REVALIDATE, `${p}: index.html is never kept without asking`);
    }

    const api = await get('/api/no-such-route');
    assert.strictEqual(api.status, 404, 'an unknown /api path falls through instead of getting index.html');
    assert.deepStrictEqual(JSON.parse(api.body.toString()), { error: 'not found' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dist, { recursive: true, force: true });
  }
  console.log('staticcache.test.js: hashed assets immutable; /ort/, manifest, logo and index.html revalidate with 304s');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
