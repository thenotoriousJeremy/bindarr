// The colour each card category is painted in, across the three games. The
// values are the ones the Dashboard's type chart already uses (and the --type-*
// tokens in index.css for the Pokémon energy types), plus the buckets a chart of
// types never needed: Multicolor, and Trainer and Energy, which have no type.
export const CARD_COLORS = {
  // Pokémon energy types
  Grass: '#4ade80',
  Fire: '#f87171',
  Water: '#60a5fa',
  Lightning: '#facc15',
  Psychic: '#c084fc',
  Fighting: '#f97316',
  Darkness: '#475569',
  Metal: '#94a3b8',
  Dragon: '#a855f7',
  Fairy: '#f472b6',
  Colorless: '#cbd5e1',
  Trainer: '#a8a29e',
  Energy: '#78716c',
  // Magic colours
  White: '#fef08a',
  Blue: '#3b82f6',
  Black: '#334155',
  Red: '#ef4444',
  Green: '#10b981',
  // Lorcana inks
  Amber: '#f59e0b',
  Amethyst: '#a855f7',
  Emerald: '#10b981',
  Ruby: '#ef4444',
  Sapphire: '#3b82f6',
  Steel: '#94a3b8',
  // More than one colour, type or ink
  Multicolor: '#d4a017',
};

// For a category none of the games above define.
export const UNKNOWN_CARD_COLOR = '#6b7280';

export function cardColor(category) {
  return CARD_COLORS[category] || UNKNOWN_CARD_COLOR;
}
