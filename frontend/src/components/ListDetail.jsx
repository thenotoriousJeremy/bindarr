import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, ChevronLeft, Search, Copy, Pencil, X, Heart, Library } from 'lucide-react';
import CardImage from './CardImage';
import { goToTab } from '../utils/router';
import { wishlist } from '../utils/wishlist';
import { gameOptions, showGamePicker, gameLabel, defaultGame } from '../utils/games';
import { displayName, setReference, langCode } from '../utils/languages';
import { translateJapaneseName } from '../utils/langHelper';
import { priceText } from '../utils/formatPrice';
import { useFx } from '../utils/useFx';
import { filterItems, listAsText, currencyTotals, progressPercent } from '../utils/listText';
import { useT } from '../utils/i18n';
import { LatestRequest, isAbortError } from '../utils/request';
import { LIST_KINDS } from '../utils/listsApi';

// Per-currency money, never added across currencies, plus how many missing
// cards have no price at all (so a total is never mistaken for the whole cost).
export function MissingValue({ summary }) {
  const { t } = useT();
  const totals = currencyTotals(summary?.missing_value);
  if (totals.length === 0 && !summary?.unpriced) return null;
  return (
    <span style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
      {totals.map(({ currency, amount }) => (
        <strong key={currency} style={{ color: 'var(--accent-yellow)' }}>{priceText(amount, currency)}</strong>
      ))}
      {summary.unpriced > 0 && (
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('lists.unpriced', { count: summary.unpriced })}</span>
      )}
    </span>
  );
}

export function ProgressBar({ summary }) {
  const pct = progressPercent(summary);
  return (
    <div style={{ height: '6px', borderRadius: '999px', background: 'var(--border-glass)', overflow: 'hidden' }} aria-hidden="true">
      <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--type-grass)' : 'var(--accent-yellow)' }} />
    </div>
  );
}

// The default Wishlist is made by the first heart; until then, say how.
export function WishlistStartHint() {
  const { t } = useT();
  return (
    <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', flexWrap: 'wrap', borderStyle: 'dashed' }}>
      <Heart size={22} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <strong style={{ color: 'var(--text-strong)' }}>{t('wishlist.defaultName')}</strong>
        <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('wishlist.startHint')}</p>
      </div>
      <button type="button" className="btn btn-secondary" onClick={() => goToTab('sets')} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
        <Library size={15} /> {t('wishlist.browseSets')}
      </button>
    </div>
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Non-secure contexts (a LAN install over http) have no clipboard API.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// One list, its cards counted against the collection: the Lists view's open
// list, and Collection > Cards > Wishlist (the default Wishlist, WishlistTab).
//
// Read when it mounts and again whenever it is shown or something changed
// elsewhere (`active`, `statsTrigger`): cards are added to lists from other tabs.
// `onBack` adds a back button. `onGone` runs when the list cannot be read (deleted
// elsewhere), `onDeleted` after its Delete, `onChanged` after a rename.
export default function ListDetail({ listId, active = true, statsTrigger, showToast, onBack, onGone, onDeleted, onChanged }) {
  const { t } = useT();
  const { show } = useFx();
  const [detail, setDetail] = useState(null);
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState('');
  const [searchGame, setSearchGame] = useState(() => defaultGame());
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  // Only the newest read of the list, or search, may land: a second search typed
  // before the first answered must not show the older answer.
  const detailReq = useRef(null);
  if (!detailReq.current) detailReq.current = new LatestRequest();
  const searchReq = useRef(null);
  if (!searchReq.current) searchReq.current = new LatestRequest();
  useEffect(() => () => { detailReq.current.cancel(); searchReq.current.cancel(); }, []);

  const loadDetail = async () => {
    const req = detailReq.current.begin();
    try {
      const res = await fetch(`/api/lists/${listId}`, { signal: req.signal });
      if (!req.isLatest()) return;
      if (res.ok) {
        const data = await res.json();
        if (req.isLatest()) setDetail(data);
      } else {
        showToast(t('lists.errLoad'));
        if (onGone) onGone();
      }
    } catch (err) {
      if (isAbortError(err) || !req.isLatest()) return;
      console.error(err);
      showToast(t('lists.errLoad'));
    }
  };

  useEffect(() => {
    if (active) loadDetail();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- showToast/t change identity every App render; refetch only on these
  }, [listId, active, statsTrigger]);

  const deleteList = async () => {
    if (!window.confirm(t('lists.confirmDelete', { name: detail.name }))) return;
    const res = await fetch(`/api/lists/${detail.id}`, { method: 'DELETE' });
    if (!res.ok) { showToast(t('lists.errDelete')); return; }
    showToast(t('lists.deleted', { name: detail.name }));
    if (detail.is_default) wishlist.load({ force: true });
    if (onDeleted) onDeleted(detail);
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    const res = await fetch(`/api/lists/${detail.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editing),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || t('lists.errUpdate')); return; }
    setEditing(null);
    loadDetail();
    if (onChanged) onChanged();
  };

  // One write at a time: overlapping +/- clicks would each send a quantity
  // computed from the same stale render.
  const mutate = async (fn) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fn();
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || t('lists.errUpdate'));
      }
      await loadDetail();
      // The hearts show the default Wishlist; keep them in step with edits here.
      if (detail.is_default) wishlist.load({ force: true });
    } catch (err) {
      console.error(err);
      showToast(t('lists.errUpdate'));
    } finally {
      setSaving(false);
    }
  };

  const updateItem = (item, patch) => mutate(() => fetch(`/api/lists/${detail.id}/items/${item.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }));

  const removeItem = (item) => mutate(() => fetch(`/api/lists/${detail.id}/items/${item.id}`, { method: 'DELETE' }));

  const setQuantity = (item, raw) => {
    const qty = parseInt(raw, 10);
    if (!Number.isInteger(qty) || qty === item.quantity_wanted) return;
    if (qty < 1) { removeItem(item); return; }
    updateItem(item, { quantity_wanted: Math.min(qty, 9999) });
  };

  const addCard = (card) => mutate(() => fetch(`/api/lists/${detail.id}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_id: card.id, quantity_wanted: 1 }),
  }));

  const runSearch = async (e) => {
    if (e) e.preventDefault();
    const name = query.trim();
    if (!name) return;
    const game = detail?.game || searchGame;
    const req = searchReq.current.begin();
    setSearching(true);
    try {
      // Same request the Add Cards search makes, across every printing the
      // provider has — a wishlist is mostly cards not owned yet.
      const params = new URLSearchParams({
        name: game === 'pokemon' ? (translateJapaneseName(name) || name) : name,
        game, scope: 'internet', lang: langCode('English'), limit: '30',
      });
      const res = await fetch(`/api/search?${params.toString()}`, { signal: req.signal });
      if (!req.isLatest()) return;
      if (res.ok) {
        const data = await res.json();
        if (req.isLatest()) setResults(Array.isArray(data) ? data : []);
      } else showToast(t(res.status === 429 ? 'deck.errRateLimit' : 'deck.errSearch'));
    } catch (err) {
      if (isAbortError(err) || !req.isLatest()) return;
      console.error(err);
      showToast(t('deck.errSearch'));
    } finally {
      if (req.isLatest()) setSearching(false);
    }
  };

  const copyAs = async (useMissing) => {
    const text = listAsText(filterItems(detail.items, filter), { useMissing });
    if (!text) { showToast(t('lists.copyEmpty')); return; }
    showToast(t(await copyText(text) ? 'lists.copied' : 'lists.errCopy'));
  };

  if (!detail) return <div className="spinner" />;
  const items = filterItems(detail.items, filter);
  const s = detail.summary;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
            {onBack && (
              <button className="btn btn-secondary btn-icon-only" onClick={onBack} aria-label={t('common.back')} style={{ borderRadius: '50%' }}>
                <ChevronLeft size={16} />
              </button>
            )}
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: '1.2rem', margin: 0, color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                {detail.is_default ? <Heart size={16} fill="currentColor" style={{ color: 'var(--accent-red)', flexShrink: 0 }} aria-label={t('wishlist.defaultBadge')} /> : null}
                {detail.name}
              </h2>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {t(`lists.kind.${detail.kind}`)} · {detail.game ? gameLabel(detail.game) : t('lists.anyGame')}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => copyAs(false)} style={{ fontSize: '0.8rem' }} title={t('lists.copyHint')}>
              <Copy size={14} /> {t('lists.copyWanted')}
            </button>
            <button className="btn btn-secondary" onClick={() => copyAs(true)} style={{ fontSize: '0.8rem' }} title={t('lists.copyHint')}>
              <Copy size={14} /> {t('lists.copyMissing')}
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing({ name: detail.name, kind: detail.kind, notes: detail.notes || '' })} style={{ fontSize: '0.8rem' }}>
              <Pencil size={14} /> {t('common.edit')}
            </button>
            <button className="btn btn-danger" onClick={deleteList} style={{ fontSize: '0.8rem' }}>
              <Trash2 size={14} /> {t('common.delete')}
            </button>
          </div>
        </div>

        {editing && (
          <form onSubmit={saveEdit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.5rem', alignItems: 'end' }}>
            <input className="input-control" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label={t('lists.name')} maxLength={120} />
            <select className="select-control" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })} aria-label={t('lists.kindLabel')}>
              {LIST_KINDS.map(k => <option key={k} value={k}>{t(`lists.kind.${k}`)}</option>)}
            </select>
            <input className="input-control" value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder={t('lists.notesPlaceholder')} aria-label={t('nav.notes')} />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={!editing.name.trim()}>{t('common.save')}</button>
            </div>
          </form>
        )}
        {!editing && detail.notes && <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{detail.notes}</p>}

        <ProgressBar summary={s} />
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--text-secondary)', alignItems: 'baseline' }}>
          <span>{t('lists.progress', { owned: s.owned, wanted: s.wanted })}</span>
          <span>{t('lists.missingCount', { count: s.missing })}</span>
          {s.missing > 0 && <span>{t('lists.missingValue')} <MissingValue summary={s} /></span>}
        </div>
      </div>

      {/* Add cards: the same internet search Add Cards runs. */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <form onSubmit={runSearch} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 220px' }}>
            <input className="input-control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('lists.searchPlaceholder')} aria-label={t('lists.searchPlaceholder')} style={{ width: '100%', paddingLeft: '2.25rem' }} />
            <Search size={15} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          </div>
          {!detail.game && showGamePicker() && (
            <select className="select-control" value={searchGame} onChange={(e) => setSearchGame(e.target.value)} aria-label={t('lists.game')} style={{ width: 'auto' }}>
              {gameOptions().map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          )}
          <button type="submit" className="btn btn-primary" disabled={searching || !query.trim()}>
            <Search size={15} /> {searching ? t('common.loading') : t('search.submit')}
          </button>
          {results.length > 0 && (
            <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => setResults([])} aria-label={t('common.close')}><X size={15} /></button>
          )}
        </form>
        {results.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '320px', overflowY: 'auto' }}>
            {results.map(card => (
              <div key={card.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.35rem 0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <CardImage card={card} alt="" style={{ width: '32px', borderRadius: '3px', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(card)}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{card.set_name} {setReference(card) ? `· ${setReference(card)}` : ''}</div>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)' }}>{card.price_trend > 0 ? show(card.price_trend, card.price_currency).text : ''}</span>
                <button className="btn btn-primary" onClick={() => addCard(card)} disabled={saving} style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}>
                  <Plus size={13} /> {t('lists.add')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sub-nav-tabs" style={{ margin: 0, maxWidth: '420px' }}>
        {['all', 'missing', 'owned'].map(f => (
          <button key={f} type="button" className={`sub-nav-tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {t(`lists.filter.${f}`)}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '2.5rem 1.5rem', color: 'var(--text-secondary)' }}>
          {t(detail.items.length === 0 ? 'lists.emptyList' : 'lists.noFilterMatches')}
        </div>
      ) : (
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          {items.map(item => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.9rem', borderBottom: '1px solid var(--border-glass)', flexWrap: 'wrap' }}>
              <CardImage card={item.card} alt="" style={{ width: '38px', borderRadius: '4px', flexShrink: 0 }} />
              <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(item.card)}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  {item.card.set_name}{setReference(item.card) ? ` · ${setReference(item.card)}` : ''}
                  {item.unit_price != null ? ` · ${show(item.unit_price, item.price_currency).text}` : ` · ${t('lists.noPrice')}`}
                </div>
                {item.notes && <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{item.notes}</div>}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', color: 'var(--text-secondary)', cursor: 'pointer', marginTop: '0.2rem' }} title={t('lists.anyPrintingHint')}>
                  <input type="checkbox" checked={!!item.any_printing} disabled={saving} onChange={(e) => updateItem(item, { any_printing: e.target.checked })} />
                  {t('lists.anyPrinting')}
                </label>
              </div>
              <div style={{ fontSize: '0.75rem', textAlign: 'right', minWidth: '90px' }}>
                <div style={{ color: item.missing === 0 ? 'var(--type-grass)' : 'var(--text-strong)', fontWeight: 700 }}>
                  {t('lists.ownedOf', { owned: item.owned, wanted: item.quantity_wanted })}
                </div>
                {item.missing > 0 && (
                  <div style={{ color: 'var(--accent-red)' }}>
                    {t('lists.missingCount', { count: item.missing })}
                    {item.missing_value != null && ` · ${show(item.missing_value, item.price_currency).text}`}
                  </div>
                )}
              </div>
              <input
                type="number" min="1" max="9999" step="1" className="input-control"
                defaultValue={item.quantity_wanted}
                key={`${item.id}-${item.quantity_wanted}`}
                disabled={saving}
                aria-label={t('lists.wantedQty')}
                onBlur={(e) => setQuantity(item, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                style={{ width: '72px', fontSize: '0.8rem' }}
              />
              <button className="btn btn-secondary btn-icon-only" onClick={() => removeItem(item)} disabled={saving} aria-label={t('lists.removeCard')} title={t('lists.removeCard')}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
