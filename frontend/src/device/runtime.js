// Device mode: Bindarr's backend running inside this app, with no server anywhere.
//
// Once the user picks "This device" on the login screen, apiBase.js sends every
// /api request here instead of over the network. The backend is
// backend/src/embedded — the same route modules a server runs — bundled into
// ./generated/backend.js by scripts/build-device-backend.mjs. This file gives it
// its database and its scan catalogs, and turns fetch() calls into its requests
// and back.
//
// Loaded only in device mode, so a server-mode app or the web build never
// downloads the bundled backend.
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { createDeviceDriver } from '../utils/deviceSqlite';
import * as scanAssets from './scanAssets';

let booting = null;

// What the backend's scan route sweeps (backend/src/cvScan.js setSource): the
// catalogs this phone has downloaded. Handing it over again drops any catalog it
// already holds in memory, which is how a removed download stops answering.
const scanSource = {
  hasModels: () => scanAssets.modelsReady(),
  hasCatalog: (game) => scanAssets.catalogReady(game),
  loadCatalog: (game) => scanAssets.loadCatalog(game),
};

async function boot() {
  const { default: backend } = await import('./generated/backend.js');
  let plugin = CapacitorSQLite;
  // The browser dev harness (see apiBase.js canRunOnDevice). A static env check,
  // so a normal build drops the branch and never bundles the stand-in.
  if (import.meta.env.VITE_DEVICE_WEB && !Capacitor.isNativePlatform()) {
    plugin = await (await import('./webStore.js')).createWebSqlitePlugin();
  }
  backend.setDriver(createDeviceDriver(plugin));
  const { token } = await backend.start();
  // Scanning is optional: a failure to read what is downloaded must not stop the
  // app from opening. The scan tab then offers the download again.
  await scanAssets.initScanAssets(backend.scanAssets).catch(err => console.warn('Scan data check failed:', err));
  backend.setScanSource(scanSource);
  return { backend, token };
}

// Opens (and on first run creates) the on-device database. Idempotent. A failure
// is kept rather than retried: the database connection is opened once per page
// load, so only a relaunch can try it again.
export function startDevice() {
  if (!booting) booting = boot();
  return booting;
}

// Download a game's scan data (models included when missing). The ready-made
// Pokémon catalog names cards by TCGplayer product id, so it also needs the
// product map a server builds from TCGCSV; that starts here, once, in the
// background, exactly as a server starts it after the same download.
export async function downloadScanData(game) {
  const { backend } = await startDevice();
  await scanAssets.downloadForGame(game);
  backend.setScanSource(scanSource);
  if (game === 'pokemon') {
    const map = await backend.productMap.summary().catch(() => null);
    if (map && !map.rows && !map.progress) backend.productMap.start();
  }
}

export async function removeScanData(game) {
  const { backend } = await startDevice();
  await scanAssets.removeGame(game);
  backend.setScanSource(scanSource);
}

export async function productMapStatus() {
  const { backend } = await startDevice();
  return backend.productMap.summary();
}

async function bodyText(body) {
  if (body === undefined || body === null || typeof body === 'string') return body;
  return new Response(body).text();
}

// A scan's photo, replaced by its embedding. The scanner posts the same body it
// would send a server; the backend here has no Buffer to read a photo with and
// no native ONNX runtime to embed one, so the app does that part (scanEngine.js)
// and the route takes it from the embedding. With no scan data for the game the
// photo is simply dropped: /scan-match then answers notBuilt, and /search returns
// its results unscored.
async function embedScanBody(url, method, body) {
  if (method !== 'POST' || typeof body !== 'string' || !/^\/api\/(scan-match|search)\b/.test(url)) return body;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return body; }
  if (!parsed || typeof parsed.image !== 'string') return body;
  const { image, ...rest } = parsed;
  const game = rest.game || 'pokemon';
  if (!scanAssets.modelsReady() || !scanAssets.catalogReady(game)) return JSON.stringify(rest);
  try {
    const { embedScan } = await import('./scanEngine.js');
    const { embedding, thumb, detected } = await embedScan(image, !!rest.cropped);
    return JSON.stringify({ ...rest, embedding, thumb, detected });
  } catch (err) {
    console.error('On-device scan failed:', err);
    return JSON.stringify(rest);
  }
}

// fetch(), answered in-process. The app's own Authorization header is replaced
// by the device's session: there is one account here, and a token left over from
// a server login means nothing to this database.
export async function deviceFetch(url, init = {}) {
  const { backend, token } = await startDevice();
  const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
  headers.authorization = `Bearer ${token}`;
  const method = (init.method || 'GET').toUpperCase();
  const res = await backend.handle({
    method,
    url,
    headers,
    body: await embedScanBody(url, method, await bodyText(init.body)),
  });
  const empty = res.status === 204 || res.status === 304;
  return new Response(empty ? null : res.body, { status: res.status, headers: res.headers });
}
