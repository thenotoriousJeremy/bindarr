import { CARD_COLORS } from './cardColors.js';

// Slice colours for the Dashboard's and the public share page's charts, which
// each kept their own copy of these two tables.

// For a slice with no colour of its own (a rarity, a type no game defines), by
// index, so the slices are never all one grey.
export const CHART_PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f43f5e', '#a855f7', '#6366f1',
];

// A type, colour or ink slice takes the category's colour from utils/cardColors,
// the table every chart of card categories shares. Magic's lands are one 'Land'
// slice on these charts (routes/stats.js), which that per-colour table has no
// entry for. Names are matched without regard to case.
const TYPE_CHART_COLORS = Object.fromEntries(
  Object.entries({ ...CARD_COLORS, Land: '#d97706' }).map(([name, color]) => [name.toLowerCase(), color])
);

export function typeChartColor(name, index) {
  return TYPE_CHART_COLORS[String(name).toLowerCase()] || CHART_PALETTE[index % CHART_PALETTE.length];
}
