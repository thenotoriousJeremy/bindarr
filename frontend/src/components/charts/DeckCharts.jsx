import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';

// The deck analytics plots, in their own module so recharts is fetched when a
// deck's stats are first drawn instead of with the deck list. Each one fills the
// sized box its caller wraps it in.

// Themed: a fixed dark box under --text-strong was unreadable in the light theme.
const TOOLTIP_STYLE = { background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-strong)' };

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

// Each datum brings its own `color` (deck/DeckStats, from utils/cardColors), so
// its label can be translated without losing it.
export function TypeBars({ data }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
        <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
        <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="value" fill="var(--accent-yellow)" radius={[4, 4, 0, 0]}>
          {data.map((entry, idx) => (
            <Cell key={`cell-${idx}`} fill={entry.color || 'var(--accent-yellow)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
