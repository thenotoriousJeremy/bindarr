import { useState, useEffect } from 'react';
import { User, Lock, ArrowRight, Eye, EyeOff, Server, Shield } from 'lucide-react';
import { isNative, getServerUrl, setServerUrl } from '../apiBase';
import { useT } from '../utils/i18n';
import Logo from './Logo';

// Must match OWNER_USERNAME in backend/src/routes/auth.js — the bootstrap route
// ignores whatever username is posted and always creates `admin`.
const OWNER_USERNAME = 'admin';

function Login({ onLoginSuccess }) {
  const { t } = useT();
  const [isRegister, setIsRegister] = useState(false);
  // Native app connects to the user's own self-hosted instance; web is same-origin.
  const [server, setServer] = useState(getServerUrl());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const oidcErr = params.get('oidc_error');
      if (oidcErr) {
        // Clean URL parameter without reloading
        window.history.replaceState({}, document.title, window.location.pathname);
        return oidcErr;
      }
    } catch { /* ignore */ }
    return '';
  });
  const [loading, setLoading] = useState(false);
  // Whether open self-registration is allowed (invite-only by default). Drives
  // whether the Sign Up option is shown at all.
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  // A server with no accounts at all: the form creates the owner account instead
  // of signing in, so nobody has to dig a generated password out of the logs.
  const [setupRequired, setSetupRequired] = useState(false);
  // OIDC / SSO status
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcProviderName, setOidcProviderName] = useState('Single Sign-On');

  useEffect(() => {
    if (isNative && !server) return; // wait until user sets their server URL
    let cancelled = false, tries = 0;
    // Cold start on native: the WebView renders before the CapacitorHttp bridge /
    // network is ready, so this fetch can fail and the Sign Up button would stay
    // hidden forever. Retry on failure (a real 200 {registrationEnabled:false}
    // stops immediately) and refetch on resume so the button self-heals.
    const load = () => {
      fetch('/api/auth/config')
        .then(res => res.ok ? res.json() : Promise.reject(new Error('config unreachable')))
        .then(data => {
          if (cancelled) return;
          setRegistrationEnabled(!!data.registrationEnabled);
          setSetupRequired(!!data.setupRequired);
          setOidcEnabled(!!data.oidcEnabled);
          if (data.oidcProviderName) setOidcProviderName(data.oidcProviderName);
          // The owner account's name is the server's to decide, not the
          // visitor's — see the bootstrap route. Shown read-only rather than
          // hidden, because it is the name they will log in with next time.
          if (data.setupRequired) setUsername(OWNER_USERNAME);
        })
        .catch(() => { if (!cancelled && tries++ < 5) setTimeout(load, 1500); });
    };
    // Debounce so a freshly-typed server address is checked once it settles,
    // not against every half-typed URL keystroke.
    const debounce = setTimeout(load, server ? 400 : 0);
    const onVis = () => { if (document.visibilityState === 'visible') { tries = 0; load(); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; clearTimeout(debounce); document.removeEventListener('visibilitychange', onVis); };
  }, [server]);

  // Creating an account (first-run owner, or self-registration) asks for the
  // password twice and validates it; signing in does neither.
  const creating = isRegister || setupRequired;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    // Browser password managers parse the form when the submit lands, and they
    // need to find an <input type="password"> to offer to save anything. Someone
    // who left "show password" on would otherwise submit a plain text field and
    // never get the save prompt — so the reveal always closes on submit.
    setShowPassword(false);

    if (isNative && !server) {
      setError(t('login.errServerFirst'));
      return;
    }

    setLoading(true);

    if (creating) {
      if (username.length < 3) {
        setError(t('login.errUsernameShort', { count: 3 }));
        setLoading(false);
        return;
      }
      if (password.length < 8) {
        setError(t('login.errPasswordShort', { count: 8 }));
        setLoading(false);
        return;
      }
      if (password !== confirmPassword) {
        setError(t('login.errPasswordMismatch'));
        setLoading(false);
        return;
      }
    }

    const endpoint = setupRequired ? '/api/auth/bootstrap'
      : isRegister ? '/api/auth/register'
        : '/api/auth/login';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('login.errFailed'));
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
      minHeight: '100vh',
      boxSizing: 'border-box',
      padding: 'calc(1rem + max(env(safe-area-inset-top, 0px), var(--sat, 0px))) 1rem calc(1rem + max(env(safe-area-inset-bottom, 0px), var(--sab, 0px))) 1rem'
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
            {t(setupRequired ? 'login.setupTagline' : isRegister ? 'login.taglineRegister' : 'login.taglineLogin')}
          </p>
        </div>

        {setupRequired && (
          <div style={{
            padding: '0.75rem 1rem',
            marginBottom: '1.5rem',
            borderLeft: '3px solid var(--accent-red)',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.5
          }}>
            {t('login.setupNote')}
          </div>
        )}

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

        {oidcEnabled && !setupRequired && !isRegister && (
          <div style={{ marginBottom: '1.25rem' }}>
            <a
              href={(isNative && server ? server.replace(/\/+$/, '') : '') + '/api/auth/oidc/login'}
              className="btn"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.6rem',
                padding: '0.75rem 1rem',
                width: '100%',
                boxSizing: 'border-box',
                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: 'var(--text-strong)',
                fontSize: '0.95rem',
                fontWeight: 600,
                borderRadius: 'var(--radius-sm)',
                textDecoration: 'none',
                transition: 'all 0.2s ease',
                cursor: 'pointer'
              }}
            >
              <Shield size={18} style={{ color: 'var(--accent-red)' }} />
              <span>{t('login.oidcLogin', { provider: oidcProviderName })}</span>
            </a>

            <div style={{ display: 'flex', alignItems: 'center', margin: '1.25rem 0 0.25rem 0', gap: '0.75rem' }}>
              <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.1)' }} />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('login.orDivider')}
              </span>
              <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.1)' }} />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {isNative && (
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="login-server" style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('login.serverUrl')}</label>
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
            <label htmlFor="login-username" style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('login.username')}</label>
            <div style={{ position: 'relative' }}>
              <input
                id="login-username"
                type="text"
                name="username"
                autoComplete="username"
                className="input-control"
                style={{ width: '100%', paddingLeft: '2.5rem' }}
                placeholder={t('login.usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                // readOnly, never disabled: a disabled field is dropped from the
                // form, so a password manager inspecting it mid-submit sees no
                // username to save. Read-only still blocks typing.
                readOnly={setupRequired || loading}
              />
              <User size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="login-password" style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('login.password')}</label>
            <div style={{ position: 'relative' }}>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete={creating ? 'new-password' : 'current-password'}
                className="input-control"
                style={{ width: '100%', paddingLeft: '2.5rem', paddingRight: '2.5rem' }}
                placeholder={t('login.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                readOnly={loading}
              />
              <Lock size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={t(showPassword ? 'login.hidePassword' : 'login.showPassword')}
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

          {creating && (
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="login-confirm-password" style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('login.confirmPassword')}</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="login-confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  name="confirm-password"
                  autoComplete="new-password"
                  className="input-control"
                  style={{ width: '100%', paddingLeft: '2.5rem' }}
                  placeholder={t('login.confirmPasswordPlaceholder')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  readOnly={loading}
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
                <span>{t(setupRequired ? 'login.setupSubmit' : isRegister ? 'login.register' : 'login.login')}</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        {registrationEnabled && !setupRequired && (
          <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t(isRegister ? 'login.haveAccount' : 'login.noAccount')}{' '}
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
              {t(isRegister ? 'login.signIn' : 'login.signUp')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default Login;
