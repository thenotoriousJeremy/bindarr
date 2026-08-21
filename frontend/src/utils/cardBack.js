// The image a card falls back to when nobody has art for it — a Bindarr card
// back, drawn rather than fetched.
//
// Drawn, for three reasons. It costs no network round trip at the exact moment
// the network already failed us; it keeps working on an instance with no internet
// at all, which is a normal way to run a self-hosted collection tracker; and it
// avoids shipping the real Pokémon/Wizards card backs, which are their artwork,
// not ours. (Scryfall does serve a Magic back at cards.scryfall.io/back.png if a
// more authentic Magic-only look is ever wanted — no Pokémon API serves one.)
//
// Emitted as a data URI so it drops straight into the same <img src> as real art
// and every existing width/aspect-ratio/object-fit style keeps applying. Note
// that a data-URI SVG in an <img> is its own document: it cannot read the page's
// CSS custom properties, so the palette below is written out literally.

// 718x1000 is the 0.718 aspect the card grids already lay out with, so the
// fallback occupies exactly the same box as the art it stands in for.
const W = 718;
const H = 1000;

// Per-game accents. The frame is shared so a mixed Pokémon/Magic/Lorcana grid of missing
// art still reads as one set of backs rather than two unrelated placeholders.
const THEMES = {
  pokemon: { glow: '#60a5fa', ring: '#facc15' },
  mtg: { glow: '#a855f7', ring: '#cbd5e1' },
  lorcana: { glow: '#eab308', ring: '#f59e0b' },
  default: { glow: '#ff4747', ring: '#cbd5e1' },
};

// The five Magic colours, in WUBRG order, as pips around the emblem. Matches the
// colours CardInspectorModal already uses for its colour-identity chips.
const WUBRG = ['#f8f6d8', '#0e68ab', '#2b2422', '#d3202a', '#00733e'];

// Five pips on a circle, starting at the top and going clockwise.
function manaPips(cx, cy, r) {
  return WUBRG.map((fill, i) => {
    const a = (i / 5) * 2 * Math.PI - Math.PI / 2;
    const x = (cx + r * Math.cos(a)).toFixed(1);
    const y = (cy + r * Math.sin(a)).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="26" fill="${fill}" stroke="#0b1120" stroke-width="5"/>`;
  }).join('');
}

// The six Lorcana Inks: Amber, Amethyst, Emerald, Ruby, Sapphire, Steel.
const LORCANA_INKS = ['#f59e0b', '#a855f7', '#10b981', '#ef4444', '#3b82f6', '#94a3b8'];

function inkPips(cx, cy, r) {
  return LORCANA_INKS.map((fill, i) => {
    const a = (i / 6) * 2 * Math.PI - Math.PI / 2;
    const x = (cx + r * Math.cos(a)).toFixed(1);
    const y = (cy + r * Math.sin(a)).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="22" fill="${fill}" stroke="#0b1120" stroke-width="4"/>`;
  }).join('');
}

// The three binder rings from the Bindarr logo, stood on end. This is the mark on
// the Pokémon and generic backs; Magic and Lorcana get their resource pips.
function binderRings(cx, cy) {
  return [-150, 0, 150]
    .map(dy => `<path d="M ${cx - 78} ${cy + dy} A 78 78 0 0 1 ${cx + 78} ${cy + dy}"
        fill="none" stroke="#0b1120" stroke-width="34" stroke-linecap="round"/>
      <path d="M ${cx - 78} ${cy + dy} A 78 78 0 0 1 ${cx + 78} ${cy + dy}"
        fill="none" stroke="#e2e8f0" stroke-width="16" stroke-linecap="round" opacity="0.85"/>`)
    .join('');
}

function svg(game) {
  const t = THEMES[game] || THEMES.default;
  const cx = W / 2;
  const cy = H / 2;
  const isMtg = game === 'mtg';
  const isLorcana = game === 'lorcana';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <radialGradient id="field" cx="50%" cy="42%" r="72%">
      <stop offset="0%" stop-color="#1c2740"/>
      <stop offset="100%" stop-color="#0a0f1d"/>
    </radialGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#33405e"/>
      <stop offset="100%" stop-color="#151d31"/>
    </linearGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${t.glow}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${t.glow}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="lattice" width="56" height="56" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <path d="M0 0 H56 M0 0 V56" stroke="#ffffff" stroke-opacity="0.035" stroke-width="2"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" rx="40" fill="url(#edge)"/>
  <rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="22" fill="url(#field)"/>
  <rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="22" fill="url(#lattice)"/>
  <rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="22"
        fill="none" stroke="${t.ring}" stroke-opacity="0.22" stroke-width="3"/>
  <rect x="52" y="52" width="${W - 104}" height="${H - 104}" rx="12"
        fill="none" stroke="#ffffff" stroke-opacity="0.06" stroke-width="2"/>

  <circle cx="${cx}" cy="${cy}" r="300" fill="url(#halo)"/>
  <circle cx="${cx}" cy="${cy}" r="212" fill="none" stroke="${t.ring}" stroke-opacity="0.28" stroke-width="4"/>
  <circle cx="${cx}" cy="${cy}" r="188" fill="#0b1120" fill-opacity="0.55"/>

  ${isMtg ? manaPips(cx, cy, 132) : (isLorcana ? inkPips(cx, cy, 132) : binderRings(cx, cy))}

  <text x="${cx}" y="${H - 92}" text-anchor="middle"
        font-family="Outfit, 'Plus Jakarta Sans', system-ui, sans-serif"
        font-size="40" font-weight="800" letter-spacing="14"
        fill="#ffffff" fill-opacity="0.22">BINDARR</text>
</svg>`;
}

// encodeURIComponent rather than base64: a plain-text data URI is ~30% smaller
// than the base64 of the same bytes, and stays greppable in devtools.
const toDataUri = (s) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.replace(/\s+/g, ' '))}`;

// Built once at module load — three small strings, reused by every <img> on the
// page, so a grid of 200 artless cards shares one decoded image per game.
const BACKS = {
  pokemon: toDataUri(svg('pokemon')),
  mtg: toDataUri(svg('mtg')),
  lorcana: toDataUri(svg('lorcana')),
  default: toDataUri(svg('default')),
};

// `game` comes off the card row and is 'pokemon' | 'mtg' | 'lorcana' in practice; anything
// else (or nothing, as on a partially-hydrated scan result) gets the neutral back.
export const cardBackFor = (game) => BACKS[game] || BACKS.default;

export default BACKS;
