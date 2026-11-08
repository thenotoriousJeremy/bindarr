import { useState, useEffect, useMemo, Suspense } from 'react';
import { lazyWithReload } from '../utils/lazyWithReload';
import { useFx } from '../utils/useFx';
import { useT } from '../utils/i18n';

// recharts is the largest dependency in the app, and every view that can open a
// card's inspector reaches this component, so the chart itself is code-split:
// the header and range buttons draw at once and the plot follows.
const PriceAreaChart = lazyWithReload(() => import('./charts/PriceAreaChart'));

// Selectable chart windows. Default is 1 Year so price movement is visible; a
// 30-day window is usually too short to show meaningful change.
// Only two windows, because only two can be filled. 30 days comes from
// Cardmarket's real rolling averages (Pokémon); "All" is whatever Bindarr has
// recorded itself. No card API sells back-history — Scryfall returns current
// prices only — so 1Y/5Y buttons could never show anything the 30-day one
// didn't already.
const RANGE_KEYS = ['30d', 'all'];

// Shared, properly-proportioned price-history chart. Fetches its own data for a
// given card id and lets the user switch the time window. Give it real vertical
// room and let the YAxis reserve enough width for "$1,234" style ticks.
export default function PriceHistoryChart({
  cardId,
  // The card's own currency: every stored point is in it. The axis and tooltip
  // convert into the display currency like every other price (utils/useFx), and
  // stay in this one when no rate is known.
  currency,
  height = 150,
  defaultRange = '30d',
  titlePrefix,
}) {
  const { t } = useT();
  const { show } = useFx();
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState([]);
  const [insufficientHistory, setInsufficientHistory] = useState(false);
  const [coverage, setCoverage] = useState({ spanDays: 0, windowDays: null, marketCount: 0, recordedCount: 0 });
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
            setCoverage({
              spanDays: json.spanDays ?? 0,
              windowDays: json.windowDays ?? null,
              marketCount: json.marketCount ?? 0,
              recordedCount: json.recordedCount ?? 0,
            });
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
  const rangeName = RANGE_KEYS.includes(range) ? t(`priceHistory.range.${range}.name`) : '';

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
          {titlePrefix ?? t('priceHistory.title')} ({rangeName})
        </span>
        {pctChange !== null && (
          <span style={{ fontSize: '0.7rem', fontWeight: 800, color: trendColor }}>
            {up ? '▲' : '▼'} {up ? '+' : ''}{show(Math.abs(absChange), currency).text} ({up ? '+' : '−'}{Math.abs(pctChange).toFixed(1)}%)
          </span>
        )}
      </div>

      {/* Range selector */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
        {RANGE_KEYS.map(key => (
          <button
            key={key}
            onClick={() => setRange(key)}
            aria-pressed={range === key}
            style={{
              flex: 1,
              padding: '3px 0',
              fontSize: '0.62rem',
              fontWeight: 700,
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-glass)',
              background: range === key ? 'var(--accent-yellow)' : 'transparent',
              color: range === key ? '#000' : 'var(--text-secondary)',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {t(`priceHistory.range.${key}.label`)}
          </button>
        ))}
      </div>

      {/* Say where the line came from. Cardmarket's rolling averages are real
          market data pulled per request; everything else is what Bindarr has
          watched happen since it was installed. */}
      {!loading && !insufficientHistory && (coverage.marketCount > 0 || coverage.recordedCount > 0) && (
        <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginBottom: '6px', lineHeight: 1.35 }}>
          {coverage.marketCount > 0
            ? t('priceHistory.sourceCardmarket')
            : t('priceHistory.sourceRecorded', { count: coverage.spanDays || 0 })}
          {coverage.marketCount > 0 && coverage.recordedCount > 0
            ? ` + ${t('priceHistory.plusRecorded', { count: coverage.recordedCount })}`
            : ''}
        </div>
      )}

      <div style={{ width: '100%', height: `${height}px` }}>
        {loading ? (
          <div className="spinner" style={{ height: '30px', margin: `${Math.max(0, height / 2 - 15)}px auto` }} />
        ) : insufficientHistory ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
            {t('priceHistory.insufficient')}
          </div>
        ) : (!chartData || chartData.length === 0) ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {t('priceHistory.noData')}
          </div>
        ) : (
          <Suspense fallback={<div className="spinner" style={{ height: '30px', margin: `${Math.max(0, height / 2 - 15)}px auto` }} />}>
            <PriceAreaChart data={chartData} currency={currency} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
