import { useState, useEffect, useRef } from 'react';
import { Shield, UserPlus, Key, Trash2, ToggleLeft, ToggleRight, Search, Users, Globe, Database, Play, RefreshCw, AlertTriangle, HardDriveDownload, Download } from 'lucide-react';
import { useBackGuard } from '../utils/useBackGuard';

const formatBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const isActive = (p) => p && (p.status === 'fetching' || p.status === 'indexing');
const isGlobalActive = (p) => p && p.status === 'running';

function AdminPanel({ showToast }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');

  // Add User Form States
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('member');
  const [addLoading, setAddLoading] = useState(false);

  // Change Password Modal States
  const [targetUser, setTargetUser] = useState(null);
  useBackGuard(!!targetUser, () => setTargetUser(null));
  const [updatePassword, setUpdatePassword] = useState('');
  const [pwdLoading, setPwdLoading] = useState(false);

  // Instance Settings States
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(false);

  // Set-index build states
  const [builds, setBuilds] = useState([]);
  const [buildProgress, setBuildProgress] = useState({});
  const [buildGame, setBuildGame] = useState('mtg');
  const [buildSetCode, setBuildSetCode] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const pollRef = useRef(null);

  // Global scan index states
  const [globals, setGlobals] = useState([]);
  const [globalProgress, setGlobalProgress] = useState({});

  // Database backup states
  const [backups, setBackups] = useState([]);
  const [backupLoading, setBackupLoading] = useState(false);

  useEffect(() => {
    fetchUsers();
    fetchSettings();
    fetchBackups();
    Promise.all([fetchBuilds(), fetchGlobals()]).then(([a, b]) => { if (a || b) startPolling(); });
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };
  const startPolling = () => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      const [a, b] = await Promise.all([fetchBuilds(), fetchGlobals()]);
      if (!a && !b) stopPolling();
    }, 1500);
  };

  // Returns whether a global build is in flight (drives polling).
  const fetchGlobals = async () => {
    try {
      const res = await fetch('/api/admin/global-indexes');
      if (!res.ok) return false;
      const data = await res.json();
      setGlobals(data.games || []);
      setGlobalProgress(data.progress || {});
      return Object.values(data.progress || {}).some(isGlobalActive);
    } catch (err) {
      console.error(err);
      return false;
    }
  };

  const handleBuildGlobal = async (game) => {
    if (!window.confirm(`Rebuild the GLOBAL ${game.toUpperCase()} scan index? This re-downloads every card image (tens of thousands), runs them through the CLIP model, and can take HOURS and ~1GB of disk. The current index keeps serving scans until the rebuild finishes.`)) return;
    try {
      const res = await fetch('/api/admin/global-indexes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game }),
      });
      const data = await res.json();
      if (res.ok) { showToast(data.message); await fetchGlobals(); startPolling(); }
      else showToast(data.error || 'Failed to start global build.');
    } catch (err) {
      console.error(err);
      showToast('Error starting global build.');
    }
  };

  const handleStopGlobal = async (game) => {
    if (!window.confirm(`Stop the running ${game.toUpperCase()} global build? The existing index is left as-is.`)) return;
    try {
      const res = await fetch(`/api/admin/global-indexes/${game}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) { showToast(data.message); fetchGlobals(); }
      else showToast(data.error || 'Failed to stop build.');
    } catch (err) {
      console.error(err);
      showToast('Error stopping build.');
    }
  };

  // Returns whether any build is currently in flight (drives polling).
  const fetchBuilds = async () => {
    try {
      const res = await fetch('/api/admin/set-indexes');
      if (!res.ok) return false;
      const data = await res.json();
      setBuilds(data.builds || []);
      setBuildProgress(data.progress || {});
      return Object.values(data.progress || {}).some(isActive);
    } catch (err) {
      console.error(err);
      return false;
    }
  };

  const handlePreview = async () => {
    const set = buildSetCode.trim();
    if (!set) return;
    setPreviewLoading(true);
    setPreview(null);
    try {
      const res = await fetch(`/api/admin/set-indexes/preview?game=${buildGame}&set=${encodeURIComponent(set)}`);
      const data = await res.json();
      if (res.ok) setPreview(data);
      else showToast(data.error || 'Preview failed.');
    } catch (err) {
      console.error(err);
      showToast('Error looking up set.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleBuild = async (game, set, cardCount) => {
    const warn = cardCount
      ? `Build ${game} "${set}"? This downloads ~${cardCount} card images (about ${formatBytes(cardCount * 20 * 1024)} on disk) and can take several minutes.`
      : `Rebuild ${game} "${set}"? This re-downloads every card image and can take several minutes.`;
    if (!window.confirm(warn)) return;
    try {
      const res = await fetch('/api/admin/set-indexes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, set }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast(data.message);
        setPreview(null);
        setBuildSetCode('');
        await fetchBuilds();
        startPolling();
      } else {
        showToast(data.error || 'Failed to start build.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error starting build.');
    }
  };

  const handleDeleteBuild = async (game, set) => {
    if (!window.confirm(`Remove the ${game} "${set}" index? Scanning this set will rebuild it on demand.`)) return;
    try {
      const res = await fetch(`/api/admin/set-indexes/${game}/${encodeURIComponent(set)}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) { showToast(data.message); fetchBuilds(); }
      else showToast(data.error || 'Failed to remove index.');
    } catch (err) {
      console.error(err);
      showToast('Error removing index.');
    }
  };

  const handleSeedDatabase = async () => {
    if (!window.confirm("Seed database with a random collection of test cards (Pikachu, Charizard, etc.)? This will add them to your collection.")) {
      return;
    }
    try {
      const res = await fetch('/api/admin/seed-cards', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        showToast(data.message);
        fetchUsers(); // Refresh stats
      } else {
        showToast("Failed to seed database.");
      }
    } catch (err) {
      console.error(err);
      showToast("Error seeding database.");
    }
  };

  const fetchBackups = async () => {
    try {
      const res = await fetch('/api/admin/backups');
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDownloadBackup = async (file) => {
    try {
      const res = await fetch(`/api/admin/backups/${encodeURIComponent(file)}/download`);
      if (!res.ok) { showToast('Download failed.'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showToast('Error downloading backup.');
    }
  };

  const handleBackup = async () => {
    setBackupLoading(true);
    try {
      const res = await fetch('/api/admin/backups', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(`Backup created: ${data.file} (${formatBytes(data.size)}).`);
        fetchBackups();
      } else {
        showToast(data.error || 'Backup failed.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error creating backup.');
    } finally {
      setBackupLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/admin/users');
      if (response.ok) {
        const data = await response.json();
        setUsers(data);
      } else {
        showToast('Failed to fetch user list.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error connecting to backend.');
    } finally {
      setLoading(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/settings');
      if (response.ok) {
        const data = await response.json();
        setPublicBaseUrl(data.public_base_url || '');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSettingsLoading(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_base_url: publicBaseUrl })
      });

      if (response.ok) {
        const data = await response.json();
        setPublicBaseUrl(data.public_base_url || '');
        showToast('Instance settings updated.');
      } else {
        const data = await response.json();
        showToast(data.error || 'Failed to update settings.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating settings.');
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    if (newUsername.length < 3) {
      showToast('Username must be at least 3 characters.');
      return;
    }
    if (newPassword.length < 8) {
      showToast('Password must be at least 8 characters.');
      return;
    }

    setAddLoading(true);
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole })
      });

      if (response.ok) {
        showToast(`User "${newUsername}" created successfully.`);
        setNewUsername('');
        setNewPassword('');
        setNewRole('member');
        fetchUsers();
      } else {
        const data = await response.json();
        showToast(data.error || 'Failed to create user.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error creating user.');
    } finally {
      setAddLoading(false);
    }
  };

  const handleToggleRole = async (user) => {
    const nextRole = user.role === 'admin' ? 'member' : 'admin';
    if (user.username === 'admin') {
      showToast('Cannot demote seeded root admin account.');
      return;
    }

    if (!window.confirm(`Are you sure you want to change role of ${user.username} to ${nextRole}?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole })
      });

      if (response.ok) {
        showToast(`Role updated to ${nextRole} for ${user.username}.`);
        fetchUsers();
      } else {
        const data = await response.json();
        showToast(data.error || 'Failed to change role.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating role.');
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!targetUser) return;
    if (updatePassword.length < 8) {
      showToast('Password must be at least 8 characters.');
      return;
    }

    setPwdLoading(true);
    try {
      const response = await fetch(`/api/admin/users/${targetUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: updatePassword })
      });

      if (response.ok) {
        showToast(`Password updated for "${targetUser.username}".`);
        setUpdatePassword('');
        setTargetUser(null);
      } else {
        const data = await response.json();
        showToast(data.error || 'Failed to update password.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating password.');
    } finally {
      setPwdLoading(false);
    }
  };

  const handleDeleteUser = async (user) => {
    if (user.username === 'admin') {
      showToast('Cannot delete seeded root admin account.');
      return;
    }

    if (!window.confirm(`CRITICAL WARNING: This will permanently delete user "${user.username}" and ALL their locations and card collections. This action CANNOT be undone. Are you sure you want to proceed?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(`User "${user.username}" deleted.`);
        fetchUsers();
      } else {
        const data = await response.json();
        showToast(data.error || 'Failed to delete user.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error deleting user.');
    }
  };

  const filteredUsers = users.filter(u =>
    (u.username || '').toLowerCase().includes(filterText.toLowerCase()) ||
    (u.role || '').toLowerCase().includes(filterText.toLowerCase())
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header Info */}
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)' }}>Trainer Administration</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Maintain users, assign roles, reset passwords, and monitor system metrics.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button 
            type="button" 
            className="btn btn-secondary btn-sm" 
            onClick={handleSeedDatabase}
            style={{ padding: '0.5rem 1rem', height: '34px', fontSize: '0.8rem', border: '1px solid var(--border-glass)' }}
          >
            🧪 Generate Test Cards
          </button>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', height: '34px' }}>
            <Users size={16} style={{ color: 'var(--accent-red)' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Total Trainers: {users.length}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '1.5rem' }} className="admin-grid-layout">
        {/* Registration Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <UserPlus size={18} style={{ color: 'var(--accent-red)' }} />
            Register New Trainer
          </h3>
          <form onSubmit={handleAddUser} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-new-username">Trainer Username</label>
              <input
                id="admin-new-username"
                type="text"
                name="new-username"
                autoComplete="off"
                className="input-control"
                placeholder="Enter username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                required
                disabled={addLoading}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-new-password">Initial Password</label>
              <input
                id="admin-new-password"
                type="password"
                name="new-user-password"
                autoComplete="new-password"
                className="input-control"
                placeholder="Min 8 characters"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                disabled={addLoading}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-new-role">Role</label>
              <select id="admin-new-role" className="select-control" value={newRole} onChange={(e) => setNewRole(e.target.value)} disabled={addLoading}>
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary" style={{ padding: '0.6rem', fontWeight: 700 }} disabled={addLoading}>
              {addLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : 'Create Account'}
            </button>
          </form>
        </div>

        {/* Instance Settings Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Globe size={18} style={{ color: 'var(--accent-red)' }} />
            Instance Settings
          </h3>
          <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ background: 'rgba(255, 71, 71, 0.03)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              If this app runs behind a reverse proxy, the browser&apos;s own address may not be the one others should use to reach a collection share link. Set the public URL here to override it. Leave blank to use the browser&apos;s address (or the <code>PUBLIC_BASE_URL</code> environment variable, if set).
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-public-base-url">Public Base URL</label>
              <input
                id="admin-public-base-url"
                type="text"
                name="public-base-url"
                autoComplete="off"
                className="input-control"
                placeholder="https://cards.example.com"
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
                disabled={settingsLoading}
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ padding: '0.6rem', fontWeight: 700, alignSelf: 'flex-start' }} disabled={settingsLoading}>
              {settingsLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : 'Save Settings'}
            </button>
          </form>
        </div>

        {/* Set Index Builds Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Database size={18} style={{ color: 'var(--accent-red)' }} />
            Set Scan Indexes
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.4 }}>
            Per-set image indexes power set-scoped camera scanning. They build automatically the first time a set is scanned; build them here ahead of time, or remove ones you no longer need. Use the MTG set code (e.g. <code>mh3</code>) or Pokémon set id (e.g. <code>sv1</code>).
          </p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-group" style={{ marginBottom: 0, width: '120px' }}>
              <label htmlFor="build-game">Game</label>
              <select id="build-game" className="select-control" value={buildGame} onChange={(e) => { setBuildGame(e.target.value); setPreview(null); }}>
                <option value="mtg">MTG</option>
                <option value="pokemon">Pokémon</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: '140px' }}>
              <label htmlFor="build-set">Set code / id</label>
              <input
                id="build-set"
                type="text"
                className="input-control"
                placeholder="mh3 / sv1"
                value={buildSetCode}
                onChange={(e) => { setBuildSetCode(e.target.value); setPreview(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlePreview(); } }}
              />
            </div>
            <button type="button" className="btn btn-secondary" style={{ height: '42px' }} onClick={handlePreview} disabled={previewLoading || !buildSetCode.trim()}>
              {previewLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : 'Preview'}
            </button>
          </div>

          {preview && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', background: 'rgba(255,193,71,0.05)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.85rem' }}>
              <AlertTriangle size={16} style={{ color: 'var(--accent-yellow)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: '180px', color: 'var(--text-secondary)' }}>
                <strong style={{ color: 'var(--text-strong)' }}>{preview.cardCount}</strong> printings, up to <strong style={{ color: 'var(--text-strong)' }}>{formatBytes(preview.estBytes)}</strong> on disk. Downloads one image per card; can take several minutes.
              </span>
              <button type="button" className="btn btn-primary" onClick={() => handleBuild(preview.game, preview.set, preview.cardCount)} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Play size={14} /> Build Set
              </button>
            </div>
          )}

          {builds.length === 0 && !Object.values(buildProgress).some(isActive) ? (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              No set indexes built yet.
            </div>
          ) : (
            <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>Game</th>
                    <th>Set</th>
                    <th>Cards</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const builtKeys = new Set(builds.map(b => b.key));
                    const pending = Object.entries(buildProgress)
                      .filter(([key, p]) => isActive(p) && !builtKeys.has(key))
                      .map(([key]) => ({ key, game: key.split('|')[0], set: key.split('|')[1], cardCount: 0, sizeBytes: 0, builtAt: 0 }));
                    return [...pending, ...builds].map((b) => {
                      const p = buildProgress[b.key];
                      const active = isActive(p);
                      const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
                      return (
                        <tr key={b.key}>
                          <td style={{ textTransform: 'uppercase', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{b.game}</td>
                          <td style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{b.set}</td>
                          <td>{b.cardCount || (p && p.total) || '-'}</td>
                          <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{b.sizeBytes ? formatBytes(b.sizeBytes) : '-'}</td>
                          <td style={{ minWidth: '160px' }}>
                            {active ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: p.status === 'fetching' ? '15%' : `${pct}%`, background: 'var(--accent-red)', transition: 'width 0.4s ease' }}></div>
                                </div>
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                                  {p.status === 'fetching' ? 'Fetching card list...' : `Indexing ${p.done}/${p.total} (${pct}%)`}
                                </span>
                              </div>
                            ) : p && p.status === 'error' ? (
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-red)' }} title={p.error}>Failed</span>
                            ) : (
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-green, #4ade80)' }}>Ready</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '0.35rem' }}>
                              <button
                                className="btn btn-secondary btn-icon-only"
                                title="Rebuild"
                                onClick={() => handleBuild(b.game, b.set, 0)}
                                disabled={active}
                              >
                                <RefreshCw size={14} />
                              </button>
                              <button
                                className="btn btn-danger btn-icon-only"
                                title="Remove index"
                                onClick={() => handleDeleteBuild(b.game, b.set)}
                                disabled={active}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Global Scan Index Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Globe size={18} style={{ color: 'var(--accent-red)' }} />
            Global Scan Indexes
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.4 }}>
            Whole-game image indexes power scanning when no set is selected. Rebuilding pulls every card (both faces of double-faced cards), so newly released sets and card backs become scannable. This is <strong>heavy</strong>: tens of thousands of images, the CLIP model on CPU, ~1GB on disk, and can run for hours. The existing index keeps serving scans until a rebuild finishes.
          </p>
          <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="collection-table">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Cards</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {globals.map((g) => {
                  const p = globalProgress[g.game];
                  const active = isGlobalActive(p);
                  const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
                  const cards = g.embed.cards || g.orb.cards || 0;
                  const bytes = (g.embed.bytes || 0) + (g.orb.bytes || 0);
                  return (
                    <tr key={g.game}>
                      <td style={{ textTransform: 'uppercase', fontWeight: 700, color: 'var(--text-strong)' }}>{g.game}</td>
                      <td>{cards ? cards.toLocaleString() : '-'}</td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{bytes ? formatBytes(bytes) : '-'}</td>
                      <td style={{ minWidth: '180px' }}>
                        {active ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent-red)', transition: 'width 0.4s ease' }}></div>
                            </div>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                              {p.phase === 'orb' ? 'ORB' : 'Embeddings'} {p.done}/{p.total || '?'} ({pct}%)
                            </span>
                          </div>
                        ) : p && p.status === 'error' ? (
                          <span style={{ fontSize: '0.75rem', color: 'var(--accent-red)' }} title={p.error}>Failed</span>
                        ) : p && p.status === 'stopped' ? (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Stopped</span>
                        ) : g.embed.present && g.orb.present ? (
                          <span style={{ fontSize: '0.75rem', color: 'var(--accent-green, #4ade80)' }}>Ready</span>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)' }}>Not built</span>
                        )}
                      </td>
                      <td>
                        {active ? (
                          <button className="btn btn-danger btn-icon-only" title="Stop build" onClick={() => handleStopGlobal(g.game)}>
                            <AlertTriangle size={14} />
                          </button>
                        ) : (
                          <button className="btn btn-secondary btn-icon-only" title="Rebuild global index" onClick={() => handleBuildGlobal(g.game)}>
                            <RefreshCw size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Database Backup Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <HardDriveDownload size={18} style={{ color: 'var(--accent-red)' }} />
              Database Backup
            </h3>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleBackup}
              disabled={backupLoading}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', height: '34px' }}
            >
              {backupLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : <><HardDriveDownload size={14} /> Back Up Now</>}
            </button>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.4 }}>
            Writes a consistent snapshot of the entire database (users, collections, tags, decks, storage, settings) to a file on the server. The newest {10} are kept. Download one to keep it off-server. To restore: stop the server, replace <code>pokemon_cards.db</code> with a backup file, and restart.
          </p>

          {backups.length === 0 ? (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              No backups yet.
            </div>
          ) : (
            <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Created</th>
                    <th>Size</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map(b => (
                    <tr key={b.file}>
                      <td style={{ fontWeight: 600, color: 'var(--text-strong)', fontFamily: 'monospace', fontSize: '0.78rem' }}>{b.file}</td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(b.created_at).toLocaleString()}</td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{formatBytes(b.size)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-icon-only"
                          title="Download backup"
                          onClick={() => handleDownloadBackup(b.file)}
                        >
                          <Download size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* User Maintenance Table */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Shield size={18} style={{ color: 'var(--accent-yellow)' }} />
              Manage Users
            </h3>
            <div style={{ position: 'relative', width: '100%', maxWidth: '220px' }}>
              <input
                type="text"
                className="input-control"
                placeholder="Filter trainers..."
                aria-label="Filter trainers"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                style={{ width: '100%', paddingLeft: '2rem', paddingVertical: '0.35rem', fontSize: '0.85rem' }}
              />
              <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </div>

          {loading ? (
            <div className="spinner"></div>
          ) : filteredUsers.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              No trainers match your filter.
            </div>
          ) : (
            <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Created At</th>
                    <th>Cards</th>
                    <th>Portfolio Value</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map(user => (
                    <tr key={user.id}>
                      <td style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{user.username}</td>
                      <td>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.5rem',
                          borderRadius: '12px',
                          backgroundColor: user.role === 'admin' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                          color: user.role === 'admin' ? 'var(--accent-red)' : 'var(--accent-blue)',
                          border: user.role === 'admin' ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(59,130,246,0.2)'
                        }}>
                          {user.role === 'admin' ? 'Admin' : 'Member'}
                        </span>
                      </td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {new Date(user.created_at).toLocaleDateString()}
                      </td>
                      <td style={{ fontWeight: 600 }}>{user.total_cards} cards</td>
                      <td style={{ fontWeight: 700, color: 'var(--accent-yellow)' }}>
                        ${(user.total_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.35rem' }}>
                          <button 
                            className="btn btn-secondary btn-icon-only" 
                            title="Toggle Role (Admin/Member)"
                            onClick={() => handleToggleRole(user)}
                            disabled={user.username === 'admin'}
                          >
                            {user.role === 'admin' ? <ToggleRight size={14} style={{ color: 'var(--accent-red)' }} /> : <ToggleLeft size={14} />}
                          </button>
                          <button 
                            className="btn btn-secondary btn-icon-only" 
                            title="Reset Password"
                            onClick={() => setTargetUser(user)}
                          >
                            <Key size={14} style={{ color: 'var(--accent-yellow)' }} />
                          </button>
                          <button 
                            className="btn btn-danger btn-icon-only" 
                            title="Delete Account"
                            onClick={() => handleDeleteUser(user)}
                            disabled={user.username === 'admin'}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Change Password Dialog Overlay */}
      {targetUser && (
        <div className="modal-overlay" style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 999
        }}>
          <div className="glass-panel" style={{ maxWidth: '380px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>Reset Password</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Change password for user: <strong>{targetUser.username}</strong></p>
            </div>
            <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="admin-reset-password">New Password</label>
                <input
                  id="admin-reset-password"
                  type="password"
                  name="reset-password"
                  autoComplete="new-password"
                  className="input-control"
                  placeholder="Min 8 characters"
                  value={updatePassword}
                  onChange={(e) => setUpdatePassword(e.target.value)}
                  required
                  autoFocus
                  disabled={pwdLoading}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => { setTargetUser(null); setUpdatePassword(''); }} disabled={pwdLoading}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={pwdLoading}>
                  {pwdLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : 'Save Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminPanel;
