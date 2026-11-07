import { useState } from 'react';
import { OPTIONAL_NAV_TABS, pinnedTabs, toggleNavTab, isCollectionView } from '../utils/navTabs';
import { useT } from '../utils/i18n';

const LABELS = {
  'add-cards': 'nav.addCards',
  sets: 'nav.browse',
  storage: 'nav.storage',
  deckbuilder: 'nav.deckBuilder',
  lists: 'nav.lists',
  notes: 'nav.notes',
  sealed: 'nav.sealed',
};

// Which tabs the nav bar shows (utils/navTabs.js). Saved on the account, so the
// bar is the same on every device; Dashboard, Collection and Settings always
// show. Browse, Lists and Sealed stay reachable inside Collection either way.
export default function NavTabsSettings({ user, onUpdateUser, showToast }) {
  const { t } = useT();
  const [saving, setSaving] = useState(false);
  const pinned = pinnedTabs(user && user.nav_tabs);

  const save = async (navTabs) => {
    setSaving(true);
    try {
      const res = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nav_tabs: navTabs }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user) { showToast(data.error || t('navTabs.errSave')); return; }
      onUpdateUser({ ...user, nav_tabs: data.user.nav_tabs });
    } catch {
      showToast(t('navTabs.errSave'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label>{t('navTabs.title')}</label>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.6rem' }}>
        {t('navTabs.hint')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '0.5rem' }}>
        {OPTIONAL_NAV_TABS.map(tab => (
          <label
            key={tab}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.6rem', margin: 0,
              background: 'var(--surface-1)', padding: '0.6rem 0.8rem',
              borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)',
              cursor: saving ? 'wait' : 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={pinned.includes(tab)}
              disabled={saving}
              onChange={() => save(toggleNavTab(user && user.nav_tabs, tab))}
              style={{ width: '16px', height: '16px', accentColor: 'var(--accent-red)' }}
            />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ color: 'var(--text-primary)', fontSize: '0.85rem' }}>{t(LABELS[tab])}</span>
              {isCollectionView(tab) && (
                <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'none', fontWeight: 400, letterSpacing: 'normal' }}>{t('navTabs.alsoInCollection')}</span>
              )}
            </span>
          </label>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={saving || user.nav_tabs == null}
        onClick={() => save(null)}
        style={{ marginTop: '0.6rem', fontSize: '0.78rem', padding: '0.35rem 0.8rem', width: 'auto', alignSelf: 'flex-start' }}
      >
        {t('navTabs.reset')}
      </button>
    </div>
  );
}
