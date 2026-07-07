import { useState, useEffect } from 'react';
import { Shield, UserPlus, Key, Trash2, ToggleLeft, ToggleRight, Search, Users } from 'lucide-react';

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
  const [updatePassword, setUpdatePassword] = useState('');
  const [pwdLoading, setPwdLoading] = useState(false);

  useEffect(() => {
    fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <h2 style={{ fontSize: '1.25rem', color: '#fff' }}>Trainer Administration</h2>
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }} className="admin-grid-layout">
        {/* Registration Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: '#fff', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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

        {/* User Maintenance Table */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
            <h3 style={{ color: '#fff', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
                      <td style={{ fontWeight: 700, color: '#fff' }}>{user.username}</td>
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
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 999,
          padding: '1rem'
        }}>
          <div className="glass-panel" style={{ maxWidth: '380px', width: '100%', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <h3 style={{ color: '#fff', fontSize: '1.1rem' }}>Reset Password</h3>
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
