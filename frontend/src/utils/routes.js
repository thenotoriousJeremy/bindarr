// The app's URL scheme: which path each tab (and the sub-view inside it) lives
// at. Pure functions only, so they run under node:test; utils/router.js wires
// them to the browser history.
//
// A tab is one path segment; a few tabs take one more segment naming what is
// open inside them (a deck, a list, a storage container). Ids are kept as
// strings here, the components convert. Public share pages (/share/...) are not
// app routes and parse to null, as does anything unknown.

export const TAB_PATHS = {
  dashboard: '',
  'add-cards': 'add',
  collection: 'collection',
  storage: 'storage',
  deckbuilder: 'decks',
  lists: 'lists',
  notes: 'notes',
  sealed: 'sealed',
  settings: 'settings',
  admin: 'admin',
};

// Tabs whose second segment names a sub-view, and what that segment may be.
const PARAM_PATTERNS = {
  storage: /^\d+$/,
  deckbuilder: /^\d+$/,
  lists: /^\d+$/,
};

const TAB_BY_SEGMENT = Object.fromEntries(Object.entries(TAB_PATHS).map(([tab, seg]) => [seg, tab]));

// '/decks/12' -> { tab: 'deckbuilder', param: '12' }; '/' -> dashboard.
// A trailing slash is tolerated. Returns null for anything that is not a route.
export function parseRoute(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  const parts = path.split(/[?#]/)[0].split('/').filter(Boolean).map(p => {
    try { return decodeURIComponent(p); } catch { return null; }
  });
  if (parts.some(p => p == null)) return null;
  if (parts.length === 0) return { tab: 'dashboard', param: null };
  const tab = TAB_BY_SEGMENT[parts[0]];
  if (!tab || tab === 'dashboard' || parts.length > 2) return null;
  if (parts.length === 1) return { tab, param: null };
  const pattern = PARAM_PATTERNS[tab];
  return pattern && pattern.test(parts[1]) ? { tab, param: parts[1] } : null;
}

// The inverse: routePath('deckbuilder', 12) -> '/decks/12'.
export function routePath(tab, param = null) {
  const seg = TAB_PATHS[tab];
  if (seg == null) return '/';
  const base = `/${seg}`;
  return param == null || param === '' || !PARAM_PATTERNS[tab] ? base : `${base}/${encodeURIComponent(String(param))}`;
}

// The app lives under Vite's base ('/' normally, '/bindarr/' for the demo
// build). These convert between the browser's pathname and the app path.
export function stripBase(pathname, base = '/') {
  const b = base.replace(/\/+$/, '');
  if (!b) return pathname || '/';
  if (pathname === b) return '/';
  return pathname.startsWith(`${b}/`) ? pathname.slice(b.length) : pathname;
}

export function withBase(path, base = '/') {
  return base.replace(/\/+$/, '') + path;
}

// A deep link opened while signed out is kept here through the login screen
// (including an SSO round trip through the identity provider, which comes back
// to '/'), and taken once the session starts. sessionStorage: per tab, gone when
// the tab closes.
const INTENDED_KEY = 'bindarr_intended_path';

export function rememberIntended(path, storage = globalThis.sessionStorage) {
  // '/' is where the SSO redirect lands; it must not overwrite the real target.
  if (!path || path === '/' || !parseRoute(path)) return;
  try { storage.setItem(INTENDED_KEY, path); } catch { /* storage blocked */ }
}

export function clearIntended(storage = globalThis.sessionStorage) {
  try { storage.removeItem(INTENDED_KEY); } catch { /* storage blocked */ }
}

// Read-once. Re-validated on the way out: only an app path on this origin, never
// a '//host' or absolute URL, whatever ended up in storage.
export function takeIntended(storage = globalThis.sessionStorage) {
  let path = null;
  try {
    path = storage.getItem(INTENDED_KEY);
    storage.removeItem(INTENDED_KEY);
  } catch { return null; }
  return path && parseRoute(path) ? path : null;
}
