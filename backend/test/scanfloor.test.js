// A cosine sweep always returns its nearest row, so "not in the catalog" and
// "here is your card" arrive in exactly the same shape. That is how Japanese
// Pokemon scans came back wrong: TCGdex serves card data for 28 of the 177
// Japanese sets it lists, so most Japanese cards had no row and were answered
// with the nearest of the ~3.3k that did.
//
// Three things stop that, and this checks all three:
//   1. cvScan.GAP_FLOOR — a winner that does not stand clear of ranks 2-11 of its
//      own catalog reports `notInCatalog`, and the client refuses to auto-add on
//      it (scripts/measure-scan-floor.js is where the number comes from, and why
//      the gate is a gap rather than an absolute cosine).
//   2. loadAll — a non-English scan sweeps the English catalog too, because the
//      artwork is identical and English has a row for nearly every card the
//      Japanese catalog is missing.
//   3. Set scoping stays per-catalog: a Japanese set id names no row in the
//      English catalog, so that catalog is dropped from a scoped sweep rather
//      than searched unscoped.
//
// Needs the ONNX models, a Japanese Pokemon catalog and network for one card
// image; skips rather than fails without them.
//
// Run: node test/scanfloor.test.js
const assert = require('assert');
const sharp = require('sharp');
const cvScan = require('../src/cvScan');
const db = require('../src/db');

// Structured noise, not flat grey: a uniform frame can trip the corner detector's
// sharpness gate and land in the raw-frame path, which is a different code path
// than the one under test.
async function noise() {
  const w = 600, h = 840;
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) % 251;
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

async function main() {
  if (!cvScan.isBuilt('pokemon', 'Japanese')) {
    console.log('scanfloor.test.js: no Japanese Pokemon catalog — skipped');
    return;
  }
  const s = await cvScan.load('pokemon', 'Japanese');
  if (!s.local || s.lang !== 'Japanese') {
    console.log('scanfloor.test.js: Japanese catalog is a fallback, not a local build — skipped');
    return;
  }

  // 1. Something that is not a card at all must not come back as one.
  const miss = await cvScan.match(await noise(), 'pokemon', 5, { lang: 'Japanese', cropped: true });
  assert.strictEqual(miss.notInCatalog, true,
    `noise scored ${miss.candidates[0]?.score?.toFixed(3)} with gap ${miss.gap?.toFixed(3)}`
    + ` — at or above GAP_FLOOR ${cvScan.GAP_FLOOR}`);
  assert.ok(miss.candidates.length > 0, 'candidates stay on screen as the recovery path');

  // 2. A card that IS catalogued, from the art the catalog was built from.
  const row = await db.get(
    `SELECT id, image_url FROM card_cache WHERE game = 'pokemon' AND language = 'Japanese'
       AND (image_url LIKE '%/low.png' OR image_url LIKE '%/low.webp') ORDER BY id LIMIT 1`
  );
  let art = null;
  try {
    const res = await fetch(row.image_url.replace(/\/low\.(?:png|webp)$/, '/high.webp'),
      { signal: AbortSignal.timeout(20000) });
    if (res.ok) art = Buffer.from(await res.arrayBuffer());
  } catch { /* offline: the hit half of this test is skipped below */ }

  if (art) {
    const hit = await cvScan.match(art, 'pokemon', 5, { lang: 'Japanese', cropped: true });
    assert.strictEqual(hit.notInCatalog, false,
      `${row.id} scored ${hit.candidates[0].score.toFixed(3)} with gap ${hit.gap.toFixed(3)},`
      + ` under GAP_FLOOR ${cvScan.GAP_FLOOR}`);
    assert.strictEqual(hit.candidates[0].cardId, row.id,
      `expected ${row.id}, got ${hit.candidates[0].cardId}`);
    // Both catalogs swept: the English one is what covers the sets TCGdex has no
    // Japanese card data for.
    assert.deepStrictEqual(hit.catalogs, ['Japanese', 'English']);

    // 3. Scoped to a Japanese set, every candidate must come from the Japanese
    // catalog — the English one has no row in that set and must be dropped, not
    // searched unscoped.
    const set = row.id.split('-')[2];
    const scoped = await cvScan.match(art, 'pokemon', 5,
      { lang: 'Japanese', cropped: true, sets: [set] });
    assert.ok(scoped.scopedRows > 0, `no catalog rows in set ${set}`);
    for (const c of scoped.candidates) {
      assert.ok(String(c.cardId).startsWith(`tcgdex-ja-${set}-`),
        `${c.cardId} is outside the scoped set ${set}`);
    }
    console.log(`scanfloor.test.js: gap floor ${cvScan.GAP_FLOOR}, noise rejected, ${row.id} found, `
      + `${scoped.candidates.length} candidates all inside ${set}`);
  } else {
    console.log(`scanfloor.test.js: gap floor ${cvScan.GAP_FLOOR}, noise rejected (card image unreachable)`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
