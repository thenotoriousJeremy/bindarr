import { useState, useEffect } from 'react';
import { User, Lock, ArrowRight, Eye, EyeOff, Server } from 'lucide-react';
import { isNative, getServerUrl, setServerUrl } from '../apiBase';
import Logo from './Logo';

function Login({ onLoginSuccess }) {
  const [isRegister, setIsRegister] = useState(false);
  // Native app connects to the user's own self-hosted instance; web is same-origin.
  const [server, setServer] = useState(getServerUrl());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Whether open self-registration is allowed (invite-only by default). Drives
  // whether the Sign Up option is shown at all.
  const [registrationEnabled, setRegistrationEnabled] = useState(false);

  useEffect(() => {
    if (isNative && !server) return; // wait until user sets their server URL
    fetch('/api/auth/config')
      .then(res => res.ok ? res.json() : { registrationEnabled: false })
      .then(data => setRegistrationEnabled(!!data.registrationEnabled))
      .catch(() => setRegistrationEnabled(false));
  }, [server]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (isNative && !server) {
      setError('Enter your server URL first.');
      return;
    }

    setLoading(true);

    if (isRegister) {
      if (username.length < 3) {
        setError('Username must be at least 3 characters.');
        setLoading(false);
        return;
      }
      if (password.length < 8) {
        setError('Password must be at least 8 characters.');
        setLoading(false);
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        setLoading(false);
        return;
      }
    }

    const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      onLoginSuccess(data.token, data.user);
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '80vh',
      padding: '1rem'
    }}>
      <div className="glass-panel" style={{
        maxWidth: '420px',
        width: '100%',
        padding: '2.5rem 2rem',
        boxShadow: 'var(--shadow-glow), var(--shadow-accent)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid rgba(255, 71, 71, 0.2)'
      }}>
        {/* Logo/Icon */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ width: '84px', height: '84px', margin: '0 auto 1rem auto', filter: 'drop-shadow(0 0 12px var(--accent-red-glow))' }}>
            <Logo />
          </div>
          <h2 style={{ fontSize: '1.8rem', color: 'var(--text-strong)', fontWeight: 800 }}>
            Bind<span style={{ color: 'var(--accent-red)' }}>arr</span>
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
            {isRegister ? 'Create your trainer account' : 'Access your personal card database'}
          </p>
        </div>

        {error && (
          <div className="glass-panel" style={{
            padding: '0.75rem 1rem',
            borderLeft: '3px solid var(--accent-red)',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            color: '#f87171',
            fontSize: '0.85rem',
            marginBottom: '1.5rem',
            borderRadius: 'var(--radius-sm)'
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {isNative && (
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="login-server" style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Server URL</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="login-server"
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="input-control"
                  style={{ width: '100%', paddingLeft: '2.5rem' }}
                  placeholder="https://your-server.example.com"
                  value={server}
                  onChange={(e) => { setServer(e.target.value); setServerUrl(e.target.value); }}
                  required
                  disabled={loading}
                />
                <Server size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              </div>
            </div>
          )}

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="login-username" style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Username</label>
            <div style={{ position: 'relative' }}>
              <input
                id="login-username"
                type="text"
                name="username"
                autoComplete="username"
                className="input-control"
                style={{ width: '100%', paddingLeft: '2.5rem' }}
                placeholder="Enter username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                disabled={loading}
              />
              <User size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="login-password" style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Password</label>
            <div style={{ position: 'relative' }}>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                className="input-control"
                style={{ width: '100%', paddingLeft: '2.5rem', paddingRight: '2.5rem' }}
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
              />
              <Lock size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                style={{
                  position: 'absolute',
                  right: '0.75rem',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '8px',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {isRegister && (
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="login-confirm-password" style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Confirm Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="login-confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  name="confirm-password"
                  autoComplete="new-password"
                  className="input-control"
                  style={{ width: '100%', paddingLeft: '2.5rem' }}
                  placeholder="Re-enter password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={loading}
                />
                <Lock size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              </div>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{
              padding: '0.75rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              fontSize: '1rem',
              fontWeight: 700,
              boxShadow: 'var(--shadow-accent)'
            }}
            disabled={loading}
          >
            {loading ? (
              <div className="spinner" style={{ width: '16px', height: '16px', margin: 0, borderWidth: '2px' }}></div>
            ) : (
              <>
                <span>{isRegister ? 'Register' : 'Login'}</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        {registrationEnabled && (
          <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              onClick={() => {
                setIsRegister(!isRegister);
                setError('');
                setPassword('');
                setConfirmPassword('');
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-red)',
                fontWeight: 600,
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: '0 2px'
              }}
              disabled={loading}
            >
              {isRegister ? 'Sign In' : 'Sign Up'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default Login;
