// Single source of truth for how a card's printing/finish is displayed across
// every view (Collection gallery/list, Storage visualizers, inspectors).
//
// Previously each view invented its own badge text ("HOLO" vs "Holo"), colors
// (amber/blue vs amber/gray), and foil overlay treatment, so the same card
// looked different depending on where you saw it. Everything now routes here.

// Short uppercase badge label shown on card thumbnails.
export function getPrintingBadgeLabel(printing) {
  switch (printing) {
    case 'Holofoil': return 'HOLO';
    case 'Reverse Holofoil': return 'REV';
    case '1st Edition': return '1ST';
    case 'Promo': return 'PRM';
    default: return '';
  }
}

// Badge background/text colors. Holo and Reverse Holo are deliberately given
// distinct hues (warm gold vs cool cyan) so they are legible at a glance and
// never mistaken for each other.
export function getPrintingBadgeStyle(printing) {
  switch (printing) {
    case 'Holofoil':
      return { background: 'linear-gradient(135deg, #fbbf24, #f59e0b)', color: '#1a1206' };
    case 'Reverse Holofoil':
      return { background: 'linear-gradient(135deg, #67e8f9, #22d3ee)', color: '#05262b' };
    case '1st Edition':
      return { background: 'linear-gradient(135deg, #c4b5fd, #8b5cf6)', color: '#160a2e' };
    case 'Promo':
      return { background: 'linear-gradient(135deg, #fca5a5, #ef4444)', color: '#2a0606' };
    default:
      return { background: 'rgba(148, 163, 184, 0.85)', color: '#0a0f1d' };
  }
}

// Returns the CSS class for the animated foil overlay, or null for finishes
// that get no shine. Holofoil -> rainbow prism; Reverse Holofoil -> silver sweep.
export function getFoilOverlayClass(printing) {
  if (printing === 'Holofoil') return 'holo-shine-overlay';
  if (printing === 'Reverse Holofoil') return 'reverse-holo-shine-overlay';
  return null;
}

export function isFoil(printing) {
  return printing === 'Holofoil' || printing === 'Reverse Holofoil';
}
