import { memo, useState, useEffect } from 'react';
import { Plus, ListChecks, Heart } from 'lucide-react';
import { useTabParam, setTabParam } from '../utils/router';
import { gameOptions, showGamePicker, gameLabel } from '../utils/games';
import { LIST_KINDS } from '../utils/listsApi';
import { useT } from '../utils/i18n';
import ListDetail, { MissingValue, ProgressBar, WishlistStartHint } from './ListDetail';

function Lists({ showToast, active = true, statsTrigger }) {
  const { t } = useT();
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  // The open list is in the URL (/lists/:id): Back closes it, a link opens it.
  const listParam = useTabParam('lists');
  const openId = listParam == null ? null : Number(listParam);
  const setOpenId = (id, opts) => setTabParam('lists', id, opts);

  // New list form
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('wishlist');
  const [newGame, setNewGame] = useState('');

  const loadLists = async () => {
    try {
      const res = await fetch('/api/lists');
      if (res.ok) setLists(await res.json());
    } catch (err) {
      console.error(err);
      showToast(t('lists.errLoad'));
    } finally {
      setLoading(false);
    }
  };

  // Tabs stay mounted while hidden, and cards are added to lists from other tabs
  // (the inspector, search) — so refresh whenever this one is shown again. The
  // open list reads itself (ListDetail).
  useEffect(() => {
    if (!active) return;
    loadLists();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- showToast/t change identity every App render; refetch only on these
  }, [active, statsTrigger, openId]);

  const createNew = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const res = await fetch('/api/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), kind: newKind, game: newGame || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || t('lists.errCreate')); return; }
    setNewName('');
    showToast(t('lists.created', { name: data.name }));
    loadLists();
  };

  // ============================ DETAIL ============================
  // Keyed by the list, so Back/Forward or a link to another list never shows the
  // last list's contents under this one's name.
  if (openId != null) {
    return (
      <ListDetail
        key={openId}
        listId={openId}
        active={active}
        statsTrigger={statsTrigger}
        showToast={showToast}
        onBack={() => setOpenId(null)}
        onGone={() => setOpenId(null, { replace: true })}
        onDeleted={() => { setOpenId(null); loadLists(); }}
        onChanged={loadLists}
      />
    );
  }

  // ============================ INDEX ============================
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', margin: 0, color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ListChecks size={20} /> {t('nav.lists')}
          </h2>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('lists.subtitle')}</p>
        </div>
        <form onSubmit={createNew} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem', alignItems: 'end' }}>
          <input className="input-control" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('lists.namePlaceholder')} aria-label={t('lists.name')} maxLength={120} />
          <select className="select-control" value={newKind} onChange={(e) => setNewKind(e.target.value)} aria-label={t('lists.kindLabel')}>
            {LIST_KINDS.map(k => <option key={k} value={k}>{t(`lists.kind.${k}`)}</option>)}
          </select>
          {showGamePicker() && (
            <select className="select-control" value={newGame} onChange={(e) => setNewGame(e.target.value)} aria-label={t('lists.game')}>
              <option value="">{t('lists.anyGame')}</option>
              {gameOptions().map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          )}
          <button type="submit" className="btn btn-primary" disabled={!newName.trim()}>
            <Plus size={16} /> {t('lists.newList')}
          </button>
        </form>
      </div>

      {!loading && !lists.some(l => l.is_default) && <WishlistStartHint />}

      {loading ? <div className="spinner" /> : lists.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem 1.5rem', color: 'var(--text-secondary)' }}>
          <ListChecks size={36} style={{ opacity: 0.4 }} />
          <p style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{t('lists.empty')}</p>
          <p style={{ fontSize: '0.85rem' }}>{t('lists.emptyHint')}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem' }}>
          {lists.map(list => (
            <button key={list.id} type="button" className="glass-panel" onClick={() => setOpenId(list.id)}
              style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '0.5rem', color: 'inherit', font: 'inherit', ...(list.is_default ? { borderColor: 'var(--accent-red)' } : {}) }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
                <strong style={{ color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  {list.is_default ? <Heart size={14} fill="currentColor" style={{ color: 'var(--accent-red)', flexShrink: 0 }} aria-label={t('wishlist.defaultBadge')} /> : null}
                  {list.name}
                </strong>
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {t(`lists.kind.${list.kind}`)}{list.game ? ` · ${gameLabel(list.game, true)}` : ''}
                </span>
              </div>
              <ProgressBar summary={list.summary} />
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span>{t('lists.progress', { owned: list.summary.owned, wanted: list.summary.wanted })}</span>
                {list.summary.missing > 0 && <MissingValue summary={list.summary} />}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Memoized: App re-renders on every toast, and its props here are stable.
export default memo(Lists);
