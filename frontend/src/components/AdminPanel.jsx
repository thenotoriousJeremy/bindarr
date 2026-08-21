import { useState, useEffect, useRef } from 'react';
import { Shield, UserPlus, Key, Trash2, ToggleLeft, ToggleRight, Search, Users, Globe, HardDriveDownload, Download } from 'lucide-react';
import { useBackGuard } from '../utils/useBackGuard';
import CatalogPanel from './CatalogPanel';
import { currencySymbol } from '../utils/formatPrice';
import { useT } from '../utils/i18n';

const formatBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
};

function AdminPanel({ showToast }) {
  const { t, locale } = useT();
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
  const [pokemonProvider, setPokemonProvider] = useState('pokemontcg');
  const [settingsLoading, setSettingsLoading] = useState(false);
  const mountedRef = useRef(true);

  // Database backup states
  const [backups, setBackups] = useState([]);
  const [backupLoading, setBackupLoading] = useState(false);

  // Scan catalog management (and its own polling) lives in CatalogPanel now.
  useEffect(() => {
    mountedRef.current = true;
    fetchUsers();
    fetchSettings();
    fetchBackups();
    return () => { mountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
















  const handleSeedDatabase = async () => {
    if (!window.confirm(t('admin.confirmSeed'))) {
      return;
    }
    try {
      const res = await fetch('/api/admin/seed-cards', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        showToast(data.message);
        fetchUsers(); // Refresh stats
      } else {
        showToast(t('admin.errSeed'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errSeedGeneric'));
    }
  };

  const fetchBackups = async () => {
    try {
      const res = await fetch('/api/admin/backups');
      if (res.ok) {
        const data = await res.json();
        if (!mountedRef.current) return;
        setBackups(data.backups || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDownloadBackup = async (file) => {
    try {
      const res = await fetch(`/api/admin/backups/${encodeURIComponent(file)}/download`);
      if (!res.ok) { showToast(t('admin.errDownload')); return; }
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
      showToast(t('admin.errDownloadGeneric'));
    }
  };

  const handleBackup = async () => {
    setBackupLoading(true);
    try {
      const res = await fetch('/api/admin/backups', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(t('admin.backupCreated', { file: data.file, size: formatBytes(data.size) }));
        fetchBackups();
      } else {
        showToast(data.error || t('admin.errBackup'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errBackupGeneric'));
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
        if (!mountedRef.current) return;
        setUsers(data);
      } else {
        showToast(t('admin.errUserList'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('common.errBackend'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/settings');
      if (response.ok) {
        const data = await response.json();
        if (!mountedRef.current) return;
        setPublicBaseUrl(data.public_base_url || '');
        setPokemonProvider(data.pokemon_provider || 'pokemontcg');
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
        body: JSON.stringify({ public_base_url: publicBaseUrl, pokemon_provider: pokemonProvider })
      });

      if (response.ok) {
        const data = await response.json();
        setPublicBaseUrl(data.public_base_url || '');
        setPokemonProvider(data.pokemon_provider || 'pokemontcg');
        showToast(t('admin.settingsUpdated'));
      } else {
        const data = await response.json();
        showToast(data.error || t('admin.errSettings'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errSettingsGeneric'));
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    if (newUsername.length < 3) {
      showToast(t('admin.errUsernameShort', { count: 3 }));
      return;
    }
    if (newPassword.length < 8) {
      showToast(t('login.errPasswordShort', { count: 8 }));
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
        showToast(t('admin.userCreated', { name: newUsername }));
        setNewUsername('');
        setNewPassword('');
        setNewRole('member');
        fetchUsers();
      } else {
        const data = await response.json();
        showToast(data.error || t('admin.errCreateUser'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errCreateUserGeneric'));
    } finally {
      setAddLoading(false);
    }
  };

  const handleToggleRole = async (user) => {
    const nextRole = user.role === 'admin' ? 'member' : 'admin';
    if (user.username === 'admin') {
      showToast(t('admin.errDemoteRoot'));
      return;
    }

    if (!window.confirm(t('admin.confirmRoleChange', { name: user.username, role: nextRole }))) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole })
      });

      if (response.ok) {
        showToast(t('admin.roleUpdated', { role: nextRole, name: user.username }));
        fetchUsers();
      } else {
        const data = await response.json();
        showToast(data.error || t('admin.errRoleChange'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errRoleChangeGeneric'));
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!targetUser) return;
    if (updatePassword.length < 8) {
      showToast(t('login.errPasswordShort', { count: 8 }));
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
        showToast(t('admin.passwordUpdated', { name: targetUser.username }));
        setUpdatePassword('');
        setTargetUser(null);
      } else {
        const data = await response.json();
        showToast(data.error || t('settings.errPasswordUpdate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('settings.errPasswordUpdateGeneric'));
    } finally {
      setPwdLoading(false);
    }
  };

  const handleDeleteUser = async (user) => {
    if (user.username === 'admin') {
      showToast(t('admin.errDeleteRoot'));
      return;
    }

    if (!window.confirm(t('admin.confirmDeleteUser', { name: user.username }))) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('admin.userDeleted', { name: user.username }));
        fetchUsers();
      } else {
        const data = await response.json();
        showToast(data.error || t('admin.errDeleteUser'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errDeleteUserGeneric'));
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
          <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)' }}>{t('admin.title')}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('admin.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button 
            type="button" 
            className="btn btn-secondary btn-sm" 
            onClick={handleSeedDatabase}
            style={{ padding: '0.5rem 1rem', height: '34px', fontSize: '0.8rem', border: '1px solid var(--border-glass)' }}
          >
            🧪 {t('admin.generateTestCards')}
          </button>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', height: '34px' }}>
            <Users size={16} style={{ color: 'var(--accent-red)' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{t('admin.totalTrainers', { count: users.length })}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '1.5rem' }} className="admin-grid-layout">
        {/* Registration Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <UserPlus size={18} style={{ color: 'var(--accent-red)' }} />
            {t('admin.registerTitle')}
          </h3>
          <form onSubmit={handleAddUser} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-new-username">{t('admin.newUsername')}</label>
              <input
                id="admin-new-username"
                type="text"
                name="new-username"
                autoComplete="off"
                className="input-control"
                placeholder={t('login.usernamePlaceholder')}
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                required
                disabled={addLoading}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-new-password">{t('admin.initialPassword')}</label>
              <input
                id="admin-new-password"
                type="password"
                name="new-user-password"
                autoComplete="new-password"
                className="input-control"
                placeholder={t('settings.newPasswordPlaceholder', { count: 8 })}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                disabled={addLoading}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-new-role">{t('admin.role')}</label>
              <select id="admin-new-role" className="select-control" value={newRole} onChange={(e) => setNewRole(e.target.value)} disabled={addLoading}>
                <option value="member">{t('admin.roleMember')}</option>
                <option value="admin">{t('admin.roleAdministrator')}</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary" style={{ padding: '0.6rem', fontWeight: 700 }} disabled={addLoading}>
              {addLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : t('admin.createAccount')}
            </button>
          </form>
        </div>

        {/* Instance Settings Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Globe size={18} style={{ color: 'var(--accent-red)' }} />
            {t('admin.instanceTitle')}
          </h3>
          <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ background: 'rgba(255, 71, 71, 0.03)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {t('admin.instanceHint', { envVar: 'PUBLIC_BASE_URL' })}
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-public-base-url">{t('admin.publicBaseUrl')}</label>
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
            {/* Which Pokémon API this install speaks to. It has always been a column
                in app_settings and a branch in utils/pokemonProvider, with no way
                to set it — so every install ran on pokemontcg.io whether or not it
                suited them. The two are not interchangeable: they number the same
                sets differently, so switching re-syncs the set table and rebuilds
                the TCGplayer product map behind it. */}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-pokemon-provider">{t('admin.pokemonProvider')}</label>
              <select
                id="admin-pokemon-provider"
                className="select-control"
                value={pokemonProvider}
                onChange={(e) => setPokemonProvider(e.target.value)}
                disabled={settingsLoading}
              >
                <option value="pokemontcg">{t('admin.providerPokemontcg')}</option>
                <option value="tcgdex">{t('admin.providerTcgdex')}</option>
              </select>
              <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                {t('admin.pokemonProviderHint')}
              </p>
            </div>
            <button type="submit" className="btn btn-primary" style={{ padding: '0.6rem', fontWeight: 700, alignSelf: 'flex-start' }} disabled={settingsLoading}>
              {settingsLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : t('admin.saveSettings')}
            </button>
          </form>
        </div>

        {/* Scan catalogs. One build per game+language: download the cards, then index
            their artwork. Replaced the per-set / whole-game ORB index panel. */}
        <div className="glass-panel">
          <CatalogPanel showToast={showToast} />
        </div>

        {/* Database Backup Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <HardDriveDownload size={18} style={{ color: 'var(--accent-red)' }} />
              {t('admin.backupTitle')}
            </h3>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleBackup}
              disabled={backupLoading}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', height: '34px' }}
            >
              {backupLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : <><HardDriveDownload size={14} /> {t('admin.backUpNow')}</>}
            </button>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.4 }}>
            {t('admin.backupHint', { keep: 10, dbFile: 'bindarr.db' })}
          </p>

          {backups.length === 0 ? (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              {t('admin.noBackups')}
            </div>
          ) : (
            <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>{t('admin.colFile')}</th>
                    <th>{t('admin.colCreated')}</th>
                    <th>{t('admin.colSize')}</th>
                    <th>{t('admin.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map(b => (
                    <tr key={b.file}>
                      <td style={{ fontWeight: 600, color: 'var(--text-strong)', fontFamily: 'monospace', fontSize: '0.78rem' }}>{b.file}</td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(b.created_at).toLocaleString(locale)}</td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{formatBytes(b.size)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-icon-only"
                          title={t('admin.downloadBackup')}
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
              {t('admin.manageUsers')}
            </h3>
            <div style={{ position: 'relative', width: '100%', maxWidth: '220px' }}>
              <input
                type="text"
                className="input-control"
                placeholder={t('admin.filterTrainers')}
                aria-label={t('admin.filterTrainers')}
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
              {t('admin.noTrainerMatch')}
            </div>
          ) : (
            <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>{t('login.username')}</th>
                    <th>{t('admin.role')}</th>
                    <th>{t('admin.colCreatedAt')}</th>
                    <th>{t('sets.colCards')}</th>
                    <th>{t('admin.colPortfolio')}</th>
                    <th>{t('admin.colActions')}</th>
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
                          {t(user.role === 'admin' ? 'admin.roleAdmin' : 'admin.roleMember')}
                        </span>
                      </td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {new Date(user.created_at).toLocaleDateString(locale)}
                      </td>
                      <td style={{ fontWeight: 600 }}>{t('admin.userCards', { count: user.total_cards })}</td>
                      <td style={{ fontWeight: 700, color: 'var(--accent-yellow)' }}>
                        {currencySymbol()}{(user.total_value || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.35rem' }}>
                          <button 
                            className="btn btn-secondary btn-icon-only" 
                            title={t('admin.toggleRole')}
                            onClick={() => handleToggleRole(user)}
                            disabled={user.username === 'admin'}
                          >
                            {user.role === 'admin' ? <ToggleRight size={14} style={{ color: 'var(--accent-red)' }} /> : <ToggleLeft size={14} />}
                          </button>
                          <button 
                            className="btn btn-secondary btn-icon-only" 
                            title={t('admin.resetPassword')}
                            onClick={() => setTargetUser(user)}
                          >
                            <Key size={14} style={{ color: 'var(--accent-yellow)' }} />
                          </button>
                          <button 
                            className="btn btn-danger btn-icon-only" 
                            title={t('admin.deleteAccount')}
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
              <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('admin.resetPassword')}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t('admin.resetPasswordFor')} <strong>{targetUser.username}</strong></p>
            </div>
            <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="admin-reset-password">{t('settings.newPassword')}</label>
                <input
                  id="admin-reset-password"
                  type="password"
                  name="reset-password"
                  autoComplete="new-password"
                  className="input-control"
                  placeholder={t('settings.newPasswordPlaceholder', { count: 8 })}
                  value={updatePassword}
                  onChange={(e) => setUpdatePassword(e.target.value)}
                  required
                  autoFocus
                  disabled={pwdLoading}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => { setTargetUser(null); setUpdatePassword(''); }} disabled={pwdLoading}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={pwdLoading}>
                  {pwdLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : t('admin.savePassword')}
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
