import { useState } from 'react';
import { Camera, Search } from 'lucide-react';
import CameraScanner from './CameraScanner';
import CardSearch from './CardSearch';

function AddCards({ onAddSuccess, showToast, setActiveTab, initialMode = 'scan' }) {
  const [mode, setMode] = useState(initialMode);

  // Demo build has no backend: the camera scanner and live card search can't
  // work, so show a notice instead of a broken UI.
  if (import.meta.env.VITE_DEMO) {
    return (
      <div className="glass-panel" style={{ maxWidth: '520px', margin: '2rem auto', padding: '2rem', textAlign: 'center' }}>
        <Camera size={40} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.75rem' }}>Not available in the demo</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          The card scanner and live search need the Bindarr backend (camera recognition,
          card database, price lookups). This is a static, read-only preview of the app.
          Run your own instance to add cards.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', gap: '1rem', position: 'relative' }}>
        <div className="sub-nav-tabs" style={{ width: '100%', maxWidth: '400px', margin: 0 }}>
          <button 
            className={`sub-nav-tab ${mode === 'scan' ? 'active' : ''}`}
            onClick={() => setMode('scan')}
          >
            <Camera size={18} />
            <span>Scan Cards</span>
          </button>
          <button 
            className={`sub-nav-tab ${mode === 'search' ? 'active' : ''}`}
            onClick={() => setMode('search')}
          >
            <Search size={18} />
            <span>Search & Add</span>
          </button>
        </div>
      </div>

      <div>
        {mode === 'scan' ? (
          <CameraScanner onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />
        ) : (
          <CardSearch onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />
        )}
      </div>
    </div>
  );
}

export default AddCards;
