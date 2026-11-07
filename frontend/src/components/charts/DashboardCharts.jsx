import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, AreaChart, Area } from 'recharts';
import { useT } from '../../utils/i18n';

// The Dashboard's plots, in their own module so recharts loads after the
// Dashboard's numbers and lists instead of holding up its first paint. Each one
// fills the sized .chart-container its caller wraps it in.

// `symbol` is the display currency the values were converted into (useFx).
export function ValueTimeline({ data, symbol }) {
  const { t } = useT();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--type-grass)" stopOpacity={0.4}/>
            <stop offset="95%" stopColor="var(--type-grass)" stopOpacity={0.0}/>
          </linearGradient>
        </defs>
        <XAxis dataKey="date" stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} />
        <YAxis stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} tickFormatter={(v) => `${symbol}${v}`} />
        <Tooltip
          contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
          labelStyle={{ color: 'var(--text-primary)' }}
          formatter={(v) => [`${symbol}${v}`, t('dash.portfolioValue')]}
        />
        <Area type="monotone" dataKey="value" stroke="var(--type-grass)" strokeWidth={2} fillOpacity={1} fill="url(#colorVal)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function SetValueBars({ data, symbol }) {
  const { t } = useT();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ left: 10, right: 30, top: 10, bottom: 10 }}>
        <XAxis type="number" stroke="var(--text-secondary)" tickFormatter={(v) => `${symbol}${v}`} />
        <YAxis dataKey="name" type="category" width={120} stroke="var(--text-secondary)" tickLine={false} axisLine={false} style={{ fontSize: '0.8rem' }} />
        <Tooltip
          contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
          labelStyle={{ color: 'var(--text-primary)' }}
          formatter={(v) => [`${symbol}${v}`, t('dash.value')]}
        />
        <Bar dataKey="value" fill="var(--accent-red)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// The type and rarity donuts: the same chart over a different slice, with the
// slice colour read from `colorKey` on each entry.
export function DistributionDonut({ data, colorKey, innerRadius, outerRadius, legendEllipsis = false }) {
  const { t } = useT();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={innerRadius}
          outerRadius={outerRadius}
          paddingAngle={3}
          dataKey="value"
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry[colorKey]} />
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
          formatter={(value) => <span style={legendEllipsis ? { color: 'var(--text-secondary)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : { color: 'var(--text-secondary)' }}>{value}</span>}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
