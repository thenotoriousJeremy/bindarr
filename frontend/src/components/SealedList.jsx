import { useState, useEffect } from 'react';
import { Plus, Package, ChevronDown, ChevronUp, Unlock, Lock, Trash2, X, Pencil, RefreshCw, Link2 } from 'lucide-react';
import { useT } from '../utils/i18n';
import { gameLabel, gameOptions } from '../utils/games';
import { formatPrice } from '../utils/formatPrice';
import SealedPurchaseForm from './SealedPurchaseForm';
import PackPriceSplitter from './PackPriceSplitter';
import MultiSelectDropdown from './MultiSelectDropdown';

// Loose match on a sealed product's TCGplayer group name against a card's own
// set name ('SV: Scarlet & Violet 151' vs 'Scarlet & Violet 151') — punctuation
// and case stripped, either side containing the other counts as a match.
const normSet = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const setsMatch = (a, b) => {
  const na = normSet(a), nb = normSet(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
};

// A single opened unit's "link cards from this pack" panel: pick from the most
// recently added, still-unlinked collection entries and hand them to
// PackPriceSplitter, which both splits the unit's price across them and stamps
// their sealed_unit_id. Scoped to the purchase's own game, and to its own set
// when a card in that set is actually in the recent list.
function LinkCardsPanel({ unit, purchase, showToast, onLinked }) {
  const { t } = useT();
  const [collectionCards, setCollectionCards] = useState([]);
  const [selected, setSelected] = useState([]);
  const [cardQuery, setCardQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/collection?list_type=collection')
      .then(r => r.json())
      .then(d => {
        const rows = (Array.isArray(d.collection) ? d.collection : Array.isArray(d) ? d : [])
          .filter(c => !c.sealed_unit_id && c.game === purchase.game)
          .sort((a, b) => new Date(b.added_at) - new Date(a.added_at));
        setCollectionCards(rows);
      })
      .catch(() => showToast?.(t('sealed.errLoadCards')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit.id]);

  const sameSet = purchase.set_name
    ? collectionCards.filter(c => setsMatch(c.set_name, purchase.set_name))
    : [];
  const normalizedQuery = cardQuery.trim().toLowerCase();
  const entries = (normalizedQuery
    ? collectionCards.filter(c => `${c.name} ${c.set_name} ${c.number}`.toLowerCase().includes(normalizedQuery))
    : sameSet.length ? sameSet : collectionCards);

  const toggle = (id) => setSelected(sel => sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);

  if (loading) return <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('common.loading')}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.5rem 0' }}>
      <>
        <input
          type="search"
          value={cardQuery}
          onChange={e => setCardQuery(e.target.value)}
          placeholder={t('sealed.cardSearchPlaceholder')}
          aria-label={t('sealed.cardSearchPlaceholder')}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        {entries.length === 0 ? (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('sealed.noRecentCards')}</div>
        ) : (
          <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            {entries.map(c => (
              <label key={c.entry_id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-strong)' }}>
                <input type="checkbox" checked={selected.includes(c.entry_id)} onChange={() => toggle(c.entry_id)} />
                {c.name} <span style={{ color: 'var(--text-secondary)' }}>· {c.set_name}</span>
              </label>
            ))}
          </div>
        )}
      </>
      <PackPriceSplitter
        entryIds={selected}
        sealedUnitId={unit.id}
        sealedUnitPrice={unit.unit_price}
        showToast={showToast}
        onApplied={() => { setSelected([]); onLinked?.(); }}
      />
    </div>
  );
}

function LinkSourcePanel({ purchase, showToast, onSaved }) {
  const { t } = useT();
  const [units, setUnits] = useState([]);
  const [selectedUnitId, setSelectedUnitId] = useState(purchase.source_unit_id ? String(purchase.source_unit_id) : '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/sealed/units?opened=1')
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('sealed.errLoad'));
        setUnits(data.units || []);
      })
      .catch(() => showToast?.(t('sealed.errLoad')))
      .finally(() => setLoading(false));
  }, [showToast, t]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/sealed/purchases/${purchase.id}/source-unit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_unit_id: selectedUnitId ? Number(selectedUnitId) : null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast?.(data.error || t('sealed.errSave')); return; }
      showToast?.(data.unit_price == null
        ? t('sealed.sourceLinkUpdated')
        : t('sealed.sourcePriceAllocated', { price: `$${formatPrice(data.unit_price)}` }));
      onSaved?.();
    } catch {
      showToast?.(t('sealed.errSave'));
    } finally {
      setSaving(false);
    }
  };

  const eligibleUnits = units.filter(unit => unit.purchase_id !== purchase.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', padding: '0.4rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label htmlFor={`source-unit-${purchase.id}`} style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {t('sealed.linkToProduct')}
        </label>
        <select id={`source-unit-${purchase.id}`} className="select-control" value={selectedUnitId}
          onChange={e => setSelectedUnitId(e.target.value)} disabled={loading || saving}>
          <option value="">{t('sealed.notLinked')}</option>
          {eligibleUnits.map(unit => (
            <option key={unit.id} value={unit.id}>
              {unit.product_name} · {t('sealed.unitLabel', { n: unit.unit_number })}
              {unit.set_name ? ` · ${unit.set_name}` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary btn-sm"
          disabled={loading || saving || (selectedUnitId || '') === (purchase.source_unit_id ? String(purchase.source_unit_id) : '')}
          onClick={save}>
          {saving ? t('common.loading') : t('common.save')}
        </button>
      </div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{t('sealed.sourceLinkHint')}</div>
    </div>
  );
}

// Read-only list of cards already pulled from one unit (GET
// /api/sealed/units/:id/cards) — the answer to "what did I link to this?", with
// an unlink button per card for when the wrong one was picked. When `expectedCards`
// is set, also reports progress toward it (e.g. "7 / 40 expected cards linked").
function LinkedCardsPanel({ unitId, expectedCards, refreshKey, showToast, onChanged }) {
  const { t } = useT();
  const [cards, setCards] = useState(null);

  const load = () => {
    fetch(`/api/sealed/units/${unitId}/cards`)
      .then(r => r.json())
      .then(d => setCards(d.cards || []))
      .catch(() => setCards([]));
  };

  useEffect(load, [unitId, refreshKey]);

  const unlink = async (entryId) => {
    const res = await fetch(`/api/collection/${entryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sealed_unit_id: null }),
    });
    if (res.ok) { load(); onChanged?.(); }
    else showToast?.(t('sealed.errSave'));
  };

  if (cards == null) return <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('common.loading')}</div>;

  const linkedCount = cards.reduce((n, c) => n + (c.quantity || 1), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      {expectedCards > 0 && (
        <div style={{ fontSize: '0.75rem', color: linkedCount >= expectedCards ? 'var(--type-grass)' : 'var(--text-secondary)' }}>
          {t('sealed.cardProgress', { linked: linkedCount, expected: expectedCards })}
        </div>
      )}
      {cards.length === 0 ? (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('sealed.noLinkedCards')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem' }}>
          {cards.map(c => (
            <div key={c.entry_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--text-strong)' }}>
              <span>{c.quantity > 1 ? `${c.quantity}x ` : ''}{c.name} <span style={{ color: 'var(--text-secondary)' }}>· {c.set_name} · {c.printing}</span></span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                {c.purchase_price != null && <span style={{ color: 'var(--text-secondary)' }}>${formatPrice(c.purchase_price)}</span>}
                <button type="button" className="btn btn-secondary btn-icon-only" title={t('sealed.unlink')} aria-label={t('sealed.unlink')}
                  onClick={() => unlink(c.entry_id)} style={{ padding: '0.2rem', color: 'var(--accent-red)' }}>
                  <X size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PurchaseCard({ purchase, onChanged, onEdit, showToast }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [units, setUnits] = useState(null);
  const [linkingUnit, setLinkingUnit] = useState(null);
  const [viewingUnit, setViewingUnit] = useState(null);
  const [cardsVersion, setCardsVersion] = useState(0);
  const [recipe, setRecipe] = useState(null);
  const [refreshingValue, setRefreshingValue] = useState(false);

  useEffect(() => {
    if (!purchase.template_id) { setRecipe(null); return; }
    fetch(`/api/sealed/templates/${purchase.template_id}`)
      .then(r => r.json())
      .then(d => setRecipe(d.template || null))
      .catch(() => setRecipe(null));
  }, [purchase.template_id]);

  const loadUnits = () => {
    fetch(`/api/sealed/purchases/${purchase.id}`)
      .then(r => r.json())
      .then(d => setUnits(d.units || []))
      .catch(() => showToast?.(t('sealed.errLoad')));
  };

  useEffect(() => { if (open && units == null) loadUnits(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleUnit = async (unit) => {
    const opening = !unit.opened_at;
    const res = await fetch(`/api/sealed/units/${unit.id}/open`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opened: opening }),
    });
    if (!res.ok) { showToast?.(t('sealed.errSave')); return; }
    const data = await res.json().catch(() => ({}));
    loadUnits();
    onChanged?.();
    if (opening && Array.isArray(data.applied) && data.applied.length > 0) {
      const cardCount = data.applied.filter(c => c.component_type === 'card').reduce((n, c) => n + (c.quantity || 1), 0);
      const productCount = data.applied.filter(c => c.component_type === 'product').reduce((n, c) => n + (c.quantity || 1), 0);
      showToast?.(t('sealed.recipeApplied', { cards: cardCount, packs: productCount }));
    }
  };

  const remove = async () => {
    if (!window.confirm(t('sealed.confirmDelete'))) return;
    const res = await fetch(`/api/sealed/purchases/${purchase.id}`, { method: 'DELETE' });
    if (res.ok) onChanged?.();
    else showToast?.(t('sealed.errSave'));
  };

  const refreshMarketValue = async () => {
    setRefreshingValue(true);
    try {
      const res = await fetch(`/api/sealed/purchases/${purchase.id}/refresh-value`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast?.(data.error || t('sealed.errSave')); return; }
      showToast?.(t('sealed.valueRefreshed'));
      onChanged?.();
    } catch {
      showToast?.(t('sealed.errSave'));
    } finally {
      setRefreshingValue(false);
    }
  };

  const total = (purchase.unit_price || 0) * purchase.quantity;
  const unopenedMarketValue = purchase.market_value == null ? null : purchase.market_value * (purchase.sealed_count || 0);

  return (
    <div className="glass-panel" style={{ padding: '0.85rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        {purchase.image_url
          ? <img src={purchase.image_url} alt="" style={{ width: '32px', height: '44px', objectFit: 'contain' }} />
          : <Package size={28} style={{ color: 'var(--text-secondary)' }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{purchase.product_name}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {gameLabel(purchase.game)} · {purchase.sealed_type || t('sealed.otherType')}
            {purchase.store ? ` · ${purchase.store}` : ''}{purchase.purchase_date ? ` · ${purchase.purchase_date}` : ''}
          </div>
          {(purchase.expected_cards > 0 || purchase.contents_note) && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {purchase.expected_cards > 0 ? t('sealed.nCards', { n: purchase.expected_cards }) : ''}
              {purchase.expected_cards > 0 && purchase.contents_note ? ' + ' : ''}
              {purchase.contents_note ? ` (${purchase.contents_note})` : ''}
            </div>
          )}
          {recipe && recipe.components?.length > 0 && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {t('sealed.recipeLabel')}: {recipe.components.map(c =>
                `${c.quantity}x ${c.component_type === 'card' ? (c.card_id || t('sealed.componentCard')) : c.product_name}`
              ).join(' + ')}
            </div>
          )}
          {purchase.source_unit_id && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {purchase.source_product_name
                ? t('sealed.unboxedFromProduct', { product: purchase.source_product_name, unit: purchase.source_unit_number })
                : t('sealed.unboxedNote')}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right', fontSize: '0.8rem' }}>
          <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{t('sealed.totalSpent')}: ${formatPrice(total)}</div>
          <div style={{ color: 'var(--text-secondary)' }}>
            {t('sealed.unopenedMarketValue')}: {unopenedMarketValue == null ? '—' : `$${formatPrice(unopenedMarketValue)}`}
          </div>
          {purchase.market_value != null && <div style={{ color: 'var(--text-secondary)' }}>{t('sealed.marketValuePerUnit')}: ${formatPrice(purchase.market_value)}</div>}
          <div style={{ color: 'var(--text-secondary)' }}>
            {purchase.sealed_count} {t('sealed.sealedLabel')} · {purchase.opened_count} {t('sealed.openedLabel')}
          </div>
        </div>
        {(purchase.sealed_count || 0) > 0 && (
          <button type="button" className="btn btn-secondary btn-icon-only" title={t('sealed.refreshMarketValue')} aria-label={t('sealed.refreshMarketValue')}
            onClick={refreshMarketValue} disabled={!purchase.product_id || refreshingValue}>
            <RefreshCw size={14} className={refreshingValue ? 'spin-animation' : ''} />
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => setOpen(o => !o)}>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <button type="button" className="btn btn-secondary btn-icon-only" title={t('common.edit')} aria-label={t('common.edit')} onClick={() => onEdit?.(purchase)}>
          <Pencil size={14} />
        </button>
        <button type="button" className="btn btn-secondary btn-icon-only" style={{ color: 'var(--accent-red)' }} onClick={remove}>
          <Trash2 size={14} />
        </button>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px solid var(--border-subtle)', paddingTop: '0.5rem' }}>
          {(units || []).map((u, i) => (
            <div key={u.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
                <span style={{ color: 'var(--text-secondary)', width: '4.5rem' }}>{t('sealed.unitLabel', { n: i + 1 })}</span>
                <span style={{ color: u.opened_at ? 'var(--type-fire)' : 'var(--type-grass)', flex: 1 }}>
                  {u.opened_at ? t('sealed.opened') : t('sealed.sealed')}
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => toggleUnit(u)}>
                  {u.opened_at ? <><Lock size={12} /> {t('sealed.reseal')}</> : <><Unlock size={12} /> {t('sealed.markOpened')}</>}
                </button>
                {u.opened_at && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLinkingUnit(linkingUnit === u.id ? null : u.id)}>
                    {t('sealed.linkCards')}
                  </button>
                )}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setViewingUnit(viewingUnit === u.id ? null : u.id)}>
                  {t('sealed.viewLinkedCards')}
                </button>
              </div>
              {linkingUnit === u.id && (
                <LinkCardsPanel unit={{ ...u, unit_price: purchase.unit_price }} purchase={purchase} showToast={showToast}
                  onLinked={() => { loadUnits(); setCardsVersion(v => v + 1); }} />
              )}
              {viewingUnit === u.id && (
                <LinkedCardsPanel unitId={u.id} expectedCards={purchase.expected_cards} refreshKey={cardsVersion} showToast={showToast}
                  onChanged={() => setCardsVersion(v => v + 1)} />
              )}
            </div>
          ))}
          {purchase.notes && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{purchase.notes}</div>}
          <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => setLinkingUnit(linkingUnit === 'source' ? null : 'source')}>
            <Link2 size={12} /> {t('sealed.linkToProduct')}
          </button>
          {linkingUnit === 'source' && (
            <LinkSourcePanel purchase={purchase} showToast={showToast} onSaved={() => { setLinkingUnit(null); onChanged?.(); }} />
          )}
        </div>
      )}
    </div>
  );
}

// The "Sealed" tab: purchases (store, date, price, quantity) with per-unit
// sealed/opened tracking, and a way to link opened-unit cards back to the
// purchase they came from.
export default function SealedList({ showToast }) {
  const { t } = useT();
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingPurchase, setEditingPurchase] = useState(null);
  const [search, setSearch] = useState('');
  const [gameFilter, setGameFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expansionFilter, setExpansionFilter] = useState([]);

  const load = () => {
    setLoading(true);
    fetch('/api/sealed/purchases')
      .then(r => r.json())
      .then(d => setPurchases(d.purchases || []))
      .catch(() => showToast?.(t('sealed.errLoad')))
      .finally(() => setLoading(false));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const totalSpent = purchases.reduce((s, p) => s + (p.unit_price || 0) * p.quantity, 0);
  const unopenedMarketValue = purchases.reduce((sum, p) => sum + (p.market_value || 0) * (p.sealed_count || 0), 0);
  const hasMarketValue = purchases.some(p => p.market_value != null && p.sealed_count > 0);
  const totalSealed = purchases.reduce((s, p) => s + (p.sealed_count || 0), 0);
  const totalOpened = purchases.reduce((s, p) => s + (p.opened_count || 0), 0);
  const productTypes = [...new Set(purchases.map(p => p.sealed_type).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const expansions = [...new Set(purchases.flatMap(p => p.expansions || []))].sort((a, b) => a.localeCompare(b));
  const query = search.trim().toLocaleLowerCase();
  const filteredPurchases = purchases.filter(purchase => {
    const searchable = [
      purchase.product_name, purchase.set_name, purchase.sealed_type, purchase.store,
      purchase.notes, purchase.contents_note, ...(purchase.expansions || []),
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    if (query && !searchable.includes(query)) return false;
    if (gameFilter && purchase.game !== gameFilter) return false;
    if (typeFilter && purchase.sealed_type !== typeFilter) return false;
    if (statusFilter === 'sealed' && !(purchase.sealed_count > 0)) return false;
    if (statusFilter === 'opened' && !(purchase.opened_count > 0)) return false;
    if (expansionFilter.length && !expansionFilter.some(expansion => (purchase.expansions || []).includes(expansion))) return false;
    return true;
  });
  const hasFilters = !!(search || gameFilter || typeFilter || statusFilter || expansionFilter.length);
  const clearFilters = () => {
    setSearch('');
    setGameFilter('');
    setTypeFilter('');
    setStatusFilter('');
    setExpansionFilter([]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-strong)' }}>
          <Package size={20} /> {t('nav.sealed')}
        </h2>
        <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
          <Plus size={16} /> {t('sealed.addPurchase')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        <span>{t('sealed.totalSpent')}: <strong style={{ color: 'var(--text-strong)' }}>${formatPrice(totalSpent)}</strong></span>
        <span>{t('sealed.unopenedMarketValue')}: <strong style={{ color: 'var(--text-strong)' }}>{hasMarketValue ? `$${formatPrice(unopenedMarketValue)}` : '—'}</strong></span>
        <span>{t('sealed.sealedLabel')}: <strong style={{ color: 'var(--text-strong)' }}>{totalSealed}</strong></span>
        <span>{t('sealed.openedLabel')}: <strong style={{ color: 'var(--text-strong)' }}>{totalOpened}</strong></span>
      </div>

      {purchases.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) repeat(auto-fit, minmax(145px, 1fr))', gap: '0.6rem', alignItems: 'center' }}>
          <input
            type="search"
            className="input-control"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('sealed.searchPlaceholder')}
            aria-label={t('sealed.searchPlaceholder')}
          />
          <select className="select-control" value={gameFilter} onChange={e => setGameFilter(e.target.value)} aria-label={t('sealed.filterGame')}>
            <option value="">{t('sealed.allGames')}</option>
            {gameOptions().map(game => <option key={game.value} value={game.value}>{game.label}</option>)}
          </select>
          <select className="select-control" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} aria-label={t('sealed.filterType')}>
            <option value="">{t('sealed.allTypes')}</option>
            {productTypes.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
          <select className="select-control" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label={t('sealed.filterStatus')}>
            <option value="">{t('sealed.allStatuses')}</option>
            <option value="sealed">{t('sealed.hasSealedUnits')}</option>
            <option value="opened">{t('sealed.hasOpenedUnits')}</option>
          </select>
          <MultiSelectDropdown
            label={t('sealed.filterExpansion')}
            allLabel={t('sealed.allExpansions')}
            value={expansionFilter}
            onChange={setExpansionFilter}
            options={expansions.map(expansion => ({ value: expansion, label: expansion }))}
          />
          {hasFilters && (
            <button type="button" className="btn btn-secondary" onClick={clearFilters}>
              <X size={14} /> {t('collection.clearFilters')}
            </button>
          )}
        </div>
      )}

      {(showForm || editingPurchase) && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
          onClick={() => { setShowForm(false); setEditingPurchase(null); }}>
          <div style={{ maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <SealedPurchaseForm
              initial={editingPurchase || undefined}
              showToast={showToast}
              onCancel={() => { setShowForm(false); setEditingPurchase(null); }}
              onSaved={() => { setShowForm(false); setEditingPurchase(null); load(); }}
            />
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</div>
      ) : purchases.length === 0 ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('sealed.empty')}
        </div>
      ) : filteredPurchases.length === 0 ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('sealed.noFilterMatches')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {filteredPurchases.map(p => (
            <PurchaseCard key={p.id} purchase={p} onChanged={load} onEdit={setEditingPurchase} showToast={showToast} />
          ))}
        </div>
      )}
    </div>
  );
}
