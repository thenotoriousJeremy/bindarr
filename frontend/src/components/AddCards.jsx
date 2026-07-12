import { useState } from 'react';
import { Camera, Search } from 'lucide-react';
import CameraScanner from './CameraScanner';
import CardSearch from './CardSearch';

function AddCards({ onAddSuccess, showToast, setActiveTab, initialMode = 'scan' }) {
  const [mode, setMode] = useState(initialMode);

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
