import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend, BarChart, Bar, XAxis, YAxis } from 'recharts';
import { useT } from '../../utils/i18n';

// The shared-collection page's plots, in their own module so a visitor sees the
// owner's numbers and cards without waiting for recharts. Each one fills the
// sized .chart-container its caller wraps it in.

export function SharedSetBars({ data }) {
  const { t } = useT();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ left: 10, right: 30, top: 10, bottom: 10 }}>
        <XAxis type="number" stroke="var(--text-secondary)" tickFormatter={(v) => `$${v}`} />
        <YAxis dataKey="name" type="category" width={120} stroke="var(--text-secondary)" tickLine={false} axisLine={false} style={{ fontSize: '0.8rem' }} />
        <Tooltip contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }} itemStyle={{ color: 'var(--text-strong)' }} labelStyle={{ color: 'var(--text-strong)' }} formatter={(v) => [`$${v}`, t('dash.value')]} />
        <Bar dataKey="value" fill="var(--accent-red)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SharedDonut({ data, colorKey }) {
  const { t } = useT();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
          {data.map((entry, i) => <Cell key={i} fill={entry[colorKey]} />)}
        </Pie>
        <Tooltip contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }} itemStyle={{ color: 'var(--text-strong)' }} labelStyle={{ color: 'var(--text-strong)' }} formatter={(v) => [v, t('dash.cards')]} />
        <Legend verticalAlign="bottom" height={36} iconSize={10} style={{ fontSize: '0.75rem' }}
          formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>} />
      </PieChart>
    </ResponsiveContainer>
  );
}
