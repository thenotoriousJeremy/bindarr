import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { useFx } from '../../utils/useFx';
import { useT } from '../../utils/i18n';

// The drawing half of PriceHistoryChart, in its own module so recharts is fetched
// when a chart is first drawn rather than with every view that can open a card.
export default function PriceAreaChart({ data, currency }) {
  const { t, locale } = useT();
  const { show } = useFx();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
          tickFormatter={(v) => show(v, currency).text}
        />
        <Tooltip
          contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)', borderRadius: '8px', fontSize: '0.75rem' }}
          labelStyle={{ color: 'var(--text-secondary)' }}
          formatter={(val) => [show(val, currency).text, t('priceHistory.market')]}
          labelFormatter={(label) => (label ? new Date(label).toLocaleDateString(locale) : '')}
        />
        <Area type="monotone" dataKey="price" stroke="var(--accent-yellow)" strokeWidth={1.75} fillOpacity={1} fill="url(#priceGlow)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
