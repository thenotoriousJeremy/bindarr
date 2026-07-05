import React, { useState, useEffect } from 'react';
import { ShieldAlert, Share2, Clipboard, RefreshCw, KeyRound, Check, Database, Download, Upload, Eye, EyeOff } from 'lucide-react';

function Settings({ user, onUpdateUser, showToast }) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  
  const [shareEnabled, setShareEnabled] = useState(user?.share_enabled === 1);
  const [shareLoading, setShareLoading] = useState(false);

  const [tcgApiKey, setTcgApiKey] = useState(user?.tcg_api_key || '');
  const [apiKeyLoading, setApiKeyLoading] = useState(false);

  const handleImportFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!window.confirm(`Import "${file.name}"? Cards from this file will be merged into your existing collection. This cannot be undone.`)) {
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    const isJson = file.name.endsWith('.json');
    const format = isJson ? 'json' : 'csv';

    reader.onload = async (event) => {
      try {
        const fileData = event.target.result;
        showToast('Importing collection...');
        const response = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format,
            data: fileData
          })
        });

        const result = await response.json();
        if (response.ok) {
          showToast(result.message || 'Import successful!');
        } else {
          showToast(`Import failed: ${result.error || 'Unknown error'}`);
        }
      } catch (err) {
        console.error(err);
        showToast(`Import failed: ${err.message}`);
      }
    };

    reader.onerror = () => {
      showToast('Failed to read the selected file.');
    };

    reader.readAsText(file);
    e.target.value = null;
  };

  useEffect(() => {
    if (user) {
      setShareEnabled(user.share_enabled === 1 || user.share_enabled === true);
      setTcgApiKey(user.tcg_api_key || '');
    }
  }, [user]);

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (!currentPassword) {
      showToast('Please enter your current password.');
      return;
    }
    if (password.length < 8) {
      showToast('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      showToast('Passwords do not match.');
      return;
    }

    setPasswordLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, password })
      });

      if (response.ok) {
        showToast('Password updated successfully.');
        setCurrentPassword('');
        setPassword('');
        setConfirmPassword('');
      } else {
        const data = await response.json();
        showToast(data.error || 'Failed to update password.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating password.');
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleExport = async (format) => {
    try {
      const response = await fetch(`/api/export?format=${format}`);
      if (!response.ok) {
        showToast('Export failed.');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pokedexrr_collection.${format === 'json' ? 'json' : 'csv'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showToast('Error exporting collection.');
    }
  };

  const handleShareToggle = async (checked) => {
    setShareEnabled(checked);
    setShareLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_enabled: checked })
      });

      if (response.ok) {
        const data = await response.json();
        onUpdateUser(data.user);
        showToast(checked ? 'Collection sharing enabled.' : 'Collection sharing disabled.');
      } else {
        setShareEnabled(!checked); // Revert
        showToast('Failed to update sharing settings.');
      }
    } catch (err) {
      console.error(err);
      setShareEnabled(!checked);
      showToast('Error updating sharing settings.');
    } finally {
      setShareLoading(false);
    }
  };

  const handleRegenerateToken = async () => {
    if (!window.confirm('Are you sure you want to regenerate your share token? Any existing links you shared will stop working.')) {
      return;
    }

    setShareLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate_share_token: true })
      });

      if (response.ok) {
        const data = await response.json();
        onUpdateUser(data.user);
        showToast('New share link generated.');
      } else {
        showToast('Failed to regenerate token.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error regenerating token.');
    } finally {
      setShareLoading(false);
    }
  };

  const handleApiKeyChange = async (e) => {
    e.preventDefault();
    setApiKeyLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tcg_api_key: tcgApiKey })
      });

      if (response.ok) {
        const data = await response.json();
        onUpdateUser(data.user);
        showToast('TCG API Key updated successfully.');
      } else {
        const data = await response.json();
        showToast(data.error || 'Failed to update API Key.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating API Key.');
    } finally {
      setApiKeyLoading(false);
    }
  };

  const shareUrl = `${window.location.protocol}//${window.location.host}/share/${user?.share_token}`;
  const tradeUrl = `${window.location.protocol}//${window.location.host}/share/${user?.share_token}?list=trade`;
  const wishlistUrl = `${window.location.protocol}//${window.location.host}/share/${user?.share_token}?list=wishlist`;

  const [copiedType, setCopiedType] = useState(''); // 'collection', 'trade', 'wishlist'

  const copyToClipboard = (url, type) => {
    navigator.clipboard.writeText(url);
    setCopiedType(type);
    showToast(`Copied public ${type} link to clipboard.`);
    setTimeout(() => setCopiedType(''), 2000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Title Panel */}
      <div className="glass-panel">
        <h2 style={{ fontSize: '1.25rem', color: '#fff' }}>Trainer Settings</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Manage your account security and collection sharing options.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }} className="settings-grid">
        {/* Sharing Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <Share2 size={20} style={{ color: 'var(--accent-red)' }} />
            <h3 style={{ color: '#fff', fontSize: '1.1rem' }}>Collection Sharing</h3>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <div>
              <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.95rem' }}>Share My Library</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Allow anyone with your link to view your collection.</div>
            </div>
            <label className="switch-control" style={{ position: 'relative', display: 'inline-block', width: '46px', height: '24px' }}>
              <input 
                type="checkbox" 
                checked={shareEnabled} 
                onChange={(e) => handleShareToggle(e.target.checked)}
                disabled={shareLoading}
                style={{ opacity: 0, width: 0, height: 0 }}
              />
              <span className={`switch-slider ${shareEnabled ? 'active' : ''}`} style={{
                position: 'absolute',
                cursor: 'pointer',
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: shareEnabled ? 'var(--type-grass)' : '#334155',
                transition: '0.3s',
                borderRadius: '24px'
              }}>
                <span style={{
                  position: 'absolute',
                  height: '18px', width: '18px',
                  left: shareEnabled ? '24px' : '4px',
                  bottom: '3px',
                  backgroundColor: '#fff',
                  transition: '0.3s',
                  borderRadius: '50%',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
                }}></span>
              </span>
            </label>
          </div>

          {shareEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}>
              
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Standard Collection Share Link</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="input-control" 
                    value={shareUrl} 
                    readOnly 
                    style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(shareUrl, 'collection')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'collection' ? <Check size={14} style={{ color: 'var(--type-grass)' }} /> : <Clipboard size={14} />}
                    <span>Copy</span>
                  </button>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Trade Binder Share Link</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="input-control" 
                    value={tradeUrl} 
                    readOnly 
                    style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(tradeUrl, 'trade')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'trade' ? <Check size={14} style={{ color: 'var(--type-grass)' }} /> : <Clipboard size={14} />}
                    <span>Copy</span>
                  </button>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Wishlist Share Link</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="input-control" 
                    value={wishlistUrl} 
                    readOnly 
                    style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(wishlistUrl, 'wishlist')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'wishlist' ? <Check size={14} style={{ color: 'var(--type-grass)' }} /> : <Clipboard size={14} />}
                    <span>Copy</span>
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button 
                  className="btn btn-secondary" 
                  onClick={handleRegenerateToken} 
                  disabled={shareLoading}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
                >
                  <RefreshCw size={12} className={shareLoading ? 'spin-animation' : ''} />
                  <span>Regenerate Link</span>
                </button>
              </div>
            </div>
          )}

          {!shareEnabled && (
            <div style={{ display: 'flex', gap: '0.5rem', background: 'rgba(255, 71, 71, 0.05)', border: '1px solid rgba(255,71,71,0.1)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              <ShieldAlert size={16} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
              <span>Your library is currently private. People visiting your share link will not be able to view your cards.</span>
            </div>
          )}
        </div>

        {/* Change Password Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <KeyRound size={20} style={{ color: 'var(--accent-yellow)' }} />
            <h3 style={{ color: '#fff', fontSize: '1.1rem' }}>Security</h3>
          </div>

          <form onSubmit={handlePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="current-password">Current Password</label>
              <input
                id="current-password"
                type="password"
                name="current-password"
                autoComplete="current-password"
                className="input-control"
                placeholder="Your current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-new-password">New Password</label>
              <input
                id="settings-new-password"
                type="password"
                name="new-password"
                autoComplete="new-password"
                className="input-control"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-confirm-password">Confirm Password</label>
              <input
                id="settings-confirm-password"
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                className="input-control"
                placeholder="Re-enter password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <button 
              type="submit" 
              className="btn btn-primary" 
              disabled={passwordLoading}
              style={{ padding: '0.6rem 1.2rem', alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            >
              {passwordLoading ? (
                <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>
              ) : 'Update Password'}
            </button>
          </form>
        </div>

        {/* Pokémon TCG API Key Settings */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <KeyRound size={20} style={{ color: 'var(--accent-red)' }} />
            <h3 style={{ color: '#fff', fontSize: '1.1rem' }}>Pokémon TCG API Key</h3>
          </div>

          <form onSubmit={handleApiKeyChange} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ background: 'rgba(255, 71, 71, 0.03)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              Card searches use the free Pokémon TCG API. Adding your own key raises your rate limit so searches stay fast during bulk scanning. Grab a free key at <a href="https://dev.pokemontcg.io" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-yellow)', fontWeight: 600 }}>dev.pokemontcg.io</a> and paste it below. It's optional.
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-tcg-api-key">API Key</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="settings-tcg-api-key"
                  type={showApiKey ? 'text' : 'password'}
                  name="tcg-api-key"
                  autoComplete="off"
                  className="input-control"
                  placeholder="e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={tcgApiKey}
                  onChange={(e) => setTcgApiKey(e.target.value)}
                  disabled={apiKeyLoading}
                  style={{ fontFamily: 'monospace', paddingRight: '2.4rem', width: '100%' }}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                  title={showApiKey ? 'Hide API key' : 'Show API key'}
                  style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
                >
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button 
              type="submit" 
              className="btn btn-primary" 
              disabled={apiKeyLoading}
              style={{ padding: '0.6rem 1.2rem', alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            >
              {apiKeyLoading ? (
                <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>
              ) : 'Save API Key'}
            </button>
          </form>
        </div>

        {/* Collection Backup & Data Options Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <Database size={20} style={{ color: 'var(--accent-red)' }} />
            <h3 style={{ color: '#fff', fontSize: '1.1rem' }}>Collection Backup & Data</h3>
          </div>

          <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
            Export your card collection as a CSV or JSON backup, or import a previously exported database. Importing will merge cards into your collection.
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={() => handleExport('csv')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <Download size={14} />
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('json')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <Download size={14} />
              <span>Export JSON</span>
            </button>

            <label 
              className="btn btn-primary" 
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', cursor: 'pointer', margin: 0 }}
            >
              <Upload size={14} />
              <span>Import Backup</span>
              <input 
                type="file" 
                accept=".json,.csv" 
                onChange={handleImportFile}
                style={{ display: 'none' }}
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
