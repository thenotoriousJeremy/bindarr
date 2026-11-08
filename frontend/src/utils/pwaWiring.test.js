// The installable app is a chain of files pointing at each other: index.html ->
// manifest -> icons, main.jsx -> registerSw -> /sw.js -> swPlugin. The manifest
// this replaced was present for months and never worked (unlinked, icons 404ing,
// no name or start_url), so these check the links, not the files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { shouldRegisterSw } from './registerSw.js';
import { inlinePolicy, precacheList } from '../../scripts/swPlugin.mjs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const html = read('index.html');
const manifest = JSON.parse(read('public/manifest.webmanifest'));

// PNG width/height from the IHDR chunk.
function pngSize(p) {
  const buf = readFileSync(new URL(p, root));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${p} is a PNG`);
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

test('index.html links the manifest, a theme colour and the iOS icon', () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<meta name="theme-color" content="#0a0f1d"/);
  const apple = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html);
  assert.ok(apple, 'iOS ignores manifest icons');
  assert.equal(pngSize(`public${apple[1]}`), '180x180');
});

test('the manifest has what Chrome needs to offer installation', () => {
  for (const field of ['name', 'short_name', 'start_url', 'display', 'background_color', 'theme_color']) {
    assert.ok(manifest[field], `manifest.${field}`);
  }
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
});

test('every manifest icon exists at the size it claims', () => {
  for (const icon of manifest.icons) {
    const p = `public${icon.src}`;
    assert.ok(existsSync(new URL(p, root)), `${icon.src} missing`);
    assert.equal(pngSize(p), icon.sizes, icon.src);
    assert.equal(icon.type, 'image/png');
    // "any maskable" on one icon makes Chrome use a padded icon everywhere or a
    // cropped one everywhere; separate entries let each context pick.
    assert.ok(['any', 'maskable'].includes(icon.purpose), `${icon.src}: one purpose per icon`);
  }
  const has = (purpose, sizes) => manifest.icons.some(i => i.purpose === purpose && i.sizes === sizes);
  assert.ok(has('any', '192x192') && has('any', '512x512'), '192 and 512 are required');
  assert.ok(has('maskable', '512x512'), 'Android crops launcher icons; maskable keeps the artwork');
});

test('the worker registers only on a production web build', () => {
  const ok = { native: false, device: false, prod: true, demo: undefined, supported: true };
  assert.equal(shouldRegisterSw(ok), true);
  assert.equal(shouldRegisterSw({ ...ok, native: true }), false, 'Capacitor serves the bundle from disk');
  assert.equal(shouldRegisterSw({ ...ok, device: true }), false, 'device mode answers /api in the page');
  assert.equal(shouldRegisterSw({ ...ok, prod: false }), false, 'dev: would fight hot reload');
  assert.equal(shouldRegisterSw({ ...ok, demo: 'true' }), false, 'demo runs on a sub-path with a fetch shim');
  assert.equal(shouldRegisterSw({ ...ok, supported: false }), false);
  assert.match(read('src/main.jsx'), /registerServiceWorker\(\{ native: isNative, device: canRunOnDevice/);
  assert.match(read('vite.config.js'), /deviceWeb \? \[servePublicOrt\] : \[serviceWorker\(\{ version: pkg\.version \}\)\]/);
});

test('the build precaches hashed js/css only, never maps, /ort or oversized chunks', () => {
  const bundle = {
    a: { type: 'chunk', fileName: 'assets/index-abc.js', code: 'x' },
    b: { type: 'asset', fileName: 'assets/index-abc.css', source: 'y' },
    c: { type: 'asset', fileName: 'assets/index-abc.js.map', source: 'z' },
    d: { type: 'asset', fileName: 'ort/ort-wasm-simd-threaded.mjs', source: 'w' },
    e: { type: 'chunk', fileName: 'assets/huge-abc.js', code: 'h'.repeat(2 * 1024 * 1024) },
    f: { type: 'asset', fileName: 'index.html', source: '<html>' },
  };
  assert.deepEqual(precacheList(bundle), ['/assets/index-abc.css', '/assets/index-abc.js']);
});

test('the inlined policy is a valid classic script', () => {
  const src = inlinePolicy(read('src/utils/swPolicy.js'));
  assert.doesNotMatch(src, /^export /m);
  // Parses as a non-module script body.
  assert.doesNotThrow(() => new Function(src));
  assert.throws(() => inlinePolicy("import x from 'y';\nexport const a = 1;"), /must not import/);
});
