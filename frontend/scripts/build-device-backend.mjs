// Bundles the backend's route modules into the app, for device mode (MOBILE.md).
//
// The phone app can run Bindarr with no server at all: src/device hands each
// /api request to backend/src/embedded, which mounts the same routes server.js
// does. That code is CommonJS written for Node, so it is bundled here, ahead of
// `vite dev` and `vite build` the way copy-ort.mjs stages the ORT wasm, into one
// ES module the app imports only when device mode is switched on.
//
// The Node modules a phone lacks are swapped per backend/src/embedded/aliases.js.
// Every other bare import resolves against the FRONTEND's node_modules — axios is
// a frontend dependency for exactly this — so building the app never needs the
// backend's native dependencies (sqlite3, sharp, onnxruntime-node) installed.
//
// Output: src/device/generated/backend.js (git-ignored, regenerated every run).
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_SRC = path.resolve(FRONTEND, '..', 'backend', 'src');
const OUT_DIR = path.join(FRONTEND, 'src', 'device', 'generated');
const aliases = createRequire(import.meta.url)(path.join(BACKEND_SRC, 'embedded', 'aliases.js'));

const isBackend = (file) => !!file && path.resolve(file.split('?')[0]).startsWith(BACKEND_SRC + path.sep);

const backendDeps = {
  name: 'bindarr-device-backend',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!isBackend(importer)) return null;
    if (Object.hasOwn(aliases, source)) return aliases[source];
    if (source.startsWith('.') || source.startsWith('\0') || path.isAbsolute(source)) return null;
    const resolved = await this.resolve(source, path.join(FRONTEND, 'index.html'), { ...options, skipSelf: true });
    // Fail here rather than let Vite fall back: it would find backend/node_modules
    // on a dev machine and build fine, then fail in CI where only the frontend's
    // dependencies are installed — or, for a Node built-in, quietly bundle an
    // empty module that breaks only on the phone.
    if (!resolved || resolved.external || String(resolved.id).includes('__vite-browser-external')) {
      this.error(`${source} (required by ${path.relative(BACKEND_SRC, importer)}) has no device build. `
        + 'Add it to frontend/package.json, or give it a stand-in in backend/src/embedded/aliases.js.');
    }
    return resolved;
  },
};

await build({
  configFile: false,
  root: FRONTEND,
  logLevel: 'warn',
  plugins: [backendDeps],
  define: {
    // Read only on paths device mode never takes (every one is behind an env var
    // embedded/index.js sets), but a bare reference must not throw at load.
    __dirname: JSON.stringify('/'),
    __filename: JSON.stringify('/index.js'),
  },
  build: {
    lib: {
      entry: path.join(BACKEND_SRC, 'embedded', 'index.js'),
      formats: ['es'],
      fileName: () => 'backend.js',
    },
    outDir: OUT_DIR,
    emptyOutDir: true,
    copyPublicDir: false,
    // The app build minifies and source-maps this file as part of its own
    // bundle, so a readable intermediate keeps those maps pointing at real code.
    minify: false,
    reportCompressedSize: false,
  },
});

console.log(`Bundled the device backend into ${path.relative(FRONTEND, OUT_DIR)}/backend.js`);
