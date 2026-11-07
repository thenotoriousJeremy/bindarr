import { useState, useEffect, useCallback } from 'react';
import { Bell, Send, Trash2 } from 'lucide-react';
import { useT } from '../utils/i18n';

// Settings → Notifications: where this user's notifications go (Discord, ntfy, a
// webhook, an Apprise server) and how big a price move has to be to mention.
//
// Its own component, and its own fetches, so Settings.jsx only gains one line.
// The server never sends a channel's URL or token back (they are write-only
// secrets), so a saved channel shows its host and "token set" rather than the
// values; replacing one means deleting the channel and adding it again.
const TYPES = ['discord', 'ntfy', 'webhook', 'apprise'];
const EMPTY = { type: 'discord', name: '', url: '', topic: '', token: '' };

const hint = { fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: 1.45 };
const row = { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' };

function NotificationSettings({ isAdmin, showToast }) {
  const { t } = useT();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [prefs, setPrefs] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      const json = await res.json();
      setData(json);
      setPrefs({
        ...json.prefs,
        price_pct: json.prefs.price_pct ?? '',
        price_abs: json.prefs.price_abs ?? '',
        min_price: json.prefs.min_price ?? '',
      });
    } catch {
      /* the panel stays hidden when the server cannot answer */
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const send = async (method, url, body) => {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, json };
  };

  const addChannel = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { ok, json } = await send('POST', '/api/notifications/channels', form);
      if (!ok) return showToast(json?.error || t('notify.errSave'));
      setForm({ ...EMPTY, type: form.type });
      showToast(t('notify.added'));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const updateChannel = async (id, patch) => {
    const { ok, json } = await send('PUT', `/api/notifications/channels/${id}`, patch);
    if (!ok) return showToast(json?.error || t('notify.errSave'));
    setData(d => ({ ...d, channels: d.channels.map(c => (c.id === id ? json : c)) }));
  };

  const deleteChannel = async (id) => {
    if (!window.confirm(t('notify.confirmDelete'))) return;
    const { ok, json } = await send('DELETE', `/api/notifications/channels/${id}`);
    if (!ok) return showToast(json?.error || t('notify.errSave'));
    setData(d => ({ ...d, channels: d.channels.filter(c => c.id !== id) }));
  };

  const testChannel = async (id) => {
    setBusy(true);
    try {
      const { ok, json } = await send('POST', `/api/notifications/channels/${id}/test`);
      showToast(ok ? t('notify.testSent') : (json?.error || t('notify.testFailed')));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const savePrefs = async (e) => {
    e.preventDefault();
    const { ok, json } = await send('PUT', '/api/notifications/prefs', prefs);
    showToast(ok ? t('notify.prefsSaved') : (json?.error || t('notify.errSave')));
  };

  if (!data || !prefs) return null;

  const urlLabel = {
    discord: t('notify.urlDiscord'),
    ntfy: t('notify.urlNtfy'),
    webhook: t('notify.urlWebhook'),
    apprise: t('notify.urlApprise'),
  }[form.type];

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
        <Bell size={20} style={{ color: 'var(--accent-yellow)' }} />
        <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('notify.title')}</h3>
      </div>

      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{t('notify.intro')}</div>

      {data.channels.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {data.channels.map(ch => (
            <div key={ch.id} style={{ border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem' }}>
                    {ch.name || t(`notify.type.${ch.type}`)}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                    {t(`notify.type.${ch.type}`)} · {ch.host}{ch.topic ? ` · ${ch.topic}` : ''}{ch.has_token ? ` · ${t('notify.tokenSet')}` : ''}
                  </div>
                  {ch.last_status === 'failed' && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--accent-red)' }}>{t('notify.lastFailed', { error: ch.last_error || '' })}</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => testChannel(ch.id)}
                    style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                    <Send size={14} /> {t('notify.sendTest')}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => deleteChannel(ch.id)}
                    aria-label={t('common.delete')} title={t('common.delete')}
                    style={{ padding: '0.4rem 0.6rem', display: 'inline-flex', alignItems: 'center' }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                <label style={row}>
                  <input type="checkbox" checked={ch.enabled} onChange={e => updateChannel(ch.id, { enabled: e.target.checked })} />
                  {t('notify.enabled')}
                </label>
                <label style={row}>
                  <input type="checkbox" checked={ch.events_price} onChange={e => updateChannel(ch.id, { events_price: e.target.checked })} />
                  {t('notify.eventsPrice')}
                </label>
                {isAdmin && (
                  <label style={row}>
                    <input type="checkbox" checked={ch.events_admin} onChange={e => updateChannel(ch.id, { events_admin: e.target.checked })} />
                    {t('notify.eventsAdmin')}
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={addChannel} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
        <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem' }}>{t('notify.addTitle')}</div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: '1 1 10rem' }}>
            <label htmlFor="notify-type">{t('notify.typeLabel')}</label>
            <select id="notify-type" className="input-control" value={form.type}
              onChange={e => setForm({ ...EMPTY, type: e.target.value, name: form.name })}>
              {TYPES.map(type => <option key={type} value={type}>{t(`notify.type.${type}`)}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: '2 1 12rem' }}>
            <label htmlFor="notify-name">{t('notify.nameLabel')}</label>
            <input id="notify-name" className="input-control" value={form.name} maxLength={80}
              onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="notify-url">{urlLabel}</label>
          <input id="notify-url" className="input-control" type={form.type === 'ntfy' ? 'url' : 'password'} autoComplete="off" required
            placeholder={form.type === 'discord' ? 'https://discord.com/api/webhooks/…' : form.type === 'ntfy' ? 'https://ntfy.sh' : 'https://'}
            value={form.url} onChange={e => setForm({ ...form, url: e.target.value })}
            style={{ fontFamily: 'monospace', width: '100%' }} />
          <div style={hint}>
            {t(`notify.hint.${form.type}`)}{' '}
            {!data.allow_private && t('notify.privateBlocked')}
          </div>
        </div>
        {form.type === 'ntfy' && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="notify-topic">{t('notify.topicLabel')}</label>
            <input id="notify-topic" className="input-control" required pattern="[A-Za-z0-9_\-]{1,64}" value={form.topic}
              onChange={e => setForm({ ...form, topic: e.target.value })} style={{ fontFamily: 'monospace' }} />
          </div>
        )}
        {form.type !== 'discord' && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="notify-token">{t('notify.tokenLabel')}</label>
            <input id="notify-token" className="input-control" type="password" autoComplete="off" value={form.token}
              onChange={e => setForm({ ...form, token: e.target.value })} style={{ fontFamily: 'monospace' }} />
            <div style={hint}>{t('notify.tokenHint')}</div>
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy} style={{ alignSelf: 'flex-start', padding: '0.6rem 1.2rem' }}>
          {t('notify.add')}
        </button>
      </form>

      <form onSubmit={savePrefs} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
        <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem' }}>{t('notify.priceTitle')}</div>
        <label style={row}>
          <input type="checkbox" checked={prefs.price_enabled} onChange={e => setPrefs({ ...prefs, price_enabled: e.target.checked })} />
          {t('notify.priceEnabled')}
        </label>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {[['price_pct', t('notify.pricePct')], ['price_abs', t('notify.priceAbs')], ['min_price', t('notify.minPrice')]].map(([key, label]) => (
            <div key={key} className="form-group" style={{ marginBottom: 0, flex: '1 1 8rem' }}>
              <label htmlFor={`notify-${key}`}>{label}</label>
              <input id={`notify-${key}`} className="input-control" type="number" min="0" step="any" value={prefs[key]}
                onChange={e => setPrefs({ ...prefs, [key]: e.target.value === '' ? '' : Number(e.target.value) })} />
            </div>
          ))}
        </div>
        <div style={hint}>{t('notify.priceHint')}</div>
        <label style={row}>
          <input type="checkbox" checked={prefs.include_wishlist} onChange={e => setPrefs({ ...prefs, include_wishlist: e.target.checked })} />
          {t('notify.includeWishlist')}
        </label>
        <button type="submit" className="btn btn-secondary" style={{ alignSelf: 'flex-start', padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
          {t('common.save')}
        </button>
      </form>
    </div>
  );
}

export default NotificationSettings;
