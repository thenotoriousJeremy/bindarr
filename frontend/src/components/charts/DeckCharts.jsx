import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';

// The deck analytics plots, in their own module so recharts is fetched when a
// deck's stats are first drawn instead of with the deck list. Each one fills the
// sized box its caller wraps it in.

const TOOLTIP_STYLE = { background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-strong)' };

export function CostCurveBars({ data }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
        <XAxis dataKey="cost" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
        <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// `colors` is shared with the legend the caller draws beside it.
export function SupertypeDonut({ data, colors }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={70}
          paddingAngle={3}
          dataKey="value"
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
          ))}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}

const TYPE_COLORS = {
  'White': '#fef08a', 'Blue': '#3b82f6', 'Black': '#475569', 'Red': '#ef4444', 'Green': '#10b981', 'Colorless': '#cbd5e1',
  'Land (Plains)': '#fef08a', 'Land (Island)': '#60a5fa', 'Land (Swamp)': '#475569', 'Land (Mountain)': '#f87171', 'Land (Forest)': '#4ade80', 'Land (Nonbasic)': '#d97706',
  'Grass': '#4ade80', 'Fire': '#f87171', 'Water': '#60a5fa', 'Lightning': '#facc15', 'Psychic': '#c084fc', 'Fighting': '#f97316', 'Darkness': '#475569', 'Metal': '#94a3b8', 'Dragon': '#a855f7', 'Fairy': '#f472b6'
};

export function TypeBars({ data }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
        <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
        <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="value" fill="var(--accent-yellow)" radius={[4, 4, 0, 0]}>
          {data.map((entry, idx) => (
            <Cell key={`cell-${idx}`} fill={TYPE_COLORS[entry.name] || 'var(--accent-yellow)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
