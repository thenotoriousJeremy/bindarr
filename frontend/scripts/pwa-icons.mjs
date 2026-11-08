// Rasterise public/logo.svg into the icons the web app manifest and iOS need.
//
//   node scripts/pwa-icons.mjs        (from frontend/, after `npm ci` in backend/)
//
// Run by hand when the logo changes; the PNGs are committed, so a build never
// needs sharp. sharp is borrowed from the backend install rather than added to
// the frontend's dependencies for a script that runs once a year.
//
// The logo draws with CSS custom properties so it can follow the theme. Outside a
// page those resolve to nothing and the SVG rasterises as a transparent square,
// so each var(--x, fallback) is replaced by its fallback first.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(path.join(import.meta.dirname, '..', '..', 'backend', 'package.json'));
const sharp = require('sharp');

const BG = '#0a0f1d'; // --bg-primary, and the manifest's background/theme colour
const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'public', 'icons');
const svg = readFileSync(path.join(root, 'public', 'logo.svg'), 'utf8')
  .replace(/var\(--[\w-]+,\s*([^)]+)\)/g, '$1');

// `scale` is how much of the square the logo spans. A maskable icon is cropped to
// the launcher's shape, and only the centre 80% circle is guaranteed to survive,
// so the logo's corners (it is wider than tall) stay inside it at 75%; the others
// keep a small margin so they do not look cramped on a rounded tile.
const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 0.9 },
  { file: 'icon-512.png', size: 512, scale: 0.9 },
  { file: 'icon-maskable-192.png', size: 192, scale: 0.75 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.75 },
  // iOS ignores the manifest's icons and fills transparency with black.
  { file: 'apple-touch-icon.png', size: 180, scale: 0.75 },
];

mkdirSync(out, { recursive: true });
for (const { file, size, scale } of ICONS) {
  const inner = Math.round(size * scale);
  const logo = await sharp(Buffer.from(svg), { density: 72 * (inner / 40) * 2 })
    .resize(inner, inner)
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(out, file));
  console.log(`icons/${file} ${size}x${size}`);
}
