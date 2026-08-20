import { useState, useEffect, useMemo } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend, BarChart, Bar, XAxis, YAxis } from 'recharts';
import { Search, Trophy, Compass, Library, ShieldAlert, Sparkles, X, MapPin, SlidersHorizontal } from 'lucide-react';
import Logo from './Logo';
import { priceText } from '../utils/formatPrice';
import { PRINTINGS } from '../utils/cardOptions';
import { getFoilOverlayClass, getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import { useBackGuard } from '../utils/useBackGuard';
import { sortCardsByOrder } from '../utils/cardSort';
import { displayName } from '../utils/languages';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';

const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f43f5e', '#a855f7', '#6366f1'
];

const TYPE_COLORS = {
  'Grass': '#4ade80', 'Fire': '#f87171', 'Water': '#60a5fa', 'Lightning': '#facc15',
  'Psychic': '#c084fc', 'Fighting': '#f97316', 'Darkness': '#475569', 'Metal': '#94a3b8',
  'Dragon': '#a855f7', 'Fairy': '#f472b6', 'Colorless': '#cbd5e1',
  'White': '#fef08a', 'Blue': '#3b82f6', 'Black': '#334155', 'Red': '#ef4444',
  'Green': '#10b981', 'Land': '#d97706'
};

// Same Sort By options as the owner's collection view (CollectionList), minus
// the owner-only 'favorite'/'added' notions. 'qty-desc' isn't a card-order
// scheme so it's handled separately below.
const SORT_CRITERIA = {
  'added-newest': [{ by: 'added_at', dir: 'desc' }, { by: 'entry_id', dir: 'desc' }],
  'name-asc': [{ by: 'name', dir: 'asc' }],
  'name-desc': [{ by: 'name', dir: 'desc' }],
  'price-desc': [{ by: 'price', dir: 'desc' }],
  'price-asc': [{ by: 'price', dir: 'asc' }],
  'set-asc': [{ by: 'set', dir: 'asc' }, { by: 'number', dir: 'asc' }],
  'number-asc': [{ by: 'number', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'rarity-desc': [{ by: 'rarity', dir: 'desc' }, { by: 'name', dir: 'asc' }],
  'rarity-asc': [{ by: 'rarity', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'type-asc': [{ by: 'type', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'language-asc': [{ by: 'language', dir: 'asc' }, { by: 'name', dir: 'asc' }],
};

function typeColor(name, i) {
  const key = Object.keys(TYPE_COLORS).find(k => k.toLowerCase() === String(name).toLowerCase());
  return key ? TYPE_COLORS[key] : COLORS[i % COLORS.length];
}

function SharedCollection({ shareToken }) {
  const { t, locale } = useT();
  const getInitialList = () => new URLSearchParams(window.location.search).get('list') || 'collection';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [listType, setListType] = useState(getInitialList);

  const [searchFilter, setSearchFilter] = useState('');
  const [rarityFilter, setRarityFilter] = useState('');
  const [printingFilter, setPrintingFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  const [showFilters, setShowFilters] = useState(false);

  // Stacking state (default to stacked)
  const [stackCards, setStackCards] = useState(true);
  const [stackByCondition, setStackByCondition] = useState(false);
  const [stackByPrinting, setStackByPrinting] = useState(false);

  const [activeCard, setActiveCard] = useState(null);
  useBackGuard(!!activeCard, () => setActiveCard(null));

  useEffect(() => {
    const urlTheme = new URLSearchParams(window.location.search).get('theme');
    if (urlTheme) {
      document.documentElement.setAttribute('data-theme', urlTheme);
    }
  }, []);

  useEffect(() => {
    const fetchSharedData = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch(`/api/shared/${shareToken}?list=${listType}`);
        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || t('shared.errLoad'));
        }
        setData(await response.json());
      } catch (err) {
        console.error(err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchSharedData();
  }, [shareToken, listType, t]);

  const collection = useMemo(() => data?.collection || [], [data]);
  const shareLocations = data?.shareLocations;

  const uniqueRarities = useMemo(() => Array.from(new Set(collection.map(c => c.rarity).filter(Boolean))), [collection]);
  const uniqueTypes = useMemo(
    () => Array.from(new Set(collection.flatMap(c => c.types || []))).sort(),
    [collection]
  );

  const topValuable = useMemo(
    () => [...collection].sort((a, b) => (b.price_trend || 0) - (a.price_trend || 0)).slice(0, 5),
    [collection]
  );

  const filteredCollection = useMemo(() => {
    const q = searchFilter.toLowerCase();
    const result = collection.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(q) ||
        (item.set_name || '').toLowerCase().includes(q) ||
        (item.number || '').includes(searchFilter);
      const matchesRarity = !rarityFilter || item.rarity === rarityFilter;
      const matchesPrinting = !printingFilter || item.printing === printingFilter;
      const matchesType = !typeFilter || (item.types || []).includes(typeFilter);
      return matchesSearch && matchesRarity && matchesPrinting && matchesType;
    });
    if (sortBy === 'qty-desc') return result.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    return sortCardsByOrder(result, SORT_CRITERIA[sortBy] || SORT_CRITERIA['added-newest']);
  }, [collection, searchFilter, rarityFilter, printingFilter, typeFilter, sortBy]);

  // Group duplicate cards if stack option is active (default true)
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
        groups[key].quantity = (groups[key].quantity || 1) + (item.quantity || 1);
      }
    });
    return Object.values(groups);
  }, [filteredCollection, stackCards, stackByCondition, stackByPrinting]);

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
          <h2 style={{ color: 'var(--text-strong)', fontSize: '1.25rem', marginBottom: '0.5rem' }}>{t('shared.unavailable')}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{error}</p>
          <a href="/" style={{
            display: 'inline-block', marginTop: '1.5rem', padding: '0.5rem 1.5rem',
            backgroundColor: 'var(--accent-red)', color: 'var(--text-strong)',
            textDecoration: 'none', fontWeight: 700, borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-accent)'
          }}>
            {t('shared.goToBindarr')}
          </a>
        </div>
      </div>
    );
  }

  const { owner, stats } = data;
  const { summary, types, rarities, sets = [] } = stats;

  const typeChartData = types.map((entry, i) => ({ name: entry.name, value: entry.value, color: typeColor(entry.name, i) }));
  const rarityChartData = rarities.map((r, i) => ({ ...r, fill: COLORS[i % COLORS.length] }));

  const handleTabChange = (type) => {
    setListType(type);
    const themeParam = new URLSearchParams(window.location.search).get('theme');
    const qTheme = themeParam ? `&theme=${encodeURIComponent(themeParam)}` : '';
    const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?list=${type}${qTheme}`;
    window.history.pushState({ path: newUrl }, '', newUrl);
  };

  // Every label on this page changes with the list being shown, so the list kind
  // is part of the key rather than three parallel ternaries.
  const kind = ['collection', 'wishlist', 'trade'].includes(listType) ? listType : 'collection';
  const valueLabel = t(`shared.${kind}.valueLabel`);
  const qtyLabel = t(`shared.${kind}.qtyLabel`);
  const listTitle = t(`shared.${kind}.title`);
  const listBlurb = t(`shared.${kind}.blurb`);

  const donut = (chartData, title, colorKey) => (
    <div className="glass-panel">
      <h3 className="chart-title">{title}</h3>
      <div className="chart-container" style={{ height: '220px' }}>
        {chartData.length === 0 ? (
          <div className="chart-empty">{t('shared.noData')}</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={chartData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                {chartData.map((entry, i) => <Cell key={i} fill={entry[colorKey]} />)}
              </Pie>
              <Tooltip contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }} itemStyle={{ color: 'var(--text-strong)' }} labelStyle={{ color: 'var(--text-strong)' }} formatter={(v) => [v, t('dash.cards')]} />
              <Legend verticalAlign="bottom" height={36} iconSize={10} style={{ fontSize: '0.75rem' }}
                formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );

  return (
    <div className="app-container" style={{ paddingBottom: '3rem' }}>
      {/* Header */}
      <header className="app-header" style={{ marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '1px solid var(--border-glass)' }}>
        <div className="logo-section">
          <div className="logo-icon"><Logo /></div>
          <h1 className="logo-text">Bind<span>arr</span></h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          <Sparkles size={14} style={{ color: 'var(--accent-yellow)' }} />
          <span>{t('shared.sharedBy')} <strong>{owner}</strong></span>
        </div>
      </header>

      {/* Public Sub Navigation Tabs */}
      <div className="sub-nav-tabs" style={{ marginBottom: '1.5rem' }}>
        {['collection', 'wishlist', 'trade'].map((val) => (
          <button key={val} className={`sub-nav-tab ${listType === val ? 'active' : ''}`} onClick={() => handleTabChange(val)}>
            {t(`shared.${val}.tab`)}
          </button>
        ))}
      </div>

      {/* Title block */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)' }}>{t('shared.ownerTitle', { owner, list: listTitle })}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{listBlurb}</p>
      </div>

      {/* Overview stats */}
      <div className="metrics-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="glass-panel metric-card">
          <div className="metric-header"><span>{valueLabel}</span><Trophy size={18} style={{ color: 'var(--accent-yellow)' }} /></div>
          <div className="metric-value">${summary.totalValue.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="metric-footer">{t('shared.valueFooter')}</div>
        </div>
        <div className="glass-panel metric-card">
          <div className="metric-header"><span>{qtyLabel}</span><Library size={18} /></div>
          <div className="metric-value">{summary.totalCards}</div>
          <div className="metric-footer">{t('shared.qtyFooter')}</div>
        </div>
        <div className="glass-panel metric-card">
          <div className="metric-header"><span>{t('shared.uniqueCards')}</span><Compass size={18} /></div>
          <div className="metric-value">{summary.uniqueCards}</div>
          <div className="metric-footer">{t('shared.uniqueFooter')}</div>
        </div>
      </div>

      {/* Analytics */}
      <div className="dashboard-details" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="glass-panel">
            <h3 className="chart-title">{t('shared.valueBySet')}</h3>
            <div className="chart-container">
              {sets.length === 0 ? (
                <div className="chart-empty">{t('shared.noSetData')}</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={sets} layout="vertical" margin={{ left: 10, right: 30, top: 10, bottom: 10 }}>
                    <XAxis type="number" stroke="var(--text-secondary)" tickFormatter={(v) => `$${v}`} />
                    <YAxis dataKey="name" type="category" width={120} stroke="var(--text-secondary)" tickLine={false} axisLine={false} style={{ fontSize: '0.8rem' }} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }} itemStyle={{ color: 'var(--text-strong)' }} labelStyle={{ color: 'var(--text-strong)' }} formatter={(v) => [`$${v}`, t('dash.value')]} />
                    <Bar dataKey="value" fill="var(--accent-red)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
            {donut(typeChartData, t('shared.typeBreakdown'), 'color')}
            {donut(rarityChartData, t('dash.rarityDistribution'), 'fill')}
          </div>
        </div>

        {/* Top Valuable */}
        <div className="glass-panel" style={{ flex: 1 }}>
          <h3 className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Trophy size={18} style={{ color: 'var(--accent-yellow)' }} /> {t('dash.topValuable')}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1.25rem' }}>
            {topValuable.map((card) => (
              <div key={card.entry_id} onClick={() => setActiveCard(card)} className="dashboard-card-clickable"
                style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', cursor: 'pointer' }}>
                <CardImage card={card} style={{ width: '48px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '5px', boxShadow: '0 2px 6px rgba(0,0,0,0.4)' }} />
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName(card)}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.set_name} • {card.rarity}</div>
                </div>
                <div style={{ fontWeight: 800, color: 'var(--accent-yellow)', fontSize: '0.9rem' }}>{priceText(card.price_trend, card.price_currency)}</div>
              </div>
            ))}
            {topValuable.length === 0 && <div className="chart-empty">{t('shared.noCards')}</div>}
          </div>
        </div>
      </div>

      {/* Filters + Sort */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: '1 1 220px' }}>
            <label>{t('shared.search')}</label>
            <div style={{ position: 'relative' }}>
              <input type="text" className="input-control" placeholder={t('shared.searchPlaceholder')}
                value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} style={{ width: '100%', paddingLeft: '2.5rem' }} />
              <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: '1 1 160px' }}>
            <label>{t('collection.sortBy')}</label>
            <select className="select-control" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="added-newest">{t('shared.sortRecent')}</option>
              {['name-asc', 'name-desc', 'price-desc', 'price-asc', 'qty-desc', 'set-asc', 'number-asc', 'type-asc', 'rarity-desc', 'rarity-asc', 'language-asc']
                .map(key => <option key={key} value={key}>{t(`collection.sort.${key}`)}</option>)}
            </select>
          </div>
          <button className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowFilters(s => !s)}
            style={{ padding: '0.5rem 0.9rem', height: '40px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}>
            <SlidersHorizontal size={15} /> {t('collection.filters')}
          </button>
        </div>

        {showFilters && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>{t('shared.type')}</label>
                <select className="select-control" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="">{t('collection.allTypes')}</option>
                  {uniqueTypes.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>{t('collection.fRarity')}</label>
                <select className="select-control" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
                  <option value="">{t('collection.allRarities')}</option>
                  {uniqueRarities.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>{t('card.printing')}</label>
                <select className="select-control" value={printingFilter} onChange={(e) => setPrintingFilter(e.target.value)}>
                  <option value="">{t('collection.allPrintings')}</option>
                  {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-glass)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <input type="checkbox" id="stackCardsSharedOpt" checked={stackCards} onChange={(e) => setStackCards(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="stackCardsSharedOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)' }}>
                  {t('shared.stackDuplicates')}
                </label>
              </div>
              {stackCards && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <input type="checkbox" id="stackByConditionSharedOpt" checked={stackByCondition} onChange={(e) => setStackByCondition(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByConditionSharedOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('shared.separateByCondition')}
                    </label>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <input type="checkbox" id="stackByPrintingSharedOpt" checked={stackByPrinting} onChange={(e) => setStackByPrinting(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByPrintingSharedOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('shared.separateByPrinting')}
                    </label>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Card grid */}
      {processedCollection.length === 0 ? (
        <div className="glass-panel" style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('collection.noMatches')}
        </div>
      ) : (
        <div className="card-grid">
          {processedCollection.map(card => {
            const rarity = (card.rarity || '').toLowerCase();
            const isUltra = rarity.includes('rare') || rarity.includes('secret') || rarity.includes('promo') || rarity.includes('ultra');
            return (
              <div key={card.entry_id} className="tcg-card tilt-card-wrapper" onClick={() => setActiveCard(card)}>
                <div className={`tcg-card-inner ${isUltra ? 'rarity-glow-ultra' : ''}`}>
                  <CardImage card={card} className="tcg-card-image" loading="lazy" />
                  {getFoilOverlayClass(card.printing) && (
                    <div className={getFoilOverlayClass(card.printing)} style={{ borderRadius: 'var(--radius-sm)' }} />
                  )}
                  {getPrintingBadgeLabel(card.printing) && (
                    <span style={{ position: 'absolute', top: '6px', left: '6px', fontSize: '0.6rem', fontWeight: 800, padding: '2px 5px', borderRadius: '3px', zIndex: 6, ...getPrintingBadgeStyle(card.printing) }}>
                      {getPrintingBadgeLabel(card.printing)}
                    </span>
                  )}
                  {card.quantity > 1 && (
                    <div className="tcg-card-quantity-tag">x{card.quantity}</div>
                  )}
                </div>
                <div className="tcg-card-info">
                  <div className="tcg-card-name">{displayName(card)}</div>
                  <div className="tcg-card-meta">
                    <span style={{ fontSize: '0.7rem' }}>{card.set_name} • #{card.number}</span>
                    <span className="tcg-card-price">{priceText(card.price_trend, card.price_currency)}</span>
                  </div>
                  {shareLocations && card.location && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                      <MapPin size={11} /> {card.location}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Read-only Card Detail Modal */}
      {activeCard && (
        <div className="modal-overlay" style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999, padding: '1rem'
        }} onClick={() => setActiveCard(null)}>
          <div className="glass-panel" style={{ maxWidth: '680px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '2rem', display: 'flex', flexWrap: 'wrap', gap: '2rem', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setActiveCard(null)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <div style={{ flex: '1 1 240px', display: 'flex', justifyContent: 'center' }}>
              <CardImage card={activeCard} style={{ width: '100%', maxWidth: '260px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.5), 0 0 15px rgba(255,255,255,0.05)' }} />
            </div>
            <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '1rem', justifyContent: 'center' }}>
              <div>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(234,179,8,0.1)', color: 'var(--accent-yellow)', border: '1px solid rgba(234,179,8,0.2)', display: 'inline-block', marginBottom: '0.5rem' }}>
                  {activeCard.rarity || t('shared.rarityCommon')}
                </span>
                <h3 style={{ fontSize: '1.5rem', color: 'var(--text-strong)', lineHeight: 1.2 }}>{activeCard.name}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{activeCard.set_name} • {t('shared.cardNumber', { number: activeCard.number })}</p>
              </div>
              <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '1rem', display: 'flex', gap: '2rem' }}>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('shared.estMarketPrice')}</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>{priceText(activeCard.price_trend, activeCard.price_currency)}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('shared.quantity')}</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--text-strong)' }}>x{activeCard.quantity}</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}><strong>{t('shared.cardDetails')}</strong></div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.8rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{t('inspector.specSupertype')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.supertype}</span>
                  {activeCard.types.length > 0 && (<><span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{t('shared.specTypes')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.types.join(', ')}</span></>)}
                  {activeCard.subtypes.length > 0 && (<><span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{t('shared.specSubtypes')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.subtypes.join(', ')}</span></>)}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{t('inspector.specCondition')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.condition}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{t('inspector.specPrinting')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.printing}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{t('inspector.specLanguage')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.language}</span>
                </div>
                {shareLocations && activeCard.location && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    <MapPin size={13} style={{ color: 'var(--accent-red)' }} />
                    <span style={{ color: 'var(--text-muted)' }}>{t('inspector.locationLabel')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.location}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SharedCollection;
