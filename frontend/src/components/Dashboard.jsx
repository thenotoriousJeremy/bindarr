import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, AreaChart, Area } from 'recharts';
import { TrendingUp, Coins, Library, Trophy, Plus, ArrowUpRight } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { formatPrice, priceText } from '../utils/formatPrice';
import { getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import { defaultGameFilter, gameOptions, showGamePicker, gameLabel } from '../utils/games';
import { useT } from '../utils/i18n';
import CardInspectorModal from './CardInspectorModal';
import CardImage from './CardImage';

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
  'Colorless': '#cbd5e1',
  'White': '#fef08a',
  'Blue': '#3b82f6',
  'Black': '#334155',
  'Red': '#ef4444',
  'Green': '#10b981',
  'Land': '#d97706',
  'Amber': '#f59e0b',
  'Amethyst': '#a855f7',
  'Emerald': '#10b981',
  'Ruby': '#ef4444',
  'Sapphire': '#3b82f6',
  'Steel': '#94a3b8'
};

function Dashboard({ statsTrigger, onNavigate, setSelectedLocationId, setFocusEntryId, onUpdate, showToast }) {
  const { t, locale } = useT();
  // Money and dates follow the interface language, not the browser's: a user who
  // picked German sees 1.234,56 and 3.8.2026 even on an en-US browser.
  const money = (n) => (n || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [timePeriod, setTimePeriod] = useState('30d');
  // '' | 'pokemon' | 'mtg'. Collapses to the only visible game when the other is
  // hidden in Settings, so the totals never include cards the user cannot see.
  const [gameFilter, setGameFilter] = useState(() => defaultGameFilter());
  
  // Timeline Chart State
  const [historyData, setHistoryData] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Clickable Card Inspector State
  const [inspectorCard, setInspectorCard] = useState(null);

  useEffect(() => {
    fetchStats();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTrigger, gameFilter]);

  useEffect(() => {
    if (stats && stats.summary.totalCards > 0) {
      fetchTimelineHistory();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timePeriod, stats, gameFilter]);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/stats${gameFilter ? `?game=${gameFilter}` : ''}`);
      if (!response.ok) {
        throw new Error(t('dash.errStats'));
      }
      const data = await response.json();
      setStats(data);
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchTimelineHistory = async () => {
    try {
      setLoadingHistory(true);
      const response = await fetch(`/api/stats/history?period=${timePeriod}${gameFilter ? `&game=${gameFilter}` : ''}`);
      if (response.ok) {
        const data = await response.json();
        setHistoryData(data);
      }
    } catch (err) {
      console.error('Error loading history timeline:', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  const renderGameTabs = () => {
    // One game shown: "All" and that game are the same list, so there is nothing
    // to switch between.
    if (!showGamePicker()) return null;
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
        <div className="sub-nav-tabs" style={{ margin: 0 }}>
          {[['', t('dash.allGames')], ...gameOptions().map(g => [g.value, g.short])].map(([val, label]) => (
            <button
              key={val || 'all'}
              type="button"
              className={`sub-nav-tab ${gameFilter === val ? 'active' : ''}`}
              style={{ padding: '0.35rem 0.85rem', fontSize: '0.75rem' }}
              onClick={() => setGameFilter(val)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  };

  if (loading) {
    return <div className="spinner"></div>;
  }

  if (error) {
    return (
      <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <p>{t('dash.errLoad', { error })}</p>
        <button className="btn btn-primary" onClick={fetchStats} style={{ marginTop: '1rem' }}>{t('dash.retry')}</button>
      </div>
    );
  }

  if (!stats || stats.summary.totalCards === 0) {
    const isFiltered = Boolean(gameFilter);
    const gameName = isFiltered ? gameLabel(gameFilter, true) : '';
    return (
      <div>
        {renderGameTabs()}
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem 1.5rem', color: 'var(--text-secondary)' }}>
          <TrendingUp size={48} style={{ color: 'var(--accent-red)', marginBottom: '1.5rem', opacity: 0.8 }} />
          <h2 style={{ color: 'var(--text-strong)', marginBottom: '0.5rem' }}>
            {isFiltered ? t('dash.emptyFilteredTitle', { game: gameName }) : t('dash.emptyTitle')}
          </h2>
          <p style={{ maxWidth: '400px', margin: '0 auto 1.5rem auto' }}>
            {isFiltered ? t('dash.emptyFilteredBody', { game: gameName }) : t('dash.emptyBody')}
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
            <div style={{ display: 'inline-block' }}>
              <button className="btn btn-primary" onClick={() => onNavigate && onNavigate('add-cards')}>{t('dash.goToAddCards')}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { summary, types, rarities, sets, topValuable, recentAdditions = [], setProgress } = stats;

  // Match type name to its color case-insensitively; fall back to a distinct
  // palette color by index so slices are never all the same gray.
  const typeColorLookup = Object.fromEntries(
    Object.entries(TYPE_COLORS).map(([k, v]) => [k.toLowerCase(), v])
  );
  const typeChartData = types.map((t, i) => {
    const fill = typeColorLookup[String(t.name).toLowerCase()] || COLORS[i % COLORS.length];
    return { name: t.name, value: t.value, color: fill, fill };
  });
  const rarityChartData = rarities.map((r, i) => ({ ...r, fill: COLORS[i % COLORS.length] }));

  return (
    <div>
      {renderGameTabs()}

      {/* Metrics Summary Grid */}
      <div className="metrics-grid">
        {/* Net Worth Card with historical switcher */}
        <div className="glass-panel metric-card accent-networth">
          <div className="metric-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="metric-icon" style={{ width: '28px', height: '28px' }}><TrendingUp size={16} /></span>
              {t('dash.netWorth')}
            </span>
            <div style={{ display: 'flex', gap: '4px', background: 'rgba(255,255,255,0.05)', padding: '2px', borderRadius: '4px' }}>
              {['7d', '30d', '1y', '5y'].map(p => (
                <button 
                  key={p} 
                  type="button" 
                  onClick={() => setTimePeriod(p)}
                  style={{
                    padding: '2px 6px',
                    fontSize: '0.65rem',
                    border: 'none',
                    borderRadius: '3px',
                    background: timePeriod === p ? 'var(--type-grass)' : 'transparent',
                    color: 'var(--text-strong)',
                    cursor: 'pointer',
                    fontWeight: 700,
                    transition: 'all 0.15s ease'
                  }}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="metric-value">${money(summary.totalValue)}</div>
          {(() => {
            const change = timePeriod === '7d' ? summary.change7d :
                           timePeriod === '30d' ? summary.change30d :
                           timePeriod === '1y' ? summary.change1y : summary.change5y;
            // change7d/30d use Cardmarket's real avg7/avg30 (only real source
            // available); change1y/5y have no real historical price source
            // anywhere, so they're marked unavailable rather than faked.
            if (!change || !change.available) {
              return (
                <div className="metric-footer" style={{ color: 'var(--text-muted)' }}>
                  <span>{t('dash.noPriceHistory')}</span>
                </div>
              );
            }
            const isPositive = change.abs >= 0;
            return (
              <div className={`metric-footer ${isPositive ? 'positive' : 'negative'}`} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <TrendingUp size={12} style={{ transform: isPositive ? 'none' : 'rotate(180deg)' }} />
                <span>
                  {isPositive ? '+' : ''}${money(change.abs)} ({isPositive ? '+' : ''}{change.pct}%)
                </span>
              </div>
            );
          })()}
        </div>

        {/* Total Invested (cost basis) */}
        <div className="glass-panel metric-card accent-invested">
          <div className="metric-header">
            <span>{t('dash.totalInvested')}</span>
            <span className="metric-icon"><Coins size={18} /></span>
          </div>
          <div className="metric-value">${money(summary.totalSpent)}</div>
          <div className="metric-footer">
            <span>{t('dash.avgPerCard', { price: formatPrice(summary.avgCardValue) })}</span>
          </div>
        </div>

        {/* Unrealized Gain / ROI */}
        {(() => {
          const roi = summary.roi || { abs: 0, pct: null };
          const isPositive = (roi.abs || 0) >= 0;
          return (
            <div className={`glass-panel metric-card ${isPositive ? 'accent-gain-up' : 'accent-gain-down'}`}>
              <div className="metric-header">
                <span>{t('dash.unrealizedGain')}</span>
                <span className="metric-icon"><ArrowUpRight size={18} style={{ transform: isPositive ? 'none' : 'rotate(90deg)' }} /></span>
              </div>
              <div className="metric-value" style={{ color: isPositive ? '#22c55e' : '#ef4444' }}>
                {isPositive ? '+' : '−'}${money(Math.abs(roi.abs || 0))}
              </div>
              <div className="metric-footer">
                <span>{roi.pct === null ? t('dash.roiUnset') : t('dash.roiVsCost', { pct: `${isPositive ? '+' : ''}${roi.pct}` })}</span>
              </div>
            </div>
          );
        })()}

        {/* Total Cards count */}
        <div className="glass-panel metric-card accent-cards">
          <div className="metric-header">
            <span>{t('dash.totalCards')}</span>
            <span className="metric-icon"><Library size={18} /></span>
          </div>
          <div className="metric-value">{summary.totalCards}</div>
          <div className="metric-footer">
            <span>{t('dash.uniqueCount', { count: summary.uniqueCards })}{summary.unsortedCount > 0 ? ` • ${t('dash.unsortedCount', { count: summary.unsortedCount })}` : ''}</span>
          </div>
        </div>
      </div>

      {/* Net Worth History Timeline Chart */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1.5rem 1.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 className="chart-title" style={{ margin: 0 }}>{t('dash.timelineTitle')}</h3>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {t('dash.timelineRange', { range: timePeriod.toUpperCase() })}
          </span>
        </div>
        <div className="chart-container" style={{ height: '240px', position: 'relative' }}>
          {loadingHistory ? (
            <div className="spinner" style={{ position: 'absolute', top: '45%', left: '45%' }}></div>
          ) : historyData.length < 2 ? (
            <div className="chart-empty">{t('dash.notEnoughHistory')}</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={historyData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--type-grass)" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="var(--type-grass)" stopOpacity={0.0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} />
                <YAxis stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} tickFormatter={(v) => `$${v}`} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                  formatter={(v) => [`$${v}`, t('dash.portfolioValue')]}
                />
                <Area type="monotone" dataKey="value" stroke="var(--type-grass)" strokeWidth={2} fillOpacity={1} fill="url(#colorVal)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Main Charts & Analytics Details */}
      <div className="dashboard-details">
        {/* Left Column: Charts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Card Value by Set Chart */}
          <div className="glass-panel">
            <h3 className="chart-title">{t('dash.valueBySet')}</h3>
            <div className="chart-container">
              {sets.length === 0 ? (
                <div className="chart-empty">{t('dash.noSetData')}</div>
              ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sets} layout="vertical" margin={{ left: 10, right: 30, top: 10, bottom: 10 }}>
                  <XAxis type="number" stroke="var(--text-secondary)" tickFormatter={(v) => `$${v}`} />
                  <YAxis dataKey="name" type="category" width={120} stroke="var(--text-secondary)" tickLine={false} axisLine={false} style={{ fontSize: '0.8rem' }} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                    formatter={(v) => [`$${v}`, t('dash.value')]}
                  />
                  <Bar dataKey="value" fill="var(--accent-red)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
            {/* Type Distribution Donut Chart */}
            <div className="glass-panel">
              <h3 className="chart-title">{t(gameFilter === 'mtg' ? 'dash.colorDistribution' : 'dash.typeDistribution')}</h3>
              <div className="chart-container" style={{ height: '220px' }}>
                {typeChartData.length === 0 ? (
                  <div className="chart-empty">{t('dash.noTypeData')}</div>
                ) : (
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
                      itemStyle={{ color: 'var(--text-strong)' }}
                      labelStyle={{ color: 'var(--text-strong)' }}
                      formatter={(v) => [v, t('dash.cards')]}
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
                )}
              </div>
            </div>

            {/* Rarity Distribution Chart */}
            <div className="glass-panel">
              <h3 className="chart-title">{t('dash.rarityDistribution')}</h3>
              <div className="chart-container" style={{ height: '220px' }}>
                {rarityChartData.length === 0 ? (
                  <div className="chart-empty">{t('dash.noRarityData')}</div>
                ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={rarityChartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={78}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {rarityChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                      itemStyle={{ color: 'var(--text-strong)' }}
                      labelStyle={{ color: 'var(--text-strong)' }}
                      formatter={(v) => [v, t('dash.cards')]}
                    />
                    <Legend 
                      verticalAlign="bottom" 
                      height={36} 
                      iconSize={10} 
                      style={{ fontSize: '0.75rem' }} 
                      formatter={(value) => <span style={{ color: 'var(--text-secondary)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Mini Tables & Lists */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Top Valuable Cards */}
          <div className="glass-panel" style={{ flex: 1 }}>
            <h3 className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Trophy size={18} style={{ color: 'var(--accent-yellow)' }} />
              {t('dash.topValuable')}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.25rem' }}>
              {topValuable.map((card, idx) => (
                <div 
                  key={idx} 
                  onClick={() => setInspectorCard(card)}
                  style={{ 
                    display: 'flex', 
                    gap: '0.75rem', 
                    alignItems: 'center', 
                    background: 'rgba(255, 255, 255, 0.02)', 
                    padding: '0.5rem', 
                    borderRadius: 'var(--radius-sm)', 
                    border: '1px solid var(--border-glass)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                  className="dashboard-card-clickable"
                >
                  <CardImage card={card} style={{ width: '56px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '5px', boxShadow: '0 2px 6px rgba(0,0,0,0.4)' }} />
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {getCardDisplayName(card.name, card.language, card.printed_name)}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <span>{card.set_name} • {card.rarity}</span>
                      {card.printing && card.printing !== 'Normal' && (
                        <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', flexShrink: 0, ...getPrintingBadgeStyle(card.printing) }}>
                          {getPrintingBadgeLabel(card.printing)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 800, color: 'var(--accent-yellow)', fontSize: '0.95rem' }}>{priceText(card.price_trend, card.price_currency)}<span style={{ fontSize: '0.6rem', fontWeight: 500, color: 'var(--text-muted)' }}> {t('dash.each')}</span></div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {card.quantity > 1 ? t('dash.qtyTotal', { qty: card.quantity, price: formatPrice(card.price_trend * card.quantity) }) : t('dash.qty', { qty: 1 })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Additions */}
          {recentAdditions.length > 0 && (
            <div className="glass-panel" style={{ flex: 1 }}>
              <h3 className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Plus size={18} style={{ color: 'var(--accent-blue)' }} />
                {t('dash.recentAdditions')}
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '1.25rem' }}>
                {recentAdditions.map((card, idx) => (
                  <div
                    key={idx}
                    onClick={() => setInspectorCard(card)}
                    style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', background: 'rgba(255, 255, 255, 0.02)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', cursor: 'pointer', transition: 'all 0.2s ease' }}
                    className="dashboard-card-clickable"
                  >
                    <CardImage card={card} style={{ width: '48px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '5px', boxShadow: '0 2px 6px rgba(0,0,0,0.4)' }} />
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {getCardDisplayName(card.name, card.language, card.printed_name)}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <span>{card.set_name} • #{card.number}</span>
                        {card.printing && card.printing !== 'Normal' && (
                          <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', flexShrink: 0, ...getPrintingBadgeStyle(card.printing) }}>
                            {getPrintingBadgeLabel(card.printing)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, color: 'var(--accent-yellow)', fontSize: '0.8rem' }}>{priceText(card.price_trend, card.price_currency)}<span style={{ fontSize: '0.55rem', fontWeight: 500, color: 'var(--text-muted)' }}> {t('dash.each')}</span></div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{card.quantity > 1 ? t('dash.qty', { qty: card.quantity }) : (card.added_at ? new Date(card.added_at).toLocaleDateString(locale) : '')}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Set Completion progress tracker */}
          {setProgress.length > 0 && (
            <div className="glass-panel">
              <h3 className="chart-title">{t('dash.setProgress')}</h3>
              <div className="set-progress-grid" style={{ marginTop: '1rem' }}>
                {setProgress.map((set, idx) => (
                  <div key={idx} className="set-progress-item">
                    <div className="set-progress-header">
                      <span style={{ color: 'var(--text-strong)' }}>{set.setName}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{set.ownedUnique} / {set.totalCards} ({set.percent}%)</span>
                    </div>
                    <div className="set-progress-bar-bg">
                      <div className="set-progress-bar-fill" style={{ width: `${set.percent}%` }}></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Card Inspector Modal Overlay */}
      <CardInspectorModal
        card={inspectorCard}
        onClose={() => setInspectorCard(null)}
        onUpdate={onUpdate}
        showToast={showToast}
        onViewStorage={(card) => {
          if (setSelectedLocationId) setSelectedLocationId(card.location_id || 'unsorted');
          if (setFocusEntryId) setFocusEntryId(card.entry_id || card.id);
          onNavigate('storage');
          setInspectorCard(null);
        }}
      />
    </div>
  );
}

export default Dashboard;
