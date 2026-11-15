// Test-only, never imported by the app: renders app components under node:test
// (renderSmoke.test.js and the other *Render/*Controls tests). Vite's own SSR
// loader compiles the JSX and resolves imports the way the app build does, and
// react-dom/server draws the first paint. Effects never run there, so no request
// is made.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The browser globals the app's modules read while loading or rendering. Call
// it at the top of a test file, before anything is loaded.
export function installBrowserGlobals() {
  const storage = new Map();
  globalThis.window = globalThis;
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
    clear: () => storage.clear(),
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.dispatchEvent = () => true;
  globalThis.location = new URL('https://bindarr.test/');
  globalThis.history = { state: null, length: 1, pushState() {}, replaceState() {}, back() {} };
}

// A Vite server in middleware mode (no port), with its dependency cache in a
// temporary folder of its own: never in node_modules/.vite, which a dev server
// or a parallel test run may be using.
export async function startRenderer() {
  const { createServer } = await import('vite');
  const cacheDir = mkdtempSync(join(tmpdir(), 'bindarr-render-'));
  const vite = await createServer({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    cacheDir,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  // The same React the loaded modules use: Vite leaves node_modules to Node.
  const React = await import('react');
  const { renderToString } = await import('react-dom/server');
  return {
    vite,
    React,
    renderToString,
    load: (path) => vite.ssrLoadModule(path),
    render: (Component, props = {}) => renderToString(React.createElement(Component, props)),
    async close() {
      await vite.close();
      rmSync(cacheDir, { recursive: true, force: true });
    },
  };
}
