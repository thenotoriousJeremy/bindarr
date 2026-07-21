import { useState, useEffect, useRef } from 'react';
import { X, MapPin, Trash2, Star, Maximize2, ExternalLink } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { formatPrice } from '../utils/formatPrice';
import { tcgplayerUrl, cardmarketUrl } from '../utils/marketplaceLinks';
import CardEntryFields from './CardEntryFields';
import PriceHistoryChart from './PriceHistoryChart';
import AddToDeckSelect from './AddToDeckSelect';
import { useBackGuard } from '../utils/useBackGuard';

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
function CardInspectorModal({ card, onClose, onUpdate, onDeleted, showToast, onViewStorage, startInEdit = false }) {
  const [mode, setMode] = useState('view');
  const [locations, setLocations] = useState([]);
  const [q, setQ] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [locationId, setLocationId] = useState('');
  const [isTrade, setIsTrade] = useState(0);
  const [favorite, setFavorite] = useState(0);
  const [listType, setListType] = useState('collection');
  const [notes, setNotes] = useState('');
  const [isFullScreen, setIsFullScreen] = useState(false);
  const hasToggledRef = useRef(false);

  useBackGuard(isFullScreen, () => setIsFullScreen(false));

  const targetEntryId = card?.entry_id || card?.id;

  useEffect(() => {
    fetch('/api/locations')
      .then(r => r.ok ? r.json() : [])
      .then(setLocations)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!card) return;
    hasToggledRef.current = false;
    setMode(startInEdit ? 'edit' : 'view');
    setQ(card.quantity ?? 1);
    setCondition(card.condition || 'Near Mint');
    setPrinting(card.printing || 'Normal');
    setLanguage(card.language || 'English');
    setPurchasePrice(card.purchase_price || 0);
    setLocationId(card.location_id || '');
    setIsTrade(card.is_trade ? 1 : 0);
    setFavorite(card.favorite ? 1 : 0);
    setListType(card.list_type || 'collection');
    setNotes(card.notes || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset form only when the entry changes, not on every card mutation
  }, [targetEntryId, startInEdit]);

  const handleClose = () => {
    if (hasToggledRef.current && onUpdate) {
      onUpdate();
    }
    onClose && onClose();
  };

  useBackGuard(!!card, handleClose);

  if (!card) return null;

  const handleSave = async (e) => {
    e.preventDefault();
    if (!targetEntryId) return;
    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, {
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
          is_trade: isTrade ? 1 : 0,
          favorite: favorite ? 1 : 0,
          notes
        })
      });
      if (res.ok) {
        card.quantity = parseInt(q, 10);
        card.condition = condition;
        card.printing = printing;
        card.language = language;
        card.purchase_price = parseFloat(purchasePrice) || 0;
        card.location_id = locationId ? parseInt(locationId, 10) : null;
        card.list_type = listType;
        card.is_trade = isTrade ? 1 : 0;
        card.favorite = favorite ? 1 : 0;
        card.notes = notes;
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
    if (!targetEntryId) return;
    const nextFavorite = field === 'favorite' ? (value ? 1 : 0) : (favorite ? 1 : 0);
    const nextIsTrade = field === 'is_trade' ? (value ? 1 : 0) : (isTrade ? 1 : 0);
    const nextListType = field === 'list_type' ? value : listType;

    // Optimistic UI & prop object updates
    if (field === 'is_trade') { setIsTrade(nextIsTrade); card.is_trade = nextIsTrade; }
    if (field === 'favorite') { setFavorite(nextFavorite); card.favorite = nextFavorite; }
    if (field === 'list_type') { setListType(nextListType); card.list_type = nextListType; }

    const payload = {
      quantity: parseInt(q, 10),
      condition,
      printing,
      language,
      purchase_price: parseFloat(purchasePrice) || 0,
      location_id: locationId ? parseInt(locationId, 10) : null,
      list_type: nextListType,
      is_trade: nextIsTrade,
      favorite: nextFavorite
    };

    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        hasToggledRef.current = true;
        showToast && showToast('Card updated.');
      } else {
        // revert on fail
        if (field === 'is_trade') { setIsTrade(isTrade); card.is_trade = isTrade; }
        if (field === 'favorite') { setFavorite(favorite); card.favorite = favorite; }
        if (field === 'list_type') { setListType(listType); card.list_type = listType; }
        showToast && showToast('Failed to update card.');
      }
    } catch (err) {
      console.error(err);
      if (field === 'is_trade') { setIsTrade(isTrade); card.is_trade = isTrade; }
      if (field === 'favorite') { setFavorite(favorite); card.favorite = favorite; }
      if (field === 'list_type') { setListType(listType); card.list_type = listType; }
      showToast && showToast('Error updating card.');
    }
  };

  const handleAddToDeck = async (deckId) => {
    if (!targetEntryId || !deckId) return;
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: [targetEntryId], action: 'add_to_deck', value: deckId })
      });
      const data = await res.json().catch(() => ({}));
      showToast && showToast(res.ok ? (data.message || 'Added to deck.') : (data.error || 'Failed to add to deck.'));
    } catch (err) {
      console.error(err);
      showToast && showToast('Error adding to deck.');
    }
  };

  const handleDelete = async () => {
    if (!targetEntryId) return;
    if (!window.confirm(`Are you sure you want to delete ${card.name} from your collection?`)) return;
    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast && showToast(`${card.name} removed from collection.`);
        onDeleted && onDeleted(targetEntryId);
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

  const cardNumber = card.number || card.collector_number || card.card_number || '';

  return (
    <div className="modal-overlay" style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 999
    }} onClick={handleClose}>
      <div className="glass-panel card-inspector" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-secondary btn-icon-only" onClick={handleClose} style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
          borderRadius: '50%',
          zIndex: 10
        }}>
          <X size={16} />
        </button>

        {/* Left side: Main Card Image Focus */}
        <div className="ci-image-col" style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div
            className="ci-image-wrap"
            onClick={() => setIsFullScreen(true)}
            title="Click to view full screen"
            style={{ position: 'relative', width: '100%', maxWidth: '300px', cursor: 'pointer' }}
          >
            <img
              src={card.image_url}
              alt={card.name}
              style={{
                width: '100%',
                aspectRatio: 0.718,
                objectFit: 'cover',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 0 20px rgba(255,255,255,0.05)',
                transition: 'transform 0.2s ease'
              }}
            />
            <div style={{
              position: 'absolute',
              bottom: '0.6rem',
              right: '0.6rem',
              background: 'rgba(0,0,0,0.65)',
              backdropFilter: 'blur(6px)',
              padding: '0.25rem 0.5rem',
              borderRadius: 'var(--radius-sm)',
              color: '#fff',
              fontSize: '0.65rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              pointerEvents: 'none',
              border: '1px solid rgba(255,255,255,0.15)'
            }}>
              <Maximize2 size={12} />
              <span>Full Screen</span>
            </div>
          </div>
        </div>

        {/* Right side: Information / Edit */}
        <div className="ci-info-col" style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1.25rem', justifyContent: 'space-between' }}>
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

            <h3 style={{ fontSize: '1.65rem', color: 'var(--text-strong)', fontWeight: 800, lineHeight: 1.15, marginBottom: '0.25rem' }}>
              {getCardDisplayName(card.name, card.language)}
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>
              {card.set_name}{cardNumber ? ` • #${cardNumber}` : ''}{card.rarity ? ` • ${card.rarity}` : ''} • x{card.quantity ?? 1} owned
            </p>

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
                  <label htmlFor="isTrade" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.85rem' }}>
                    Listed in Trade Binder
                  </label>
                </div>
              )}

              <CardEntryFields
                quantity={q} purchasePrice={purchasePrice} condition={condition} printing={printing} language={language}
                onQuantity={setQ} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting} onLanguage={setLanguage}
              />

              <div className="form-group">
                <label>Storage Container</label>
                <select className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Unassigned Pile</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Notes</label>
                <textarea
                  className="input-control"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Provenance, condition details, trade plans..."
                  rows={3}
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
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
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-strong)', marginTop: '0.15rem' }}>
                    ${formatPrice(card.purchase_price)}
                  </div>
                </div>
              </div>

              {/* Marketplace links — where the price is sourced */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <a
                  href={tcgplayerUrl(card)} target="_blank" rel="noopener noreferrer"
                  className="btn btn-secondary"
                  style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                >
                  <ExternalLink size={13} /> View on TCGplayer
                </a>
                <a
                  href={cardmarketUrl(card)} target="_blank" rel="noopener noreferrer"
                  className="btn btn-secondary"
                  style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                >
                  <ExternalLink size={13} /> Cardmarket
                </a>
              </div>

              {/* Price History Area Chart */}
              <PriceHistoryChart cardId={card.card_id} height={100} defaultRange="1y" />

              {/* Specifications Details Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem 1rem', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-glass)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                <div><span style={{ color: 'var(--text-muted)' }}>Condition:</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{card.condition}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Printing:</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{card.printing}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Language:</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{card.language}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Supertype:</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{card.supertype}</span></div>
              </div>

              {/* Storage Container details (clickable to view in storage) */}
              {card.list_type !== 'wishlist' && (
                <div 
                  onClick={() => onViewStorage && card.list_type !== 'wishlist' && onViewStorage(card)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    background: 'rgba(255, 71, 71, 0.03)', padding: '0.65rem 0.75rem',
                    borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)',
                    fontSize: '0.75rem', cursor: onViewStorage ? 'pointer' : 'default',
                    transition: 'background 0.2s'
                  }}
                  title={onViewStorage ? 'Click to view in storage' : undefined}
                >
                  <MapPin size={14} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Location: </span>
                    <strong style={{ color: 'var(--text-strong)' }}>
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

              {card.notes && (
                <div style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {card.notes}
                </div>
              )}

              {/* Main Actions Row: Edit Card + Icon buttons for Favorite & Delete */}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setMode('edit')}>
                  Edit Card
                </button>

                <AddToDeckSelect
                  onAdd={handleAddToDeck}
                  placeholder="+ Add to Deck…"
                  style={{ fontSize: '0.8rem', padding: '0.45rem 0.5rem', maxWidth: '140px' }}
                />

                {card.list_type === 'wishlist' && (
                  <button 
                    className="btn btn-secondary" 
                    style={{ backgroundColor: 'rgba(74,222,128,0.2)', color: 'var(--type-grass)', border: '1px solid rgba(74,222,128,0.3)', padding: '0 0.75rem', fontSize: '0.8rem' }} 
                    onClick={() => handleQuickToggle('list_type', 'collection')}
                    title="Move to Collection"
                  >
                    Obtained
                  </button>
                )}

                <button
                  type="button"
                  className={`btn ${favorite === 1 ? 'btn-primary' : 'btn-secondary'} btn-icon-only`}
                  style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem', ...(favorite === 1 ? { backgroundColor: 'rgba(250,204,21,0.2)', color: '#facc15', border: '1px solid rgba(250,204,21,0.3)' } : {}) }}
                  onClick={() => handleQuickToggle('favorite', favorite === 1 ? 0 : 1)}
                  title={favorite === 1 ? 'Remove Favorite' : 'Mark as Favorite'}
                >
                  <Star size={16} fill={favorite === 1 ? '#facc15' : 'none'} />
                </button>

                <button
                  type="button"
                  className="btn btn-danger btn-icon-only"
                  style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem' }}
                  onClick={handleDelete}
                  title="Delete Card"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Fullscreen Image Preview. stopPropagation on every click so closing the
          zoom returns to the inspector instead of bubbling to the overlay's
          handleClose (which would dismiss the whole popup). */}
      {isFullScreen && (
        <div
          className="modal-overlay"
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            backdropFilter: 'blur(12px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            cursor: 'zoom-out',
            padding: 'max(1rem, max(env(safe-area-inset-top, 0px), var(--sat, 0px))) 1rem max(1rem, max(env(safe-area-inset-bottom, 0px), var(--sab, 0px))) 1rem'
          }}
          onClick={(e) => { e.stopPropagation(); setIsFullScreen(false); }}
        >
          <button
            className="btn btn-secondary btn-icon-only"
            onClick={(e) => { e.stopPropagation(); setIsFullScreen(false); }}
            style={{
              position: 'absolute',
              top: 'max(1rem, max(env(safe-area-inset-top, 0px), var(--sat, 0px)))',
              right: '1rem',
              borderRadius: '50%',
              zIndex: 10,
              background: 'rgba(0,0,0,0.6)',
              color: '#fff'
            }}
          >
            <X size={20} />
          </button>
          <img
            src={card.image_url}
            alt={card.name}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxHeight: '88vh',
              maxWidth: '88vw',
              objectFit: 'contain',
              /* No border-radius: the card art already has its own rounded
                 corners, so a CSS radius here clips them. drop-shadow follows
                 the image's own shape instead of a rounded box. */
              filter: 'drop-shadow(0 20px 60px rgba(0,0,0,0.8))'
            }}
          />
        </div>
      )}
    </div>
  );
}

export default CardInspectorModal;
