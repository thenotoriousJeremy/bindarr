import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, AreaChart, Area } from 'recharts';
import { TrendingUp, Coins, Library, Trophy, Plus, ArrowUpRight } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { formatPrice } from '../utils/formatPrice';
import { getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import CardInspectorModal from './CardInspectorModal';

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

function Dashboard({ statsTrigger, onNavigate, setSelectedLocationId, onUpdate, showToast }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [timePeriod, setTimePeriod] = useState('30d');
  
  // Timeline Chart State
  const [historyData, setHistoryData] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Clickable Card Inspector State
  const [inspectorCard, setInspectorCard] = useState(null);

  useEffect(() => {
    fetchStats();
  }, [statsTrigger]);

  useEffect(() => {
    if (stats && stats.summary.totalCards > 0) {
      fetchTimelineHistory();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timePeriod, stats]);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/stats');
      if (!response.ok) {
        throw new Error('Failed to load stats');
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
      const response = await fetch(`/api/stats/history?period=${timePeriod}`);
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

  if (loading) {
    return <div className="spinner"></div>;
  }

  if (error) {
    return (
      <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <p>Error loading dashboard statistics: {error}</p>
        <button className="btn btn-primary" onClick={fetchStats} style={{ marginTop: '1rem' }}>Retry</button>
      </div>
    );
  }

  if (!stats || stats.summary.totalCards === 0) {
    return (
      <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem 1.5rem', color: 'var(--text-secondary)' }}>
        <TrendingUp size={48} style={{ color: 'var(--accent-red)', marginBottom: '1.5rem', opacity: 0.8 }} />
        <h2 style={{ color: '#fff', marginBottom: '0.5rem' }}>Welcome to Pokedexrr!</h2>
        <p style={{ maxWidth: '400px', margin: '0 auto 1.5rem auto' }}>
          Your collection database is currently empty. Start scanning cards with your phone camera or search cards manually to build your binder!
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
          <div style={{ display: 'inline-block' }}>
            <span style={{ fontSize: '0.85rem', display: 'block', marginBottom: '0.25rem' }}>Scan with Camera</span>
            <button className="btn btn-primary" onClick={() => onNavigate && onNavigate('add-cards')}>Go to Add Cards</button>
          </div>
        </div>
      </div>
    );
  }

  const { summary, types, rarities, sets, topValuable, recentAdditions = [], setProgress } = stats;

  const typeChartData = types.map(t => ({
    name: t.name,
    value: t.value,
    color: TYPE_COLORS[t.name] || '#94a3b8'
  }));

  return (
    <div>
      {/* Metrics Summary Grid */}
      <div className="metrics-grid">
        {/* Net Worth Card with historical switcher */}
        <div className="glass-panel metric-card">
          <div className="metric-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Net Worth</span>
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
                    background: timePeriod === p ? 'var(--accent-red)' : 'transparent',
                    color: '#fff',
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
          <div className="metric-value">${summary.totalValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
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
                  <span>Not enough price history yet for this range</span>
                </div>
              );
            }
            const isPositive = change.abs >= 0;
            return (
              <div className={`metric-footer ${isPositive ? 'positive' : 'negative'}`} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <TrendingUp size={12} style={{ transform: isPositive ? 'none' : 'rotate(180deg)' }} />
                <span>
                  {isPositive ? '+' : ''}${change.abs.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} ({isPositive ? '+' : ''}{change.pct}%)
                </span>
              </div>
            );
          })()}
        </div>

        {/* Total Invested (cost basis) */}
        <div className="glass-panel metric-card">
          <div className="metric-header">
            <span>Total Invested</span>
            <Coins size={18} style={{ color: 'var(--accent-yellow)' }} />
          </div>
          <div className="metric-value">${(summary.totalSpent || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
          <div className="metric-footer">
            <span>Avg ${formatPrice(summary.avgCardValue)} / card</span>
          </div>
        </div>

        {/* Unrealized Gain / ROI */}
        {(() => {
          const roi = summary.roi || { abs: 0, pct: null };
          const isPositive = (roi.abs || 0) >= 0;
          return (
            <div className="glass-panel metric-card">
              <div className="metric-header">
                <span>Unrealized Gain</span>
                <ArrowUpRight size={18} style={{ color: isPositive ? '#22c55e' : '#ef4444', transform: isPositive ? 'none' : 'rotate(90deg)' }} />
              </div>
              <div className="metric-value" style={{ color: isPositive ? '#22c55e' : '#ef4444' }}>
                {isPositive ? '+' : '−'}${Math.abs(roi.abs || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
              </div>
              <div className="metric-footer">
                <span>{roi.pct === null ? 'Set purchase prices to track ROI' : `${isPositive ? '+' : ''}${roi.pct}% vs cost basis`}</span>
              </div>
            </div>
          );
        })()}

        {/* Total Cards count */}
        <div className="glass-panel metric-card">
          <div className="metric-header">
            <span>Total Cards Owned</span>
            <Library size={18} />
          </div>
          <div className="metric-value">{summary.totalCards}</div>
          <div className="metric-footer">
            <span>{summary.uniqueCards} unique{summary.unsortedCount > 0 ? ` • ${summary.unsortedCount} unsorted` : ''}</span>
          </div>
        </div>
      </div>

      {/* Net Worth History Timeline Chart */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1.5rem 1.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 className="chart-title" style={{ margin: 0 }}>Net Worth Valuation Timeline</h3>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            Showing performance history ({timePeriod.toUpperCase()})
          </span>
        </div>
        <div className="chart-container" style={{ height: '240px', position: 'relative' }}>
          {loadingHistory ? (
            <div className="spinner" style={{ position: 'absolute', top: '45%', left: '45%' }}></div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={historyData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--accent-red)" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="var(--accent-red)" stopOpacity={0.0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} />
                <YAxis stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} tickFormatter={(v) => `$${v}`} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                  formatter={(v) => [`$${v}`, 'Portfolio Value']}
                />
                <Area type="monotone" dataKey="value" stroke="var(--accent-red)" strokeWidth={2} fillOpacity={1} fill="url(#colorVal)" />
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
            <h3 className="chart-title">Collection Value by Set</h3>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sets} layout="vertical" margin={{ left: 10, right: 30, top: 10, bottom: 10 }}>
                  <XAxis type="number" stroke="var(--text-secondary)" tickFormatter={(v) => `$${v}`} />
                  <YAxis dataKey="name" type="category" width={120} stroke="var(--text-secondary)" tickLine={false} axisLine={false} style={{ fontSize: '0.8rem' }} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                    formatter={(v) => [`$${v}`, 'Value']}
                  />
                  <Bar dataKey="value" fill="var(--accent-red)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
            {/* Type Distribution Donut Chart */}
            <div className="glass-panel">
              <h3 className="chart-title">Energy Type Distribution</h3>
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

            {/* Rarity Distribution Chart */}
            <div className="glass-panel">
              <h3 className="chart-title">Rarity Distribution</h3>
              <div className="chart-container" style={{ height: '220px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={rarities}
                      cx="50%"
                      cy="50%"
                      innerRadius={0}
                      outerRadius={75}
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
                      formatter={(value) => <span style={{ color: 'var(--text-secondary)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
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
              Top Valuable Cards
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
                  <img src={card.image_url} alt={card.name} style={{ width: '40px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '4px' }} />
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {getCardDisplayName(card.name, card.language)}
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
                    <div style={{ fontWeight: 800, color: 'var(--accent-yellow)', fontSize: '0.95rem' }}>${formatPrice(card.price_trend)}<span style={{ fontSize: '0.6rem', fontWeight: 500, color: 'var(--text-muted)' }}> ea</span></div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {card.quantity > 1 ? `x${card.quantity} • $${formatPrice(card.price_trend * card.quantity)} total` : 'x1'}
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
                Recent Additions
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '1.25rem' }}>
                {recentAdditions.map((card, idx) => (
                  <div
                    key={idx}
                    onClick={() => setInspectorCard(card)}
                    style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', background: 'rgba(255, 255, 255, 0.02)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', cursor: 'pointer', transition: 'all 0.2s ease' }}
                    className="dashboard-card-clickable"
                  >
                    <img src={card.image_url} alt={card.name} style={{ width: '34px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '4px' }} />
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {getCardDisplayName(card.name, card.language)}
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
                      <div style={{ fontWeight: 700, color: 'var(--accent-yellow)', fontSize: '0.8rem' }}>${formatPrice(card.price_trend)}<span style={{ fontSize: '0.55rem', fontWeight: 500, color: 'var(--text-muted)' }}> ea</span></div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{card.quantity > 1 ? `x${card.quantity}` : (card.added_at ? new Date(card.added_at).toLocaleDateString() : '')}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Set Completion progress tracker */}
          {setProgress.length > 0 && (
            <div className="glass-panel">
              <h3 className="chart-title">Set Progress</h3>
              <div className="set-progress-grid" style={{ marginTop: '1rem' }}>
                {setProgress.map((set, idx) => (
                  <div key={idx} className="set-progress-item">
                    <div className="set-progress-header">
                      <span style={{ color: '#fff' }}>{set.setName}</span>
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
          onNavigate('storage');
          setInspectorCard(null);
        }}
      />
    </div>
  );
}

export default Dashboard;
