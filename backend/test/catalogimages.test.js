// What a catalog build downloads, and when it may skip the download.
//
// embedUrl decides the image the scanner is matched against; artKey decides
// whether a vector from the last build is still good. Both are about bandwidth:
// measured 2026-11-15, TCGdex's WebP is ~4x smaller than its PNG (73 KB vs 290
// KB at 600x825) and embeds to the same vector (cosine 0.996-0.999 against the
// PNG, where two different cards score ~0.32), so switching formats must NOT
// re-download a catalog's worth of art. A resolution change must.
//
// No framework — plain node + assert. Run: `node test/catalogimages.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-catalogimages-${process.pid}.db`);
const catalog = require('../src/catalog');

const T = 'https://assets.tcgdex.net/en/sv/sv01/001';

// TCGdex: thumbnails of either format embed from the 600px WebP.
for (const src of [`${T}/low.png`, `${T}/low.webp`, `${T}/high.png`, `${T}/low.jpg`]) {
  assert.strictEqual(catalog.embedUrl({ id: 'tcgdex-en-sv01-001', image_url: src }), `${T}/high.webp`, src);
}
// Japanese assets live under the same scheme.
assert.strictEqual(
  catalog.embedUrl({ id: 'tcgdex-ja-SV2a-004', image_url: 'https://assets.tcgdex.net/ja/SV/SV2a/004/low.webp' }),
  'https://assets.tcgdex.net/ja/SV/SV2a/004/high.webp');

// pokemontcg.io: the 245px `small` image upscaled to 448 is a blur; embed the hi-res.
assert.strictEqual(catalog.embedUrl({ id: 'sv1-1', image_url: 'https://images.pokemontcg.io/sv1/1.png' }),
  'https://images.pokemontcg.io/sv1/1_hires.png');
assert.strictEqual(catalog.embedUrl({ id: 'sv1-1', image_url: 'https://images.pokemontcg.io/sv1/1_hires.png' }),
  'https://images.pokemontcg.io/sv1/1_hires.png', 'already hi-res is left alone');

// Lorcast and Scryfall keep their behaviour.
assert.strictEqual(catalog.embedUrl({ id: 'lorcana-x', image_url: 'https://cards.lorcast.io/card/digital/normal/crd_1.avif?17' }),
  'https://cards.lorcast.io/card/digital/large/crd_1.avif?17');
const scry = 'https://cards.scryfall.io/normal/front/3/7/374c9fc8.jpg?1783945751';
assert.strictEqual(catalog.embedUrl({ id: 'mtg-374c9fc8', image_url: scry }), scry);

// artKey: same picture, same resolution => same key.
assert.strictEqual(catalog.artKey(`${T}/high.png`), catalog.artKey(`${T}/high.webp`),
  'a vector embedded from the PNG is reused for the WebP');
assert.notStrictEqual(catalog.artKey(`${T}/low.png`), catalog.artKey(`${T}/high.webp`),
  'a resolution change re-embeds');
assert.notStrictEqual(catalog.artKey(scry), catalog.artKey(scry.replace('1783945751', '1790000000')),
  "Scryfall's timestamp changes when a card is rescanned, and that must re-embed");
assert.notStrictEqual(catalog.artKey('https://images.pokemontcg.io/sv1/1.png'),
  catalog.artKey('https://images.pokemontcg.io/sv1/1_hires.png'), 'pokemontcg.io thumbnails are rebuilt from hi-res');
assert.strictEqual(catalog.artKey(undefined), '');

console.log('catalogimages.test.js: all assertions passed');
process.exit(0);
