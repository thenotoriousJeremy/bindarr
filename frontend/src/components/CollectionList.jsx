import React, { useState, useEffect, useMemo } from 'react';
import { Search, Download, Trash2, Edit2, X, MapPin, LayoutGrid, List, Database, Upload, ChevronDown } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { formatPrice } from '../utils/formatPrice';
import { CONDITIONS, PRINTINGS, LANGUAGES } from '../utils/cardOptions';
import { getPrintingBadgeLabel, getPrintingBadgeStyle, getFoilOverlayClass } from '../utils/cardPrinting';
import PriceHistoryChart from './PriceHistoryChart';
import DeckBuilder from './DeckBuilder';

function CollectionList({ statsTrigger, onUpdate, showToast, token, selectedCardFilter, setSelectedCardFilter }) {
  const [collection, setCollection] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (selectedCardFilter) {
      setSearchFilter(selectedCardFilter);
      // Reset after applying so they can clear search manually
      setSelectedCardFilter('');
    }
  }, [selectedCardFilter]);
  
  // UX view state
  const [viewMode, setViewMode] = useState('gallery'); // 'gallery' or 'list'
  const [inspectorCard, setInspectorCard] = useState(null);
  const [subTab, setSubTab] = useState('collection'); // 'collection', 'wishlist', 'trade'
  const [priceHistory, setPriceHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  
  // Search & Filter state
  const [searchFilter, setSearchFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [rarityFilter, setRarityFilter] = useState('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [printingFilter, setPrintingFilter] = useState('');
  const [minPriceFilter, setMinPriceFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  
  // Edit Modal State
  const [editingItem, setEditingItem] = useState(null);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editQuantity, setEditQuantity] = useState(1);
  const [editCondition, setEditCondition] = useState('Near Mint');
  const [editPrinting, setEditPrinting] = useState('Normal');
  const [editLanguage, setEditLanguage] = useState('English');
  const [editPurchasePrice, setEditPurchasePrice] = useState(0);
  const [editLocationId, setEditLocationId] = useState('');
  const [editSubLocation1, setEditSubLocation1] = useState('');
  const [editSubLocation2, setEditSubLocation2] = useState('');
  const [editIsTrade, setEditIsTrade] = useState(0);
  const [editListType, setEditListType] = useState('collection');
  const [showDataMenu, setShowDataMenu] = useState(false);

  const handleImportFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    const isJson = file.name.endsWith('.json');
    const format = isJson ? 'json' : 'csv';

    reader.onload = async (event) => {
      try {
        const fileData = event.target.result;
        showToast('Importing collection...');
        const response = await fetch('/api/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            format,
            data: fileData
          })
        });

        const result = await response.json();
        if (response.ok) {
          showToast(result.message || 'Import successful!');
          fetchCollection();
          if (onUpdate) onUpdate();
        } else {
          showToast(`Import failed: ${result.error || 'Unknown error'}`);
        }
      } catch (err) {
        console.error(err);
        showToast(`Import failed: ${err.message}`);
      }
    };

    reader.readAsText(file);
    e.target.value = null;
  };

  useEffect(() => {
    fetchCollection();
    fetchLocations();
  }, [statsTrigger, subTab]);

  useEffect(() => {
    if (inspectorCard) {
      fetchPriceHistory(inspectorCard.card_id);
    } else {
      setPriceHistory([]);
    }
  }, [inspectorCard]);

  const fetchPriceHistory = async (cardId) => {
    try {
      setLoadingHistory(true);
      const response = await fetch(`/api/cards/${cardId}/price-history`);
      if (response.ok) {
        const data = await response.json();
        setPriceHistory(data);
      }
    } catch (err) {
      console.error('Error fetching price history:', err);
    } finally {
      setLoadingHistory(false);
    }
  };

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
    setEditingItem(item);
    setEditQuantity(item.quantity);
    setEditCondition(item.condition);
    setEditPrinting(item.printing);
    setEditLanguage(item.language);
    setEditPurchasePrice(item.purchase_price || 0);
    setEditLocationId(item.location_id || '');
    setEditSubLocation1(item.sub_location_1 || '');
    setEditSubLocation2(item.sub_location_2 || '');
    setEditIsTrade(item.is_trade || 0);
    setEditListType(item.list_type || 'collection');
    setIsEditOpen(true);
  };

  const closeEdit = () => {
    setIsEditOpen(false);
    setEditingItem(null);
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingItem) return;

    try {
      const response = await fetch(`/api/collection/${editingItem.entry_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: parseInt(editQuantity, 10),
          condition: editCondition,
          printing: editPrinting,
          language: editLanguage,
          purchase_price: parseFloat(editPurchasePrice) || 0,
          location_id: editLocationId ? parseInt(editLocationId, 10) : null,
          sub_location_1: editSubLocation1,
          sub_location_2: editSubLocation2,
          list_type: editListType,
          is_trade: editIsTrade
        })
      });

      if (response.ok) {
        showToast('Card entry updated.');
        onUpdate();
        closeEdit();
      } else {
        showToast('Failed to update card.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error editing card.');
    }
  };

  // Extract unique rarities from collection for filters
  const uniqueRarities = useMemo(
    () => Array.from(new Set(collection.map(item => item.rarity).filter(Boolean))),
    [collection]
  );

  // Filter logic
  const filteredCollection = useMemo(() => collection.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
                          (item.set_name || '').toLowerCase().includes(searchFilter.toLowerCase()) ||
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
  }), [collection, searchFilter, locationFilter, rarityFilter, conditionFilter, printingFilter, minPriceFilter, maxPriceFilter, sortBy]);

  const selectedLoc = locations.find(l => l.id == editLocationId);
  const isBinder = selectedLoc ? selectedLoc.type === 'Binder' : false;
  const isBox = selectedLoc ? selectedLoc.type === 'Box' : false;

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

            </div>
          </div>

      {/* Database Listing Panel */}
      {loading ? (
        <div className="spinner"></div>
      ) : filteredCollection.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          <p>No cards matched your filters. Clear filters or add some cards!</p>
        </div>
      ) : viewMode === 'gallery' ? (
        /* Visual Cards Grid Gallery View */
        <div className="card-grid">
          {filteredCollection.map((item) => {
            const rarity = (item.rarity || '').toLowerCase();
            const isUltra = rarity.includes('rare') || rarity.includes('secret') || rarity.includes('promo') || rarity.includes('ultra');
            const glowClass = isUltra ? 'rarity-glow-ultra' : '';

            return (
              <div key={item.entry_id} className="tcg-card tilt-card-wrapper" onClick={() => setInspectorCard(item)}>
                <div className={`tcg-card-inner ${glowClass}`}>
                  <img src={item.image_url} alt={item.name} className="tcg-card-image" loading="lazy" />
                  {getFoilOverlayClass(item.printing) && (
                    <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: 'var(--radius-sm)' }} />
                  )}
                  <div className="tcg-card-quantity-tag">x{item.quantity}</div>
                  
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
                {filteredCollection.map((item) => (
                  <tr key={item.entry_id}>
                    <td>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <div style={{ position: 'relative', width: '36px', height: '50px', flexShrink: 0, overflow: 'hidden', borderRadius: '4px' }}>
                          <img src={item.image_url} alt={item.name} className="collection-row-thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} />
                          {getFoilOverlayClass(item.printing) && (
                            <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: '4px' }} />
                          )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getCardDisplayName(item.name, item.language)}</div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {item.set_name} • #{item.number} • {item.rarity}
                          </div>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                            {item.printing}{item.printing !== 'Normal' ? '' : ''} • {item.condition}
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
                      <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>x{item.quantity}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>${formatPrice(item.price_trend)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Drawer Overlay for Editing Collection Item */}
      <div className={`drawer-backdrop ${isEditOpen ? 'open' : ''}`} onClick={closeEdit}></div>
      <div className={`quick-add-drawer ${isEditOpen ? 'open' : ''}`}>
        {editingItem && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ color: '#fff', fontSize: '1.25rem' }}>Edit Collection Card</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{editingItem.name} ({editingItem.set_name} • #{editingItem.number})</p>
              </div>
              <button className="btn btn-secondary btn-icon-only" onClick={closeEdit} style={{ borderRadius: '50%' }}>
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleEditSubmit}>
              {editListType === 'wishlist' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(74,222,128,0.1)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(74,222,128,0.2)', marginBottom: '1.25rem' }}>
                  <input 
                    type="checkbox" 
                    checked={editListType === 'collection'} 
                    onChange={(e) => setEditListType(e.target.checked ? 'collection' : 'wishlist')} 
                    id="markOwnedCheckbox"
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  <label htmlFor="markOwnedCheckbox" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: 'var(--type-grass)', fontSize: '0.85rem' }}>
                    Mark as Obtained (Move to Collection)
                  </label>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginBottom: '1.25rem' }}>
                  <input 
                    type="checkbox" 
                    checked={editIsTrade === 1} 
                    onChange={(e) => setEditIsTrade(e.target.checked ? 1 : 0)} 
                    id="isTradeCheckbox"
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  <label htmlFor="isTradeCheckbox" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>
                    Listed in Trade Binder
                  </label>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                <div className="form-group">
                  <label>Quantity</label>
                  <input 
                    type="number" 
                    className="input-control" 
                    min="1" 
                    value={editQuantity}
                    onChange={(e) => setEditQuantity(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Purchase Price ($)</label>
                  <input 
                    type="number" 
                    step="0.01" 
                    className="input-control" 
                    value={editPurchasePrice}
                    onChange={(e) => setEditPurchasePrice(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
                <div className="form-group">
                  <label>Condition</label>
                  <select className="select-control" value={editCondition} onChange={(e) => setEditCondition(e.target.value)}>
                    {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                <div className="form-group">
                  <label>Printing</label>
                  <select className="select-control" value={editPrinting} onChange={(e) => setEditPrinting(e.target.value)}>
                    {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>

                <div className="form-group">
                  <label>Language</label>
                  <select className="select-control" value={editLanguage} onChange={(e) => setEditLanguage(e.target.value)}>
                    {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              </div>

              <div className="glass-panel" style={{ padding: '1rem', marginTop: '0.5rem', marginBottom: '1.25rem', background: 'rgba(0,0,0,0.2)' }}>
                <h4 style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Real-World Location Assignment</h4>
                
                <div className="form-group">
                  <label>Storage Container</label>
                  <select className="select-control" value={editLocationId} onChange={(e) => {
                    setEditLocationId(e.target.value);
                    setEditSubLocation1('');
                    setEditSubLocation2('');
                  }}>
                    <option value="">Unassigned Pile</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                    ))}
                  </select>
                </div>

                {editLocationId && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', marginTop: '0.75rem' }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>{isBinder ? 'Page Number' : isBox ? 'Row Number / Letter' : 'Sub-Location 1'}</label>
                      <input 
                        type="text" 
                        className="input-control" 
                        placeholder={isBinder ? 'e.g. Page 12' : isBox ? 'e.g. Row 2' : 'e.g. Top shelf'} 
                        value={editSubLocation1}
                        onChange={(e) => setEditSubLocation1(e.target.value)}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>{isBinder ? 'Slot Number (1-9)' : isBox ? 'Divider / Section' : 'Sub-Location 2'}</label>
                      <input 
                        type="text" 
                        className="input-control" 
                        placeholder={isBinder ? 'e.g. Slot 4' : isBox ? 'e.g. Behind Grass Divider' : 'e.g. Box A'} 
                        value={editSubLocation2}
                        onChange={(e) => setEditSubLocation2(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={closeEdit} style={{ flex: 1 }}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>Save Changes</button>
              </div>
            </form>
          </div>
        )}
      </div>
      {/* Card Detail Inspector Modal (Private Authorized View) */}
      {inspectorCard && (
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
        }} onClick={() => setInspectorCard(null)}>
          <div className="glass-panel" style={{
            maxWidth: '720px',
            width: '100%',
            padding: '2.5rem',
            display: 'flex',
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: '2.5rem',
            position: 'relative',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 20px 50px rgba(0,0,0,0.6)'
          }} onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setInspectorCard(null)} style={{
              position: 'absolute',
              top: '1rem',
              right: '1rem',
              borderRadius: '50%'
            }}>
              <X size={16} />
            </button>

            {/* Left side: Card Image & Badge overlays */}
            <div style={{ flex: '1 1 250px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
              <div style={{ position: 'relative', width: '100%', maxWidth: '280px' }}>
                <img 
                  src={inspectorCard.image_url} 
                  alt={inspectorCard.name} 
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
                  Owned: x{inspectorCard.quantity}
                </span>
                <span className="badge" style={{ padding: '0.4rem 0.8rem', background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.2)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-yellow)', fontSize: '0.75rem', fontWeight: 700 }}>
                  {inspectorCard.rarity || 'Common'}
                </span>
              </div>
            </div>

            {/* Right side: Information */}
            <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1.25rem', justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                  {inspectorCard.list_type === 'wishlist' && (
                    <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4', border: '1px solid rgba(6, 182, 212, 0.3)' }}>
                      Wishlist Item
                    </span>
                  )}
                  {inspectorCard.is_trade === 1 && (
                    <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(74, 222, 128, 0.15)', color: 'var(--type-grass)', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                      For Trade
                    </span>
                  )}
                </div>

                <h3 style={{ fontSize: '1.65rem', color: '#fff', fontWeight: 800, lineHeight: 1.15, marginBottom: '0.25rem' }}>
                  {getCardDisplayName(inspectorCard.name, inspectorCard.language)}
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>{inspectorCard.set_name} • Card #{inspectorCard.number}</p>
              </div>

              {/* Price Panel */}
              <div style={{ borderTop: '1px solid var(--border-glass)', borderBottom: '1px solid var(--border-glass)', padding: '0.75rem 0', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>TCG MARKET PRICE</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-yellow)', marginTop: '0.15rem' }}>
                    ${formatPrice(inspectorCard.price_trend)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>EST. PURCHASE VALUE</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', marginTop: '0.15rem' }}>
                    ${formatPrice(inspectorCard.purchase_price)}
                  </div>
                </div>
              </div>

              {/* Price History Area Chart */}
              <PriceHistoryChart data={priceHistory} loading={loadingHistory} />

              {/* Specifications Details Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem 1rem', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-glass)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                <div><span style={{ color: 'var(--text-muted)' }}>Condition:</span> <span style={{ color: '#fff', fontWeight: 600 }}>{inspectorCard.condition}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Printing:</span> <span style={{ color: '#fff', fontWeight: 600 }}>{inspectorCard.printing}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Language:</span> <span style={{ color: '#fff', fontWeight: 600 }}>{inspectorCard.language}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Supertype:</span> <span style={{ color: '#fff', fontWeight: 600 }}>{inspectorCard.supertype}</span></div>
              </div>

              {/* Storage Container details */}
              {inspectorCard.list_type !== 'wishlist' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255, 71, 71, 0.02)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', fontSize: '0.75rem' }}>
                  <MapPin size={14} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Location: </span>
                    <strong style={{ color: '#fff' }}>
                      {inspectorCard.location_name ? `${inspectorCard.location_name} (${inspectorCard.location_type})` : 'Unassigned Pile'}
                    </strong>
                    {inspectorCard.location_name && (inspectorCard.sub_location_1 || inspectorCard.sub_location_2) && (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {` • ${inspectorCard.location_type === 'Binder' ? 'Page' : 'Row'} ${inspectorCard.sub_location_1 || '?'}`}
                        {inspectorCard.sub_location_2 ? ` / Slot ${inspectorCard.sub_location_2}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Actions row inside modal */}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                {inspectorCard.list_type === 'wishlist' && (
                  <button 
                    className="btn btn-primary" 
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                    onClick={() => {
                      openEdit(inspectorCard);
                      setEditListType('collection');
                      setInspectorCard(null);
                    }}
                  >
                    Move to Collection
                  </button>
                )}
                <button 
                  className="btn btn-secondary" 
                  style={{ flex: 1 }}
                  onClick={() => {
                    openEdit(inspectorCard);
                    setInspectorCard(null);
                  }}
                >
                  Edit Card
                </button>
                <button 
                  className="btn btn-danger" 
                  style={{ flex: 1 }}
                  onClick={() => {
                    handleDelete(inspectorCard.entry_id, inspectorCard.name);
                    setInspectorCard(null);
                  }}
                >
                  Delete
                </button>
              </div>

            </div>
          </div>
        </div>
      )}
    </>
  )}
</div>
  );
}

export default CollectionList;
