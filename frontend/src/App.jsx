import React, { useState, useEffect, lazy, Suspense } from 'react';
import { LayoutDashboard, Database, MapPin, Sparkles, Settings as SettingsIcon, LogOut, ShieldAlert, Plus, Swords } from 'lucide-react';
import Login from './components/Login';
import Logo from './components/Logo';
import { pushBackGuard } from './utils/useBackGuard';

// View components are code-split so heavy deps (recharts in the chart views)
// load on demand instead of in the initial bundle.
const Dashboard = lazy(() => import('./components/Dashboard'));
const AddCards = lazy(() => import('./components/AddCards'));
const CollectionList = lazy(() => import('./components/CollectionList'));
const LocationManager = lazy(() => import('./components/LocationManager'));
const Settings = lazy(() => import('./components/Settings'));
const AdminPanel = lazy(() => import('./components/AdminPanel'));
const SharedCollection = lazy(() => import('./components/SharedCollection'));
const DeckBuilder = lazy(() => import('./components/DeckBuilder'));

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
      return (
        <div style={{ padding: '2rem', color: 'var(--text-strong)', background: 'rgba(255,0,0,0.1)', border: '1px solid red', borderRadius: '8px', margin: '2rem' }}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem', color: 'var(--accent-red)' }}>Something went wrong.</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ff8888', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '4px', fontSize: '0.85rem' }}>{this.state.error && this.state.error.toString()}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', marginTop: '1rem', color: 'var(--text-secondary)' }}>{this.state.error && this.state.error.stack}</pre>
          <button className="btn btn-primary" style={{ marginTop: '1.5rem' }} onClick={() => window.location.reload()}>Reload Page</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Fallback shown while a lazily-loaded view chunk is fetched.
function ChunkFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
      <div className="spinner" aria-label="Loading" />
    </div>
  );
}

// Global fetch interceptor to append authorization headers and handle 401s
const originalFetch = window.fetch;
window.fetch = function (input, options = {}) {
  // `input` may be a string, a URL, or a Request object — normalize before using string methods.
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const isPublicOrAuthRoute = url.includes('/api/shared/') || url.includes('/api/auth/login') || url.includes('/api/auth/register');

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

function App() {
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
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [focusEntryId, setFocusEntryId] = useState(null);
  const [selectedCardFilter, setSelectedCardFilter] = useState('');
  const [toast, setToast] = useState(null);
  const [statsTrigger, setStatsTrigger] = useState(0);

  // Navigate tabs through here so each change pushes a history entry: a back
  // gesture then returns to the PREVIOUS tab (not always dashboard), and modals
  // stack their own guards on top. At the dashboard root with nothing pushed,
  // back exits normally.
  const goTab = (tab) => {
    if (tab === activeTab) return;
    const prev = activeTab;
    pushBackGuard(() => setActiveTab(prev));
    setActiveTab(tab);
  };

  // Detect public share route on load
  const [shareToken] = useState(() => {
    const path = window.location.pathname;
    const match = path.match(/^\/share\/([a-zA-Z0-9_-]+)$/);
    return match ? match[1] : null;
  });

  const showToast = (message) => {
    setToast(message);
  };

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Handle automatic logout on 401
  useEffect(() => {
    const handleAutoLogout = () => {
      setToken(null);
      setUser(null);
      localStorage.removeItem('bindarr_token');
      localStorage.removeItem('bindarr_user');
      showToast('Session expired. Please log in again.');
    };
    window.addEventListener('bindarr_logout', handleAutoLogout);
    return () => window.removeEventListener('bindarr_logout', handleAutoLogout);
  }, []);

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
    showToast(`Welcome back, ${newUser.username}!`);
    setActiveTab('dashboard');
  };

  const handleLogout = () => {
    // Revoke token on server asynchronously
    fetch('/api/auth/logout', { method: 'POST' }).catch(err => console.error(err));

    setToken(null);
    setUser(null);
    localStorage.removeItem('bindarr_token');
    localStorage.removeItem('bindarr_user');
    showToast('Logged out successfully.');
  };

  const handleUpdateUser = (updatedUser) => {
    setUser(updatedUser);
    localStorage.setItem('bindarr_user', JSON.stringify(updatedUser));
  };

  const triggerRefresh = () => {
    setStatsTrigger(prev => prev + 1);
  };

  // Render shared collection view if URL matches /share/:token
  if (shareToken) {
    return (
      <Suspense fallback={<ChunkFallback />}>
        <SharedCollection shareToken={shareToken} />
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
      case 'settings':
        return <Settings user={user} onUpdateUser={handleUpdateUser} showToast={showToast} />;
      case 'admin':
        return <AdminPanel showToast={showToast} />;
      default:
        return <Dashboard statsTrigger={statsTrigger} onNavigate={goTab} setSelectedLocationId={setSelectedLocationId} setFocusEntryId={setFocusEntryId} onUpdate={triggerRefresh} showToast={showToast} />;
    }
  };

  return (
    <div className="app-container">
      {/* Premium Header */}
      <header className="app-header" style={{ position: 'relative' }}>
        <div className="logo-section">
          <div className="logo-icon">
            <Logo />
          </div>
          <h1 className="logo-text">Bind<span>arr</span></h1>
        </div>

        {/* Navigation Tabs (Nested inside header for unified layout) */}
        <nav className="nav-tabs" style={{ margin: 0 }}>
          <button 
            className={`nav-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => goTab('dashboard')}
          >
            <LayoutDashboard size={18} />
            <span>Dashboard</span>
          </button>
          <button 
            className={`nav-tab ${activeTab === 'add-cards' ? 'active' : ''}`}
            onClick={() => goTab('add-cards')}
          >
            <Plus size={18} />
            <span>Add Cards</span>
          </button>
          <button 
            className={`nav-tab ${activeTab === 'collection' ? 'active' : ''}`}
            onClick={() => goTab('collection')}
          >
            <Database size={18} />
            <span>Collection</span>
          </button>
          <button 
            className={`nav-tab ${activeTab === 'storage' ? 'active' : ''}`}
            onClick={() => goTab('storage')}
          >
            <MapPin size={18} />
            <span>Storage</span>
          </button>
          <button 
            className={`nav-tab ${activeTab === 'deckbuilder' ? 'active' : ''}`}
            onClick={() => goTab('deckbuilder')}
          >
            <Swords size={18} />
            <span>Deck Builder</span>
          </button>

          <button 
            className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => goTab('settings')}
          >
            <SettingsIcon size={18} />
            <span>Settings</span>
          </button>
          {user.role === 'admin' && (
            <button 
              className={`nav-tab ${activeTab === 'admin' ? 'active' : ''}`}
              onClick={() => goTab('admin')}
            >
              <ShieldAlert size={18} style={{ color: 'var(--accent-red)' }} />
              <span>Admin</span>
            </button>
          )}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            <Sparkles size={14} style={{ color: 'var(--accent-yellow)' }} />
            <span>Hello, <strong style={{ color: 'var(--text-strong)' }}>{user.username}</strong> ({user.role})</span>
          </div>
          <button
            onClick={handleLogout}
            className="btn btn-secondary btn-icon-only"
            title="Log Out"
            aria-label="Log Out"
            style={{ padding: '0.4rem 0.5rem', borderRadius: 'var(--radius-sm)' }}
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ flex: 1, marginTop: '1rem' }}>
        <ErrorBoundary>
          {/* key on activeTab replays the mount animation for a smooth
              transition instead of a hard swap between views */}
          <div key={activeTab} className="view-transition">
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
