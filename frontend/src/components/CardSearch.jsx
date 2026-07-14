import { useState, useEffect, useMemo } from 'react';
import { Search, Plus, X, ShieldAlert } from 'lucide-react';
import confetti from 'canvas-confetti';
import { formatPrice } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import CardEntryFields from './CardEntryFields';
import { translateJapaneseName } from '../utils/langHelper';


function CardSearch({ onAddSuccess, showToast, setActiveTab }) {
  const [query, setQuery] = useState('');
  const [numberQuery, setNumberQuery] = useState('');
  const [setCodeQuery, setSetCodeQuery] = useState('');
  const [game, setGame] = useState('pokemon'); // 'pokemon' | 'mtg'
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  
  // Filter states
  const [filterRarity, setFilterRarity] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterSupertype, setFilterSupertype] = useState('');
  const [sortBy, setSortBy] = useState('relevance');

  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [, setLocations] = useState([]);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [, setLocationId] = useState('');

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
    setSearchError(null);
    setFilterType('');
    setFilterRarity('');
    setFilterSupertype('');
    setSortBy('relevance');
    try {
      const params = new URLSearchParams();
      // Japanese-name translation is a Pokémon-only helper; MTG names go through as typed.
      const finalQuery = query ? (game === 'mtg' ? query : (translateJapaneseName(query) || query)) : '';
      if (finalQuery) params.append('name', finalQuery);
      if (numberQuery) params.append('number', numberQuery);
      if (setCodeQuery) params.append('set', setCodeQuery);
      params.append('scope', 'internet');
      params.append('game', game);

      const response = await fetch(`/api/search?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        setCards(data);
      } else {
        const errData = await response.json().catch(() => ({}));
        if (response.status === 403 || errData.error === 'Invalid API Key') {
          setSearchError('invalid-key');
        } else if (response.status === 429 || errData.error === 'Rate limit exceeded') {
          setSearchError('rate-limit');
        }
        showToast(errData.error || 'Search request failed.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error connecting to search API.');
    } finally {
      setLoading(false);
    }
  };

  // Dynamically compute filters from search results
  const uniqueRarities = useMemo(() => {
    const set = new Set();
    cards.forEach(c => { if (c.rarity) set.add(c.rarity); });
    return Array.from(set).sort();
  }, [cards]);

  const uniqueSupertypes = useMemo(() => {
    const set = new Set();
    cards.forEach(c => { if (c.supertype) set.add(c.supertype); });
    return Array.from(set).sort();
  }, [cards]);

  const uniqueTypes = useMemo(() => {
    const set = new Set();
    cards.forEach(c => {
      if (c.types) {
        c.types.forEach(t => set.add(t));
      }
    });
    return Array.from(set).sort();
  }, [cards]);

  // Apply filters and sorting
  const filteredAndSortedCards = useMemo(() => {
    let result = [...cards];

    // Apply filters
    if (filterRarity) {
      result = result.filter(c => c.rarity === filterRarity);
    }
    if (filterSupertype) {
      result = result.filter(c => c.supertype === filterSupertype);
    }
    if (filterType) {
      result = result.filter(c => c.types && c.types.includes(filterType));
    }

    // Apply sorting
    if (sortBy === 'name-asc') {
      result.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'name-desc') {
      result.sort((a, b) => b.name.localeCompare(a.name));
    } else if (sortBy === 'price-asc') {
      result.sort((a, b) => (a.price_trend || 0) - (b.price_trend || 0));
    } else if (sortBy === 'price-desc') {
      result.sort((a, b) => (b.price_trend || 0) - (a.price_trend || 0));
    } else if (sortBy === 'number-asc') {
      result.sort((a, b) => {
        const numA = parseInt(a.number, 10);
        const numB = parseInt(b.number, 10);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.number.localeCompare(b.number);
      });
    } else if (sortBy === 'number-desc') {
      result.sort((a, b) => {
        const numA = parseInt(a.number, 10);
        const numB = parseInt(b.number, 10);
        if (!isNaN(numA) && !isNaN(numB)) return numB - numA;
        return b.number.localeCompare(a.number);
      });
    }

    return result;
  }, [cards, filterRarity, filterSupertype, filterType, sortBy]);

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
          location_id: null
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
  return (
    <div>
      {/* Search Header Panel */}
      <div className="glass-panel" style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem', margin: 0, color: '#fff' }}>Search {game === 'mtg' ? 'Magic: The Gathering' : 'Pokémon'} Cards</h2>
          <div className="sub-nav-tabs" style={{ margin: 0 }}>
            {[['pokemon', 'Pokémon'], ['mtg', 'MTG']].map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={`sub-nav-tab ${game === val ? 'active' : ''}`}
                style={{ padding: '0.4rem 0.9rem', fontSize: '0.8rem' }}
                onClick={() => setGame(val)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <form onSubmit={handleSearch} style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.75rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>CARD NAME</label>
              <div style={{ position: 'relative' }}>
                <input 
                  type="text" 
                  className="input-control" 
                  placeholder={game === 'mtg' ? 'e.g. Black Lotus, Lightning Bolt...' : 'e.g. Charizard, Pikachu, Mewtwo...'}
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
                placeholder={game === 'mtg' ? 'e.g. eld, m10, Throne of Eldraine' : 'e.g. Base, Jungle, sv3pt5'}
                value={setCodeQuery}
                onChange={(e) => setSetCodeQuery(e.target.value)}
              />
            </div>
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }}>
            <Search size={18} />
            Search Internet API
          </button>
        </form>
      </div>

      {searchError && (
        <div className="glass-panel" style={{ borderLeft: '4px solid var(--accent-red)', background: 'rgba(239, 68, 68, 0.08)', padding: '1.25rem', marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-red)', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
            <ShieldAlert size={18} />
            {searchError === 'invalid-key' ? 'Invalid API Key' : 'Rate Limit Exceeded'}
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
            {searchError === 'invalid-key' 
              ? 'Your custom Pokémon TCG API key is invalid or unauthorized.' 
              : 'You have exceeded the unauthenticated search rate limits.'}
            {' '}Get a free API key at <a href="https://dev.pokemontcg.io/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-yellow)', textDecoration: 'underline' }}>pokemontcg.io</a> and configure it in your Settings.
          </p>
          {setActiveTab && (
            <button 
              type="button" 
              className="btn btn-secondary" 
              onClick={() => setActiveTab('settings')}
              style={{ width: 'fit-content', padding: '0.35rem 0.75rem', fontSize: '0.75rem', marginTop: '0.25rem' }}
            >
              Go to Settings
            </button>
          )}
        </div>
      )}

      {/* Loading state */}
      {loading && <div className="spinner"></div>}

      {/* Filters and Sorting Panel */}
      {!loading && cards.length > 0 && (
        <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>FILTER BY TYPE</label>
              <select className="select-control" value={filterType} onChange={e => setFilterType(e.target.value)}>
                <option value="">All Types</option>
                {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>FILTER BY RARITY</label>
              <select className="select-control" value={filterRarity} onChange={e => setFilterRarity(e.target.value)}>
                <option value="">All Rarities</option>
                {uniqueRarities.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>FILTER BY SUPERTYPE</label>
              <select className="select-control" value={filterSupertype} onChange={e => setFilterSupertype(e.target.value)}>
                <option value="">All Supertypes</option>
                {uniqueSupertypes.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>SORT BY</label>
              <select className="select-control" value={sortBy} onChange={e => setSortBy(e.target.value)}>
                <option value="relevance">Relevance</option>
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="price-asc">Price (Low to High)</option>
                <option value="price-desc">Price (High to Low)</option>
                <option value="number-asc">Number (Ascending)</option>
                <option value="number-desc">Number (Descending)</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Search Results Grid */}
      {!loading && cards.length > 0 && filteredAndSortedCards.length > 0 && (
        <div className="card-grid">
          {filteredAndSortedCards.map((card) => {
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
                    <span className="tcg-card-price">${formatPrice(card.price_trend)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Filtered Empty State */}
      {!loading && cards.length > 0 && filteredAndSortedCards.length === 0 && (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem', marginBottom: '2rem' }}>
          <p>No cards matched your active filters. Try clearing your selection above.</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && searching && cards.length === 0 && (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          <p>No cards matched your search queries. Try again with broader terms (e.g. searching &quot;Charizard&quot; without a card number).</p>
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
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>TCG MARKET PRICE ({printing})</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>${formatPrice(resolveCardPrice(selectedCard, printing))}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Rarity: <span style={{ color: '#fff', fontWeight: 600 }}>{selectedCard.rarity}</span></div>
              </div>
            </div>

            <form onSubmit={handleSubmit}>
              <CardEntryFields
                quantity={quantity} purchasePrice={purchasePrice} condition={condition} printing={printing} language={language}
                onQuantity={setQuantity} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting} onLanguage={setLanguage}
              />



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
