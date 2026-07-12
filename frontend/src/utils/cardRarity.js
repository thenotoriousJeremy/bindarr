// Single source of truth for the rarity tiers used across LocationManager's
// visualizers (card border glow, badge color, badge label).
export function getRarityTier(rarity) {
  const r = (rarity || '').toLowerCase();
  if (r.includes('secret') || r.includes('ultra') || r.includes('hyper') || r.includes('illustration') || r.includes('double rare') || r.includes('shiny rare') || r.includes('classic collection')) {
    return 'top';
  }
  if (r.includes('rare') || r.includes('promo')) return 'rare';
  if (r.includes('uncommon')) return 'uncommon';
  return 'common';
}

// Scarcity rank for sorting: higher = rarer. Checked rarest-keyword first so
// "Rare Secret" scores as secret, not plain rare, and "Uncommon" before
// "Common" (it contains the substring). Unknown rarities score 0 (before
// Common on ascending). Must stay aligned with RARITY_RANK in
// backend/src/utils/compartmentSort.js so display order matches placement.
const RARITY_RANK = [
  { kw: 'classic collection', rank: 16 },
  { kw: 'hyper', rank: 15 },
  { kw: 'special illustration', rank: 14 },
  { kw: 'illustration', rank: 13 },
  { kw: 'secret', rank: 12 },
  { kw: 'ultra', rank: 11 },
  { kw: 'radiant', rank: 10 },
  { kw: 'amazing', rank: 9 },
  { kw: 'shiny', rank: 8 },
  { kw: 'double rare', rank: 7 },
  { kw: 'mythic', rank: 6 },
  { kw: 'rare holo', rank: 5 },
  { kw: 'holo rare', rank: 5 },
  { kw: 'promo', rank: 4 },
  { kw: 'rare', rank: 3 },
  { kw: 'uncommon', rank: 2 },
  { kw: 'common', rank: 1 },
];

export function getRarityRank(rarity) {
  const r = (rarity || '').toLowerCase();
  for (const { kw, rank } of RARITY_RANK) {
    if (r.includes(kw)) return rank;
  }
  return 0;
}

export function getCardRarityBorder(rarity) {
  switch (getRarityTier(rarity)) {
    case 'top':
      return {
        border: '2.5px solid #f59e0b',
        boxShadow: '0 0 12px rgba(245, 158, 11, 0.95), inset 0 0 6px rgba(245, 158, 11, 0.5)'
      };
    case 'rare':
      return {
        border: '2px solid #e2e8f0',
        boxShadow: '0 0 8px rgba(255, 255, 255, 0.85), inset 0 0 4px rgba(255, 255, 255, 0.4)'
      };
    case 'uncommon':
      return {
        border: '1.5px solid #3b82f6',
        boxShadow: '0 0 6px rgba(59, 130, 246, 0.8)'
      };
    default:
      return {
        border: '1px solid rgba(255, 255, 255, 0.3)',
        boxShadow: 'none'
      };
  }
}

export function getRarityBadgeStyle(rarity) {
  const tier = getRarityTier(rarity);
  const background = tier === 'top' ? '#f59e0b'
    : tier === 'rare' ? '#e2e8f0'
    : tier === 'uncommon' ? '#3b82f6'
    : 'rgba(156, 163, 175, 0.75)';
  const color = tier === 'rare' ? '#000' : '#fff';
  return { background, color };
}

export function getRarityBadgeLabel(rarity) {
  const r = (rarity || '').toLowerCase();
  if (r.includes('secret') || r.includes('ultra') || r.includes('hyper') || r.includes('illustration')) return 'ULTRA';
  if (r.includes('double rare')) return 'DR';
  if (r.includes('shiny rare')) return 'SR';
  if (r.includes('rare')) return 'RARE';
  if (r.includes('promo')) return 'PROMO';
  if (r.includes('uncommon')) return 'UNC';
  return 'COM';
}
