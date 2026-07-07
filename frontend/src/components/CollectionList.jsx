import { useState, useEffect, useMemo } from 'react';
import { Search, Trash2, Edit2, LayoutGrid, List } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { formatPrice } from '../utils/formatPrice';
import { CONDITIONS, PRINTINGS } from '../utils/cardOptions';
import { translateJapaneseName } from '../utils/pokemonTranslation';
import { getPrintingBadgeLabel, getPrintingBadgeStyle, getFoilOverlayClass } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import DeckBuilder from './DeckBuilder';
import CardInspectorModal from './CardInspectorModal';

function CollectionList({ statsTrigger, onUpdate, showToast, selectedCardFilter, setSelectedCardFilter }) {
  const [collection, setCollection] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (selectedCardFilter) {
      setSearchFilter(selectedCardFilter);
      // Reset after applying so they can clear search manually
      setSelectedCardFilter('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardFilter]);
  
  // UX view state
  const [viewMode, setViewMode] = useState('gallery'); // 'gallery' or 'list'
  const [inspectorCard, setInspectorCard] = useState(null);
  const [inspectorStartEdit, setInspectorStartEdit] = useState(false);
  const [subTab, setSubTab] = useState('collection'); // 'collection', 'wishlist', 'trade'

  // Search & Filter state
  const [searchFilter, setSearchFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [rarityFilter, setRarityFilter] = useState('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [printingFilter, setPrintingFilter] = useState('');
  const [minPriceFilter, setMinPriceFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  
  // Stacking state
  const [stackCards, setStackCards] = useState(false);
  const [stackByCondition, setStackByCondition] = useState(false);
  const [stackByPrinting, setStackByPrinting] = useState(false);
  
  useEffect(() => {
    fetchCollection();
    fetchLocations();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTrigger, subTab]);

  const fetchCollection = async () => {
    try {
      setLoading(true);
      let url = '/api/collection?list_type=collection';
      if (subTab === 'wishlist') {
        url = '/api/collection?list_type=wishlist';
      } else if (subTab === 'trade') {
        url = '/api/collection?list_type=collection&is_trade=1';
      }

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setCollection(data);
      }
    } catch (err) {
      console.error(err);
      showToast('Error loading collection.');
    } finally {
      setLoading(false);
    }
  };

  const fetchLocations = async () => {
    try {
      const response = await fetch('/api/locations');
      if (response.ok) {
        const data = await response.json();
        setLocations(data);
      }
    } catch (err) {
      console.error('Error fetching locations:', err);
    }
  };

  const handleDelete = async (entryId, cardName) => {
    if (!window.confirm(`Are you sure you want to delete ${cardName} from your collection?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/collection/${entryId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(`${cardName} removed from collection.`);
        onUpdate();
      } else {
        showToast('Failed to delete card.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error connecting to backend.');
    }
  };

  const openEdit = (item) => {
    setInspectorCard(item);
    setInspectorStartEdit(true);
  };

  // Extract unique rarities from collection for filters
  const uniqueRarities = useMemo(
    () => Array.from(new Set(collection.map(item => item.rarity).filter(Boolean))),
    [collection]
  );

  // Filter logic
  const filteredCollection = useMemo(() => {
    const translatedSearch = searchFilter ? (translateJapaneseName(searchFilter) || searchFilter).toLowerCase() : '';
    return collection.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(translatedSearch) ||
                          (item.set_name || '').toLowerCase().includes(translatedSearch) ||
                          (item.number || '').includes(searchFilter);
    const matchesLocation = locationFilter === '' ? true :
                            locationFilter === 'unassigned' ? !item.location_id :
                            item.location_id == locationFilter;
    const matchesRarity = rarityFilter === '' ? true : item.rarity === rarityFilter;
    const matchesCondition = conditionFilter === '' ? true : item.condition === conditionFilter;
    const matchesPrinting = printingFilter === '' ? true : item.printing === printingFilter;

    const price = item.price_trend || 0;
    const matchesMinPrice = minPriceFilter === '' ? true : price >= parseFloat(minPriceFilter);
    const matchesMaxPrice = maxPriceFilter === '' ? true : price <= parseFloat(maxPriceFilter);

    return matchesSearch && matchesLocation && matchesRarity && matchesCondition && matchesPrinting && matchesMinPrice && matchesMaxPrice;
  }).sort((a, b) => {
    if (sortBy === 'name-asc') {
      return a.name.localeCompare(b.name);
    } else if (sortBy === 'name-desc') {
      return b.name.localeCompare(a.name);
    } else if (sortBy === 'price-desc') {
      return (b.price_trend || 0) - (a.price_trend || 0);
    } else if (sortBy === 'price-asc') {
      return (a.price_trend || 0) - (b.price_trend || 0);
    } else if (sortBy === 'qty-desc') {
      return (b.quantity || 0) - (a.quantity || 0);
    } else if (sortBy === 'added-oldest') {
      return new Date(a.added_at || 0) - new Date(b.added_at || 0);
    } else { // 'added-newest'
      return new Date(b.added_at || 0) - new Date(a.added_at || 0);
    }
  });
  }, [collection, searchFilter, locationFilter, rarityFilter, conditionFilter, printingFilter, minPriceFilter, maxPriceFilter, sortBy]);

  // Group duplicate cards if stack option is active
  const processedCollection = useMemo(() => {
    if (!stackCards) return filteredCollection;

    const groups = {};
    filteredCollection.forEach(item => {
      let key = item.card_id;
      if (stackByCondition) key += `-${item.condition}`;
      if (stackByPrinting) key += `-${item.printing}`;

      if (!groups[key]) {
        groups[key] = { ...item };
      } else {
        groups[key].quantity += item.quantity;
      }
    });
    return Object.values(groups);
  }, [filteredCollection, stackCards, stackByCondition, stackByPrinting]);

  return (
    <div>
      {/* Sub Navigation Tabs & View Toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button 
            className={`btn ${subTab === 'collection' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSubTab('collection')}
            style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
          >
            Collection
          </button>
          <button 
            className={`btn ${subTab === 'wishlist' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSubTab('wishlist')}
            style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
          >
            Wishlist
          </button>
          <button 
            className={`btn ${subTab === 'trade' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSubTab('trade')}
            style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
          >
            Trade Binder
          </button>
          <button 
            className={`btn ${subTab === 'deckbuilder' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSubTab('deckbuilder')}
            style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
          >
            Deck Builder
          </button>
        </div>

        {/* View Toggle */}
        <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
          <button 
            className={`btn btn-icon-only ${viewMode === 'gallery' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('gallery')}
            style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
            title="Gallery View"
          >
            <LayoutGrid size={14} />
          </button>
          <button 
            className={`btn btn-icon-only ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('list')}
            style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
            title="List Table View"
          >
            <List size={14} />
          </button>
        </div>
      </div>

      {subTab === 'deckbuilder' ? (
        <DeckBuilder showToast={showToast} />
      ) : (
        <>
          {/* Filter Options Panel */}
          <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1.25rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              
              {/* Row 1: Text Search & Sorting */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>Search Cards</label>
                  <div style={{ position: 'relative' }}>
                    <input 
                      type="text" 
                      className="input-control" 
                      placeholder="Search name, set, card number..." 
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                      style={{ width: '100%', paddingLeft: '2.5rem' }}
                    />
                    <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  </div>
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>Sort By</label>
                  <select className="select-control" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                    <option value="added-newest">Added (Newest)</option>
                    <option value="added-oldest">Added (Oldest)</option>
                    <option value="name-asc">Name (A-Z)</option>
                    <option value="name-desc">Name (Z-A)</option>
                    <option value="price-desc">Price (High to Low)</option>
                    <option value="price-asc">Price (Low to High)</option>
                    <option value="qty-desc">Quantity (High to Low)</option>
                  </select>
                </div>
              </div>

              {/* Row 2: Selector Filters Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '0.75rem' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>Location</label>
                  <select className="select-control" value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
                    <option value="">All Locations</option>
                    <option value="unassigned">Unassigned Pile</option>
                    {locations.map(loc => (
                      <option key={loc.id} value={loc.id}>{loc.name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>Rarity</label>
                  <select className="select-control" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
                    <option value="">All Rarities</option>
                    {uniqueRarities.map(rarity => (
                      <option key={rarity} value={rarity}>{rarity}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>Condition</label>
                  <select className="select-control" value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)}>
                    <option value="">All Conditions</option>
                    {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>Printing</label>
                  <select className="select-control" value={printingFilter} onChange={(e) => setPrintingFilter(e.target.value)}>
                    <option value="">All Printings</option>
                    {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>Min Price</label>
                  <input 
                    type="number" 
                    className="input-control" 
                    placeholder="Min $" 
                    value={minPriceFilter} 
                    onChange={(e) => setMinPriceFilter(e.target.value)} 
                    style={{ padding: '0.4rem 0.5rem' }}
                  />
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>Max Price</label>
                  <input 
                    type="number" 
                    className="input-control" 
                    placeholder="Max $" 
                    value={maxPriceFilter} 
                    onChange={(e) => setMaxPriceFilter(e.target.value)} 
                    style={{ padding: '0.4rem 0.5rem' }}
                  />
                </div>
              </div>

              {/* Row 3: Stacking Options */}
              <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input 
                    type="checkbox" 
                    id="stackCardsOpt" 
                    checked={stackCards} 
                    onChange={(e) => setStackCards(e.target.checked)} 
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  <label htmlFor="stackCardsOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#fff' }}>
                    Stack Duplicate Cards
                  </label>
                </div>

                {stackCards && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input 
                        type="checkbox" 
                        id="stackByConditionOpt" 
                        checked={stackByCondition} 
                        onChange={(e) => setStackByCondition(e.target.checked)} 
                        style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                      />
                      <label htmlFor="stackByConditionOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        Split by Condition
                      </label>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input 
                        type="checkbox" 
                        id="stackByPrintingOpt" 
                        checked={stackByPrinting} 
                        onChange={(e) => setStackByPrinting(e.target.checked)} 
                        style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                      />
                      <label htmlFor="stackByPrintingOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        Split by Holo/Printing
                      </label>
                    </div>
                  </>
                )}
              </div>

            </div>
          </div>

      {/* Database Listing Panel */}
      {loading ? (
        <div className="spinner"></div>
      ) : processedCollection.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          <p>No cards matched your filters. Clear filters or add some cards!</p>
        </div>
      ) : viewMode === 'gallery' ? (
        /* Visual Cards Grid Gallery View */
        <div className="card-grid">
          {processedCollection.map((item) => {
            const rarityStyle = getCardRarityBorder(item.rarity);

            return (
              <div key={item.entry_id} className="tcg-card tilt-card-wrapper" onClick={() => { setInspectorCard(item); setInspectorStartEdit(false); }}>
                <div className="tcg-card-inner" style={rarityStyle}>
                  <img src={item.image_url} alt={item.name} className="tcg-card-image" loading="lazy" />
                  {getFoilOverlayClass(item.printing) && (
                    <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: 'var(--radius-sm)' }} />
                  )}
                  {item.quantity > 1 && (
                    <div className="tcg-card-quantity-tag">x{item.quantity}</div>
                  )}

                  {/* Rarity badge (shared tier system, matches Storage view) */}
                  <span style={{
                    position: 'absolute',
                    top: '6px',
                    left: '6px',
                    fontSize: '0.55rem',
                    fontWeight: 900,
                    padding: '2px 4px',
                    borderRadius: '3px',
                    zIndex: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                    ...getRarityBadgeStyle(item.rarity)
                  }}>
                    {getRarityBadgeLabel(item.rarity)}
                  </span>

                  {/* Overlay Tags */}
                  <div style={{
                    position: 'absolute',
                    bottom: '6px',
                    left: '6px',
                    right: '6px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '4px',
                    pointerEvents: 'none'
                  }}>
                    <span style={{
                      fontSize: '0.6rem',
                      fontWeight: 800,
                      padding: '2px 5px',
                      borderRadius: '3px',
                      background: 'rgba(0, 0, 0, 0.75)',
                      color: '#fff',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      textTransform: 'uppercase'
                    }}>
                      {item.condition === 'Near Mint' ? 'NM' : 
                       item.condition === 'Lightly Played' ? 'LP' : 
                       item.condition === 'Moderately Played' ? 'MP' : 
                       item.condition === 'Heavily Played' ? 'HP' : 'DMG'}
                    </span>
                    {item.printing !== 'Normal' && (
                      <span style={{
                        fontSize: '0.6rem',
                        fontWeight: 800,
                        padding: '2px 5px',
                        borderRadius: '3px',
                        ...getPrintingBadgeStyle(item.printing),
                        border: '1px solid rgba(255, 255, 255, 0.2)'
                      }}>
                        {getPrintingBadgeLabel(item.printing)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="tcg-card-info">
                  <div className="tcg-card-name">{getCardDisplayName(item.name, item.language)}</div>
                  <div className="tcg-card-meta">
                    <span style={{ fontSize: '0.7rem' }}>{item.set_name} • #{item.number}</span>
                    <span className="tcg-card-price">${formatPrice(item.price_trend)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Traditional List Table View */
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowY: 'auto' }}>
            <table className="collection-table" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th>Card</th>
                  <th style={{ width: '70px', textAlign: 'right' }}>Qty / Value</th>
                </tr>
              </thead>
              <tbody>
                {processedCollection.map((item) => (
                  <tr key={item.entry_id}>
                    <td>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <div style={{ position: 'relative', width: '36px', height: '50px', flexShrink: 0, overflow: 'hidden', borderRadius: '4px', ...getCardRarityBorder(item.rarity) }}>
                          <img src={item.image_url} alt={item.name} className="collection-row-thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} />
                          {getFoilOverlayClass(item.printing) && (
                            <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: '4px' }} />
                          )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getCardDisplayName(item.name, item.language)}</div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <span>{item.set_name} • #{item.number}</span>
                            <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 3px', borderRadius: '3px', flexShrink: 0, ...getRarityBadgeStyle(item.rarity) }}>
                              {getRarityBadgeLabel(item.rarity)}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                            {item.printing} • {item.condition}
                          </div>
                          <div style={{ display: 'flex', gap: '0.35rem', marginTop: '2px' }}>
                            <button className="btn btn-secondary btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => openEdit(item)} title="Edit">
                              <Edit2 size={9} />
                            </button>
                            <button className="btn btn-danger btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => handleDelete(item.entry_id, item.name)} title="Delete">
                              <Trash2 size={9} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', verticalAlign: 'top', paddingTop: '0.6rem' }}>
                      {item.quantity > 1 && (
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>x{item.quantity}</div>
                      )}
                      <div style={{ fontSize: '0.7rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>${formatPrice(item.price_trend)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Card Detail Inspector Modal (Private Authorized View) */}
      <CardInspectorModal
        card={inspectorCard}
        startInEdit={inspectorStartEdit}
        onClose={() => { setInspectorCard(null); setInspectorStartEdit(false); }}
        onUpdate={onUpdate}
        showToast={showToast}
      />
    </>
  )}
</div>
  );
}

export default CollectionList;
