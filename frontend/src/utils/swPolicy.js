// What the service worker caches, under which name, and what it leaves alone.
//
// Pure functions, so the rules can be tested in Node. scripts/swPlugin.mjs inlines
// this file into the generated sw.js, which is a classic script: keep it free of
// imports, and export only `const` and `function` declarations.
//
// The rules, in short:
//   * The app shell (index.html, the hashed /assets/ files, icons) is shared by
//     everyone and versioned per build, so a deploy brings a fresh cache.
//   * Authenticated API reads and card images go to a cache named for the
//     session's token hash. Another account on the same device has a different
//     token, so it can never be served the first account's collection, and
//     logging out deletes the whole cache.
//   * The API is always network-first. The cache is only an offline fallback:
//     prices are only worth showing as current when they are.
//   * Writes, auth, admin, exports and anything not listed are never touched, nor
//     are /ort/ and /models/, which the server revalidates itself (pinning them
//     here would undo that).

export const SHELL_PREFIX = 'bindarr-shell-';
export const DATA_PREFIX = 'bindarr-data-';

// Caps per data cache. Images are tens of KB each, so 500 is ~15-30 MB; API
// entries are one per distinct read URL (collection pages, stats, decks...).
export const MAX_IMAGES = 500;
export const MAX_API = 150;

// Set on a response served from the cache because the network failed, so the
// page can tell "offline" apart from "online but slow".
export const OFFLINE_HEADER = 'X-Bindarr-Offline';

// Same-origin files outside /assets/ that the shell needs offline. Not hashed, so
// they are network-first: a new logo or manifest is picked up on the next load.
export const SHELL_FILES = [
  '/manifest.webmanifest',
  '/logo.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

// API reads that are never kept: credentials, admin data, file downloads, and
// the scan pipeline (large, and meaningless offline).
const API_NEVER = [
  /^\/api\/auth\//,
  /^\/api\/admin(\/|$)/,
  /^\/api\/shared\//,
  /^\/api\/card-art\//,
  /^\/api\/export/,
  /^\/api\/import/,
  /^\/api\/scan/,
  /\/download(\/|$)/,
];

export function shellCacheName(version) {
  return `${SHELL_PREFIX}${version}`;
}

export function dataCacheName(userKey) {
  return `${DATA_PREFIX}${userKey}`;
}

// A short, non-reversible key for a bearer token. The token itself never appears
// in a cache name (cache names are readable by any script on the origin).
export async function userKeyFor(authorization, subtle = globalThis.crypto.subtle) {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization || '');
  if (!m) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(m[1]));
  return [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function isCacheableApiPath(pathname) {
  return pathname.startsWith('/api/') && !API_NEVER.some(re => re.test(pathname));
}

// Decide how the worker handles one request. Returns one of:
//   'navigate'  network-first, falling back to the cached index.html
//   'asset'     cache-first (hashed, so a cached copy is never stale)
//   'shell'     network-first, cached copy offline
//   'api'       network-first into the session's data cache
//   'image'     cache-first into the session's data cache
//   'bypass'    not handled; the browser fetches it as if there were no worker
export function classifyRequest({ method, url, origin, mode, destination, authorization }) {
  if (method !== 'GET') return 'bypass';
  const u = new URL(url);
  if (u.origin !== origin) {
    // Card art from the providers' CDNs. Fonts and anything else cross-origin
    // are left to the browser.
    return destination === 'image' && u.protocol === 'https:' ? 'image' : 'bypass';
  }
  const p = u.pathname;
  if (p.startsWith('/api/')) {
    return authorization && isCacheableApiPath(p) ? 'api' : 'bypass';
  }
  if (p.startsWith('/ort/') || p.startsWith('/models/')) return 'bypass';
  if (mode === 'navigate') return 'navigate';
  if (p.startsWith('/assets/') && !p.endsWith('.map')) return 'asset';
  if (SHELL_FILES.includes(p)) return 'shell';
  return 'bypass';
}

// A response worth keeping. The server answers an unknown path (an old chunk
// after a deploy, say) with index.html and a 200, so an asset that comes back as
// HTML is a miss, never something to cache; the page's stale-chunk handling
// needs to see it fail.
export function isCacheableResponse(kind, { status, type, contentType }) {
  if (kind === 'image') return status === 200 || type === 'opaque';
  if (status !== 200) return false;
  const ct = (contentType || '').toLowerCase();
  if (kind === 'api') return ct.includes('application/json');
  if (kind === 'asset') return !ct.includes('text/html');
  if (kind === 'navigate') return ct.includes('text/html');
  return true;
}

// Which caches to drop. Shell caches from other builds go when the new worker
// activates; data caches for any session other than `keepDataName` go whenever
// the current session writes, so one device never holds two accounts' data.
export function staleCaches(names, { version, keepDataName } = {}) {
  return names.filter(n => {
    if (n.startsWith(SHELL_PREFIX)) return version !== undefined && n !== shellCacheName(version);
    if (n.startsWith(DATA_PREFIX)) return keepDataName !== undefined && n !== keepDataName;
    return false;
  });
}

// Oldest-first trim: Cache.keys() lists entries in insertion order. Images and
// API entries share a cache but have separate caps.
export function trimPlan(urls, { origin, maxImages = MAX_IMAGES, maxApi = MAX_API }) {
  const images = [];
  const api = [];
  for (const url of urls) (new URL(url).origin === origin ? api : images).push(url);
  return [
    ...images.slice(0, Math.max(0, images.length - maxImages)),
    ...api.slice(0, Math.max(0, api.length - maxApi)),
  ];
}
