import { useState, useEffect } from 'react';
import { Plus, Trash2, ChevronLeft, Search, ListChecks, Copy, Pencil, X } from 'lucide-react';
import CardImage from './CardImage';
import { useBackGuard } from '../utils/useBackGuard';
import { gameOptions, showGamePicker, gameLabel, defaultGame } from '../utils/games';
import { displayName, setReference, langCode } from '../utils/languages';
import { translateJapaneseName } from '../utils/langHelper';
import { priceText } from '../utils/formatPrice';
import { filterItems, listAsText, currencyTotals, progressPercent } from '../utils/listText';
import { useT } from '../utils/i18n';

const KINDS = ['wishlist', 'buylist', 'missing', 'custom'];

// Per-currency money, never added across currencies, plus how many missing
// cards have no price at all (so a total is never mistaken for the whole cost).
function MissingValue({ summary }) {
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

function ProgressBar({ summary }) {
  const pct = progressPercent(summary);
  return (
    <div style={{ height: '6px', borderRadius: '999px', background: 'var(--border-glass)', overflow: 'hidden' }} aria-hidden="true">
      <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--type-grass)' : 'var(--accent-yellow)' }} />
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

function Lists({ showToast, active = true, statsTrigger }) {
  const { t } = useT();
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);

  // New list form
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('wishlist');
  const [newGame, setNewGame] = useState('');

  // Detail view
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState('');
  const [searchGame, setSearchGame] = useState(() => defaultGame());
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  useBackGuard(openId != null, () => setOpenId(null));

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

  const loadDetail = async (id) => {
    try {
      const res = await fetch(`/api/lists/${id}`);
      if (res.ok) setDetail(await res.json());
      else { setOpenId(null); showToast(t('lists.errLoad')); }
    } catch (err) {
      console.error(err);
      showToast(t('lists.errLoad'));
    }
  };

  // Tabs stay mounted while hidden, and cards are added to lists from other tabs
  // (the inspector, search) — so refresh whenever this one is shown again.
  useEffect(() => {
    if (!active) return;
    loadLists();
    if (openId != null) loadDetail(openId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- showToast/t change identity every App render; refetch only on these
  }, [active, statsTrigger, openId]);

  const openList = (list) => {
    setDetail(null);
    setFilter('all');
    setEditing(null);
    setResults([]);
    setQuery('');
    if (list.game) setSearchGame(list.game);
    setOpenId(list.id);
  };

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

  const deleteList = async (list) => {
    if (!window.confirm(t('lists.confirmDelete', { name: list.name }))) return;
    const res = await fetch(`/api/lists/${list.id}`, { method: 'DELETE' });
    if (!res.ok) { showToast(t('lists.errDelete')); return; }
    showToast(t('lists.deleted', { name: list.name }));
    setOpenId(null);
    loadLists();
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
    loadDetail(detail.id);
    loadLists();
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
      await loadDetail(detail.id);
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

  const setQuantity = (item, raw) => {
    const qty = parseInt(raw, 10);
    if (!Number.isInteger(qty) || qty === item.quantity_wanted) return;
    if (qty < 1) { removeItem(item); return; }
    updateItem(item, { quantity_wanted: Math.min(qty, 9999) });
  };

  const removeItem = (item) => mutate(() => fetch(`/api/lists/${detail.id}/items/${item.id}`, { method: 'DELETE' }));

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
    setSearching(true);
    try {
      // Same request the Add Cards search makes, across every printing the
      // provider has — a wishlist is mostly cards not owned yet.
      const params = new URLSearchParams({
        name: game === 'pokemon' ? (translateJapaneseName(name) || name) : name,
        game, scope: 'internet', lang: langCode('English'), limit: '30',
      });
      const res = await fetch(`/api/search?${params.toString()}`);
      if (res.ok) setResults(await res.json());
      else showToast(t(res.status === 429 ? 'deck.errRateLimit' : 'deck.errSearch'));
    } catch (err) {
      console.error(err);
      showToast(t('deck.errSearch'));
    } finally {
      setSearching(false);
    }
  };

  const copyAs = async (useMissing) => {
    const text = listAsText(filterItems(detail.items, filter), { useMissing });
    if (!text) { showToast(t('lists.copyEmpty')); return; }
    showToast(t(await copyText(text) ? 'lists.copied' : 'lists.errCopy'));
  };

  // ============================ INDEX ============================
  if (openId == null) {
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
              {KINDS.map(k => <option key={k} value={k}>{t(`lists.kind.${k}`)}</option>)}
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

        {loading ? <div className="spinner" /> : lists.length === 0 ? (
          <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem 1.5rem', color: 'var(--text-secondary)' }}>
            <ListChecks size={36} style={{ opacity: 0.4 }} />
            <p style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{t('lists.empty')}</p>
            <p style={{ fontSize: '0.85rem' }}>{t('lists.emptyHint')}</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem' }}>
            {lists.map(list => (
              <button key={list.id} type="button" className="glass-panel" onClick={() => openList(list)}
                style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '0.5rem', color: 'inherit', font: 'inherit' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
                  <strong style={{ color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</strong>
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

  // ============================ DETAIL ============================
  if (!detail) return <div className="spinner" />;
  const items = filterItems(detail.items, filter);
  const s = detail.summary;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setOpenId(null)} aria-label={t('common.back')} style={{ borderRadius: '50%' }}>
              <ChevronLeft size={16} />
            </button>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: '1.2rem', margin: 0, color: 'var(--text-strong)' }}>{detail.name}</h2>
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
            <button className="btn btn-danger" onClick={() => deleteList(detail)} style={{ fontSize: '0.8rem' }}>
              <Trash2 size={14} /> {t('common.delete')}
            </button>
          </div>
        </div>

        {editing && (
          <form onSubmit={saveEdit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.5rem', alignItems: 'end' }}>
            <input className="input-control" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label={t('lists.name')} maxLength={120} />
            <select className="select-control" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })} aria-label={t('lists.kindLabel')}>
              {KINDS.map(k => <option key={k} value={k}>{t(`lists.kind.${k}`)}</option>)}
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
                <span style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)' }}>{card.price_trend > 0 ? priceText(card.price_trend, card.price_currency) : ''}</span>
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
                  {item.unit_price != null ? ` · ${priceText(item.unit_price, item.price_currency)}` : ` · ${t('lists.noPrice')}`}
                </div>
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
                    {item.missing_value != null && ` · ${priceText(item.missing_value, item.price_currency)}`}
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

export default Lists;
