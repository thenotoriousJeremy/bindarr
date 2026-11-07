// The app's URL scheme: which path each tab (and the sub-view inside it) lives
// at. Pure functions only, so they run under node:test; utils/router.js wires
// them to the browser history.
//
// A tab is one path segment; a few tabs take more segments naming what is open
// inside them (a deck, a list, a storage container, a set). The param is those
// segments joined by '/', kept as a string; the components convert. Public share pages (/share/...) are not
// app routes and parse to null, as does anything unknown.

export const TAB_PATHS = {
  dashboard: '',
  'add-cards': 'add',
  collection: 'collection',
  sets: 'sets',
  storage: 'storage',
  deckbuilder: 'decks',
  lists: 'lists',
  notes: 'notes',
  sealed: 'sealed',
  settings: 'settings',
  admin: 'admin',
};

// Tabs with a sub-view, and what each of its segments may be. Sets takes
// game/set and an optional language: /sets/pokemon/sv3pt5, /sets/pokemon/sv1a/ja.
// Set ids are the providers' (sv3pt5, mh3, 1, SV1a...), so anything but '/'.
const SET_SEGMENT = /^[^/]{1,60}$/;
const PARAM_PATTERNS = {
  storage: [/^\d+$/],
  deckbuilder: [/^\d+$/],
  lists: [/^\d+$/],
  sets: [/^[a-z]{2,20}$/, SET_SEGMENT, /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/],
};
// How many of a tab's segments are required.
const PARAM_REQUIRED = { sets: 2 };

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
  if (!tab || tab === 'dashboard') return null;
  if (parts.length === 1) return { tab, param: null };
  const patterns = PARAM_PATTERNS[tab];
  const rest = parts.slice(1);
  if (!patterns || rest.length > patterns.length || rest.length < (PARAM_REQUIRED[tab] || 1)) return null;
  return rest.every((seg, i) => patterns[i].test(seg)) ? { tab, param: rest.join('/') } : null;
}

// The inverse: routePath('deckbuilder', 12) -> '/decks/12'. A multi-segment
// param is given joined ('pokemon/sv1') or as an array.
export function routePath(tab, param = null) {
  const seg = TAB_PATHS[tab];
  if (seg == null) return '/';
  const base = `/${seg}`;
  if (param == null || param === '' || !PARAM_PATTERNS[tab]) return base;
  const parts = Array.isArray(param) ? param.filter(p => p != null && p !== '') : String(param).split('/');
  return `${base}/${parts.map(p => encodeURIComponent(String(p))).join('/')}`;
}

// The Sets tab's param <-> { game, set, lang }. lang is left out of the path
// for English, the default.
export function setParam({ game, set, lang } = {}) {
  if (!game || !set) return null;
  return [game, set, lang && lang !== 'en' ? lang : null].filter(Boolean).join('/');
}

export function parseSetParam(param) {
  if (!param) return null;
  const [game, set, lang] = param.split('/');
  return game && set ? { game, set, lang: lang || 'en' } : null;
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
  let path;
  try {
    path = storage.getItem(INTENDED_KEY);
    storage.removeItem(INTENDED_KEY);
  } catch { return null; }
  return path && parseRoute(path) ? path : null;
}
