import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Camera, Search, Database, MapPin, Sparkles, Settings as SettingsIcon, LogOut, ShieldAlert, Layers } from 'lucide-react';
import Dashboard from './components/Dashboard';
import CameraScanner from './components/CameraScanner';
import CardSearch from './components/CardSearch';
import CollectionList from './components/CollectionList';
import LocationManager from './components/LocationManager';
import Login from './components/Login';
import Settings from './components/Settings';
import AdminPanel from './components/AdminPanel';
import SharedCollection from './components/SharedCollection';
import DeckBuilder from './components/DeckBuilder';

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
        <div style={{ padding: '2rem', color: '#fff', background: 'rgba(255,0,0,0.1)', border: '1px solid red', borderRadius: '8px', margin: '2rem' }}>
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

// Global fetch interceptor to append authorization headers and handle 401s
const originalFetch = window.fetch;
window.fetch = function (input, options = {}) {
  // `input` may be a string, a URL, or a Request object — normalize before using string methods.
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const isPublicOrAuthRoute = url.includes('/api/shared/') || url.includes('/api/auth/login') || url.includes('/api/auth/register');

  const token = localStorage.getItem('pokedexrr_token');
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
      window.dispatchEvent(new Event('pokedexrr_logout'));
    }
    return response;
  });
};

function App() {
  const [token, setToken] = useState(localStorage.getItem('pokedexrr_token'));
  const [user, setUser] = useState(() => {
    try {
      const u = localStorage.getItem('pokedexrr_user');
      return u ? JSON.parse(u) : null;
    } catch {
      return null;
    }
  });

  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [selectedCardFilter, setSelectedCardFilter] = useState('');
  const [toast, setToast] = useState(null);
  const [statsTrigger, setStatsTrigger] = useState(0); 

  // Detect public share route on load
  const [shareToken, setShareToken] = useState(() => {
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
      localStorage.removeItem('pokedexrr_token');
      localStorage.removeItem('pokedexrr_user');
      showToast('Session expired. Please log in again.');
    };
    window.addEventListener('pokedexrr_logout', handleAutoLogout);
    return () => window.removeEventListener('pokedexrr_logout', handleAutoLogout);
  }, []);

  const handleLoginSuccess = (newToken, newUser) => {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('pokedexrr_token', newToken);
    localStorage.setItem('pokedexrr_user', JSON.stringify(newUser));
    showToast(`Welcome back, ${newUser.username}!`);
    setActiveTab('dashboard');
  };

  const handleLogout = () => {
    // Revoke token on server asynchronously
    fetch('/api/auth/logout', { method: 'POST' }).catch(err => console.error(err));

    setToken(null);
    setUser(null);
    localStorage.removeItem('pokedexrr_token');
    localStorage.removeItem('pokedexrr_user');
    showToast('Logged out successfully.');
  };

  const handleUpdateUser = (updatedUser) => {
    setUser(updatedUser);
    localStorage.setItem('pokedexrr_user', JSON.stringify(updatedUser));
  };

  const triggerRefresh = () => {
    setStatsTrigger(prev => prev + 1);
  };

  // Render shared collection view if URL matches /share/:token
  if (shareToken) {
    return <SharedCollection shareToken={shareToken} />;
  }

  // Render login screen if unauthenticated
  if (!token || !user) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard statsTrigger={statsTrigger} onNavigate={setActiveTab} />;
      case 'scanner':
        return <CameraScanner onAddSuccess={triggerRefresh} showToast={showToast} setActiveTab={setActiveTab} />;
      case 'search':
        return <CardSearch onAddSuccess={triggerRefresh} showToast={showToast} />;
      case 'collection':
        return (
          <CollectionList 
            statsTrigger={statsTrigger} 
            onUpdate={triggerRefresh} 
            showToast={showToast} 
            token={token} 
            selectedCardFilter={selectedCardFilter}
            setSelectedCardFilter={setSelectedCardFilter}
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
            setSelectedCardFilter={setSelectedCardFilter}
            setActiveTab={setActiveTab}
          />
        );
      case 'settings':
        return <Settings user={user} onUpdateUser={handleUpdateUser} showToast={showToast} />;
      case 'admin':
        return <AdminPanel showToast={showToast} />;
      default:
        return <Dashboard statsTrigger={statsTrigger} onNavigate={setActiveTab} />;
    }
  };

  return (
    <div className="app-container">
      {/* Premium Header */}
      <header className="app-header" style={{ position: 'relative' }}>
        <div className="logo-section">
          <div className="logo-icon"></div>
          <h1 className="logo-text">Poke<span>dexrr</span></h1>
        </div>

        {/* Navigation Tabs (Nested inside header for unified layout) */}
        <nav className="nav-tabs" style={{ margin: 0 }}>
          <button 
            className={`nav-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard size={18} />
            <span>Dashboard</span>
          </button>
          <button 
            className={`nav-tab ${activeTab === 'scanner' ? 'active' : ''}`}
            onClick={() => setActiveTab('scanner')}
          >
            <Camera size={18} />
            <span>Scan Cards</span>
          </button>
          <button 
            className={`nav-tab ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            <Search size={18} />
            <span>Search & Add</span>
          </button>
          <button 
            className={`nav-tab ${activeTab === 'collection' ? 'active' : ''}`}
            onClick={() => setActiveTab('collection')}
          >
            <Database size={18} />
            <span>Collection</span>
          </button>
          <button 
            className={`nav-tab ${activeTab === 'storage' ? 'active' : ''}`}
            onClick={() => setActiveTab('storage')}
          >
            <MapPin size={18} />
            <span>Storage</span>
          </button>

          <button 
            className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <SettingsIcon size={18} />
            <span>Settings</span>
          </button>
          {user.role === 'admin' && (
            <button 
              className={`nav-tab ${activeTab === 'admin' ? 'active' : ''}`}
              onClick={() => setActiveTab('admin')}
            >
              <ShieldAlert size={18} style={{ color: 'var(--accent-red)' }} />
              <span>Admin</span>
            </button>
          )}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            <Sparkles size={14} style={{ color: 'var(--accent-yellow)' }} />
            <span>Hello, <strong style={{ color: '#fff' }}>{user.username}</strong> ({user.role})</span>
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
            {renderContent()}
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
