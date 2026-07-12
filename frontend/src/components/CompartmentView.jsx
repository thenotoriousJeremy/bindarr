import { useState, useEffect, useRef } from 'react';
import { getPrintingBadgeStyle, getPrintingBadgeLabel, getFoilOverlayClass } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import { formatPrice } from '../utils/formatPrice';
import { typeCategory } from '../utils/cardSort';

const infoChipStyle = { fontSize: '0.6rem', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(255,255,255,0.08)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' };

function pocketColumns(capacity) {
  return Math.max(1, Math.round(Math.sqrt(capacity || 1)));
}

// The label a card falls under for a given divider field.
function categoryForField(card, field, setsList = []) {
  switch (field) {
    case 'name':
      return card.name ? card.name.charAt(0).toUpperCase() : '?';
    case 'set': {
      if (!card.set_name) return 'Unknown Set';
      if (!setsList || setsList.length === 0) return card.set_name;
      const idx = setsList.findIndex(s => s.name === card.set_name);
      return idx >= 0 ? `${idx + 1}. ${card.set_name}` : card.set_name;
    }
    case 'color_identity':
    case 'color': {
      let ci = 'Colorless';
      if (typeof card.color_identity === 'string') {
        try { const p = JSON.parse(card.color_identity); if (p.length > 0) ci = p[0]; } catch { /* ignore */ }
      } else if (Array.isArray(card.color_identity) && card.color_identity.length > 0) {
        ci = card.color_identity[0];
      }
      const names = { 'W': 'White', 'U': 'Blue', 'B': 'Black', 'R': 'Red', 'G': 'Green' };
      return names[ci] || ci || 'Colorless';
    }
    case 'type': {
      let types = [];
      if (card.types) {
        try {
          types = typeof card.types === 'string' ? JSON.parse(card.types) : card.types;
        } catch (e) { types = Array.isArray(card.types) ? card.types : []; }
      }
      return typeCategory(types);
    }
    case 'cmc':
      return `CMC ${card.cmc != null && card.cmc !== '' ? card.cmc : '?'}`;
    case 'rarity':
      return card.rarity || 'Common';
    case 'printing':
      return card.printing || 'Normal';
    case 'language':
      return card.language || 'English';
    case 'price': {
      const p = card.price_trend || 0;
      if (p >= 100) return '$100+';
      if (p >= 50) return '$50+';
      if (p >= 20) return '$20+';
      if (p >= 10) return '$10+';
      if (p >= 5) return '$5+';
      if (p >= 1) return '$1+';
      return '< $1';
    }
    default:
      return null; // added_at, entry_id, number: too granular to divide on
  }
}

function dividerFieldsOf(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const chosen = arr.filter(r => r && r.divider === true);
  if (chosen.length > 0) return chosen.map(r => ({ field: r.by, color: r.dividerColor || '#6b7280' }));
  if (arr.some(r => r && r.divider === false)) return [];
  return [{ field: arr[0].by, color: '#6b7280' }];
}

// eslint-disable-next-line react-refresh/only-export-components
export function getSortCategories(card, sortOrder, setsList = []) {
  if (!card || !sortOrder || sortOrder === 'custom') return [];

  let dividerFields = [];
  if (Array.isArray(sortOrder)) {
    dividerFields = dividerFieldsOf(sortOrder);
  } else if (typeof sortOrder === 'string' && sortOrder.startsWith('[')) {
    try { dividerFields = dividerFieldsOf(JSON.parse(sortOrder)); }
    catch (e) { dividerFields = []; }
  } else if (typeof sortOrder === 'string') {
    if (sortOrder.startsWith('name')) dividerFields = [{ field: 'name', color: '#6b7280' }];
    else if (sortOrder.startsWith('set')) dividerFields = [{ field: 'set', color: '#6b7280' }];
    else if (sortOrder.startsWith('type')) dividerFields = [{ field: 'type', color: '#6b7280' }];
    else if (sortOrder.startsWith('price')) dividerFields = [{ field: 'price', color: '#6b7280' }];
    else if (sortOrder.startsWith('language')) dividerFields = [{ field: 'language', color: '#6b7280' }];
  }

  return dividerFields.map(df => ({
    field: df.field,
    color: df.color,
    label: categoryForField(card, df.field, setsList)
  })).filter(c => c.label !== null);
}

// Category the container FILES by — the primary (first) sort field, matching
// the backend's placement engine. Used by the Category-to-Page map, which must
// track filing, not the (independent) visual divider choice.
// eslint-disable-next-line react-refresh/only-export-components
export function getPrimaryCategory(card, sortOrder, setsList = []) {
  if (!card || !sortOrder || sortOrder === 'custom') return null;
  let field = null;
  if (Array.isArray(sortOrder)) field = sortOrder[0]?.by || null;
  else if (typeof sortOrder === 'string' && sortOrder.startsWith('[')) {
    try { field = JSON.parse(sortOrder)[0]?.by || null; } catch (e) { field = null; }
  } else if (typeof sortOrder === 'string') {
    if (sortOrder.startsWith('name')) field = 'name';
    else if (sortOrder.startsWith('set')) field = 'set';
    else if (sortOrder.startsWith('type')) field = 'type';
    else if (sortOrder.startsWith('price')) field = 'price';
    else if (sortOrder.startsWith('language')) field = 'language';
  }
  if (!field) return null;
  return categoryForField(card, field, setsList);
}

function PrintingBadge({ printing }) {
  if (!printing || printing === 'Normal') return null;
  return (
    <div style={{
      position: 'absolute', top: '-4px', right: '-4px',
      fontSize: '0.55rem', fontWeight: 'bold',
      padding: '0.1rem 0.3rem', borderRadius: '4px',
      zIndex: 20, boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
      ...getPrintingBadgeStyle(printing)
    }}>
      {getPrintingBadgeLabel(printing)}
    </div>
  );
}

// Detail banner for the currently focused card. Shared by the box coverflow and
// the binder grid so both surfaces describe a selection the same way.
export function FocusedCardInfo({ card, slotNumber, moveSelect = null }) {
  return (
    <div className="focused-card-info-panel" style={{ marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.7rem', borderRadius: 'var(--radius-sm)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <strong style={{ fontSize: '0.85rem' }}>#{slotNumber} | {card.name}</strong>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
              {card.set_name} • #{card.number}
            </div>
          </div>
          {moveSelect}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }}>
          {card.rarity && (
            <span style={{ fontSize: '0.6rem', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.03em', ...getRarityBadgeStyle(card.rarity) }}>
              {getRarityBadgeLabel(card.rarity)}
            </span>
          )}
          {card.printing && card.printing !== 'Normal' && (
            <span style={{ fontSize: '0.6rem', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', ...getPrintingBadgeStyle(card.printing) }}>
              {getPrintingBadgeLabel(card.printing)}
            </span>
          )}
          {card.printing === 'Normal' && <span style={infoChipStyle}>Normal</span>}
          {card.supertype && <span style={{ ...infoChipStyle, color: '#fff' }} title="Supertype">{card.supertype}</span>}
          {(card.types || []).length > 0 && <span style={infoChipStyle} title="Types">{card.types.join(' / ')}</span>}
          {(card.subtypes || []).length > 0 && <span style={infoChipStyle} title="Subtypes">{card.subtypes.join(' / ')}</span>}
          {card.condition && <span style={infoChipStyle}>{card.condition}</span>}
          {card.language && card.language !== 'English' && <span style={infoChipStyle}>{card.language}</span>}
          {card.quantity > 1 && <span style={{ ...infoChipStyle, color: '#fff' }}>x{card.quantity}</span>}
          {card.price_trend > 0 && (
            <span style={{ ...infoChipStyle, color: 'var(--accent-yellow)', marginLeft: 'auto' }}>
              Value ${formatPrice(card.price_trend)}
            </span>
          )}
          {card.purchase_price > 0 && <span style={infoChipStyle}>Paid ${formatPrice(card.purchase_price)}</span>}
        </div>
      </div>
    </div>
  );
}

export default function CompartmentView({
  compartment,
  cards = [],
  locationType,
  sortOrder = 'custom',
  setsList = [],
  highlightPositions = [], // Array of positions to highlight (1-indexed)
  highlightEntryIds = [], // Cards to highlight by entry_id (exact, packing-independent)
  targetActiveIndex = null,
  onCardClick = null,
  
  // Lifted state for binder active card
  activeEntryId = undefined,
  onActiveEntryIdChange = null,
  hideFocusedCardInfo = false,

  // Storage Management Props (can be omitted for read-only view)
  onRename = null,
  onSetCapacity = null,
  onRemove = null,
  onMoveCard = null,
  moveTargets = [],
  canRemove = false,
  recommendedSpot = null,
  focusEntryId = null,

  // Multi-select (optional; enabled when onCardLongPress is provided)
  selectMode = false,
  selectedIds = null,
  onCardLongPress = null,
  onCardToggle = null,

  // Per-compartment filing rules editor (optional)
  onEditRules = null
}) {
  const isBinder = locationType === 'Binder' || locationType === 'Toploader Binder';
  const isSelected = (entryId) => !!(selectedIds && selectedIds.has(entryId));
  const highlightSet = new Set(highlightEntryIds);

  // Long-press-to-arm selection, mirrors CollectionList. Coexists with the
  // swipe/coverflow touch handlers because a >10px move cancels the timer.
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);
  const pointerStart = useRef(null);
  useEffect(() => () => clearTimeout(longPressTimer.current), []);

  const beginPress = (e, entryId) => {
    if (!onCardLongPress) return;
    longPressFired.current = false;
    pointerStart.current = { x: e.clientX, y: e.clientY };
    clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      onCardLongPress(entryId);
      if (navigator.vibrate) navigator.vibrate(25);
    }, 450);
  };
  const movePress = (e) => {
    if (!pointerStart.current) return;
    if (Math.abs(e.clientX - pointerStart.current.x) > 10 || Math.abs(e.clientY - pointerStart.current.y) > 10) {
      clearTimeout(longPressTimer.current);
    }
  };
  const endPress = () => { clearTimeout(longPressTimer.current); pointerStart.current = null; };
  const pressHandlers = (entryId) => ({
    onPointerDown: (e) => beginPress(e, entryId),
    onPointerMove: movePress,
    onPointerUp: endPress,
    onPointerLeave: endPress,
    onContextMenu: (e) => e.preventDefault(),
  });
  // Returns true if the click was consumed by selection (caller should stop).
  const handleSelectClick = (entryId) => {
    if (longPressFired.current) { longPressFired.current = false; return true; }
    if (selectMode) { onCardToggle && onCardToggle(entryId); return true; }
    return false;
  };
  const selectedOutline = { outline: '3px solid var(--accent-red)', outlineOffset: '1px' };

  // How many per-compartment filing rules are set (for the Accepts button label).
  const compRuleCount = (() => {
    const cfg = compartment && compartment.rule_config;
    if (!cfg) return 0;
    try {
      const p = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
      const rules = Array.isArray(p) ? p : (p.rules || []);
      return rules.length;
    } catch (e) { return 0; }
  })();
  const acceptsLabel = compRuleCount > 0 ? `Accepts (${compRuleCount})` : 'Accepts';

  const recIdx = recommendedSpot ? recommendedSpot.index : -1;
  const cardsWithGhost = [...cards];
  if (recIdx >= 0) {
    while (cardsWithGhost.length < recIdx) cardsWithGhost.push(null);
    cardsWithGhost.splice(recIdx, 0, {
      __ghost: true,
      image_url: recommendedSpot.image_url,
      name: recommendedSpot.name,
      set_name: recommendedSpot.set_name
    });
  }

  // --- Box Coverflow State ---
  const slotCountBox = Math.max(compartment?.capacity || 1, cardsWithGhost.length);
  const filledCardsBox = Array.from({ length: slotCountBox }, (_, i) => cardsWithGhost[i] || null);
  
  const initialActiveIndex = highlightPositions.length > 0 
    ? Math.max(0, highlightPositions[0] - 1) 
    : 0;
    
  const [coverflowActiveIndex, setCoverflowActiveIndex] = useState(0);
  const lastTargetActiveRef = useRef(null);

  const [touchStart, setTouchStart] = useState(0);

  const handleCoverflowTouchStart = (e) => setTouchStart(e.touches[0].clientX);
  const handleCoverflowTouchEnd = (e, totalCards) => {
    const end = e.changedTouches[0].clientX;
    if (touchStart - end > 40) setCoverflowActiveIndex(prev => Math.min(totalCards - 1, prev + 1));
    if (end - touchStart > 40) setCoverflowActiveIndex(prev => Math.max(0, prev - 1));
  };

  // --- Binder Grid State ---
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(compartment?.display_label || '');
  const [binderActiveEntryId, setBinderActiveEntryId] = useState(null);

  const currentActiveId = activeEntryId !== undefined ? activeEntryId : binderActiveEntryId;
  const setCurrentActiveId = (id) => {
    if (onActiveEntryIdChange) onActiveEntryIdChange(id);
    else setBinderActiveEntryId(id);
  };

  if (!compartment) return null;

  if (isBinder) {
    const cols = pocketColumns(compartment.capacity);
    const slotCount = Math.max(compartment.capacity, cardsWithGhost.length);
    const pockets = Array.from({ length: slotCount }, (_, i) => cardsWithGhost[i] || null);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', height: '100%' }}>
        {onRename && (
          <div className="row-flash" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
            {editingLabel ? (
              <input
                autoFocus
                className="input-control"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={() => { if (editingLabel) { setEditingLabel(false); onRename(labelDraft); } }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { setEditingLabel(false); onRename(labelDraft); }
                  else if (e.key === 'Escape') setEditingLabel(false);
                }}
                style={{ padding: '0.15rem 0.4rem', fontSize: '0.75rem', width: '110px' }}
              />
            ) : (
              <strong onDoubleClick={() => { setLabelDraft(compartment.label || ''); setEditingLabel(true); }} title="Double-click to rename" style={{ cursor: 'pointer', fontSize: '0.8rem' }}>
                {compartment.display_label}
              </strong>
            )}
            
            {(compartment.assignedFilters || []).length > 0 && (
              <span title="Sorting categories filed to this page" style={{ fontSize: '0.55rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {compartment.assignedFilters.length === 1 ? compartment.assignedFilters[0] : `${compartment.assignedFilters.length} cats`}
              </span>
            )}

            {onEditRules && (
              <button type="button" className="btn btn-secondary" onClick={() => onEditRules(compartment)} title="Set which cards this page accepts" style={{ fontSize: '0.55rem', padding: '0.15rem 0.4rem', ...(compRuleCount > 0 ? { borderColor: 'var(--accent-red)', color: '#fff' } : {}) }}>
                {acceptsLabel}
              </button>
            )}

            {onSetCapacity && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.1rem', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                <span>{compartment.count} /</span>
                <input
                  type="number" min="1" className="input-control" defaultValue={compartment.capacity}
                  onBlur={(e) => { const v = parseInt(e.target.value, 10); if (v > 0 && v !== compartment.capacity) onSetCapacity(v); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  title="Change capacity"
                  style={{ width: '40px', padding: '0 0.1rem', fontSize: '0.65rem', background: 'transparent', border: '1px solid transparent', color: 'inherit', textAlign: 'left' }}
                />
              </div>
            )}
            
            {canRemove && onRemove && (
              <button type="button" className="btn btn-danger btn-icon-only" onClick={onRemove} title="Remove this page" style={{ width: '22px', height: '22px', padding: 0, marginLeft: 'auto' }}>
                &times;
              </button>
            )}
          </div>
        )}
        
        <div className="binder-pocket-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {(() => {
            let lastNonGhostCats = [];
            return pockets.map((card, i) => {
              const pos = i + 1;
              const cats = card && card.__ghost ? [] : getSortCategories(card, sortOrder, setsList);
              const prevCats = lastNonGhostCats;
              
              const newDividers = [];
              if (cats.length > 0) {
                if (prevCats.length === 0) {
                  newDividers.push(...cats);
                } else {
                  let diffIdx = -1;
                  for (let j = 0; j < cats.length; j++) {
                    if (!prevCats[j] || cats[j].label !== prevCats[j].label) {
                      diffIdx = j;
                      break;
                    }
                  }
                  if (diffIdx !== -1) {
                    for (let j = diffIdx; j < cats.length; j++) {
                      newDividers.push(cats[j]);
                    }
                  }
                }
                lastNonGhostCats = cats;
              }

              const categoryStart = newDividers.length > 0;
              const isHighlighted = highlightPositions.includes(pos);
              const isTarget = isHighlighted || (card && !card.__ghost && highlightSet.has(card.entry_id));

              if (card && card.__ghost) {
                return (
                  <div key={`ghost-${i}`} id="recommended-spot" className={`binder-pocket recommended-ghost ${categoryStart ? 'set-start' : ''}`}>
                    {card.image_url && <img src={card.image_url} alt={card.name} style={{ opacity: 0.85 }} />}
                    <div className="rec-ghost-label">Slot {pos}</div>
                    {newDividers.length > 0 && (
                      <div style={{ position: 'absolute', top: 0, left: 0, transform: 'translateY(-100%)', display: 'flex', flexDirection: 'column', gap: '2px', paddingBottom: '2px', zIndex: 20 }}>
                        {newDividers.map((div, dIdx) => (
                          <div key={dIdx} className="set-divider-label" title={div.label} style={{ position: 'relative', top: 'auto', left: 'auto', backgroundColor: div.color }}>{div.label}</div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }
              return card ? (
                <div
                  key={card.entry_id || `slot-${i}`}
                  className={`binder-pocket ${categoryStart ? 'set-start' : ''} ${card.entry_id === focusEntryId ? 'focus-flash' : ''}`}
                  style={{
                    ...getCardRarityBorder(card.rarity),
                    ...(isTarget ? {
                      border: '2.5px solid var(--accent-green)',
                      boxShadow: '0 0 15px rgba(34,197,94,0.4), inset 0 0 20px rgba(34,197,94,0.3)'
                    } : {}),
                    ...(card.entry_id === currentActiveId ? { border: '2.5px solid var(--accent-yellow)', boxShadow: '0 0 10px rgba(250,204,21,0.5)' } : {}),
                    ...(isSelected(card.entry_id) ? selectedOutline : {})
                  }}
                  {...pressHandlers(card.entry_id)}
                  onClick={() => {
                    if (handleSelectClick(card.entry_id)) return;
                    if (card.entry_id === currentActiveId) onCardClick && onCardClick(card);
                    else setCurrentActiveId(card.entry_id);
                  }}
                >
                  <img src={card.image_url} alt={card.name} title={card.name} />
                  {getFoilOverlayClass(card.printing) && <div className={getFoilOverlayClass(card.printing)} style={{ borderRadius: '4px' }} />}
                  <PrintingBadge printing={card.printing} />
                  {card.checked_out_qty > 0 && (
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.62)', borderRadius: '4px', zIndex: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                      <span style={{ fontSize: '0.5rem', fontWeight: 900, letterSpacing: '0.04em', color: '#fff', background: 'var(--accent-red)', padding: '2px 5px', borderRadius: '4px', transform: 'rotate(-8deg)', textTransform: 'uppercase' }}>
                        {card.checked_out_qty < card.quantity ? `${card.checked_out_qty}/${card.quantity} Out` : 'In Play'}
                      </span>
                    </div>
                  )}
                  {selectMode && (
                    <div style={{ position: 'absolute', top: '3px', left: '3px', zIndex: 25, width: '18px', height: '18px', borderRadius: '50%', background: isSelected(card.entry_id) ? 'var(--accent-red)' : 'rgba(0,0,0,0.6)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '0.65rem', fontWeight: 900 }}>{isSelected(card.entry_id) ? '✓' : ''}</div>
                  )}
                  {newDividers.length > 0 && (
                    <div style={{ position: 'absolute', top: 0, left: 0, transform: 'translateY(-100%)', display: 'flex', flexDirection: 'column', gap: '2px', paddingBottom: '2px', zIndex: 20 }}>
                      {newDividers.map((div, dIdx) => (
                        <div key={dIdx} className="set-divider-label" title={div.label} style={{ position: 'relative', top: 'auto', left: 'auto', backgroundColor: div.color }}>{div.label}</div>
                      ))}
                    </div>
                  )}

                  {isTarget && (
                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'var(--accent-green)', color: '#000', width: '30px', height: '30px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1rem', boxShadow: '0 4px 10px rgba(0,0,0,0.5)' }}>✓</div>
                  )}
                </div>
              ) : (
                <div key={`empty-${i}`} className="binder-pocket empty" style={isTarget ? { borderColor: 'var(--accent-green)', background: 'rgba(34,197,94,0.1)' } : {}}>
                  <span className="slot-number">{pos}</span>
                  {isTarget && (
                    <div style={{ color: 'var(--accent-green)', fontWeight: 'bold', fontSize: '0.8rem', marginTop: '0.5rem' }}>Pull</div>
                  )}
                </div>
              );
            })})()}
        </div>

        {(() => {
          if (hideFocusedCardInfo) return null;
          const activeCard = cards.find(c => c.entry_id === currentActiveId);
          if (!activeCard) return null;
          const slotNumber = pockets.findIndex(p => p && p.entry_id === currentActiveId) + 1;
          const moveSelect = sortOrder === 'custom' && moveTargets.length > 1 && onMoveCard ? (
            <select
              className="select-control"
              value=""
              onChange={(e) => { if (e.target.value) onMoveCard(activeCard.entry_id, parseInt(e.target.value, 10)); }}
              style={{ fontSize: '0.65rem', padding: '0.15rem 0.3rem', width: '110px', flexShrink: 0 }}
            >
              <option value="">Move to...</option>
              {moveTargets.filter(t => t.id !== compartment.id).map(t => (
                <option key={t.id} value={t.id}>{t.display_label}</option>
              ))}
            </select>
          ) : null;
          return <FocusedCardInfo card={activeCard} slotNumber={slotNumber} moveSelect={moveSelect} />;
        })()}
      </div>
    );
  } else {
    // --- Box Coverflow Rendering ---
    const renderedCards = [];
    let slotCounter = 1;
    
    let lastFilledIdx = -1;
    for (let i = filledCardsBox.length - 1; i >= 0; i--) {
      if (filledCardsBox[i]) {
        lastFilledIdx = i;
        break;
      }
    }
    
    const highestTargetIdx = highlightPositions.length > 0 ? Math.max(...highlightPositions) - 1 : -1;
    const renderLimit = Math.max(lastFilledIdx, highestTargetIdx);

    let currentCats = [];
    for (let i = 0; i <= renderLimit; i++) {
      const card = filledCardsBox[i];
      if (card) {
        if (card.__ghost) {
          // Ghost cards don't have full metadata (price, type, etc.) and aren't 
          // permanently in the compartment, so they shouldn't trigger dividers.
          renderedCards.push({ ...card, __slotNumber: slotCounter });
        } else {
          const cats = getSortCategories(card, sortOrder, setsList);
          let diffIdx = -1;
          if (cats.length > 0) {
            if (currentCats.length === 0) {
              diffIdx = 0;
            } else {
              for (let j = 0; j < cats.length; j++) {
                if (!currentCats[j] || cats[j].label !== currentCats[j].label) {
                  diffIdx = j;
                  break;
                }
              }
            }
          }
          if (diffIdx !== -1) {
            for (let j = diffIdx; j < cats.length; j++) {
              renderedCards.push({
                __divider: true,
                entry_id: `div-${card.entry_id || i}-${cats[j].field}-${cats[j].label}`,
                label: cats[j].label,
                color: cats[j].color
              });
            }
            currentCats = cats;
          }
          renderedCards.push({ ...card, __slotNumber: slotCounter });
        }
      } else {
        renderedCards.push({
          __empty: true,
          __slotNumber: slotCounter,
          entry_id: `spacer-${slotCounter}`
        });
      }
      slotCounter++;
    }

    let actualActiveIndex = coverflowActiveIndex;
    if (focusEntryId) {
      const targetIdx = renderedCards.findIndex(c => c.entry_id === focusEntryId);
      if (targetIdx !== -1) {
        actualActiveIndex = targetIdx;
      }
    } else if (targetActiveIndex !== null && targetActiveIndex !== undefined) {
      // Map slot index to renderedCards index
      const targetIdx = renderedCards.findIndex(c => c.__slotNumber === targetActiveIndex + 1 && !c.__divider);
      if (targetIdx !== -1) {
        if (lastTargetActiveRef.current !== targetActiveIndex) {
          lastTargetActiveRef.current = targetActiveIndex;
          actualActiveIndex = targetIdx;
          setTimeout(() => setCoverflowActiveIndex(targetIdx), 0);
        }
      }
    }
    
    // Also fix initialization on first render if targetActiveIndex wasn't provided
    if (actualActiveIndex === 0 && initialActiveIndex > 0 && (targetActiveIndex === null || targetActiveIndex === undefined)) {
      const targetIdx = renderedCards.findIndex(c => c.__slotNumber === initialActiveIndex + 1 && !c.__divider);
      if (targetIdx !== -1 && actualActiveIndex !== targetIdx && lastTargetActiveRef.current !== 'init') {
        lastTargetActiveRef.current = 'init';
        actualActiveIndex = targetIdx;
        setTimeout(() => setCoverflowActiveIndex(targetIdx), 0);
      }
    }

    const activeCardIndex = Math.min(actualActiveIndex, Math.max(0, renderedCards.length - 1));

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%', overflow: 'hidden' }}>
        {onRename && (
          <div className="row-flash" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.1)', padding: '0.4rem 0.6rem', borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
            {editingLabel ? (
              <input
                autoFocus
                className="input-control"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={() => { if (editingLabel) { setEditingLabel(false); onRename(labelDraft); } }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { setEditingLabel(false); onRename(labelDraft); }
                  else if (e.key === 'Escape') setEditingLabel(false);
                }}
                style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem', width: '150px' }}
              />
            ) : (
              <strong onDoubleClick={() => { setLabelDraft(compartment.label || ''); setEditingLabel(true); }} title="Double-click to rename" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
                {compartment.display_label}
              </strong>
            )}
            {onEditRules && (
              <button type="button" className="btn btn-secondary" onClick={() => onEditRules(compartment)} title="Set which cards this row accepts" style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem', ...(compRuleCount > 0 ? { borderColor: 'var(--accent-red)', color: '#fff' } : {}) }}>
                {acceptsLabel}
              </button>
            )}
          </div>
        )}

        {renderedCards.length === 0 ? (
          <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.8rem' }}>
            Empty row.
          </div>
        ) : (
          <>
          <div
            className="box-coverflow-container"
            onTouchStart={handleCoverflowTouchStart}
            onTouchEnd={(e) => handleCoverflowTouchEnd(e, renderedCards.length)}
          >
            <button
              type="button"
              className="box-coverflow-nav left"
              disabled={activeCardIndex <= 0}
              onClick={() => setCoverflowActiveIndex(prev => Math.max(0, prev - 1))}
            >
              &larr;
            </button>

            <div className="box-coverflow-track">
              {renderedCards.map((card, i) => {
                const offset = i - activeCardIndex;
                const absOffset = Math.abs(offset);
                let transform = '';
                let zIndex = 10 - absOffset;
                let opacity = 1;
                let filter = 'none';

                if (offset === 0) {
                  transform = `translateX(0px) scale(1.22) translateZ(0px)`;
                  opacity = 1;
                } else {
                  const dir = offset > 0 ? 1 : -1;
                  const translateX = dir * (85 + absOffset * 35);
                  const rotateY = dir * -48;
                  transform = `translateX(${translateX}px) scale(0.8) rotateY(${rotateY}deg)`;
                  opacity = Math.max(0.12, 1 - absOffset * 0.22);
                  filter = `brightness(${Math.max(0.35, 1 - absOffset * 0.18)})`;
                }
                
                const pos = card.__slotNumber;
                const isTarget = highlightPositions.includes(pos) || (!card.__divider && !card.__empty && !card.__ghost && highlightSet.has(card.entry_id));
                
                const highlightStyle = isTarget ? { 
                  border: '2px solid var(--accent-green)', 
                  boxShadow: '0 0 20px rgba(34,197,94,0.6)' 
                } : {};

                if (card.__empty) {
                  return (
                    <div
                      key={card.entry_id}
                      className={`box-coverflow-card ${offset === 0 ? 'active' : ''}`}
                      style={{ transform, zIndex, opacity: opacity * 0.6, filter, ...highlightStyle }}
                      onClick={() => setCoverflowActiveIndex(i)}
                    >
                      <div style={{ width: '100%', height: '100%', background: 'rgba(0,0,0,0.3)', border: '2px dashed rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: '5px' }}>
                        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.8rem', fontWeight: 'bold' }}>Slot {card.__slotNumber}</span>
                        {isTarget && (
                          <div style={{ color: 'var(--accent-green)', fontWeight: 'bold', fontSize: '1rem', marginTop: '0.5rem' }}>Pull</div>
                        )}
                      </div>
                    </div>
                  );
                }

                if (card.__divider) {
                  return (
                    <div
                      key={card.entry_id}
                      className={`box-coverflow-card ${offset === 0 ? 'active' : ''}`}
                      style={{ transform, zIndex, opacity, filter: 'none', background: card.color || 'var(--accent-red)', border: `1px solid ${card.color || 'var(--accent-red)'}`, display: 'flex', flexDirection: 'column', overflow: 'visible' }}
                      onClick={() => setCoverflowActiveIndex(i)}
                    >
                      <div style={{ position: 'absolute', top: '-18px', left: '10px', background: card.color || 'var(--accent-red)', color: '#fff', padding: '2px 12px', borderRadius: '6px 6px 0 0', fontSize: '0.7rem', fontWeight: 'bold', boxShadow: '0 -2px 5px rgba(0,0,0,0.3)', whiteSpace: 'nowrap' }}>
                        {card.label}
                      </div>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '0.5rem', color: '#fff' }}>
                        <div style={{ fontSize: '1.2rem', fontWeight: 'bold', textAlign: 'center', padding: '0 1rem' }}>{card.label}</div>
                      </div>
                    </div>
                  );
                }

                if (card.__ghost) {
                  return (
                    <div
                      key="ghost"
                      id="recommended-spot"
                      className={`box-coverflow-card recommended-ghost ${offset === 0 ? 'active' : ''}`}
                      style={{ transform, zIndex, opacity: opacity * 0.85, filter }}
                      onClick={() => setCoverflowActiveIndex(i)}
                    >
                      {card.image_url && <img src={card.image_url} alt={card.name} />}
                      <div className="rec-ghost-label">Slot {pos}</div>
                    </div>
                  );
                }

                return (
                  <div
                    key={card.entry_id}
                    className={`box-coverflow-card ${offset === 0 ? 'active' : ''}`}
                    style={{ transform, zIndex, opacity, filter, ...highlightStyle, ...getCardRarityBorder(card.rarity), ...(isSelected(card.entry_id) ? selectedOutline : {}) }}
                    {...pressHandlers(card.entry_id)}
                    onClick={() => {
                      if (handleSelectClick(card.entry_id)) return;
                      if (offset === 0 && onCardClick) onCardClick(card);
                      else setCoverflowActiveIndex(i);
                    }}
                  >
                    <img src={card.image_url} alt={card.name} />
                    {getFoilOverlayClass(card.printing) && <div className={getFoilOverlayClass(card.printing)} style={{ borderRadius: '4.5px' }} />}
                    <PrintingBadge printing={card.printing} />
                    {card.checked_out_qty > 0 && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.62)', borderRadius: '5px', zIndex: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                        <span style={{ fontSize: '0.7rem', fontWeight: 900, letterSpacing: '0.04em', color: '#fff', background: 'var(--accent-red)', padding: '3px 8px', borderRadius: '4px', transform: 'rotate(-8deg)', textTransform: 'uppercase' }}>
                          {card.checked_out_qty < card.quantity ? `${card.checked_out_qty}/${card.quantity} Out` : 'In Play'}
                        </span>
                      </div>
                    )}
                    {selectMode && (
                      <div style={{ position: 'absolute', top: '4px', left: '4px', zIndex: 25, width: '20px', height: '20px', borderRadius: '50%', background: isSelected(card.entry_id) ? 'var(--accent-red)' : 'rgba(0,0,0,0.6)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '0.7rem', fontWeight: 900 }}>{isSelected(card.entry_id) ? '✓' : ''}</div>
                    )}
                    
                    {isTarget && (
                      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'var(--accent-green)', color: '#000', width: '40px', height: '40px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1.5rem', boxShadow: '0 4px 10px rgba(0,0,0,0.5)' }}>✓</div>
                    )}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              className="box-coverflow-nav right"
              disabled={activeCardIndex >= renderedCards.length - 1}
              onClick={() => setCoverflowActiveIndex(prev => Math.min(renderedCards.length - 1, prev + 1))}
            >
              &rarr;
            </button>
          </div>

          {(() => {
            const activeCard = renderedCards[activeCardIndex];
            if (!activeCard || activeCard.__ghost || activeCard.__divider || activeCard.__empty) return null;

            const moveSelect = sortOrder === 'custom' && moveTargets.length > 1 && onMoveCard ? (
              <select
                className="select-control"
                value=""
                onChange={(e) => { if (e.target.value) onMoveCard(activeCard.entry_id, parseInt(e.target.value, 10)); }}
                style={{ fontSize: '0.65rem', padding: '0.15rem 0.3rem', width: '110px', flexShrink: 0 }}
              >
                <option value="">Move to...</option>
                {moveTargets.filter(t => t.id !== compartment.id).map(t => (
                  <option key={t.id} value={t.id}>{t.display_label}</option>
                ))}
              </select>
            ) : null;

            return <FocusedCardInfo card={activeCard} slotNumber={activeCard.__slotNumber} moveSelect={moveSelect} />;
          })()}
          </>
        )}
      </div>
    );
  }
}
