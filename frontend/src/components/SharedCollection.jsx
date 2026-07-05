import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { Search, Trophy, Compass, Library, ShieldAlert, Sparkles, X } from 'lucide-react';
import { formatPrice } from '../utils/formatPrice';
import { PRINTINGS } from '../utils/cardOptions';
import { getFoilOverlayClass, getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';

const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', 
  '#ec4899', '#14b8a6', '#f43f5e', '#a855f7', '#6366f1'
];

const TYPE_COLORS = {
  'Grass': '#4ade80',
  'Fire': '#f87171',
  'Water': '#60a5fa',
  'Lightning': '#facc15',
  'Psychic': '#c084fc',
  'Fighting': '#f97316',
  'Darkness': '#475569',
  'Metal': '#94a3b8',
  'Dragon': '#a855f7',
  'Fairy': '#f472b6',
  'Colorless': '#cbd5e1'
};

function SharedCollection({ shareToken }) {
  const getInitialList = () => {
    const params = new URLSearchParams(window.location.search);
    return params.get('list') || 'collection';
  };

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [listType, setListType] = useState(getInitialList);

  // Search/Filters
  const [searchFilter, setSearchFilter] = useState('');
  const [rarityFilter, setRarityFilter] = useState('');
  const [printingFilter, setPrintingFilter] = useState('');

  // Detailed Modal State
  const [activeCard, setActiveCard] = useState(null);

  useEffect(() => {
    fetchSharedData();
  }, [shareToken, listType]);

  const fetchSharedData = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`/api/shared/${shareToken}?list=${listType}`);
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to load shared collection.');
      }
      const resData = await response.json();
      setData(resData);
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <div className="spinner"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh', padding: '1rem' }}>
        <div className="glass-panel" style={{ textAlign: 'center', maxWidth: '400px', width: '100%', padding: '2.5rem 1.5rem', border: '1px solid rgba(255, 71, 71, 0.2)' }}>
          <ShieldAlert size={48} style={{ color: 'var(--accent-red)', marginBottom: '1rem' }} />
          <h2 style={{ color: '#fff', fontSize: '1.25rem', marginBottom: '0.5rem' }}>Collection Unavailable</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{error}</p>
          <a href="/" style={{
            display: 'inline-block',
            marginTop: '1.5rem',
            padding: '0.5rem 1.5rem',
            backgroundColor: 'var(--accent-red)',
            color: '#fff',
            textDecoration: 'none',
            fontWeight: 700,
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-accent)'
          }}>
            Go to Pokedexrr
          </a>
        </div>
      </div>
    );
  }

  const { owner, collection, stats } = data;
  const { summary, types, rarities } = stats;

  const typeChartData = types.map(t => ({
    name: t.name,
    value: t.value,
    color: TYPE_COLORS[t.name] || '#94a3b8'
  }));

  const uniqueRarities = Array.from(new Set(collection.map(item => item.rarity).filter(Boolean)));

  // Filters logic
  const filteredCollection = collection.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchFilter.toLowerCase()) || 
                          (item.set_name || '').toLowerCase().includes(searchFilter.toLowerCase()) ||
                          (item.number || '').includes(searchFilter);
    const matchesRarity = rarityFilter === '' ? true : item.rarity === rarityFilter;
    const matchesPrinting = printingFilter === '' ? true : item.printing === printingFilter;

    return matchesSearch && matchesRarity && matchesPrinting;
  });

  const handleTabChange = (type) => {
    setListType(type);
    const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?list=${type}`;
    window.history.pushState({ path: newUrl }, '', newUrl);
  };

  const valueLabel = listType === 'wishlist' ? 'Est. Wishlist Value' : listType === 'trade' ? 'Est. Trade Value' : 'Est. Collection Value';
  const qtyLabel = listType === 'wishlist' ? 'Total Cards Wanted' : listType === 'trade' ? 'Total Cards for Trade' : 'Total Cards Owned';
  const qtyFooter = listType === 'wishlist' ? 'Wanted card quantity count' : listType === 'trade' ? 'Trade card quantity count' : 'Card binder quantity count';

  return (
    <div className="app-container" style={{ paddingBottom: '3rem' }}>
      {/* Header */}
      <header className="app-header" style={{ marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '1px solid var(--border-glass)' }}>
        <div className="logo-section">
          <div className="logo-icon"></div>
          <h1 className="logo-text">Poke<span>Keep</span></h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          <Sparkles size={14} style={{ color: 'var(--accent-yellow)' }} />
          <span>Shared Binder: <strong>{owner}</strong></span>
        </div>
      </header>

      {/* Public Sub Navigation Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
        <button 
          className={`btn ${listType === 'collection' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => handleTabChange('collection')}
          style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
        >
          Collection
        </button>
        <button 
          className={`btn ${listType === 'wishlist' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => handleTabChange('wishlist')}
          style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
        >
          Wishlist
        </button>
        <button 
          className={`btn ${listType === 'trade' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => handleTabChange('trade')}
          style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
        >
          Trade Binder
        </button>
      </div>

      {/* Title block based on active share view */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', color: '#fff', textTransform: 'capitalize' }}>
          {owner}'s {listType === 'trade' ? 'Trade Binder' : listType === 'wishlist' ? 'Wanted Wishlist' : 'Pokémon Collection'}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          {listType === 'trade' ? 'Browse cards this collector is willing to trade.' : listType === 'wishlist' ? 'View cards this collector is searching for.' : 'Browse this collector\'s catalog library.'}
        </p>
      </div>

      {/* Overview stats */}
      <div className="metrics-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="glass-panel metric-card">
          <div className="metric-header">
            <span>{valueLabel}</span>
            <Trophy size={18} style={{ color: 'var(--accent-yellow)' }} />
          </div>
          <div className="metric-value">${summary.totalValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
          <div className="metric-footer">Based on current TCG Market values</div>
        </div>

        <div className="glass-panel metric-card">
          <div className="metric-header">
            <span>{qtyLabel}</span>
            <Library size={18} />
          </div>
          <div className="metric-value">{summary.totalCards}</div>
          <div className="metric-footer">{qtyFooter}</div>
        </div>

        <div className="glass-panel metric-card">
          <div className="metric-header">
            <span>Unique Catalog Cards</span>
            <Compass size={18} />
          </div>
          <div className="metric-value">{summary.uniqueCards}</div>
          <div className="metric-footer">Distinct card IDs</div>
        </div>
      </div>

      <div className="dashboard-details" style={{ marginBottom: '1.5rem' }}>
        {/* Left Column: Visual distribution charts */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
          <div className="glass-panel">
            <h3 className="chart-title">Energy Type Breakdown</h3>
            <div className="chart-container" style={{ height: '220px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={typeChartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {typeChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                    formatter={(v) => [v, 'Cards']}
                  />
                  <Legend 
                    verticalAlign="bottom" 
                    height={36} 
                    iconSize={10} 
                    style={{ fontSize: '0.75rem' }} 
                    formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="glass-panel">
          <h3 className="chart-title">Rarity Distribution</h3>
          <div className="chart-container" style={{ height: '220px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={rarities}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {rarities.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                  formatter={(v) => [v, 'Cards']}
                />
                <Legend 
                  verticalAlign="bottom" 
                  height={36} 
                  iconSize={10} 
                  style={{ fontSize: '0.75rem' }} 
                  formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Filter and Cards Grid */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Search Collection</label>
            <div style={{ position: 'relative' }}>
              <input 
                type="text" 
                className="input-control" 
                placeholder="Search card name, set, number..." 
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                style={{ width: '100%', paddingLeft: '2.5rem' }}
              />
              <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Rarity</label>
              <select className="select-control" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
                <option value="">All Rarities</option>
                {uniqueRarities.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Printing</label>
              <select className="select-control" value={printingFilter} onChange={(e) => setPrintingFilter(e.target.value)}>
                <option value="">All Printings</option>
                {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {filteredCollection.length === 0 ? (
        <div className="glass-panel" style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No cards matched your filters.
        </div>
      ) : (
        <div className="card-grid">
          {filteredCollection.map(card => {
            // Check rarity to apply special shimmer borders
            const rarity = (card.rarity || '').toLowerCase();
            const isUltra = rarity.includes('rare') || rarity.includes('secret') || rarity.includes('promo') || rarity.includes('ultra');
            const glowClass = isUltra ? 'rarity-glow-ultra' : '';

            return (
              <div key={card.entry_id} className="tcg-card tilt-card-wrapper" onClick={() => setActiveCard(card)}>
                <div className={`tcg-card-inner ${glowClass}`}>
                  <img src={card.image_url} alt={card.name} className="tcg-card-image" loading="lazy" />
                  {getFoilOverlayClass(card.printing) && (
                    <div className={getFoilOverlayClass(card.printing)} style={{ borderRadius: 'var(--radius-sm)' }} />
                  )}
                  {getPrintingBadgeLabel(card.printing) && (
                    <span style={{ position: 'absolute', top: '6px', left: '6px', fontSize: '0.6rem', fontWeight: 800, padding: '2px 5px', borderRadius: '3px', zIndex: 6, ...getPrintingBadgeStyle(card.printing) }}>
                      {getPrintingBadgeLabel(card.printing)}
                    </span>
                  )}
                  <div className="tcg-card-quantity-tag">x{card.quantity}</div>
                </div>
                <div className="tcg-card-info">
                  <div className="tcg-card-name">{card.name}</div>
                  <div className="tcg-card-meta">
                    <span style={{ fontSize: '0.7rem' }}>{card.set_name} • #{card.number}</span>
                    <span className="tcg-card-price">${formatPrice(card.price_trend)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Card Detail Inspector Modal (Shared Readonly View) */}
      {activeCard && (
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
        }} onClick={() => setActiveCard(null)}>
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
            <button className="btn btn-secondary btn-icon-only" onClick={() => setActiveCard(null)} style={{
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
                src={activeCard.image_url} 
                alt={activeCard.name} 
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
                <span style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '4px',
                  backgroundColor: 'rgba(234, 179, 8, 0.1)',
                  color: 'var(--accent-yellow)',
                  border: '1px solid rgba(234, 179, 8, 0.2)',
                  display: 'inline-block',
                  marginBottom: '0.5rem'
                }}>
                  {activeCard.rarity || 'Common'}
                </span>
                <h3 style={{ fontSize: '1.5rem', color: '#fff', lineHeight: 1.2 }}>{activeCard.name}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{activeCard.set_name} • Card #{activeCard.number}</p>
              </div>

              <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '1rem', display: 'flex', gap: '2rem' }}>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>EST. MARKET PRICE</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>
                    ${formatPrice(activeCard.price_trend)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>OWNED QUANTITY</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#fff' }}>
                    x{activeCard.quantity}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  <strong>Card Details:</strong>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.8rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Supertype:</span> <span style={{ color: '#fff' }}>{activeCard.supertype}</span>
                  {activeCard.types.length > 0 && (
                    <>
                      <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>Types:</span> 
                      <span style={{ color: '#fff' }}>{activeCard.types.join(', ')}</span>
                    </>
                  )}
                  {activeCard.subtypes.length > 0 && (
                    <>
                      <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>Subtypes:</span> 
                      <span style={{ color: '#fff' }}>{activeCard.subtypes.join(', ')}</span>
                    </>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Condition:</span> <span style={{ color: '#fff' }}>{activeCard.condition}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>Printing:</span> <span style={{ color: '#fff' }}>{activeCard.printing}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>Language:</span> <span style={{ color: '#fff' }}>{activeCard.language}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SharedCollection;
