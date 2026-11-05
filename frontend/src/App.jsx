import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, Suspense } from 'react';
import { LayoutDashboard, Database, MapPin, Sparkles, Settings as SettingsIcon, LogOut, ShieldAlert, Plus, Swords, StickyNote, Package, ListChecks, Smartphone, Library } from 'lucide-react';
import Login from './components/Login';
import Logo from './components/Logo';
import { App as CapacitorApp } from '@capacitor/app';
import { useRouteSync, goToTab, initialTab } from './utils/router';
import { useT } from './utils/i18n';
import { useStableCallback } from './utils/useStableCallback';
import { clearApiCache } from './utils/useApi';
import { isNative, isDeviceMode, setDeviceMode } from './apiBase';
import { parseOidcReturn, takeVerifier } from './utils/nativeOidc';
import { isSessionExpired } from './utils/sessionExpiry';
import { loadStoredUser, saveStoredUser } from './utils/storedUser';
import { readOidcCode } from './utils/webOidc';
import { clearOfflineData, isOffline, isWriteMethod, noteApiResponse, noteApiUnreachable, offlineWriteResponse, setWriteBlockedText, subscribeOffline } from './utils/offline';
import { lazyWithReload } from './utils/lazyWithReload';
import { useNameDictionaries } from './utils/useNameDictionaries';
import { navBarTabs, litNavTab, collectionTarget, isCollectionView } from './utils/navTabs';
import { wishlist } from './utils/wishlist';
import CollectionViews from './components/CollectionViews';

// View components are code-split so heavy deps (recharts in the chart views)
// load on demand instead of in the initial bundle. A view whose chunk an upgrade
// removed reloads the page once rather than crashing (see utils/chunkReload).
const Dashboard = lazyWithReload(() => import('./components/Dashboard'));
const AddCards = lazyWithReload(() => import('./components/AddCards'));
const CollectionList = lazyWithReload(() => import('./components/CollectionList'));
const LocationManager = lazyWithReload(() => import('./components/LocationManager'));
const Settings = lazyWithReload(() => import('./components/Settings'));
const AdminPanel = lazyWithReload(() => import('./components/AdminPanel'));
const SetupWizard = lazyWithReload(() => import('./components/SetupWizard'));
const SharedCollection = lazyWithReload(() => import('./components/SharedCollection'));
const SharedContainer = lazyWithReload(() => import('./components/SharedContainer'));
const DeckBuilder = lazyWithReload(() => import('./components/DeckBuilder'));
const Lists = lazyWithReload(() => import('./components/Lists'));
const Notes = lazyWithReload(() => import('./components/Notes'));
const SealedList = lazyWithReload(() => import('./components/SealedList'));
const SetCompletion = lazyWithReload(() => import('./components/SetCompletion'));

// Each nav-bar tab's label and icon. Which of them the bar shows is the user's
// choice (utils/navTabs.js, Settings).
const NAV_TAB_META = {
  dashboard: ['nav.dashboard', LayoutDashboard],
  'add-cards': ['nav.addCards', Plus],
  collection: ['nav.collection', Database],
  sets: ['nav.browse', Library],
  storage: ['nav.storage', MapPin],
  deckbuilder: ['nav.deckBuilder', Swords],
  lists: ['nav.lists', ListChecks],
  notes: ['nav.notes', StickyNote],
  sealed: ['nav.sealed', Package],
  settings: ['nav.settings', SettingsIcon],
  admin: ['nav.admin', ShieldAlert],
};

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }
  // Tabs stay mounted while hidden, so a crash would otherwise persist until a
  // manual reload. Clearing it when its tab is left gives the view a fresh try
  // the next time it is opened.
  componentDidUpdate(prevProps) {
    if (prevProps.active && !this.props.active && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }
  render() {
    if (this.state.hasError) {
      // Class component, so no hook: App hands t down as a prop.
      const t = this.props.t;
      return (
        <div style={{ padding: '2rem', color: 'var(--text-strong)', background: 'rgba(255,0,0,0.1)', border: '1px solid red', borderRadius: '8px', margin: '2rem' }}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem', color: 'var(--accent-red)' }}>{t('error.crashed')}</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ff8888', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '4px', fontSize: '0.85rem' }}>{this.state.error && this.state.error.toString()}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', marginTop: '1rem', color: 'var(--text-secondary)' }}>{this.state.error && this.state.error.stack}</pre>
          <button className="btn btn-primary" style={{ marginTop: '1.5rem' }} onClick={() => window.location.reload()}>{t('error.reload')}</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Fallback shown while a lazily-loaded view chunk is fetched.
function ChunkFallback() {
  const { t } = useT();
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
      <div className="spinner" aria-label={t('common.loading')} />
    </div>
  );
}

// Global fetch interceptor to append authorization headers and handle 401s
const originalFetch = window.fetch;
window.fetch = function (input, options = {}) {
  // `input` may be a string, a URL, or a Request object — normalize before using string methods.
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const isPublicOrAuthRoute = url.includes('/api/shared/') || url.includes('/api/auth/login') || url.includes('/api/auth/register') || url.includes('/api/auth/bootstrap') || url.includes('/api/auth/oidc/exchange');

  // Device mode answers /api on the phone itself, so being offline changes
  // nothing there: no banner, no refused writes.
  const isApi = url.startsWith('/api/') && !isDeviceMode();
  const write = isApi && isWriteMethod(options.method || (input && input.method));
  // Read-only while offline (utils/offline.js): refuse the write up front with a
  // message the view can show, rather than a network error it can only guess at.
  if (write && isOffline()) {
    window.dispatchEvent(new Event('bindarr_offline_write'));
    return Promise.resolve(offlineWriteResponse());
  }

  const token = localStorage.getItem('bindarr_token');
  const finalOptions = { ...options };
  if (token && url.startsWith('/api/') && !isPublicOrAuthRoute) {
    finalOptions.headers = {
      ...finalOptions.headers,
      'Authorization': `Bearer ${token}`
    };
  }
  return originalFetch(input, finalOptions).then(response => {
    if (isApi) noteApiResponse(response);
    if (response.status === 401 && !isPublicOrAuthRoute) {
      // Only the auth gate's "this session is gone" signs out -- not every 401
      // (utils/sessionExpiry). Read off a clone, so the caller still gets the body.
      isSessionExpired(response).then(expired => {
        if (expired) window.dispatchEvent(new Event('bindarr_logout'));
      });
    }
    return response;
  }, err => {
    if (!isApi) throw err;
    noteApiUnreachable();
    if (!write) throw err;
    window.dispatchEvent(new Event('bindarr_offline_write'));
    return offlineWriteResponse();
  });
};

// bindarr://oidc links already acted on. Module-level, not state: getLaunchUrl
// keeps returning the link that cold-started the app for its whole lifetime, and
// the effect that reads it re-runs. Without this, signing out and starting a new
// SSO login would replay that old, spent code -- and burn the NEW login's verifier
// on it.
const handledOidcReturns = new Set();

function App() {
  const { t } = useT();
  // Names of non-English cards come from dictionaries fetched on first use
  // (utils/langHelper). Re-render once they land, so every open view swaps the
  // English names it drew in the meantime.
  useNameDictionaries();
  const [token, setToken] = useState(localStorage.getItem('bindarr_token'));
  // Through utils/storedUser, which also strips the API keys older builds kept in
  // this copy.
  const [user, setUser] = useState(() => loadStoredUser());

  // Follows the URL (utils/router.js); a reload lands back on the same tab.
  const [activeTab, setActiveTab] = useState(initialTab);
  // First-run scanning setup. Asked once per session, only for an admin, and only
  // while it is genuinely incomplete — setupNeeded() reads the same endpoints the
  // wizard does so there is one definition of 'set up'.
  const [showSetup, setShowSetup] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [focusEntryId, setFocusEntryId] = useState(null);
  const [selectedCardFilter, setSelectedCardFilter] = useState('');
  const [toast, setToast] = useState(null);
  const [statsTrigger, setStatsTrigger] = useState(0);
  // The set the Sets tab should open, from the dashboard's set-progress list. A
  // new object per click, so reopening the same set still reaches the tab.
  const [focusSet, setFocusSet] = useState(null);
  const [offline, setOffline] = useState(isOffline);
  // The Collection sub-view last open (CollectionViews), where the Collection
  // tab takes you back to from elsewhere. Adjusted during render, like mountedTabs.
  const [lastCollectionView, setLastCollectionView] = useState(isCollectionView(activeTab) ? activeTab : 'collection');
  if (isCollectionView(activeTab) && activeTab !== lastCollectionView) setLastCollectionView(activeTab);

  // Every tab opened this session stays mounted (hidden when inactive), so its
  // filters, search, open deck/container and inner scroll boxes are still there
  // when you come back. Mounted lazily: a tab costs nothing until first opened.
  // Adjusted during render rather than in an effect so the new tab mounts in
  // the same commit that activates it.
  const [mountedTabs, setMountedTabs] = useState([activeTab]);
  if (!mountedTabs.includes(activeTab)) setMountedTabs([...mountedTabs, activeTab]);

  // The page itself (window) is the scroller, shared by every tab, so each
  // tab's offset is read as you leave it (showTab, before the DOM changes — a
  // scroll listener would race the page shrinking) and put back when it
  // returns (the restoring layout effect sits below the tab-bar fit check).
  const scrollByTabRef = useRef({});
  const shownTabRef = useRef(activeTab);
  const showTab = (tab) => {
    scrollByTabRef.current[shownTabRef.current] = window.scrollY;
    setActiveTab(tab);
  };

  // A focus request is consumed by the storage tab; clear it once you leave so
  // the same card can be located again, and so a stale target doesn't keep
  // suppressing storage's own default selection.
  useEffect(() => {
    if (activeTab !== 'storage') setFocusEntryId(null);
  }, [activeTab]);

  // A new session starts with only the landing tab mounted, so nothing from the
  // previous account's views lingers. Used by both logout paths; it touches only
  // state setters and a ref, so the 401 listener can call it without re-binding.
  const resetTabs = () => {
    clearApiCache();
    setActiveTab('dashboard');
    setMountedTabs(['dashboard']);
    setFocusSet(null);
    setLastCollectionView('collection');
    wishlist.reset();
    scrollByTabRef.current = {};
  };

  // Navigate tabs through here: it pushes the tab's URL, so Back and Forward walk
  // tab history, and useRouteSync below then shows the tab.
  // Stable identity (as are showToast and triggerRefresh): the tabs are
  // memoized, and a toast appearing re-renders App, which must not re-render
  // a 20,000-card grid through a handler prop that merely looks new.
  const goTab = useStableCallback((tab) => {
    if (tab !== activeTab) goToTab(tab);
  });
  const openSet = useCallback((target) => { setFocusSet({ ...target }); goTab('sets'); }, [goTab]);

  // Detect public share route on load
  const [shareToken] = useState(() => {
    const path = window.location.pathname;
    const match = path.match(/^\/share\/([a-zA-Z0-9_-]+)$/);
    return match ? match[1] : null;
  });
  const [sharedContainerId] = useState(() => {
    const id = new URLSearchParams(window.location.search).get('container');
    return /^\d+$/.test(id || '') ? id : null;
  });

  useRouteSync({ enabled: !shareToken, signedIn: !!(token && user), activeTab, showTab });

  // showToast(message) for a note; showToast(message, { onAction, actionLabel })
  // adds a button (Undo by default) and keeps the toast up long enough to use it.
  // Stable identity: the tabs are memoized and receive it as a prop.
  const showToast = useCallback((message, options) => {
    setToast({ message, ...(options || {}), id: Date.now() + Math.random() });
  }, []);

  // Web SSO return. The callback sends the browser back with ?oidc_code=..., a
  // one-time code that redeems only together with the HttpOnly cookie set when
  // THIS browser started the login (utils/webOidc) -- never the session itself,
  // which the old ?oidc_token= / ?token= sign-in took from any link. Off the URL
  // before it is used, so a reload or the history cannot present it again; and,
  // as with the native hand-off below, the answer is not dropped on a re-run (the
  // code is spent by then, and a second pass finds nothing left to read).
  useEffect(() => {
    if (isNative) return;
    const ret = readOidcCode(window.location.href);
    if (!ret) return;
    window.history.replaceState(window.history.state, document.title, ret.cleanUrl);
    fetch('/api/auth/oidc/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ret.code })
    })
      .then(res => res.json().then(data => (res.ok ? data : Promise.reject(new Error(data.error || 'exchange failed')))))
      .then(data => {
        if (!data.token || !data.user) return;
        // Same completion as handleLoginSuccess, as in the native hand-off.
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem('bindarr_token', data.token);
        saveStoredUser(data.user);
        showToast(t('toast.welcomeBack', { name: data.user.username }));
        setActiveTab('dashboard');
      })
      .catch(err => {
        console.error('OIDC exchange failed:', err);
        showToast(t('login.errOidcFailed'));
      });
  }, [t, showToast]);

  // Native SSO return (issue #94). The login ran in the system browser; the
  // server sends it back as bindarr://oidc?code=... (or ?oidc_error=...), either
  // to the running app (appUrlOpen) or as the link that cold-started it
  // (getLaunchUrl). The code is useless without the verifier Login.jsx stored, and
  // with no verifier pending this app never started a login -- so the link is
  // ignored rather than signing the user into whatever account it names.
  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    let listener = null;

    const handleUrl = (url) => {
      const ret = parseOidcReturn(url);
      // The launch URL and appUrlOpen can both report the same link.
      if (!ret || handledOidcReturns.has(url)) return;
      handledOidcReturns.add(url);
      const verifier = takeVerifier();
      if (!verifier) return;

      if (ret.error) {
        showToast(ret.error);
        return;
      }
      fetch('/api/auth/oidc/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ret.code, verifier })
      })
        .then(res => res.json().then(data => (res.ok ? data : Promise.reject(new Error(data.error || 'exchange failed')))))
        .then(data => {
          // Deliberately not gated on `cancelled`: the code and verifier are both
          // spent by now, and on a cold start the locale finishing its load (a new
          // `t`) re-runs this effect mid-request -- dropping the answer then would
          // sign nobody in and leave nothing to retry with.
          if (!data.token || !data.user) return;
          // Same completion as handleLoginSuccess, inlined so this listener does
          // not have to be re-registered on every render.
          setToken(data.token);
          setUser(data.user);
          localStorage.setItem('bindarr_token', data.token);
          saveStoredUser(data.user);
          showToast(t('toast.welcomeBack', { name: data.user.username }));
          setActiveTab('dashboard');
        })
        .catch(err => {
          console.error('OIDC native exchange failed:', err);
          showToast(t('login.errOidcFailed'));
        });
    };

    CapacitorApp.addListener('appUrlOpen', (event) => handleUrl(event.url))
      .then(handle => { if (cancelled) handle.remove(); else listener = handle; })
      .catch(err => console.error('appUrlOpen listener failed:', err));
    CapacitorApp.getLaunchUrl()
      .then(launch => { if (!cancelled && launch && launch.url) handleUrl(launch.url); })
      .catch(() => { /* no launch URL */ });

    return () => {
      cancelled = true;
      if (listener) listener.remove();
    };
  }, [t, showToast]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, toast.onAction ? 6000 : 2500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Fit the tab bar by measuring, not by breakpoint. How much room the tabs
  // need depends on Android's system font scale (the WebView honours it), the
  // language (German and Russian labels run long) and whether the admin tab is
  // shown — no media query can see any of that. Each pass starts from the
  // least compact state, so widening the window brings labels and the greeting
  // back, then steps down only while something still doesn't fit:
  //   .nav-tight on the header   -> greeting hidden (top bar only, index.css)
  //   .nav-compact on the bar    -> icons only, except the active tab
  //   .nav-tighter on the header -> "Bindarr" wordmark hidden, mark stays
  //                                 (top bar only)
  // and past that the bar's hidden-scrollbar overflow is the last resort.
  // Layout effect + classList (no state): measured and settled before paint,
  // so there is no flash and no re-render.
  const navRef = useRef(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const header = nav.closest('.app-header');
    const fits = () => nav.scrollWidth <= nav.clientWidth + 1
      && ![...nav.querySelectorAll('.nav-tab-label')].some(l => l.scrollWidth > l.clientWidth + 1);
    const steps = [[header, 'nav-tight'], [nav, 'nav-compact'], [header, 'nav-tighter']];
    const step = () => {
      for (const [el, cls] of steps) el?.classList.remove(cls);
      for (const [el, cls] of steps) {
        if (fits()) return;
        el?.classList.add(cls);
      }
    };
    // Tabs transition their padding; .nav-measuring switches that off so each
    // fits() reads the real size, and the settled layout is flushed before it
    // is switched back on so nothing animates afterwards.
    const check = () => {
      nav.classList.add('nav-measuring');
      step();
      void nav.offsetWidth;
      nav.classList.remove('nav-measuring');
    };
    check();
    window.addEventListener('resize', check);
    // Web fonts change label widths after first paint.
    document.fonts?.ready.then(check).catch(() => {});
    return () => window.removeEventListener('resize', check);
  }, [token, user, activeTab, t]);

  // Put the shown tab's page offset back (see showTab). Before paint, so there
  // is no flash of the old offset, and declared after the fit check above on
  // purpose: that check resizes the header, and scroll anchoring would shift a
  // restore made before it by a few pixels. Storage's focus-a-card scroll runs
  // later (passive effect) and wins.
  useLayoutEffect(() => {
    shownTabRef.current = activeTab;
    window.scrollTo(0, scrollByTabRef.current[activeTab] || 0);
  }, [activeTab]);

  // Offer first-run setup to an admin until it is finished or skipped. The flag
  // lives on the server, so closing the wizard halfway resumes it at the next
  // login on any device; everything it configures is also reachable from Settings
  // and Admin. Not in device mode: the wizard sets up a server's scan models and
  // catalogs, and nothing it offers applies to a phone on its own.
  useEffect(() => {
    if (!user || user.role !== 'admin' || isDeviceMode()) return;
    let cancelled = false;
    import('./components/SetupWizard')
      .then(m => m.setupNeeded())
      .then(needed => { if (needed && !cancelled) setShowSetup(true); })
      .catch(() => { /* never block the app on the wizard's own probe */ });
    return () => { cancelled = true; };
  }, [user]);

  // Offline banner, and the message a refused write carries (utils/offline.js).
  useEffect(() => subscribeOffline(setOffline), []);
  useEffect(() => {
    setWriteBlockedText(t('offline.writeBlocked'));
    const onBlocked = () => setToast(t('offline.writeBlocked'));
    window.addEventListener('bindarr_offline_write', onBlocked);
    return () => window.removeEventListener('bindarr_offline_write', onBlocked);
  }, [t]);

  // Handle automatic logout on 401
  useEffect(() => {
    const handleAutoLogout = () => {
      setToken(null);
      setUser(null);
      localStorage.removeItem('bindarr_token');
      localStorage.removeItem('bindarr_user');
      clearOfflineData();
      resetTabs();
      showToast(t('toast.sessionExpired'));
    };
    window.addEventListener('bindarr_logout', handleAutoLogout);
    return () => window.removeEventListener('bindarr_logout', handleAutoLogout);
  }, [t, showToast]);

  // The stored user is a copy, and one saved by an older build has no has_* key
  // flags (it had the keys themselves, which loadStoredUser drops), so Settings
  // would call every saved key "not set". Re-read it once per session start. An
  // unchanged answer keeps the same object, so nothing keyed on `user` re-runs.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch('/api/auth/me')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (cancelled || !data || !data.user) return;
        setUser(prev => (JSON.stringify(prev) === JSON.stringify(data.user) ? prev : data.user));
        saveStoredUser(data.user);
      })
      .catch(() => { /* offline or server down: the stored copy stands */ });
    return () => { cancelled = true; };
  }, [token]);

  // Pointer-reactive foil: one delegated listener drives --px/--py (0-100%) on
  // whichever card the pointer is over, so the holo/reverse-holo rainbow tracks
  // the cursor (MTG-style). CSS custom props inherit down to the overlay div.
  useEffect(() => {
    const onMove = (e) => {
      const card = e.target.closest && e.target.closest('.tilt-card-wrapper');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--px', `${((e.clientX - r.left) / r.width) * 100}%`);
      card.style.setProperty('--py', `${((e.clientY - r.top) / r.height) * 100}%`);
      card.classList.add('foil-active');
    };
    const onLeave = (e) => {
      const card = e.target.closest && e.target.closest('.tilt-card-wrapper');
      if (card) card.classList.remove('foil-active');
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerout', onLeave, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerout', onLeave);
    };
  }, []);

  const handleLoginSuccess = (newToken, newUser) => {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('bindarr_token', newToken);
    saveStoredUser(newUser);
    showToast(isDeviceMode() ? t('toast.deviceReady') : t('toast.welcomeBack', { name: newUser.username }));
    setActiveTab('dashboard');
  };

  // Device mode → back to the login screen to pick a server. The collection stays
  // in the on-device database, so choosing "This device" again finds it intact.
  const handleLeaveDevice = () => {
    setDeviceMode(false);
    setToken(null);
    setUser(null);
    localStorage.removeItem('bindarr_token');
    localStorage.removeItem('bindarr_user');
    resetTabs();
  };

  const handleLogout = () => {
    // Revoke token on server asynchronously
    fetch('/api/auth/logout', { method: 'POST' }).catch(err => console.error(err));

    setToken(null);
    setUser(null);
    localStorage.removeItem('bindarr_token');
    localStorage.removeItem('bindarr_user');
    // The last account's collection must not stay readable offline.
    clearOfflineData();
    resetTabs();
    showToast(t('toast.loggedOut'));
  };

  const handleUpdateUser = (updatedUser) => {
    setUser(updatedUser);
    saveStoredUser(updatedUser);
  };

  const triggerRefresh = useCallback(() => {
    setStatsTrigger(prev => prev + 1);
  }, []);

  // Render shared collection view if URL matches /share/:token. ?container=<id>
  // narrows it to one binder or box, drawn as that container rather than a list.
  if (shareToken) {
    return (
      <Suspense fallback={<ChunkFallback />}>
        {sharedContainerId
          ? <SharedContainer shareToken={shareToken} containerId={sharedContainerId} />
          : <SharedCollection shareToken={shareToken} />}
      </Suspense>
    );
  }

  // Render login screen if unauthenticated. The toast too: "your session expired"
  // and a failed SSO hand-off are said exactly when this screen is showing, and
  // without it here they were never seen.
  if (!token || !user) {
    return (
      <>
        <Login onLoginSuccess={handleLoginSuccess} />
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  // One account and no server: the Admin tab's account, backup and catalog
  // management have nothing to manage, and its instance settings move into
  // Settings (see InstanceSettings).
  const deviceMode = isDeviceMode();
  const showAdmin = user.role === 'admin' && !deviceMode;
  const barTabs = navBarTabs(user.nav_tabs, { showAdmin, activeTab });
  const litTab = litNavTab(activeTab, barTabs);

  const renderTab = (tab) => {
    switch (tab === 'admin' && !showAdmin ? 'dashboard' : tab) {
      case 'dashboard':
        return <Dashboard statsTrigger={statsTrigger} onNavigate={goTab} onOpenSet={openSet} setSelectedLocationId={setSelectedLocationId} setFocusEntryId={setFocusEntryId} onUpdate={triggerRefresh} showToast={showToast} />;
      case 'add-cards':
        return <AddCards active={activeTab === 'add-cards'} onAddSuccess={triggerRefresh} showToast={showToast} setActiveTab={goTab} />;
      case 'collection':
        return (
          <CollectionList 
            statsTrigger={statsTrigger} 
            onUpdate={triggerRefresh} 
            showToast={showToast} 
            token={token} 
            selectedCardFilter={selectedCardFilter}
            setSelectedCardFilter={setSelectedCardFilter}
            onNavigate={goTab}
            setSelectedLocationId={setSelectedLocationId}
            setFocusEntryId={setFocusEntryId}
          />
        );
      case 'storage':
        return (
          <LocationManager
            statsTrigger={statsTrigger}
            onUpdate={triggerRefresh}
            showToast={showToast}
            selectedLocationId={selectedLocationId}
            setSelectedLocationId={setSelectedLocationId}
            focusEntryId={focusEntryId}
            setFocusEntryId={setFocusEntryId}
          />
        );
      case 'sets':
        return <SetCompletion focusSet={focusSet} statsTrigger={statsTrigger} showToast={showToast} />;
      case 'deckbuilder':
        return <DeckBuilder showToast={showToast} />;
      case 'lists':
        return <Lists active={activeTab === 'lists'} statsTrigger={statsTrigger} showToast={showToast} />;
      case 'notes':
        return <Notes showToast={showToast} />;
      case 'sealed':
        return <SealedList showToast={showToast} />;
      case 'transfers':
        return <TransferManager user={user} showToast={showToast} />;
      case 'settings':
        return <Settings user={user} onUpdateUser={handleUpdateUser} showToast={showToast} onLeaveDevice={handleLeaveDevice} />;
      case 'admin':
        return <AdminPanel user={user} onUpdateUser={handleUpdateUser} showToast={showToast} />;
      default:
        return <Dashboard statsTrigger={statsTrigger} onNavigate={goTab} onOpenSet={openSet} setSelectedLocationId={setSelectedLocationId} setFocusEntryId={setFocusEntryId} onUpdate={triggerRefresh} showToast={showToast} />;
    }
  };

  return (
    <div className="app-container">
      {showSetup && (
        <Suspense fallback={null}>
          <SetupWizard user={user} onUpdateUser={handleUpdateUser} showToast={showToast} onClose={() => setShowSetup(false)} />
        </Suspense>
      )}
      {/* Premium Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-icon">
            <Logo />
          </div>
          <h1 className="logo-text">Bind<span>arr</span></h1>
        </div>

        {/* Navigation Tabs (Nested inside header for unified layout). Each tab
            carries its name as aria-label/title: on narrow screens, or when the
            labels don't fit (navRef check above), the label span is hidden for
            all but the active tab (index.css). */}
        <nav ref={navRef} className="nav-tabs" style={{ margin: 0 }}>
          {barTabs.map(tab => {
            const [labelKey, Icon] = NAV_TAB_META[tab];
            const label = t(labelKey);
            return (
              <button
                key={tab}
                className={`nav-tab ${litTab === tab ? 'active' : ''}`}
                onClick={() => goTab(tab === 'collection' ? collectionTarget(activeTab, lastCollectionView, barTabs) : tab)}
                aria-label={label}
                title={label}
                aria-current={litTab === tab ? 'page' : undefined}
              >
                <Icon size={18} style={tab === 'admin' ? { color: 'var(--accent-red)' } : undefined} />
                <span className="nav-tab-label">{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {deviceMode ? (
            // Nobody to greet and nothing to log out of; say where the data is.
            <div className="header-greeting" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              <Smartphone size={14} style={{ color: 'var(--accent-yellow)' }} />
              <span>{t('header.onDevice')}</span>
            </div>
          ) : (
            <>
              <div className="header-greeting" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                <Sparkles size={14} style={{ color: 'var(--accent-yellow)' }} />
                <span>{t('header.greeting')} <strong style={{ color: 'var(--text-strong)' }}>{user.username}</strong> ({t(`role.${user.role}`)})</span>
              </div>
              <button
                onClick={handleLogout}
                className="btn btn-secondary btn-icon-only"
                title={t('header.logOut')}
                aria-label={t('header.logOut')}
                style={{ padding: '0.4rem 0.5rem', borderRadius: 'var(--radius-sm)' }}
              >
                <LogOut size={14} />
              </button>
            </>
          )}
        </div>
      </header>

      {offline && !isDeviceMode() && (
        <div className="offline-banner" role="status">{t('offline.banner')}</div>
      )}

      {/* Main Content Area */}
      <main style={{ flex: 1, marginTop: '1rem' }}>
        {/* Browse, Lists and Sealed live under Collection (utils/navTabs.js). */}
        {isCollectionView(activeTab) && <CollectionViews active={activeTab} onSelect={goTab} />}
        {/* One pane per tab opened so far (see mountedTabs). Inactive panes are
            hidden, not unmounted; the active one carries .view-transition, so
            the fade replays on every switch. Each has its own boundary, so a
            crash stays in its tab and clears when you leave it. */}
        {mountedTabs.map(tab => (
          <div
            key={tab}
            className={tab === activeTab ? 'tab-pane view-transition' : 'tab-pane tab-pane-hidden'}
          >
            <ErrorBoundary active={tab === activeTab} t={t}>
              <Suspense fallback={<ChunkFallback />}>
                {renderTab(tab)}
              </Suspense>
            </ErrorBoundary>
          </div>
        ))}
      </main>

      {/* Toast Notification */}
      {toast && (
        <div key={toast.id} className={toast.onAction ? 'toast toast-action' : 'toast'} role="status">
          <span>{toast.message}</span>
          {toast.onAction && (
            <button
              type="button"
              className="toast-action-btn"
              onClick={() => { const run = toast.onAction; setToast(null); run(); }}
            >
              {toast.actionLabel || t('toast.undo')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
