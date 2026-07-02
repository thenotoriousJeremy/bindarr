import React, { useState, useEffect } from 'react';
import { Search, Plus, X, Info, HelpCircle } from 'lucide-react';
import confetti from 'canvas-confetti';

function CardSearch({ onAddSuccess, showToast }) {
  const [query, setQuery] = useState('');
  const [numberQuery, setNumberQuery] = useState('');
  const [setCodeQuery, setSetCodeQuery] = useState('');
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  
  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [locations, setLocations] = useState([]);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [locationId, setLocationId] = useState('');
  const [subLocation1, setSubLocation1] = useState('');
  const [subLocation2, setSubLocation2] = useState('');

  // Fetch physical locations on mount for the form dropdown
  useEffect(() => {
    fetchLocations();
  }, []);

  const fetchLocations = async () => {
    try {
      const response = await fetch('/api/locations');
      if (response.ok) {
        const data = await response.json();
        setLocations(data);
        if (data.length > 0) {
          // Default to Unassigned Pile
          setLocationId('');
        }
      }
    } catch (err) {
      console.error('Error fetching locations:', err);
    }
  };

  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    if (!query && !numberQuery && !setCodeQuery) return;
    
    setLoading(true);
    setSearching(true);
    try {
      const params = new URLSearchParams();
      if (query) params.append('name', query);
      if (numberQuery) params.append('number', numberQuery);
      if (setCodeQuery) params.append('set', setCodeQuery);

      const response = await fetch(`/api/search?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        setCards(data);
      } else {
        showToast('Search request failed.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error connecting to search API.');
    } finally {
      setLoading(false);
    }
  };

  const openQuickAdd = (card) => {
    setSelectedCard(card);
    setPurchasePrice(0); // Default to 0 purchase spend
    // Guess printing based on rarity
    const rarity = (card.rarity || '').toLowerCase();
    if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || rarity.includes('shining')) {
      setPrinting('Holofoil');
    } else {
      setPrinting('Normal');
    }
    
    // Set default sub-location placeholders based on container type
    const defaultLoc = locations.find(l => l.id == locationId);
    setSubLocation1('');
    setSubLocation2('');

    setIsDrawerOpen(true);
  };

  const closeDrawer = () => {
    setIsDrawerOpen(false);
    setSelectedCard(null);
    setQuantity(1);
    setCondition('Near Mint');
    setPrinting('Normal');
    setLanguage('English');
    setPurchasePrice(0);
    setSubLocation1('');
    setSubLocation2('');
  };

  const handleLocationChange = (e) => {
    const val = e.target.value;
    setLocationId(val);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCard) return;

    try {
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: selectedCard.id,
          quantity: parseInt(quantity, 10),
          condition,
          printing,
          language,
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: locationId ? parseInt(locationId, 10) : null,
          sub_location_1: subLocation1,
          sub_location_2: subLocation2
        })
      });

      if (response.ok) {
        showToast(`${selectedCard.name} added to collection!`);
        
        // Trigger confetti for rare/valuable cards!
        const rarity = (selectedCard.rarity || '').toLowerCase();
        const price = selectedCard.price_trend || 0;
        if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || price > 10) {
          confetti({
            particleCount: 150,
            spread: 80,
            origin: { y: 0.6 }
          });
        }

        onAddSuccess(); // Update stats
        closeDrawer();
      } else {
        showToast('Failed to add card to database.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error saving to collection.');
    }
  };

  // Helper to determine location type layout guidance
  const selectedLocation = locations.find(l => l.id == locationId);
  const isBinder = selectedLocation ? selectedLocation.type === 'Binder' : false;
  const isBox = selectedLocation ? selectedLocation.type === 'Box' : false;

  return (
    <div>
      {/* Search Header Panel */}
      <div className="glass-panel" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem', color: '#fff' }}>Search Pokemon Cards</h2>
        <form onSubmit={handleSearch} style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.75rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>CARD NAME</label>
              <div style={{ position: 'relative' }}>
                <input 
                  type="text" 
                  className="input-control" 
                  placeholder="e.g. Charizard, Pikachu, Mewtwo..." 
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ width: '100%', paddingLeft: '2.5rem' }}
                />
                <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>CARD NUMBER (OPTIONAL)</label>
              <input 
                type="text" 
                className="input-control" 
                placeholder="e.g. 58/102, 150" 
                value={numberQuery}
                onChange={(e) => setNumberQuery(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>SET NAME/ID (OPTIONAL)</label>
              <input 
                type="text" 
                className="input-control" 
                placeholder="e.g. Base, Jungle, sv3pt5" 
                value={setCodeQuery}
                onChange={(e) => setSetCodeQuery(e.target.value)}
              />
            </div>
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }}>
            <Search size={18} />
            Search Database
          </button>
        </form>
      </div>

      {/* Loading state */}
      {loading && <div className="spinner"></div>}

      {/* Search Results Grid */}
      {!loading && cards.length > 0 && (
        <div className="card-grid">
          {cards.map((card) => {
            const glowClass = (card.types && card.types[0]) ? `type-glow-${card.types[0].toLowerCase()}` : 'type-glow-normal';
            return (
              <div 
                key={card.id} 
                className="tcg-card"
                onClick={() => openQuickAdd(card)}
              >
                <div className={`tcg-card-inner ${glowClass}`}>
                  <img src={card.image_url} alt={card.name} className="tcg-card-image" loading="lazy" />
                  <div style={{ position: 'absolute', bottom: '8px', right: '8px', background: 'rgba(0,0,0,0.85)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border-glass-hover)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Plus size={10} style={{ color: 'var(--accent-red)' }} />
                    <span style={{ fontSize: '0.65rem', fontWeight: 700 }}>Quick Add</span>
                  </div>
                </div>
                <div className="tcg-card-info">
                  <div className="tcg-card-name">{card.name}</div>
                  <div className="tcg-card-meta">
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{card.set_name}</span>
                    <span className="tcg-card-price">${card.price_trend ? card.price_trend.toFixed(2) : '0.00'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!loading && searching && cards.length === 0 && (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          <p>No cards matched your search queries. Try again with broader terms (e.g. searching "Charizard" without a card number).</p>
        </div>
      )}

      {/* Drawer Dialog Backdrop */}
      <div className={`drawer-backdrop ${isDrawerOpen ? 'open' : ''}`} onClick={closeDrawer}></div>

      {/* Quick Add Drawer Sheet */}
      <div className={`quick-add-drawer ${isDrawerOpen ? 'open' : ''}`}>
        {selectedCard && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ color: '#fff', fontSize: '1.25rem' }}>Add Card to Collection</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{selectedCard.name} ({selectedCard.set_name} • #{selectedCard.number})</p>
              </div>
              <button className="btn btn-secondary btn-icon-only" onClick={closeDrawer} style={{ borderRadius: '50%' }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', background: 'rgba(255, 255, 255, 0.02)', padding: '1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
              <img src={selectedCard.image_url} alt={selectedCard.name} style={{ width: '80px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: 'var(--radius-sm)', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }} />
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>TCG MARKET PRICE</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>${selectedCard.price_trend ? selectedCard.price_trend.toFixed(2) : '0.00'}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Rarity: <span style={{ color: '#fff', fontWeight: 600 }}>{selectedCard.rarity}</span></div>
              </div>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                <div className="form-group">
                  <label>Quantity</label>
                  <input 
                    type="number" 
                    className="input-control" 
                    min="1" 
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Purchase Price ($)</label>
                  <input 
                    type="number" 
                    step="0.01" 
                    className="input-control" 
                    value={purchasePrice}
                    onChange={(e) => setPurchasePrice(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
                <div className="form-group">
                  <label>Condition</label>
                  <select className="select-control" value={condition} onChange={(e) => setCondition(e.target.value)}>
                    <option value="Near Mint">Near Mint</option>
                    <option value="Lightly Played">Lightly Played</option>
                    <option value="Moderately Played">Moderately Played</option>
                    <option value="Heavily Played">Heavily Played</option>
                    <option value="Damaged">Damaged</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Printing</label>
                  <select className="select-control" value={printing} onChange={(e) => setPrinting(e.target.value)}>
                    <option value="Normal">Normal</option>
                    <option value="Holofoil">Holofoil</option>
                    <option value="Reverse Holofoil">Reverse Holofoil</option>
                    <option value="1st Edition">1st Edition</option>
                    <option value="Promo">Promo</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Language</label>
                  <select className="select-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
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
                  <select className="select-control" value={locationId} onChange={handleLocationChange}>
                    <option value="">Unassigned Pile</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                    ))}
                  </select>
                </div>

                {locationId && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', marginTop: '0.75rem' }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>{isBinder ? 'Page Number' : isBox ? 'Row Number / Letter' : 'Sub-Location 1'}</label>
                      <input 
                        type="text" 
                        className="input-control" 
                        placeholder={isBinder ? 'e.g. Page 12' : isBox ? 'e.g. Row 2' : 'e.g. Top shelf'} 
                        value={subLocation1}
                        onChange={(e) => setSubLocation1(e.target.value)}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>{isBinder ? 'Slot Number (1-9)' : isBox ? 'Divider / Section' : 'Sub-Location 2'}</label>
                      <input 
                        type="text" 
                        className="input-control" 
                        placeholder={isBinder ? 'e.g. Slot 4' : isBox ? 'e.g. Behind Grass Divider' : 'e.g. Box A'} 
                        value={subLocation2}
                        onChange={(e) => setSubLocation2(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={closeDrawer} style={{ flex: 1 }}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>Add to Collection</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

export default CardSearch;
