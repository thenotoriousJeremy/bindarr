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

// Global fetch interceptor to append authorization headers and handle 401s
const originalFetch = window.fetch;
window.fetch = function (url, options = {}) {
  const token = localStorage.getItem('pokekeep_token');
  if (token && url.startsWith('/api/') && !url.includes('/api/shared/')) {
    options.headers = {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    };
  }
  return originalFetch(url, options).then(response => {
    if (response.status === 401 && !url.includes('/api/shared/')) {
      // Dispatch custom event to trigger logout without page refresh
      window.dispatchEvent(new Event('pokekeep_logout'));
    }
    return response;
  });
};

function App() {
  const [token, setToken] = useState(localStorage.getItem('pokekeep_token'));
  const [user, setUser] = useState(() => {
    try {
      const u = localStorage.getItem('pokekeep_user');
      return u ? JSON.parse(u) : null;
    } catch {
      return null;
    }
  });

  const [activeTab, setActiveTab] = useState('dashboard');
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
      localStorage.removeItem('pokekeep_token');
      localStorage.removeItem('pokekeep_user');
      showToast('Session expired. Please log in again.');
    };
    window.addEventListener('pokekeep_logout', handleAutoLogout);
    return () => window.removeEventListener('pokekeep_logout', handleAutoLogout);
  }, []);

  const handleLoginSuccess = (newToken, newUser) => {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('pokekeep_token', newToken);
    localStorage.setItem('pokekeep_user', JSON.stringify(newUser));
    showToast(`Welcome back, ${newUser.username}!`);
    setActiveTab('dashboard');
  };

  const handleLogout = () => {
    // Revoke token on server asynchronously
    fetch('/api/auth/logout', { method: 'POST' }).catch(err => console.error(err));

    setToken(null);
    setUser(null);
    localStorage.removeItem('pokekeep_token');
    localStorage.removeItem('pokekeep_user');
    showToast('Logged out successfully.');
  };

  const handleUpdateUser = (updatedUser) => {
    setUser(updatedUser);
    localStorage.setItem('pokekeep_user', JSON.stringify(updatedUser));
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
        return <Dashboard statsTrigger={statsTrigger} />;
      case 'scanner':
        return <CameraScanner onAddSuccess={triggerRefresh} showToast={showToast} />;
      case 'search':
        return <CardSearch onAddSuccess={triggerRefresh} showToast={showToast} />;
      case 'collection':
        return <CollectionList statsTrigger={statsTrigger} onUpdate={triggerRefresh} showToast={showToast} token={token} />;

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
          <h1 className="logo-text">Poke<span>Keep</span></h1>
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
            style={{ padding: '0.4rem 0.5rem', borderRadius: 'var(--radius-sm)' }}
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ flex: 1, marginTop: '1rem' }}>
        {renderContent()}
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
