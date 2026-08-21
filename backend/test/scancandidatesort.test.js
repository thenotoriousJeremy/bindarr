const assert = require('assert');
const sharp = require('sharp');
const cvScan = require('../src/cvScan');

async function noise() {
  const w = 448, h = 448;
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) % 251;
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

async function main() {
  // Test 1: Empty or single card inputs return cleanly
  const empty = await cvScan.scoreCards(null, 'mtg', []);
  assert.deepStrictEqual(empty, []);

  const single = [{ id: 'mtg-test-1', name: 'Test Card' }];
  const singleRes = await cvScan.scoreCards(await noise(), 'mtg', single);
  assert.strictEqual(singleRes.length, 1);

  // Test 2: If catalog is built, scoreCards sorts and sets scores
  if (cvScan.isBuilt('mtg')) {
    const s = await cvScan.load('mtg');
    if (s && s.ids && s.ids.length >= 2) {
      const topId = String(s.ids[0]).replace(/_back$/, '');
      const secondId = String(s.ids[1]).replace(/_back$/, '');
      
      const cards = [
        { id: `mtg-${secondId}`, name: 'Card B', image_url: 'http://example.com/b.jpg' },
        { id: `mtg-${topId}`, name: 'Card A', image_url: 'http://example.com/a.jpg' },
        { id: 'mtg-nonexistent', name: 'Card C' }
      ];

      const scored = await cvScan.scoreCards(await noise(), 'mtg', cards, { cropped: true });
      assert.strictEqual(scored.length, 3);
      assert.ok(typeof scored[0].score === 'number');
      assert.ok(typeof scored[1].score === 'number');
      assert.ok(scored[0].score >= scored[1].score);
    }
  }

  console.log('scancandidatesort.test.js: all assertions passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
