import { useState, useEffect } from 'react';
import { X, MapPin, Trash2 } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { formatPrice } from '../utils/formatPrice';
import { CONDITIONS, PRINTINGS, LANGUAGES } from '../utils/cardOptions';
import PriceHistoryChart from './PriceHistoryChart';

// MTG color identity pip colors (WUBRG), approximating the printed mana colors.
const MTG_COLOR_BG = {
  White: '#f8f6d8', Blue: '#0e68ab', Black: '#2b2422', Red: '#d3202a', Green: '#00733e'
};
const MTG_COLOR_FG = {
  White: '#3a3520', Blue: '#fff', Black: '#fff', Red: '#fff', Green: '#fff'
};

// Shared card detail popup used by Dashboard, CollectionList and LocationManager.
// Self-contained: owns its edit form (PUT) and delete (DELETE) so every screen
// gets the same rich view + edit without duplicating the form. onUpdate() lets
// the parent refetch after a change. onViewStorage is optional (hidden if absent).
function CardInspectorModal({ card, onClose, onUpdate, showToast, onViewStorage, startInEdit = false }) {
  const [mode, setMode] = useState('view');
  const [locations, setLocations] = useState([]);
  const [q, setQ] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [locationId, setLocationId] = useState('');
  const [isTrade, setIsTrade] = useState(0);
  const [listType, setListType] = useState('collection');

  useEffect(() => {
    fetch('/api/locations')
      .then(r => r.ok ? r.json() : [])
      .then(setLocations)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!card) return;
    setMode(startInEdit ? 'edit' : 'view');
    setQ(card.quantity ?? 1);
    setCondition(card.condition || 'Near Mint');
    setPrinting(card.printing || 'Normal');
    setLanguage(card.language || 'English');
    setPurchasePrice(card.purchase_price || 0);
    setLocationId(card.location_id || '');
    setIsTrade(card.is_trade || 0);
    setListType(card.list_type || 'collection');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.entry_id, startInEdit]);

  if (!card) return null;

  const handleSave = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/collection/${card.entry_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: parseInt(q, 10),
          condition,
          printing,
          language,
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: locationId ? parseInt(locationId, 10) : null,
          list_type: listType,
          is_trade: isTrade
        })
      });
      if (res.ok) {
        showToast && showToast('Card entry updated.');
        onUpdate && onUpdate();
        onClose();
      } else {
        showToast && showToast('Failed to update card.');
      }
    } catch (err) {
      console.error(err);
      showToast && showToast('Error editing card.');
    }
  };

  const handleQuickToggle = async (field, value) => {
    // Optimistic UI updates
    if (field === 'is_trade') setIsTrade(value);
    if (field === 'list_type') setListType(value);
    
    // We update the backend by sending all current form state but overriding the toggled field
    const payload = {
      quantity: parseInt(q, 10),
      condition,
      printing,
      language,
      purchase_price: parseFloat(purchasePrice) || 0,
      location_id: locationId ? parseInt(locationId, 10) : null,
      list_type: field === 'list_type' ? value : listType,
      is_trade: field === 'is_trade' ? value : isTrade
    };
    try {
      const res = await fetch(`/api/collection/${card.entry_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        showToast && showToast(`Card updated.`);
        onUpdate && onUpdate();
      } else {
        // revert on fail
        if (field === 'is_trade') setIsTrade(isTrade);
        if (field === 'list_type') setListType(listType);
        showToast && showToast('Failed to update card.');
      }
    } catch (err) {
      console.error(err);
      if (field === 'is_trade') setIsTrade(isTrade);
      if (field === 'list_type') setListType(listType);
      showToast && showToast('Error updating card.');
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Are you sure you want to delete ${card.name} from your collection?`)) return;
    try {
      const res = await fetch(`/api/collection/${card.entry_id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast && showToast(`${card.name} removed from collection.`);
        onUpdate && onUpdate();
        onClose();
      } else {
        showToast && showToast('Failed to delete card.');
      }
    } catch (err) {
      console.error(err);
      showToast && showToast('Error connecting to backend.');
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 999,
      padding: '1.5rem'
    }} onClick={onClose}>
      <div className="glass-panel" style={{
        maxWidth: '720px',
        width: '100%',
        maxHeight: '90vh',
        overflowY: 'auto',
        padding: '2.5rem',
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: '2.5rem',
        position: 'relative',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 20px 50px rgba(0,0,0,0.6)'
      }} onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-secondary btn-icon-only" onClick={onClose} style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
          borderRadius: '50%',
          zIndex: 10
        }}>
          <X size={16} />
        </button>

        {/* Left side: Card Image & Badge overlays */}
        <div style={{ flex: '1 1 250px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: '280px' }}>
            <img
              src={card.image_url}
              alt={card.name}
              style={{
                width: '100%',
                aspectRatio: 0.718,
                objectFit: 'cover',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 0 20px rgba(255,255,255,0.05)'
              }}
            />
          </div>

          {/* Quantities indicator badge */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <span className="badge" style={{ padding: '0.4rem 0.8rem', background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: '0.75rem', fontWeight: 700 }}>
              Owned: x{card.quantity}
            </span>
            <span className="badge" style={{ padding: '0.4rem 0.8rem', background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.2)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-yellow)', fontSize: '0.75rem', fontWeight: 700 }}>
              {card.rarity || 'Common'}
            </span>
          </div>
        </div>

        {/* Right side: Information / Edit */}
        <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1.25rem', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              {card.list_type === 'wishlist' && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4', border: '1px solid rgba(6, 182, 212, 0.3)' }}>
                  Wishlist Item
                </span>
              )}
              {card.is_trade === 1 && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(74, 222, 128, 0.15)', color: 'var(--type-grass)', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                  For Trade
                </span>
              )}
            </div>

            <h3 style={{ fontSize: '1.65rem', color: '#fff', fontWeight: 800, lineHeight: 1.15, marginBottom: '0.25rem' }}>
              {getCardDisplayName(card.name, card.language)}
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>{card.set_name} • Card #{card.number}</p>

            {/* MTG cards: show color pips + type line (Pokémon energy types are
                already conveyed via the type-glow styling elsewhere). */}
            {card.supertype === 'MTG' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                {(Array.isArray(card.types) ? card.types : []).map(color => (
                  <span key={color} className={`mtg-color-pip mtg-color-${color.toLowerCase()}`} style={{
                    fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em',
                    padding: '0.15rem 0.45rem', borderRadius: '999px',
                    background: MTG_COLOR_BG[color] || 'rgba(255,255,255,0.1)',
                    color: MTG_COLOR_FG[color] || '#fff', border: '1px solid rgba(0,0,0,0.2)'
                  }}>{color}</span>
                ))}
                {(!card.types || card.types.length === 0) && (
                  <span style={{ fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.15rem 0.45rem', borderRadius: '999px', background: 'rgba(180,180,180,0.25)', color: '#eee' }}>Colorless</span>
                )}
                {Array.isArray(card.subtypes) && card.subtypes.length > 0 && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{card.subtypes.join(' ')}</span>
                )}
              </div>
            )}
          </div>

          {mode === 'edit' ? (
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {listType === 'wishlist' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(74,222,128,0.1)', padding: '0.6rem 0.9rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(74,222,128,0.2)' }}>
                  <input type="checkbox" checked={listType === 'collection'} onChange={(e) => setListType(e.target.checked ? 'collection' : 'wishlist')} id="markOwned" style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                  <label htmlFor="markOwned" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: 'var(--type-grass)', fontSize: '0.85rem' }}>
                    Mark as Obtained (Move to Collection)
                  </label>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.6rem 0.9rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <input type="checkbox" checked={isTrade === 1} onChange={(e) => setIsTrade(e.target.checked ? 1 : 0)} id="isTrade" style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                  <label htmlFor="isTrade" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>
                    Listed in Trade Binder
                  </label>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>
                <div className="form-group">
                  <label>Quantity</label>
                  <input type="number" className="input-control" min="1" value={q} onChange={(e) => setQ(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>Purchase Price ($)</label>
                  <input type="number" step="0.01" className="input-control" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.6rem' }}>
                <div className="form-group">
                  <label>Condition</label>
                  <select className="select-control" value={condition} onChange={(e) => setCondition(e.target.value)}>
                    {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Printing</label>
                  <select className="select-control" value={printing} onChange={(e) => setPrinting(e.target.value)}>
                    {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Language</label>
                  <select className="select-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                    {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Storage Container</label>
                <select className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Unassigned Pile</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setMode('view')} style={{ flex: 1 }}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>Save Changes</button>
              </div>
            </form>
          ) : (
            <>
              {/* Price Panel */}
              <div style={{ borderTop: '1px solid var(--border-glass)', borderBottom: '1px solid var(--border-glass)', padding: '0.75rem 0', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>TCG MARKET PRICE</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-yellow)', marginTop: '0.15rem' }}>
                    ${formatPrice(card.price_trend)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>EST. PURCHASE VALUE</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', marginTop: '0.15rem' }}>
                    ${formatPrice(card.purchase_price)}
                  </div>
                </div>
              </div>

              {/* Price History Area Chart */}
              <PriceHistoryChart cardId={card.card_id} defaultRange="1y" />

              {/* Specifications Details Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem 1rem', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-glass)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                <div><span style={{ color: 'var(--text-muted)' }}>Condition:</span> <span style={{ color: '#fff', fontWeight: 600 }}>{card.condition}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Printing:</span> <span style={{ color: '#fff', fontWeight: 600 }}>{card.printing}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Language:</span> <span style={{ color: '#fff', fontWeight: 600 }}>{card.language}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Supertype:</span> <span style={{ color: '#fff', fontWeight: 600 }}>{card.supertype}</span></div>
              </div>

              {/* Storage Container details */}
              {card.list_type !== 'wishlist' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255, 71, 71, 0.02)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', fontSize: '0.75rem' }}>
                  <MapPin size={14} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Location: </span>
                    <strong style={{ color: '#fff' }}>
                      {card.location_name ? `${card.location_name}${card.location_type ? ` (${card.location_type})` : ''}` : 'Unassigned Pile'}
                    </strong>
                    {card.location_name && card.compartment_display_label && (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {` • ${card.compartment_display_label}`}
                        {card.position > 0 ? ` • Slot ${Math.floor(card.position / 1000)}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Actions row */}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setMode('edit')}>
                  Edit Card
                </button>
                {onViewStorage && card.list_type !== 'wishlist' && (
                  <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => onViewStorage(card)}>
                    View in Storage
                  </button>
                )}
                <button className="btn btn-danger" style={{ padding: '0 0.75rem' }} onClick={handleDelete} title="Delete">
                  <Trash2 size={16} />
                </button>
              </div>

              {/* Quick toggles row */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {card.list_type === 'wishlist' ? (
                  <button 
                    className="btn btn-primary" 
                    style={{ flex: 1, backgroundColor: 'rgba(74,222,128,0.2)', color: 'var(--type-grass)', border: '1px solid rgba(74,222,128,0.3)' }} 
                    onClick={() => handleQuickToggle('list_type', 'collection')}
                  >
                    Move to Collection
                  </button>
                ) : (
                  <button 
                    className={`btn ${isTrade === 1 ? 'btn-primary' : 'btn-secondary'}`} 
                    style={{ flex: 1, ...(isTrade === 1 ? { backgroundColor: 'rgba(74,222,128,0.2)', color: 'var(--type-grass)', border: '1px solid rgba(74,222,128,0.3)' } : {}) }} 
                    onClick={() => handleQuickToggle('is_trade', isTrade === 1 ? 0 : 1)}
                  >
                    {isTrade === 1 ? 'Remove from Trade' : 'Add to Trade Binder'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default CardInspectorModal;
