import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Package, ChevronDown, ChevronUp, Unlock, Lock, Trash2, X, Pencil, RefreshCw, Link2, Share2, Search, SlidersHorizontal, LayoutGrid, List, MousePointerClick, ArrowLeftRight } from 'lucide-react';
import { useT } from '../utils/i18n';
import { gameLabel, gameOptions } from '../utils/games';
import { formatPrice } from '../utils/formatPrice';
import { printingLabel } from '../utils/cardOptions';
import { useLongPress } from '../utils/useLongPress';
import SealedPurchaseForm from './SealedPurchaseForm';
import Modal from './Modal';
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

const filterLabelStyle = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' };

function SealedFilterField({ label, children }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label style={filterLabelStyle}>{label}</label>
      {children}
    </div>
  );
}

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
  const [progress, setProgress] = useState(null);

  const load = () => {
    fetch(`/api/sealed/units/${unitId}/cards`)
      .then(r => r.json())
      .then(d => { setCards(d.cards || []); setProgress(d.progress || null); })
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
  const shownLinkedCount = progress?.linked_cards ?? linkedCount;
  const shownExpectedCards = progress?.expected_cards ?? expectedCards;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      {shownExpectedCards > 0 && (
        <div style={{ fontSize: '0.75rem', color: shownLinkedCount >= shownExpectedCards ? 'var(--type-grass)' : 'var(--text-secondary)' }}>
          {t('sealed.cardProgress', { linked: shownLinkedCount, expected: shownExpectedCards })}
        </div>
      )}
      {cards.length === 0 ? (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('sealed.noLinkedCards')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem' }}>
          {cards.map(c => (
            <div key={c.entry_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--text-strong)' }}>
              <span>{c.quantity > 1 ? `${c.quantity}x ` : ''}{c.name} <span style={{ color: 'var(--text-secondary)' }}>· {c.set_name} · {printingLabel(t, c.printing, c.game)}</span></span>
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

function PurchaseCard({ purchase, onChanged, onEdit, showToast, onProposeTrade, selected, onSelectionChange, showClaimedByOthers, viewMode, selectMode, pressHandlers, longPressFired }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [units, setUnits] = useState(null);
  const [unitsError, setUnitsError] = useState(false);
  const [linkingUnit, setLinkingUnit] = useState(null);
  const [viewingUnit, setViewingUnit] = useState(null);
  const [cardsVersion, setCardsVersion] = useState(0);
  const [recipe, setRecipe] = useState(null);
  const [refreshingValue, setRefreshingValue] = useState(false);
  const [openingAll, setOpeningAll] = useState(false);
  const [savingAvailability, setSavingAvailability] = useState(false);

  useEffect(() => {
    if (!purchase.template_id) { setRecipe(null); return; }
    fetch(`/api/sealed/templates/${purchase.template_id}`)
      .then(r => r.json())
      .then(d => setRecipe(d.template || null))
      .catch(() => setRecipe(null));
  }, [purchase.template_id]);

  const loadUnits = () => {
    setUnits(null);
    setUnitsError(false);
    fetch(`/api/sealed/purchases/${purchase.id}${showClaimedByOthers ? '?show_claimed_by_others=1' : ''}`)
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('sealed.errLoad'));
        setUnits(data.units || []);
      })
      .catch(() => {
        setUnitsError(true);
        showToast?.(t('sealed.errLoad'));
      });
  };

  useEffect(() => { if (open) loadUnits(); }, [open, showClaimedByOthers]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const openAll = async () => {
    setOpeningAll(true);
    try {
      const res = await fetch(`/api/sealed/purchases/${purchase.id}/open-all`, { method: 'PUT' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast?.(data.error || t('sealed.errSave')); return; }
      loadUnits();
      onChanged?.();
      showToast?.(t('sealed.markedAllOpen', { count: data.opened }));
    } catch {
      showToast?.(t('sealed.errSave'));
    } finally {
      setOpeningAll(false);
    }
  };

  const toggleSharing = async () => {
    setSavingAvailability(true);
    try {
      const res = await fetch(`/api/sealed/purchases/${purchase.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ available_to_all: !purchase.available_to_all }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast?.(data.error || t('sealed.errSave'));
        return;
      }
      onChanged?.();
    } catch {
      showToast?.(t('sealed.errSave'));
    } finally {
      setSavingAvailability(false);
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

  const total = purchase.unit_price == null ? null : Number(purchase.unit_price) * Number(purchase.quantity);
  const unopenedMarketValue = purchase.market_value == null ? null : purchase.market_value * (purchase.sealed_count || 0);
  const hasSealedUnits = (purchase.sealed_count || 0) > 0;
  const canShare = purchase.is_owner && hasSealedUnits;
  const purchaseSelection = (
    <input
      type="checkbox"
      className="sealed-purchase-card-select"
      checked={canShare && selected}
      disabled={!canShare}
      aria-label={t('sealed.selectPurchase', { product: purchase.product_name })}
      onChange={event => onSelectionChange?.(purchase.id, event.target.checked)}
    />
  );
  const tilePressHandlers = canShare ? pressHandlers?.(purchase.id) : {};
  const purchaseImage = purchase.image_url
    ? <img src={purchase.image_url} alt="" className="sealed-purchase-card-image" />
    : <Package size={viewMode === 'gallery' ? 56 : 28} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />;
  const purchaseCounts = (
    <div className="sealed-purchase-card-counts">
      <span>{purchase.sealed_count} {t('sealed.sealedLabel')}</span>
      <span>{purchase.opened_count} {t('sealed.openedLabel')}</span>
    </div>
  );
  const purchaseFinancials = (
    <div className="sealed-purchase-card-financials">
      <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>
        {t('sealed.totalSpent')}: {total == null ? '—' : `$${formatPrice(total)}`}
      </div>
      <div style={{ color: 'var(--text-secondary)' }}>
        {t('sealed.unopenedMarketValue')}: {unopenedMarketValue == null ? '—' : `$${formatPrice(unopenedMarketValue)}`}
      </div>
      {purchase.market_value != null && <div style={{ color: 'var(--text-secondary)' }}>{t('sealed.marketValuePerUnit')}: ${formatPrice(purchase.market_value)}</div>}
    </div>
  );

  const toggleDetails = () => {
    if (viewMode === 'gallery') setOpen(true);
    else setOpen(current => !current);
  };

  const activateTile = () => {
    if (longPressFired?.current) {
      longPressFired.current = false;
      return;
    }
    if (selectMode && canShare) {
      onSelectionChange?.(purchase.id, !selected);
      return;
    }
    toggleDetails();
  };

  const renderPurchaseDetails = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px solid var(--border-subtle)', paddingTop: '0.5rem' }}>
      {unitsError ? (
        <div style={{ color: 'var(--text-secondary)' }}>{t('sealed.errLoad')}</div>
      ) : units === null ? (
        <div style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</div>
      ) : (
        <>
          {units.filter(unit => !unit.opened_at && (unit.claimed_by_user_id == null || unit.claimed_by_me)).length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary btn-sm"
                disabled={openingAll} onClick={openAll}>
                <Unlock size={12} /> {openingAll ? t('common.loading') : t('sealed.markAllOpen')}
              </button>
            </div>
          )}
          {units.map((u, i) => (
            <div key={u.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-secondary)', width: '4.5rem' }}>{t('sealed.unitLabel', { n: u.unit_number || i + 1 })}</span>
                <span style={{ color: u.opened_at ? 'var(--type-fire)' : 'var(--type-grass)', flex: 1 }}>
                  {u.opened_at ? t('sealed.opened') : t('sealed.sealed')}
                </span>
                {u.claimed_by_username && (
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {t('sealed.claimedBy', { user: u.claimed_by_username })}
                  </span>
                )}
                {u.expected_cards > 0 && (
                  <span style={{ color: u.linked_cards >= u.expected_cards ? 'var(--type-grass)' : 'var(--text-secondary)' }}>
                    {t('sealed.cardProgress', { linked: u.linked_cards || 0, expected: u.expected_cards })}
                  </span>
                )}
                {u.can_toggle && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => toggleUnit(u)}>
                    {u.opened_at ? <><Lock size={12} /> {t('sealed.reseal')}</> : <><Unlock size={12} /> {t(!purchase.is_owner && !u.claimed_by_me ? 'sealed.openAndClaim' : 'sealed.markOpened')}</>}
                  </button>
                )}
                {u.opened_at && u.can_view_cards && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLinkingUnit(linkingUnit === u.id ? null : u.id)}>
                    {t('sealed.linkCards')}
                  </button>
                )}
                {u.can_view_cards && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setViewingUnit(viewingUnit === u.id ? null : u.id)}>
                    {t('sealed.viewLinkedCards')}
                  </button>
                )}
                {onProposeTrade && purchase.is_owner && !u.opened_at && (u.claimed_by_user_id == null || u.claimed_by_me) && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => onProposeTrade(u)}>
                    <ArrowLeftRight size={12} /> {t('inspector.proposeTrade')}
                  </button>
                )}
              </div>
              {linkingUnit === u.id && (
                <LinkCardsPanel unit={{ ...u, unit_price: purchase.unit_price }} purchase={purchase} showToast={showToast}
                  onLinked={() => { loadUnits(); setCardsVersion(v => v + 1); }} />
              )}
              {viewingUnit === u.id && (
                <LinkedCardsPanel unitId={u.id} expectedCards={u.expected_cards} refreshKey={cardsVersion} showToast={showToast}
                  onChanged={() => setCardsVersion(v => v + 1)} />
              )}
            </div>
          ))}
        </>
      )}
      {purchase.is_owner && purchase.notes && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{purchase.notes}</div>}
      {purchase.is_owner && (
        <>
          <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => setLinkingUnit(linkingUnit === 'source' ? null : 'source')}>
            <Link2 size={12} /> {t('sealed.linkToProduct')}
          </button>
          {linkingUnit === 'source' && (
            <LinkSourcePanel purchase={purchase} showToast={showToast} onSaved={() => { setLinkingUnit(null); onChanged?.(); }} />
          )}
        </>
      )}
    </div>
  );

  return (
    <div className={`glass-panel sealed-purchase-card ${viewMode === 'gallery' ? 'sealed-purchase-card-tile' : ''}`} style={{ padding: '0.85rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div className="sealed-purchase-card-header">
        {viewMode === 'gallery' ? (
          <button type="button" className="sealed-purchase-card-tile-summary"
            onClick={activateTile} {...tilePressHandlers}
            aria-label={`${t(selectMode && canShare ? 'collection.select' : 'sealed.purchaseDetails')}: ${purchase.product_name}`}
            aria-pressed={selectMode && canShare ? selected : undefined}>
            <div className="sealed-purchase-card-visual">
              {purchaseImage}
              {selectMode && canShare && (
                <div className={`sealed-purchase-card-selection-mark${selected ? ' is-selected' : ''}`} aria-hidden="true">
                  {selected ? '✓' : ''}
                </div>
              )}
            </div>
            <div className="sealed-purchase-card-details">
              <div className="sealed-purchase-card-title" style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{purchase.product_name}</div>
            </div>
            <div className="sealed-purchase-card-values">{purchaseCounts}</div>
          </button>
        ) : (
          <div className="sealed-purchase-card-identity">
            {purchaseSelection}
            <div className="sealed-purchase-card-visual">{purchaseImage}</div>
            <div className="sealed-purchase-card-details">
              <div className="sealed-purchase-card-title" style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{purchase.product_name}</div>
              <div className="sealed-purchase-card-secondary" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {gameLabel(purchase.game)} · {purchase.sealed_type || t('sealed.otherType')}
                {` · ${t('sealed.quantity')}: ${purchase.quantity}`}
                {purchase.store ? ` · ${purchase.store}` : ''}{purchase.purchase_date ? ` · ${purchase.purchase_date}` : ''}
                {purchase.buyer_username ? ` · ${t('sealed.buyer')}: ${purchase.buyer_username}` : ''}
              </div>
              {hasSealedUnits && (purchase.available_to_all || purchase.is_claimed) && (
                <div className="sealed-purchase-card-secondary" style={{ fontSize: '0.72rem', color: 'var(--accent-blue, var(--text-secondary))' }}>
                  {purchase.available_to_all ? t('sealed.availableToAll') : t('sealed.claimedFromShared')}
                </div>
              )}
              {(purchase.expected_cards_per_unit > 0 || purchase.contents_note) && (
                <div className="sealed-purchase-card-secondary" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                  {purchase.expected_cards_per_unit > 0 ? t('sealed.nCards', { n: purchase.expected_cards_per_unit }) : ''}
                  {purchase.expected_cards_per_unit > 0 && purchase.contents_note ? ' + ' : ''}
                  {purchase.contents_note ? ` (${purchase.contents_note})` : ''}
                </div>
              )}
              {recipe && recipe.components?.length > 0 && (
                <div className="sealed-purchase-card-secondary" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                  {t('sealed.recipeLabel')}: {recipe.components.map(c =>
                    `${c.quantity}x ${c.component_type === 'card' ? (c.card_id || t('sealed.componentCard')) : c.product_name}`
                  ).join(' + ')}
                </div>
              )}
              {purchase.source_unit_id && (
                <div className="sealed-purchase-card-secondary" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                  {purchase.source_product_name
                    ? t('sealed.unboxedFromProduct', { product: purchase.source_product_name, unit: purchase.source_unit_number })
                    : t('sealed.unboxedNote')}
                </div>
              )}
            </div>
          </div>
        )}
        {viewMode === 'list' && (
          <div className="sealed-purchase-card-values">
            {purchaseFinancials}
            {purchaseCounts}
          </div>
        )}
        <div className="sealed-purchase-card-actions">
          {purchase.is_owner && hasSealedUnits && (
            <button type="button" className="btn btn-secondary btn-icon-only" title={t('sealed.refreshMarketValue')} aria-label={t('sealed.refreshMarketValue')}
              onClick={refreshMarketValue} disabled={!purchase.product_id || refreshingValue}>
              <RefreshCw size={14} className={refreshingValue ? 'spin-animation' : ''} />
            </button>
          )}
          {viewMode === 'list' && (
            <button type="button" className="btn btn-secondary btn-icon-only"
              title={t('sealed.purchaseDetails')}
              aria-label={`${t('sealed.purchaseDetails')}: ${purchase.product_name}`}
              onClick={toggleDetails}>
              {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
          {canShare && (
            <button type="button"
              className={`btn btn-icon-only ${purchase.available_to_all ? 'btn-primary' : 'btn-secondary sealed-share-start'}`}
              title={t(purchase.available_to_all ? 'sealed.stopSharing' : 'sealed.sharePurchase')}
              aria-label={t(purchase.available_to_all ? 'sealed.stopSharing' : 'sealed.sharePurchase')}
              disabled={savingAvailability} onClick={toggleSharing}>
              {purchase.available_to_all ? <Lock size={14} /> : <Share2 size={14} />}
            </button>
          )}
          {purchase.is_owner && (
            <>
              <button type="button" className="btn btn-secondary btn-icon-only" title={t('common.edit')} aria-label={t('common.edit')} onClick={() => onEdit?.(purchase)}>
                <Pencil size={14} />
              </button>
              <button type="button" className="btn btn-secondary btn-icon-only" style={{ color: 'var(--accent-red)' }} onClick={remove}>
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      {open && viewMode === 'list' && renderPurchaseDetails()}
      {open && viewMode === 'gallery' && createPortal(
        <Modal
          onClose={() => setOpen(false)}
          label={t('sealed.purchaseDetails')}
          className="glass-panel"
          overlayStyle={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          style={{
            maxWidth: '760px', width: '100%', maxHeight: '90vh', overflowY: 'auto',
            overscrollBehavior: 'contain', padding: '1.25rem', position: 'relative',
          }}
        >
          <button type="button" className="btn btn-secondary btn-icon-only"
            onClick={() => setOpen(false)} aria-label={t('common.close')}
            style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', borderRadius: '50%' }}>
            <X size={16} />
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', paddingRight: '2rem', marginBottom: '0.75rem' }}>
            {purchase.image_url
              ? <img src={purchase.image_url} alt="" style={{ width: '48px', height: '64px', objectFit: 'contain', flexShrink: 0 }} />
              : <Package size={32} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <h2 style={{ color: 'var(--text-strong)', margin: 0 }}>{purchase.product_name}</h2>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                {gameLabel(purchase.game)} · {purchase.sealed_type || t('sealed.otherType')} · {t('sealed.quantity')}: {purchase.quantity}
              </div>
              {(purchase.store || purchase.purchase_date) && (
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                  {[purchase.store, purchase.purchase_date].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          </div>
          {renderPurchaseDetails()}
        </Modal>,
        document.body
      )}
    </div>
  );
}

// The "Sealed" tab: purchases (store, date, price, quantity) with per-unit
// sealed/opened tracking, and a way to link opened-unit cards back to the
// purchase they came from.
export default function SealedList({ showToast, onProposeTrade }) {
  const { t } = useT();
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingPurchase, setEditingPurchase] = useState(null);
  const [viewMode, setViewMode] = useState('gallery');
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState('');
  const [gameFilter, setGameFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expansionFilter, setExpansionFilter] = useState([]);
  const [showClaimedByOthers, setShowClaimedByOthers] = useState(false);
  const [selectedPurchaseIds, setSelectedPurchaseIds] = useState(() => new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [savingSharing, setSavingSharing] = useState(false);

  const armPurchaseSelection = (id) => {
    const purchase = purchases.find(item => item.id === id);
    if (!purchase || !purchase.is_owner || (purchase.sealed_count || 0) <= 0) return;
    setSelectMode(true);
    setSelectedPurchaseIds(current => new Set(current).add(id));
  };
  const { handlers: purchasePressHandlers, fired: purchaseLongPressFired } = useLongPress(armPurchaseSelection);
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedPurchaseIds(new Set());
  };

  const load = (includeClaimedByOthers = showClaimedByOthers) => {
    setLoading(true);
    fetch(`/api/sealed/purchases${includeClaimedByOthers ? '?show_claimed_by_others=1' : ''}`)
      .then(r => r.json())
      .then(d => setPurchases(d.purchases || []))
      .catch(() => showToast?.(t('sealed.errLoad')))
      .finally(() => setLoading(false));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSelectedPurchaseIds(current => {
      const ownedIds = new Set(purchases.filter(purchase => purchase.is_owner && (purchase.sealed_count || 0) > 0
        && (showClaimedByOthers || purchase.visible_unit_count > 0)).map(purchase => purchase.id));
      const next = new Set([...current].filter(id => ownedIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [purchases, showClaimedByOthers]);

  const visiblePurchases = purchases.filter(
    purchase => showClaimedByOthers || !purchase.is_owner || purchase.visible_unit_count > 0
  );
  const totalSpent = purchases.reduce((s, p) => s + (p.is_owner ? (p.unit_price || 0) * p.quantity : 0), 0);
  const unopenedMarketValue = visiblePurchases.reduce((sum, p) => sum + (p.market_value || 0) * (p.sealed_count || 0), 0);
  const hasMarketValue = visiblePurchases.some(p => p.market_value != null && p.sealed_count > 0);
  const totalSealed = visiblePurchases.reduce((s, p) => s + (p.sealed_count || 0), 0);
  const totalOpened = visiblePurchases.reduce((s, p) => s + (p.opened_count || 0), 0);
  const productTypes = [...new Set(visiblePurchases.map(p => p.sealed_type).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const expansions = [...new Set(visiblePurchases.flatMap(p => p.expansions || []))].sort((a, b) => a.localeCompare(b));
  const query = search.trim().toLocaleLowerCase();
  const filteredPurchases = visiblePurchases.filter(purchase => {
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
  const filteredOwnedPurchases = filteredPurchases.filter(purchase => purchase.is_owner && (purchase.sealed_count || 0) > 0);
  const selectedOwnedPurchases = visiblePurchases.filter(
    purchase => purchase.is_owner && (purchase.sealed_count || 0) > 0 && selectedPurchaseIds.has(purchase.id)
  );
  const allFilteredOwnedSelected = filteredOwnedPurchases.length > 0
    && filteredOwnedPurchases.every(purchase => selectedPurchaseIds.has(purchase.id));
  const activeFilterCount = (gameFilter ? 1 : 0) + (typeFilter ? 1 : 0) + (statusFilter ? 1 : 0)
    + (expansionFilter.length ? 1 : 0) + (showClaimedByOthers ? 1 : 0);
  const hasFilters = !!(search || gameFilter || typeFilter || statusFilter || expansionFilter.length || showClaimedByOthers);
  const clearFilters = () => {
    setSearch('');
    setGameFilter('');
    setTypeFilter('');
    setStatusFilter('');
    setExpansionFilter([]);
    setShowClaimedByOthers(false);
    load(false);
  };
  const toggleFilteredSelection = () => {
    const filteredIds = filteredOwnedPurchases.map(purchase => purchase.id);
    if (viewMode === 'gallery') setSelectMode(true);
    setSelectedPurchaseIds(current => {
      const next = new Set(current);
      if (allFilteredOwnedSelected) filteredIds.forEach(id => next.delete(id));
      else filteredIds.forEach(id => next.add(id));
      return next;
    });
  };
  const setPurchaseSelected = (id, selected) => {
    setSelectedPurchaseIds(current => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const updateSelectedSharing = async (availableToAll) => {
    const ids = selectedOwnedPurchases.map(purchase => purchase.id);
    if (!ids.length) return;

    setSavingSharing(true);
    try {
      const res = await fetch('/api/sealed/purchases/bulk-sharing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchase_ids: ids, available_to_all: availableToAll }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast?.(data.error || t('sealed.errSave'));
        return;
      }
      setSelectedPurchaseIds(new Set());
      showToast?.(t('sealed.bulkSharingUpdated', { count: data.updated }));
      load();
    } catch {
      showToast?.(t('sealed.errSave'));
    } finally {
      setSavingSharing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-strong)' }}>
          <Package size={20} /> {t('nav.sealed')}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {viewMode === 'gallery' && (
            <button type="button" className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              title={t('collection.selectHint')}>
              <MousePointerClick size={14} /> {t(selectMode ? 'bulk.done' : 'collection.select')}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
            <Plus size={16} /> {t('sealed.addPurchase')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        <span>{t('sealed.totalSpent')}: <strong style={{ color: 'var(--text-strong)' }}>${formatPrice(totalSpent)}</strong></span>
        <span>{t('sealed.unopenedMarketValue')}: <strong style={{ color: 'var(--text-strong)' }}>{hasMarketValue ? `$${formatPrice(unopenedMarketValue)}` : '—'}</strong></span>
        <span>{t('sealed.sealedLabel')}: <strong style={{ color: 'var(--text-strong)' }}>{totalSealed}</strong></span>
        <span>{t('sealed.openedLabel')}: <strong style={{ color: 'var(--text-strong)' }}>{totalOpened}</strong></span>
      </div>

      <div className="glass-panel" style={{ marginBottom: '1rem', padding: '1rem 1.25rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: '0.75rem', alignItems: 'flex-end' }}>
          <SealedFilterField label={t('sealed.searchLabel')}>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                className="input-control"
                placeholder={t('sealed.searchPlaceholder')}
                value={search}
                onChange={event => setSearch(event.target.value)}
                style={{ width: '100%', paddingLeft: '2.5rem' }}
              />
              <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </SealedFilterField>

          <button
            type="button"
            className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setShowFilters(current => !current)}
            style={{ padding: '0.5rem 0.9rem', height: '40px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
          >
            <SlidersHorizontal size={15} />
            {t('collection.filters')}
            {activeFilterCount > 0 && (
              <span style={{ background: 'var(--accent-red)', color: 'var(--text-strong)', fontSize: '0.65rem', fontWeight: 900, borderRadius: '999px', padding: '1px 7px', minWidth: '18px', textAlign: 'center' }}>
                {activeFilterCount}
              </span>
            )}
          </button>

          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <button
              type="button"
              className={`btn btn-icon-only ${viewMode === 'gallery' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('gallery')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title={t('collection.galleryView')}
              aria-label={t('collection.galleryView')}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              type="button"
              className={`btn btn-icon-only ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('list')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title={t('collection.listView')}
              aria-label={t('collection.listView')}
            >
              <List size={14} />
            </button>
          </div>
        </div>

        {showFilters && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-glass)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem' }}>
              <SealedFilterField label={t('sealed.filterGame')}>
                <select className="select-control" value={gameFilter} onChange={event => setGameFilter(event.target.value)}>
                  <option value="">{t('sealed.allGames')}</option>
                  {gameOptions().map(game => <option key={game.value} value={game.value}>{game.label}</option>)}
                </select>
              </SealedFilterField>
              <SealedFilterField label={t('sealed.filterType')}>
                <select className="select-control" value={typeFilter} onChange={event => setTypeFilter(event.target.value)}>
                  <option value="">{t('sealed.allTypes')}</option>
                  {productTypes.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
              </SealedFilterField>
              <SealedFilterField label={t('sealed.filterStatus')}>
                <select className="select-control" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
                  <option value="">{t('sealed.allStatuses')}</option>
                  <option value="sealed">{t('sealed.hasSealedUnits')}</option>
                  <option value="opened">{t('sealed.hasOpenedUnits')}</option>
                </select>
              </SealedFilterField>
              <SealedFilterField label={t('sealed.filterExpansion')}>
                <MultiSelectDropdown
                  label={t('sealed.filterExpansion')}
                  allLabel={t('sealed.allExpansions')}
                  value={expansionFilter}
                  onChange={setExpansionFilter}
                  options={expansions.map(expansion => ({ value: expansion, label: expansion }))}
                />
              </SealedFilterField>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id="showClaimedByOthers"
                  checked={showClaimedByOthers}
                  onChange={event => {
                    const checked = event.target.checked;
                    setShowClaimedByOthers(checked);
                    load(checked);
                  }}
                  style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                />
                <label htmlFor="showClaimedByOthers" style={{ cursor: 'pointer', margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {t('sealed.showClaimedByOthers')}
                </label>
              </div>

              {hasFilters && (
                <button type="button" className="btn btn-secondary" onClick={clearFilters} style={{ fontSize: '0.72rem', padding: '0.3rem 0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <X size={13} /> {t('collection.clearFilters')}
                </button>
              )}
              {filteredOwnedPurchases.length > 0 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={toggleFilteredSelection}>
                  {t(allFilteredOwnedSelected ? 'sealed.deselectFiltered' : 'sealed.selectFiltered', { count: filteredOwnedPurchases.length })}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {selectedOwnedPurchases.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', padding: '0.25rem 0' }}>
          <span style={{ color: 'var(--text-secondary)', marginRight: 'auto' }}>
            {t('sealed.selectedPurchases', { count: selectedOwnedPurchases.length })}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!selectedOwnedPurchases.length || savingSharing}
            onClick={() => updateSelectedSharing(true)}>
            {t('sealed.makeSelectedAvailable')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!selectedOwnedPurchases.length || savingSharing}
            onClick={() => updateSelectedSharing(false)}>
            {t('sealed.makeSelectedPrivate')}
          </button>
          {selectedOwnedPurchases.length > 0 && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={savingSharing}
              onClick={() => setSelectedPurchaseIds(new Set())}>
              {t('bulk.clear')}
            </button>
          )}
        </div>
      )}

      {(showForm || editingPurchase) && (
        <Modal onClose={() => { setShowForm(false); setEditingPurchase(null); }} label={t('sealed.addPurchase')} closeOnBackdrop={false}
          overlayStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
          style={{ maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
            <SealedPurchaseForm
              initial={editingPurchase || undefined}
              showToast={showToast}
              onCancel={() => { setShowForm(false); setEditingPurchase(null); }}
              onSaved={() => { setShowForm(false); setEditingPurchase(null); load(); }}
            />
        </Modal>
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
        <div className={viewMode === 'gallery' ? 'sealed-purchase-grid' : 'sealed-purchase-list'}>
          {filteredPurchases.map(p => (
            <PurchaseCard key={p.id} purchase={p} onChanged={load} onEdit={setEditingPurchase} showToast={showToast} onProposeTrade={onProposeTrade}
              selected={selectedPurchaseIds.has(p.id)} onSelectionChange={setPurchaseSelected}
              showClaimedByOthers={showClaimedByOthers} viewMode={viewMode} selectMode={selectMode}
              pressHandlers={purchasePressHandlers} longPressFired={purchaseLongPressFired} />
          ))}
        </div>
      )}
    </div>
  );
}
