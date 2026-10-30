import React, { useState, useEffect, useLayoutEffect, useRef, lazy, Suspense } from 'react';
import { LayoutDashboard, Database, MapPin, Sparkles, Settings as SettingsIcon, LogOut, ShieldAlert, Plus, Swords, StickyNote, Package } from 'lucide-react';
import Login from './components/Login';
import Logo from './components/Logo';
import { App as CapacitorApp } from '@capacitor/app';
import { pushBackGuard } from './utils/useBackGuard';
import { useT } from './utils/i18n';
import { isNative } from './apiBase';
import { parseOidcReturn, takeVerifier } from './utils/nativeOidc';

// View components are code-split so heavy deps (recharts in the chart views)
// load on demand instead of in the initial bundle.
const Dashboard = lazy(() => import('./components/Dashboard'));
const AddCards = lazy(() => import('./components/AddCards'));
const CollectionList = lazy(() => import('./components/CollectionList'));
const LocationManager = lazy(() => import('./components/LocationManager'));
const Settings = lazy(() => import('./components/Settings'));
const AdminPanel = lazy(() => import('./components/AdminPanel'));
const SetupWizard = lazy(() => import('./components/SetupWizard'));
const SharedCollection = lazy(() => import('./components/SharedCollection'));
const SharedContainer = lazy(() => import('./components/SharedContainer'));
const DeckBuilder = lazy(() => import('./components/DeckBuilder'));
const Notes = lazy(() => import('./components/Notes'));
const SealedList = lazy(() => import('./components/SealedList'));

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

  const token = localStorage.getItem('bindarr_token');
  const finalOptions = { ...options };
  if (token && url.startsWith('/api/') && !isPublicOrAuthRoute) {
    finalOptions.headers = {
      ...finalOptions.headers,
      'Authorization': `Bearer ${token}`
    };
  }
  return originalFetch(input, finalOptions).then(response => {
    if (response.status === 401 && !isPublicOrAuthRoute) {
      // Dispatch custom event to trigger logout without page refresh
      window.dispatchEvent(new Event('bindarr_logout'));
    }
    return response;
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
  const [token, setToken] = useState(localStorage.getItem('bindarr_token'));
  const [user, setUser] = useState(() => {
    try {
      const u = localStorage.getItem('bindarr_user');
      return u ? JSON.parse(u) : null;
    } catch {
      return null;
    }
  });

  const [activeTab, setActiveTab] = useState('dashboard');
  // First-run scanning setup. Asked once per session, only for an admin, and only
  // while it is genuinely incomplete — setupNeeded() reads the same endpoints the
  // wizard does so there is one definition of 'set up'.
  const [showSetup, setShowSetup] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [focusEntryId, setFocusEntryId] = useState(null);
  const [selectedCardFilter, setSelectedCardFilter] = useState('');
  const [toast, setToast] = useState(null);
  const [statsTrigger, setStatsTrigger] = useState(0);

  const tabGuardRef = useRef(null);

  // Navigate tabs through here so each change pushes a history entry: a back
  // gesture then returns to the PREVIOUS tab (not always dashboard), and modals
  // stack their own guards on top. We never dispose the old tab guard — each
  // switch pushes a fresh entry so the back button walks through tab history.
  // Disposing with history.back() would race during rapid switches and navigate
  // the browser past the app origin into about:blank.
  const goTab = (tab) => {
    if (tab === activeTab) return;
    const prev = activeTab;
    tabGuardRef.current = pushBackGuard(() => {
      tabGuardRef.current = null;
      setActiveTab(prev);
    });
    setActiveTab(tab);
  };

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

  const showToast = (message) => {
    setToast(message);
  };

  // Handle OIDC / SSO token in URL redirect
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const oidcToken = params.get('oidc_token') || params.get('token');
      if (oidcToken && !token) {
        // Clean URL parameters immediately
        const newUrl = window.location.pathname + (window.location.hash || '');
        window.history.replaceState({}, document.title, newUrl);

        // Fetch user profile with the token to complete login
        fetch('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${oidcToken}` }
        })
          .then(res => res.ok ? res.json() : Promise.reject(new Error('Failed to fetch profile')))
          .then(data => {
            if (data.user) {
              setToken(oidcToken);
              setUser(data.user);
              localStorage.setItem('bindarr_token', oidcToken);
              localStorage.setItem('bindarr_user', JSON.stringify(data.user));
              showToast(t('toast.welcomeBack', { name: data.user.username }));
              setActiveTab('dashboard');
            }
          })
          .catch(err => {
            console.error('OIDC token verification failed:', err);
            showToast(t('login.errOidcFailed'));
          });
      }
    } catch { /* ignore URL parse error */ }
  }, [t, token]);

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
          localStorage.setItem('bindarr_user', JSON.stringify(data.user));
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
  }, [t]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 2500);
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

  // Offer first-run setup to an admin until it is finished or skipped. The flag
  // lives on the server, so closing the wizard halfway resumes it at the next
  // login on any device; everything it configures is also reachable from Settings
  // and Admin.
  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    let cancelled = false;
    import('./components/SetupWizard')
      .then(m => m.setupNeeded())
      .then(needed => { if (needed && !cancelled) setShowSetup(true); })
      .catch(() => { /* never block the app on the wizard's own probe */ });
    return () => { cancelled = true; };
  }, [user]);

  // Handle automatic logout on 401
  useEffect(() => {
    const handleAutoLogout = () => {
      setToken(null);
      setUser(null);
      localStorage.removeItem('bindarr_token');
      localStorage.removeItem('bindarr_user');
      showToast(t('toast.sessionExpired'));
    };
    window.addEventListener('bindarr_logout', handleAutoLogout);
    return () => window.removeEventListener('bindarr_logout', handleAutoLogout);
  }, [t]);

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
    localStorage.setItem('bindarr_user', JSON.stringify(newUser));
    showToast(t('toast.welcomeBack', { name: newUser.username }));
    setActiveTab('dashboard');
  };

  const handleLogout = () => {
    // Revoke token on server asynchronously
    fetch('/api/auth/logout', { method: 'POST' }).catch(err => console.error(err));

    setToken(null);
    setUser(null);
    localStorage.removeItem('bindarr_token');
    localStorage.removeItem('bindarr_user');
    showToast(t('toast.loggedOut'));
  };

  const handleUpdateUser = (updatedUser) => {
    setUser(updatedUser);
    localStorage.setItem('bindarr_user', JSON.stringify(updatedUser));
  };

  const triggerRefresh = () => {
    setStatsTrigger(prev => prev + 1);
  };

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

  // Render login screen if unauthenticated
  if (!token || !user) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard statsTrigger={statsTrigger} onNavigate={goTab} setSelectedLocationId={setSelectedLocationId} setFocusEntryId={setFocusEntryId} onUpdate={triggerRefresh} showToast={showToast} />;
      case 'add-cards':
        return <AddCards onAddSuccess={triggerRefresh} showToast={showToast} setActiveTab={goTab} />;
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
      case 'deckbuilder':
        return <DeckBuilder showToast={showToast} />;
      case 'notes':
        return <Notes showToast={showToast} />;
      case 'sealed':
        return <SealedList showToast={showToast} />;
      case 'settings':
        return <Settings user={user} onUpdateUser={handleUpdateUser} showToast={showToast} />;
      case 'admin':
        return <AdminPanel user={user} onUpdateUser={handleUpdateUser} showToast={showToast} />;
      default:
        return <Dashboard statsTrigger={statsTrigger} onNavigate={goTab} setSelectedLocationId={setSelectedLocationId} setFocusEntryId={setFocusEntryId} onUpdate={triggerRefresh} showToast={showToast} />;
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
          <button 
            className={`nav-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => goTab('dashboard')}
            aria-label={t('nav.dashboard')}
            title={t('nav.dashboard')}
          >
            <LayoutDashboard size={18} />
            <span className="nav-tab-label">{t('nav.dashboard')}</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'add-cards' ? 'active' : ''}`}
            onClick={() => goTab('add-cards')}
            aria-label={t('nav.addCards')}
            title={t('nav.addCards')}
          >
            <Plus size={18} />
            <span className="nav-tab-label">{t('nav.addCards')}</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'collection' ? 'active' : ''}`}
            onClick={() => goTab('collection')}
            aria-label={t('nav.collection')}
            title={t('nav.collection')}
          >
            <Database size={18} />
            <span className="nav-tab-label">{t('nav.collection')}</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'storage' ? 'active' : ''}`}
            onClick={() => goTab('storage')}
            aria-label={t('nav.storage')}
            title={t('nav.storage')}
          >
            <MapPin size={18} />
            <span className="nav-tab-label">{t('nav.storage')}</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'deckbuilder' ? 'active' : ''}`}
            onClick={() => goTab('deckbuilder')}
            aria-label={t('nav.deckBuilder')}
            title={t('nav.deckBuilder')}
          >
            <Swords size={18} />
            <span className="nav-tab-label">{t('nav.deckBuilder')}</span>
          </button>

          <button
            className={`nav-tab ${activeTab === 'notes' ? 'active' : ''}`}
            onClick={() => goTab('notes')}
            aria-label={t('nav.notes')}
            title={t('nav.notes')}
          >
            <StickyNote size={18} />
            <span className="nav-tab-label">{t('nav.notes')}</span>
          </button>

          <button
            className={`nav-tab ${activeTab === 'sealed' ? 'active' : ''}`}
            onClick={() => goTab('sealed')}
            aria-label={t('nav.sealed')}
            title={t('nav.sealed')}
          >
            <Package size={18} />
            <span className="nav-tab-label">{t('nav.sealed')}</span>
          </button>

          <button
            className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => goTab('settings')}
            aria-label={t('nav.settings')}
            title={t('nav.settings')}
          >
            <SettingsIcon size={18} />
            <span className="nav-tab-label">{t('nav.settings')}</span>
          </button>
          {user.role === 'admin' && (
            <button 
              className={`nav-tab ${activeTab === 'admin' ? 'active' : ''}`}
              onClick={() => goTab('admin')}
              aria-label={t('nav.admin')}
              title={t('nav.admin')}
            >
              <ShieldAlert size={18} style={{ color: 'var(--accent-red)' }} />
              <span className="nav-tab-label">{t('nav.admin')}</span>
            </button>
          )}
        </nav>

        <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
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
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ flex: 1, marginTop: '1rem' }}>
        {/* key on activeTab remounts the boundary per tab, so a crash in one
            view clears when you navigate away instead of persisting until a
            manual reload. */}
        <ErrorBoundary key={activeTab} t={t}>
          <div className="view-transition">
            <Suspense fallback={<ChunkFallback />}>
              {renderContent()}
            </Suspense>
          </div>
        </ErrorBoundary>
      </main>

      {/* Toast Notification */}
      {toast && (
        <div className="toast">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
