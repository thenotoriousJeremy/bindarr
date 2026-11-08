import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createNavHistory } from './navHistory';
import { parseRoute, routePath, stripBase, withBase, rememberIntended, clearIntended, takeIntended } from './routes';

// The app's router: a small store over the History API (no react-router). The
// URL is the source of truth for which tab is shown and what is open inside the
// deck, list and storage tabs; utils/routes.js has the path scheme.
//
// Tabs stay mounted while hidden (App.jsx), so each tab remembers the last path
// it was shown at: switching back to Decks returns to the deck that was open,
// and a hidden tab's sub-view never changes because another tab's URL did.

const BASE = (import.meta.env && import.meta.env.BASE_URL) || '/';

let nav = null;
export function getNav() {
  if (!nav) nav = createNavHistory(window);
  return nav;
}

const readPath = () => stripBase(window.location.pathname, BASE);

let current = readPath();
const lastPathByTab = {};
const listeners = new Set();

function setCurrent(path) {
  const route = parseRoute(path);
  if (route) lastPathByTab[route.tab] = path;
  if (path === current) return;
  current = path;
  listeners.forEach(fn => fn());
}
setCurrent(current);

// Back/Forward (and anything else that pops history) moves the store too.
let hooked = false;
function subscribe(fn) {
  if (!hooked) {
    hooked = true;
    getNav().subscribe(() => setCurrent(readPath()));
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A new session must not inherit the last one's open decks and lists.
function forgetTabPaths() {
  for (const tab of Object.keys(lastPathByTab)) delete lastPathByTab[tab];
  setCurrent(current);
}

export const currentPath = () => current;

export function navigate(path, { replace = false } = {}) {
  if (path === current && !replace) return;
  const from = current;
  setCurrent(path);
  if (replace) getNav().replace(withBase(path, BASE), { from: getNav().state()?.from });
  else getNav().push(withBase(path, BASE), { from });
}

// Go up to `path` (deck -> deck list). When the current entry was opened from
// there, step back to it rather than stacking a new entry, so Back afterwards
// leaves the tab instead of reopening what was just closed.
function navigateUp(path) {
  const n = getNav();
  if (n.state()?.from === path && n.canGoBack()) {
    setCurrent(path);
    n.back();
  } else {
    navigate(path);
  }
}

// Switch tab, landing on whatever the tab last showed.
export function goToTab(tab) {
  const route = parseRoute(current);
  if (route && route.tab === tab) return;
  navigate(lastPathByTab[tab] || routePath(tab));
}

// What is open in a tab: the route's id segment, or null. Read from the tab's
// last path, so a hidden tab keeps its value.
export function getTabParam(tab) {
  const route = parseRoute(lastPathByTab[tab] || '');
  return route ? route.param : null;
}

// Open (value) or close (null) a tab's sub-view. On the shown tab this is
// navigation; on a hidden one it only updates what the tab will show next.
export function setTabParam(tab, value, { replace = false } = {}) {
  const path = routePath(tab, value);
  const route = parseRoute(current);
  if (!route || route.tab !== tab) {
    if (lastPathByTab[tab] !== path) {
      lastPathByTab[tab] = path;
      listeners.forEach(fn => fn());
    }
    return;
  }
  if (path === current) return;
  if (value == null && !replace) navigateUp(path);
  else navigate(path, { replace });
}

export function useRoutePath() {
  return useSyncExternalStore(subscribe, currentPath);
}

export function useTabParam(tab) {
  return useSyncExternalStore(subscribe, () => getTabParam(tab));
}

// App.jsx's half: keeps the shown tab in step with the URL, and carries a deep
// link through the login screen.
//   enabled  - false on public share pages, which the router leaves alone
//   signedIn - whether the app (not the login screen) is showing
//   showTab  - App's tab switch (it saves the scroll offset of the tab it leaves)
export function useRouteSync({ enabled, signedIn, activeTab, showTab }) {
  const path = useRoutePath();
  const wasSignedIn = useRef(signedIn);
  const expired = useRef(false);

  // A 401 ends the session where you are; come back here after signing in.
  useEffect(() => {
    const onExpired = () => {
      expired.current = true;
      rememberIntended(currentPath());
    };
    window.addEventListener('bindarr_logout', onExpired);
    return () => window.removeEventListener('bindarr_logout', onExpired);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const was = wasSignedIn.current;
    wasSignedIn.current = signedIn;
    if (!signedIn) {
      if (was) forgetTabPaths();
      if (was && !expired.current) {
        // Logging out on purpose: the next sign-in starts fresh.
        clearIntended();
        navigate('/', { replace: true });
      } else {
        rememberIntended(path);
      }
      return;
    }
    expired.current = false;
    if (!was) {
      const intended = takeIntended();
      if (intended && intended !== path) navigate(intended, { replace: true });
    }
  }, [enabled, signedIn, path]);

  // Layout effect: the tab changes in the same frame as the URL.
  useLayoutEffect(() => {
    if (!enabled || !signedIn) return;
    const route = parseRoute(path);
    if (!route) { navigate('/', { replace: true }); return; }
    if (route.tab !== activeTab) showTab(route.tab);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- showTab is a fresh closure every App render
  }, [enabled, signedIn, path, activeTab]);
}

// The tab to show on first render, before any effect runs.
export function initialTab() {
  const route = parseRoute(current);
  return route ? route.tab : 'dashboard';
}
