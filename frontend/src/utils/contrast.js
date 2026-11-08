// WCAG 2.x contrast ratio between two colours, for keeping the theme tokens
// in index.css readable (contrast.test.js checks every [data-theme] block).

// '#rgb' / '#rrggbb' -> [r, g, b] in 0..255, or null for anything else.
export function parseHex(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

// Relative luminance per WCAG 2.x.
export function luminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fg, bg) {
  const a = luminance(typeof fg === 'string' ? parseHex(fg) : fg);
  const b = luminance(typeof bg === 'string' ? parseHex(bg) : bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// The custom properties declared directly in each theme block of a stylesheet:
// { default: {...:root}, light: {...}, pokemon: {...}, ... }. Only plain
// `:root {` and `:root[data-theme="x"] {` blocks count -- not the per-theme
// component rules that merely start with that selector.
export function themeTokens(css) {
  const themes = {};
  const block = /:root(?:\[data-theme="([\w-]+)"\])?\s*\{([^}]*)\}/g;
  let m;
  while ((m = block.exec(css))) {
    const name = m[1] || 'default';
    const vars = themes[name] || (themes[name] = {});
    for (const [, key, value] of m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[key] = value.trim();
  }
  return themes;
}

// 'rgba(r, g, b, a)' painted over an opaque [r, g, b] backdrop -> [r, g, b].
// Plain hex just returns itself.
export function composite(color, backdrop) {
  const hex = parseHex(color);
  if (hex) return hex;
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(String(color).trim());
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return [1, 2, 3].map((i, k) => Number(m[i]) * a + backdrop[k] * (1 - a));
}
