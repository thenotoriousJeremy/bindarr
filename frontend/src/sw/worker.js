/* global SW_VERSION, PRECACHE, SHELL_FILES, OFFLINE_HEADER, shellCacheName, dataCacheName, userKeyFor, classifyRequest, isCacheableResponse, staleCaches, trimPlan */
// Service worker body. Not bundled with the app: scripts/swPlugin.mjs prepends
// SW_VERSION, PRECACHE and the rules from utils/swPolicy.js and emits the result
// as /sw.js on a production web build. Registered by utils/registerSw.js, never
// in the native apps (they load the bundle from disk already).
//
// Read-only offline: the shell loads, and the last-fetched collection and card
// art are shown with a banner. Writes are not queued; the page refuses them
// while offline (utils/offline.js).
//
// No skipWaiting. A new build's worker waits until every tab on the old one is
// closed, so a running page keeps the chunks it was built with instead of
// having its cache swapped underneath it. The page's index.html is always
// fetched from the network first, so a reload while online still gets the new
// build; its chunks are fetched (and cached) on demand.

const SHELL = shellCacheName(SW_VERSION);

// The data cache for the session seen on the most recent API read. Image
// requests carry no token, so this is how they find their cache. Lost when the
// browser stops the worker; the next API read sets it again.
let currentData = null;
// Sessions logged out while this worker was running. A read that was in flight
// at logout must not recreate the cache that was just deleted.
const loggedOut = new Set();

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // index.html comes from '/' because the static handler would serve
    // /index.html itself with a year-long immutable header.
    const index = await fetch('/', { cache: 'no-store' });
    if (index.ok) await cache.put('/index.html', index);
    // Best effort per file: one missing icon must not leave the app with no
    // worker at all.
    await Promise.all([...PRECACHE, ...SHELL_FILES].map(url =>
      cache.add(new Request(url, { cache: 'no-cache' })).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const stale = staleCaches(await caches.keys(), { version: SW_VERSION });
    await Promise.all(stale.map(n => caches.delete(n)));
    // Control the page that installed the first worker, so it works offline
    // without a reload. Later builds only activate once the old tabs are gone.
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'logout') {
    if (currentData) loggedOut.add(currentData);
    currentData = null;
    event.waitUntil(caches.keys().then(names =>
      Promise.all(staleCaches(names, { keepDataName: '' }).map(n => caches.delete(n)))));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const kind = classifyRequest({
    method: req.method,
    url: req.url,
    origin: self.location.origin,
    mode: req.mode,
    destination: req.destination,
    authorization: req.headers.get('Authorization'),
  });
  if (kind === 'bypass') return;
  if (kind === 'navigate') event.respondWith(navigate(req));
  else if (kind === 'asset') event.respondWith(asset(req));
  else if (kind === 'shell') event.respondWith(networkFirst(req, SHELL, kind));
  else if (kind === 'api') event.respondWith(api(req));
  else if (kind === 'image') event.respondWith(image(req));
});

const meta = (res) => ({ status: res.status, type: res.type, contentType: res.headers.get('Content-Type') });

function markOffline(res) {
  const headers = new Headers(res.headers);
  headers.set(OFFLINE_HEADER, '1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function navigate(req) {
  try {
    const res = await fetch(req);
    // Every page is the same index.html; keep the newest for offline loads.
    if (isCacheableResponse('navigate', meta(res))) {
      const copy = res.clone();
      caches.open(SHELL).then(c => c.put('/index.html', copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match('/index.html', { cacheName: SHELL })
      || await caches.match('/index.html');
    if (cached) return markOffline(cached);
    throw err;
  }
}

async function asset(req) {
  // Any build's cache: a page still running an older build may ask for a chunk
  // the previous worker cached.
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (isCacheableResponse('asset', meta(res))) {
    const copy = res.clone();
    caches.open(SHELL).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
}

async function networkFirst(req, cacheName, kind) {
  try {
    const res = await fetch(req);
    if (isCacheableResponse(kind, meta(res))) {
      const copy = res.clone();
      caches.open(cacheName).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req, { cacheName });
    if (cached) return markOffline(cached);
    throw err;
  }
}

async function api(req) {
  const key = await userKeyFor(req.headers.get('Authorization'));
  const name = dataCacheName(key);
  if (loggedOut.has(name)) return fetch(req);
  currentData = name;
  try {
    const res = await fetch(req);
    if (isCacheableResponse('api', meta(res))) {
      store(name, req, res.clone()).catch(() => {});
    } else if (res.status === 401) {
      // The session is gone server-side; so is its offline copy.
      loggedOut.add(name);
      currentData = null;
      caches.delete(name).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req, { cacheName: name, ignoreVary: true });
    if (cached) return markOffline(cached);
    throw err;
  }
}

async function image(req) {
  const name = currentData;
  if (!name) return fetch(req);
  const cached = await caches.match(req.url, { cacheName: name });
  if (cached) return cached;
  // CORS first, so the cached copy has a real size; the providers' CDNs allow
  // it. A host that does not falls back to the plain (opaque) image request.
  let res;
  try {
    res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
  } catch {
    res = await fetch(req);
  }
  if (!loggedOut.has(name) && isCacheableResponse('image', meta(res))) {
    store(name, req.url, res.clone()).catch(() => {});
  }
  return res;
}

async function store(name, key, res) {
  const cache = await caches.open(name);
  await cache.put(key, res);
  const keys = await cache.keys();
  const drop = trimPlan(keys.map(k => k.url), { origin: self.location.origin });
  await Promise.all(drop.map(url => cache.delete(url)));
  // One session's data on the device at a time.
  const others = staleCaches(await caches.keys(), { keepDataName: name });
  await Promise.all(others.map(n => caches.delete(n)));
}
