// Offline state for the page, and the read-only rule that goes with it.
//
// "Offline" is either the browser saying so, or the service worker having just
// answered an API read from its cache because the server could not be reached
// (a phone on wifi with the server down still reports navigator.onLine). Any
// API response that came from the network clears the second case.
//
// While offline, API writes are refused here, before they are sent, with a
// 503 { error, code: 'offline' } the calling view shows like any other error.
// Nothing is queued: a write replayed later against a collection that has
// moved on is worse than one that plainly did not happen.
import { DATA_PREFIX, OFFLINE_HEADER } from './swPolicy.js';

let unreachable = false;
const listeners = new Set();
let writeBlockedText = 'You are offline. Changes cannot be saved until the connection is back.';

const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export const isOffline = () => browserOffline() || unreachable;

function setUnreachable(next) {
  if (next === unreachable) return;
  unreachable = next;
  const offline = isOffline();
  listeners.forEach(fn => fn(offline));
}

export function subscribeOffline(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { unreachable = false; listeners.forEach(fn => fn(isOffline())); });
  window.addEventListener('offline', () => listeners.forEach(fn => fn(true)));
}

// App sets the translated text once the locale is loaded.
export const setWriteBlockedText = (text) => { writeBlockedText = text; };

export const isWriteMethod = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());

// Called with every /api response the page receives.
export function noteApiResponse(res) {
  setUnreachable(res?.headers?.get(OFFLINE_HEADER) === '1');
}

// Called when an /api request could not reach the server at all.
export const noteApiUnreachable = () => setUnreachable(true);

export function offlineWriteResponse() {
  return new Response(JSON.stringify({ error: writeBlockedText, code: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Logout: drop every session's offline data, and tell the worker so a read
// still in flight is not cached under the old session afterwards.
export async function clearOfflineData(
  cacheStorage = globalThis.caches,
  serviceWorker = globalThis.navigator?.serviceWorker,
) {
  try {
    serviceWorker?.controller?.postMessage({ type: 'logout' });
    if (!cacheStorage) return;
    const names = await cacheStorage.keys();
    await Promise.all(names.filter(n => n.startsWith(DATA_PREFIX)).map(n => cacheStorage.delete(n)));
  } catch (err) {
    console.warn('Could not clear offline data:', err);
  }
}
