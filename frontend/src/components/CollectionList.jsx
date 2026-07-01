import React, { useState, useEffect } from 'react';
import { Search, Download, Trash2, Edit2, X, MapPin, LayoutGrid, List } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { getCardDisplayName } from '../utils/langHelper';
import DeckBuilder from './DeckBuilder';
import LocationManager from './LocationManager';

function CollectionList({ statsTrigger, onUpdate, showToast, token }) {
  const [collection, setCollection] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  
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
  const uniqueRarities = Array.from(new Set(collection.map(item => item.rarity).filter(Boolean)));

  // Filter logic
  const filteredCollection = collection.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchFilter.toLowerCase()) || 
                          (item.set_name || '').toLowerCase().includes(searchFilter.toLowerCase()) ||
                          (item.number || '').includes(searchFilter);
    const matchesLocation = locationFilter === '' ? true : 
                            locationFilter === 'unassigned' ? !item.location_id : 
                            item.location_id == locationFilter;
    const matchesRarity = rarityFilter === '' ? true : item.rarity === rarityFilter;
    const matchesCondition = conditionFilter === '' ? true : item.condition === conditionFilter;

    return matchesSearch && matchesLocation && matchesRarity && matchesCondition;
  });

  const selectedLoc = locations.find(l => l.id == editLocationId);
  const isBinder = selectedLoc ? selectedLoc.type === 'Binder' : false;
  const isBox = selectedLoc ? selectedLoc.type === 'Box' : false;

  return (
    <div>
      {/* Title & Exports Bar */}
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', color: '#fff' }}>My Pokémon Card Collection</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Browse, edit, and filter your physical and digital card list.</p>
        </div>
        
        {/* Toggle & Export buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
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

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <a href={`/api/export?format=csv&token=${token}`} download className="btn btn-secondary" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <Download size={14} />
              Export CSV
            </a>
            <a href={`/api/export?format=json&token=${token}`} download className="btn btn-secondary" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <Download size={14} />
              Export JSON
            </a>
          </div>
        </div>
      </div>

      {/* Sub Navigation Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem', flexWrap: 'wrap' }}>
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
        <button 
          className={`btn ${subTab === 'locations' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setSubTab('locations')}
          style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
        >
          Storage Locations
        </button>
      </div>

      {subTab === 'deckbuilder' ? (
        <DeckBuilder showToast={showToast} />
      ) : subTab === 'locations' ? (
        <LocationManager statsTrigger={statsTrigger} onUpdate={onUpdate} showToast={showToast} />
      ) : (
        <>
          {/* Filter Options Panel */}
          <div className="glass-panel" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
          
          {/* Text Search */}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Search Cards</label>
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

          {/* Selector Filters Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Location</label>
              <select className="select-control" value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
                <option value="">All Locations</option>
                <option value="unassigned">Unassigned Pile</option>
                {locations.map(loc => (
                  <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Rarity</label>
              <select className="select-control" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
                <option value="">All Rarities</option>
                {uniqueRarities.map(rarity => (
                  <option key={rarity} value={rarity}>{rarity}</option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Condition</label>
              <select className="select-control" value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)}>
                <option value="">All Conditions</option>
                <option value="Near Mint">Near Mint</option>
                <option value="Lightly Played">Lightly Played</option>
                <option value="Moderately Played">Moderately Played</option>
                <option value="Heavily Played">Heavily Played</option>
                <option value="Damaged">Damaged</option>
              </select>
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
              <div key={item.entry_id} className="tcg-card" onClick={() => setInspectorCard(item)}>
                <div className={`tcg-card-inner ${glowClass}`}>
                  <img src={item.image_url} alt={item.name} className="tcg-card-image" loading="lazy" />
                  <div className="tcg-card-quantity-tag">x{item.quantity}</div>
                </div>
                <div className="tcg-card-info">
                  <div className="tcg-card-name">{getCardDisplayName(item.name, item.language)}</div>
                  <div className="tcg-card-meta">
                    <span style={{ fontSize: '0.7rem' }}>{item.set_name} • #{item.number}</span>
                    <span className="tcg-card-price">${item.price_trend ? item.price_trend.toFixed(2) : '0.00'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Traditional List Table View */
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="collection-table-wrapper">
            <table className="collection-table">
              <thead>
                <tr>
                  <th>Card Name / Set</th>
                  <th>Real-World Location</th>
                  <th>Condition / Printing</th>
                  <th>Qty</th>
                  <th>Valuation (Each)</th>
                  <th>Total Spent</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredCollection.map((item) => (
                  <tr key={item.entry_id}>
                    <td>
                      <div className="collection-card-row-info">
                        <img src={item.image_url} alt={item.name} className="collection-row-thumbnail" />
                        <div>
                          <div style={{ fontWeight: 700, color: '#fff' }}>{getCardDisplayName(item.name, item.language)}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            {item.set_name} • #{item.number} • {item.rarity}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {item.location_name ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                          <span style={{ fontWeight: 600, color: '#fff', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <MapPin size={12} style={{ color: 'var(--accent-red)' }} />
                            {item.location_name}
                          </span>
                          {(item.sub_location_1 || item.sub_location_2) && (
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', paddingLeft: '1rem' }}>
                              {item.location_type === 'Binder' ? 'Page' : item.location_type === 'Box' ? 'Row' : ''} {item.sub_location_1 || '?'}{' '}
                              {item.sub_location_2 ? `• Slot/Section: ${item.sub_location_2}` : ''}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Unassigned Pile</span>
                      )}
                    </td>
                    <td>
                      <div style={{ fontSize: '0.85rem', color: '#fff' }}>{item.condition}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{item.printing} • {item.language}</div>
                    </td>
                    <td style={{ fontWeight: 700 }}>x{item.quantity}</td>
                    <td>
                      <div style={{ fontWeight: 700, color: 'var(--accent-yellow)' }}>${(item.price_trend || 0).toFixed(2)}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Market Price</div>
                    </td>
                    <td style={{ fontSize: '0.9rem' }}>
                      ${((item.purchase_price || 0) * item.quantity).toFixed(2)}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.35rem' }}>
                        <button className="btn btn-secondary btn-icon-only" onClick={() => openEdit(item)}>
                          <Edit2 size={12} />
                        </button>
                        <button className="btn btn-danger btn-icon-only" onClick={() => handleDelete(item.entry_id, item.name)}>
                          <Trash2 size={12} />
                        </button>
                      </div>
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
                    <option value="Near Mint">Near Mint</option>
                    <option value="Lightly Played">Lightly Played</option>
                    <option value="Moderately Played">Moderately Played</option>
                    <option value="Heavily Played">Heavily Played</option>
                    <option value="Damaged">Damaged</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Printing</label>
                  <select className="select-control" value={editPrinting} onChange={(e) => setEditPrinting(e.target.value)}>
                    <option value="Normal">Normal</option>
                    <option value="Holofoil">Holofoil</option>
                    <option value="Reverse Holofoil">Reverse Holofoil</option>
                    <option value="1st Edition">1st Edition</option>
                    <option value="Promo">Promo</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Language</label>
                  <select className="select-control" value={editLanguage} onChange={(e) => setEditLanguage(e.target.value)}>
                    <option value="English">English</option>
                    <option value="Japanese">Japanese</option>
                    <option value="German">German</option>
                    <option value="French">French</option>
                    <option value="Spanish">Spanish</option>
                    <option value="Italian">Italian</option>
                  </select>
                </div>
              </div>

              <div className="glass-panel" style={{ padding: '1rem', marginTop: '0.5rem', marginBottom: '1.25rem', background: 'rgba(0,0,0,0.2)' }}>
                <h4 style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Real-World Location Assignment</h4>
                
                <div className="form-group">
                  <label>Storage Container</label>
                  <select className="select-control" value={editLocationId} onChange={(e) => setEditLocationId(e.target.value)}>
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
          backgroundColor: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(5px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 999,
          padding: '1.5rem'
        }} onClick={() => setInspectorCard(null)}>
          <div className="glass-panel" style={{
            maxWidth: '680px',
            width: '100%',
            padding: '2rem',
            display: 'flex',
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: '2rem',
            position: 'relative'
          }} onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setInspectorCard(null)} style={{
              position: 'absolute',
              top: '1rem',
              right: '1rem',
              borderRadius: '50%'
            }}>
              <X size={16} />
            </button>

            {/* Left side: Card Image */}
            <div style={{ flex: '1 1 240px', display: 'flex', justifyContent: 'center' }}>
              <img 
                src={inspectorCard.image_url} 
                alt={inspectorCard.name} 
                style={{
                  width: '100%',
                  maxWidth: '260px',
                  aspectRatio: 0.718,
                  objectFit: 'cover',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5), 0 0 15px rgba(255, 255, 255, 0.05)'
                }}
              />
            </div>

            {/* Right side: Information */}
            <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '1rem', justifyContent: 'center' }}>
              <div>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
                  <span style={{
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    padding: '0.15rem 0.4rem',
                    borderRadius: '4px',
                    backgroundColor: 'rgba(234, 179, 8, 0.1)',
                    color: 'var(--accent-yellow)',
                    border: '1px solid rgba(234, 179, 8, 0.2)'
                  }}>
                    {inspectorCard.rarity || 'Common'}
                  </span>

                  {inspectorCard.list_type === 'wishlist' && (
                    <span style={{
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      padding: '0.15rem 0.4rem',
                      borderRadius: '4px',
                      backgroundColor: 'rgba(6, 182, 212, 0.15)',
                      color: '#06b6d4',
                      border: '1px solid rgba(6, 182, 212, 0.3)'
                    }}>
                      Wishlist Item
                    </span>
                  )}

                  {inspectorCard.is_trade === 1 && (
                    <span style={{
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      padding: '0.15rem 0.4rem',
                      borderRadius: '4px',
                      backgroundColor: 'rgba(74, 222, 128, 0.15)',
                      color: 'var(--type-grass)',
                      border: '1px solid rgba(74, 222, 128, 0.3)'
                    }}>
                      For Trade
                    </span>
                  )}
                </div>

                <h3 style={{ fontSize: '1.5rem', color: '#fff', lineHeight: 1.2 }}>{inspectorCard.name}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{inspectorCard.set_name} • Card #{inspectorCard.number}</p>
              </div>

              <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>TCG MARKET</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>
                    ${inspectorCard.price_trend ? inspectorCard.price_trend.toFixed(2) : '0.00'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>PURCHASE PRICE</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff' }}>
                    ${inspectorCard.purchase_price ? inspectorCard.purchase_price.toFixed(2) : '0.00'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>QUANTITY</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff' }}>
                    x{inspectorCard.quantity}
                  </div>
                </div>
              </div>

              {/* Price History Area Chart */}
              {loadingHistory ? (
                <div className="spinner" style={{ height: '30px', margin: '0.5rem auto' }}></div>
              ) : priceHistory.length > 0 && (
                <div style={{ width: '100%', height: '80px', background: 'rgba(0,0,0,0.15)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', marginBottom: '4px', letterSpacing: '0.05em' }}>Price Trend History (30 Days)</div>
                  <div style={{ width: '100%', height: '50px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={priceHistory} margin={{ top: 0, right: 0, left: -22, bottom: 0 }}>
                        <defs>
                          <linearGradient id="priceGlow" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--accent-yellow)" stopOpacity={0.3}/>
                            <stop offset="95%" stopColor="var(--accent-yellow)" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="recorded_at" hide />
                        <YAxis domain={['auto', 'auto']} hide />
                        <Tooltip 
                          contentStyle={{ background: 'rgba(0,0,0,0.85)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.75rem', color: '#fff' }}
                          labelFormatter={(label) => new Date(label).toLocaleDateString()}
                          formatter={(val) => [`$${val.toFixed(2)}`, 'Market Value']}
                        />
                        <Area type="monotone" dataKey="price" stroke="var(--accent-yellow)" strokeWidth={1.5} fillOpacity={1} fill="url(#priceGlow)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Physical Location Details */}
              {inspectorCard.list_type !== 'wishlist' && (
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: 600 }}>STORAGE CONTAINER</div>
                  {inspectorCard.location_name ? (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.85rem', fontWeight: 700, color: '#fff' }}>
                        <MapPin size={11} style={{ color: 'var(--accent-red)' }} />
                        {inspectorCard.location_name} ({inspectorCard.location_type})
                      </div>
                      {(inspectorCard.sub_location_1 || inspectorCard.sub_location_2) && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', paddingLeft: '1rem', marginTop: '0.1rem' }}>
                          {inspectorCard.location_type === 'Binder' ? 'Page' : inspectorCard.location_type === 'Box' ? 'Row' : ''} {inspectorCard.sub_location_1 || '?'}{' '}
                          {inspectorCard.sub_location_2 ? `• Slot/Section: ${inspectorCard.sub_location_2}` : ''}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontStyle: 'italic', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Unassigned Pile</div>
                  )}
                </div>
              )}

              {/* Card Meta details */}
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Supertype:</span> {inspectorCard.supertype}
                {inspectorCard.types && inspectorCard.types.length > 0 && ` • Types: ${inspectorCard.types.join(', ')}`}
                {inspectorCard.subtypes && inspectorCard.subtypes.length > 0 && ` • Subtypes: ${inspectorCard.subtypes.join(', ')}`}
              </div>

              {/* Modal Actions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.25rem' }}>
                {inspectorCard.list_type === 'wishlist' && (
                  <button 
                    className="btn btn-primary" 
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                    onClick={() => {
                      // Claim the card by setting edit states to collection mode
                      openEdit(inspectorCard);
                      setEditListType('collection'); // Force convert
                      setInspectorCard(null);
                    }}
                  >
                    Add to Collection (Obtained)
                  </button>
                )}
                
                <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
                  <button 
                    className="btn btn-secondary" 
                    style={{ flex: 1 }}
                    onClick={() => {
                      openEdit(inspectorCard);
                      setInspectorCard(null);
                    }}
                  >
                    Edit Details
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
        </div>
      )}
    </>
  )}
</div>
  );
}

export default CollectionList;
