import { useState, useEffect, useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { formatPrice } from '../utils/formatPrice';

// Selectable chart windows. Default is 1 Year so price movement is visible; a
// 30-day window is usually too short to show meaningful change.
const RANGE_OPTIONS = [
  { key: '1m', label: '1M', name: '30 Days' },
  { key: '1y', label: '1Y', name: '1 Year' },
  { key: '5y', label: '5Y', name: '5 Years' },
];

// Shared, properly-proportioned price-history chart. Fetches its own data for a
// given card id and lets the user switch the time window. Give it real vertical
// room and let the YAxis reserve enough width for "$1,234" style ticks.
export default function PriceHistoryChart({
  cardId,
  height = 150,
  defaultRange = '1y',
  titlePrefix = 'Price History',
}) {
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState([]);
  const [insufficientHistory, setInsufficientHistory] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!cardId) {
      setData([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/cards/${cardId}/price-history?range=${range}`);
        if (response.ok) {
          const json = await response.json();
          if (!cancelled) {
            setData(json.data ?? []);
            setInsufficientHistory(!!json.insufficientHistory);
          }
        }
      } catch (err) {
        console.error('Error fetching price history:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cardId, range]);

  const chartData = useMemo(
    () => (data || []).map(d => ({ ...d, ts: new Date(d.recorded_at).getTime() })),
    [data]
  );

  const { pctChange, absChange } = useMemo(() => {
    if (!data || data.length < 2) return { pctChange: null, absChange: null };
    const first = data[0]?.price ?? 0;
    const last = data[data.length - 1]?.price ?? 0;
    const abs = last - first;
    const pct = first > 0 ? (abs / first) * 100 : 0;
    return { pctChange: pct, absChange: abs };
  }, [data]);

  if (!cardId) return null;

  const up = (pctChange ?? 0) >= 0;
  const trendColor = up ? '#22c55e' : '#ef4444';
  const rangeName = RANGE_OPTIONS.find(r => r.key === range)?.name ?? '';

  return (
    <div style={{
      width: '100%',
      background: 'rgba(0,0,0,0.15)',
      padding: '0.75rem',
      borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border-glass)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px', gap: '0.5rem' }}>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {titlePrefix} ({rangeName})
        </span>
        {pctChange !== null && (
          <span style={{ fontSize: '0.7rem', fontWeight: 800, color: trendColor }}>
            {up ? '▲' : '▼'} {up ? '+' : ''}${formatPrice(Math.abs(absChange))} ({up ? '+' : '−'}{Math.abs(pctChange).toFixed(1)}%)
          </span>
        )}
      </div>

      {/* Range selector */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
        {RANGE_OPTIONS.map(opt => (
          <button
            key={opt.key}
            onClick={() => setRange(opt.key)}
            aria-pressed={range === opt.key}
            style={{
              flex: 1,
              padding: '3px 0',
              fontSize: '0.62rem',
              fontWeight: 700,
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-glass)',
              background: range === opt.key ? 'var(--accent-yellow)' : 'transparent',
              color: range === opt.key ? '#000' : 'var(--text-secondary)',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div style={{ width: '100%', height: `${height}px` }}>
        {loading ? (
          <div className="spinner" style={{ height: '30px', margin: `${Math.max(0, height / 2 - 15)}px auto` }} />
        ) : insufficientHistory ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
            Not enough price history yet for this range.
          </div>
        ) : (!chartData || chartData.length === 0) ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            No price data for this window.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="priceGlow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent-yellow)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--accent-yellow)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} hide />
              <YAxis
                domain={['auto', 'auto']}
                stroke="var(--text-secondary)"
                style={{ fontSize: '0.6rem' }}
                width={48}
                tickFormatter={(v) => `$${formatPrice(v)}`}
              />
              <Tooltip
                contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)', borderRadius: '8px', fontSize: '0.75rem' }}
                labelStyle={{ color: 'var(--text-secondary)' }}
                formatter={(val) => [`$${formatPrice(val)}`, 'Market']}
                labelFormatter={(label) => (label ? new Date(label).toLocaleDateString() : '')}
              />
              <Area type="monotone" dataKey="price" stroke="var(--accent-yellow)" strokeWidth={1.75} fillOpacity={1} fill="url(#priceGlow)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
