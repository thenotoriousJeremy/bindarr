import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAPERS, POCKET_PRESETS, CALIBRATION_MM, mmToPx, pageGeometry, compositionOf, pocketRect, fullMask,
  remapMask, coverTransform, pagePointToImageUv, artworkSlices, pieceMatrix, pieceSizePx, pieceSourceRect,
  pocketImageStyle, artPocketsByPage, packInserts, pocketPresetFor,
} from './binderArtGeometry.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nine = (gapMm = 0) => pageGeometry({ columns: 3, rows: 3, widthMm: 63, heightMm: 88, gapMm });

test('mm to px at print resolution', () => {
  near(mmToPx(25.4), 300);
  near(mmToPx(25.4, 600), 600);
  near(mmToPx(63), 744.0944881889764);
  assert.deepEqual(pieceSizePx({ widthMm: 63, heightMm: 88 }), { width: 744, height: 1039 });
});

test('pocket rectangles step by pocket size plus spacing', () => {
  const page = nine(3);
  near(page.widthMm, 3 * 63 + 2 * 3);
  near(page.heightMm, 3 * 88 + 2 * 3);
  const comp = compositionOf(page, null, false);
  assert.deepEqual(pocketRect(comp, 'left', 0, 0), { side: 'left', row: 0, col: 0, x: 0, y: 0, widthMm: 63, heightMm: 88 });
  const mid = pocketRect(comp, 'left', 1, 2);
  near(mid.x, 2 * 66);
  near(mid.y, 91);
  assert.equal(pocketRect(comp, 'left', 3, 0), null);
  assert.equal(pocketRect(comp, 'right', 0, 0), null, 'no right page without a spread');
});

test('a spread puts the facing page one seam to the right', () => {
  const page = nine(2);
  const comp = compositionOf(page, nine(2), true);
  near(comp.widthMm, page.widthMm * 2 + 2);
  const firstRight = pocketRect(comp, 'right', 0, 0);
  near(firstRight.x, page.widthMm + 2);
  assert.equal(fullMask(comp).length, 18);
  assert.equal(compositionOf(page, null, true).spread, false, 'a spread needs a facing page');
});

test('image-to-pocket crop: unrotated cover maps each pocket to its own pixels', () => {
  const page = nine(0);
  const comp = compositionOf(page, null, false);
  // 10 image px per mm, exactly the page's shape.
  const image = { width: 1890, height: 2640 };
  const transform = coverTransform(comp, image.width / image.height);
  near(transform.widthMm, 189);
  const tl = pieceSourceRect({ pocket: pocketRect(comp, 'left', 0, 0), transform, image });
  near(tl.x, 0); near(tl.y, 0); near(tl.width, 630); near(tl.height, 880);
  const br = pieceSourceRect({ pocket: pocketRect(comp, 'left', 2, 2), transform, image });
  near(br.x, 1260); near(br.y, 1760); near(br.width, 630); near(br.height, 880);
});

test('image-to-pocket crop skips the seams between pockets', () => {
  const page = nine(5);
  const comp = compositionOf(page, null, false);
  const image = { width: page.widthMm * 10, height: page.heightMm * 10 };
  const transform = coverTransform(comp, image.width / image.height);
  const rect = pieceSourceRect({ pocket: pocketRect(comp, 'left', 1, 1), transform, image });
  near(rect.x, 680); near(rect.y, 930); near(rect.width, 630); near(rect.height, 880);
});

test('the canvas matrix draws picture pixels at the print resolution', () => {
  const page = nine(0);
  const comp = compositionOf(page, null, false);
  const image = { width: 1890, height: 2640 };
  const transform = coverTransform(comp, image.width / image.height);
  const pocket = pocketRect(comp, 'left', 0, 1);
  const [a, b, c, d, e, f] = pieceMatrix({ pocket, transform, image });
  const apply = (x, y) => ({ x: a * x + c * y + e, y: b * x + d * y + f });
  // The picture pixel at the pocket's top-left corner lands on canvas (0, 0)...
  const origin = apply(630, 0);
  near(origin.x, 0); near(origin.y, 0);
  // ...and the far corner on the canvas size, in 300 dpi pixels.
  const far = apply(1260, 880);
  near(far.x, mmToPx(63)); near(far.y, mmToPx(88));
});

test('rotation turns the crop without a second scale', () => {
  const image = { width: 200, height: 100 };
  const transform = { xMm: 0, yMm: 0, widthMm: 100, rotationDeg: 90 };
  // A 10 mm square centred on the picture is 20 image px square at any angle.
  const rect = pieceSourceRect({ pocket: { x: -5, y: -5, widthMm: 10, heightMm: 10 }, transform, image });
  near(rect.width, 20); near(rect.height, 20);
  near(rect.x, 90); near(rect.y, 40);
  const uv = pagePointToImageUv({ x: 0, y: 25 }, 2, transform);
  near(uv.u, 0.75); near(uv.v, 0.5);
});

test('pocket overlay style positions the picture relative to its pocket', () => {
  const style = pocketImageStyle({ x: 63, y: 88, widthMm: 63, heightMm: 88 }, { xMm: 94.5, yMm: 132, widthMm: 189, rotationDeg: 10 });
  near(style.leftPct, 50); near(style.topPct, 50); near(style.widthPct, 300);
  assert.equal(style.rotationDeg, 10);
});

test('a page layout change drops pockets that no longer exist', () => {
  const after = compositionOf(pageGeometry({ columns: 2, rows: 2, widthMm: 63, heightMm: 88 }), null, false);
  const kept = remapMask([{ side: 'left', row: 0, col: 0 }, { side: 'left', row: 2, col: 2 }], after);
  assert.deepEqual(kept, [{ side: 'left', row: 0, col: 0 }]);
});

test('only masked pockets become slices', () => {
  const comp = compositionOf(nine(), nine(), true);
  const slices = artworkSlices({ composition: comp, mask: [{ side: 'left', row: 0, col: 0 }, { side: 'right', row: 2, col: 2 }, { side: 'left', row: 9, col: 9 }] });
  assert.equal(slices.length, 2);
  assert.ok(slices[1].x > nine().widthMm);
});

test('binder view: a spread reaches the next page, and a page\'s own layer wins', () => {
  const compartments = [{ id: 10, capacity: 9 }, { id: 11, capacity: 9 }, { id: 12, capacity: 9 }];
  const base = { x_mm: 100, y_mm: 132, width_mm: 400, rotation_deg: 0, pocket_w_mm: 63, pocket_h_mm: 88, gap_mm: 0 };
  const layers = [
    { ...base, compartment_id: 11, artwork_id: 2, spread: false, mask: [{ side: 'left', row: 0, col: 0 }] },
    { ...base, compartment_id: 10, artwork_id: 1, spread: true, mask: [{ side: 'left', row: 1, col: 1 }, { side: 'right', row: 0, col: 0 }, { side: 'right', row: 2, col: 1 }] },
  ];
  const map = artPocketsByPage({ layers, compartments, pageColumns: null });
  assert.deepEqual([...map.get(10).keys()], [4]);
  assert.equal(map.get(11).get(0).artworkId, 2, 'own layer overrides the spread on the same pocket');
  assert.equal(map.get(11).get(7).artworkId, 1);
  assert.equal(map.has(12), false);
});

test('inserts pack at actual size on A4 and Letter, with guides and labels', () => {
  const comp = compositionOf(nine(), null, false);
  const slices = artworkSlices({ composition: comp, mask: fullMask(comp) });
  for (const paper of [PAPERS.a4, PAPERS.letter]) {
    const packed = packInserts({ slices, paper, labels: true });
    assert.equal(packed.rejected.length, 0);
    const tiles = packed.sheets.flatMap(s => s.tiles);
    assert.equal(tiles.length, 9);
    for (const tile of tiles) {
      assert.equal(tile.widthMm, 63);
      assert.equal(tile.heightMm, 88);
      assert.equal(tile.guides.length, 8);
      assert.ok(tile.label);
      assert.ok(tile.x >= 5 && tile.x + tile.widthMm <= paper.widthMm - 5 + 1e-9, "inside the 5 mm margin");
      assert.ok(tile.label.y + 3 <= paper.heightMm);
    }
    for (const sheet of packed.sheets) {
      assert.equal(sheet.markerMm, CALIBRATION_MM);
      const bottom = Math.max(...sheet.tiles.map(tile => tile.label.y + 3));
      assert.ok(bottom < sheet.markerY - 1, 'labels clear the calibration line');
    }
    // Three across on both; a whole 3 x 3 page on one A4 sheet, two rows on Letter.
    assert.equal(packed.sheets[0].tiles.filter(tile => tile.y === packed.sheets[0].tiles[0].y).length, 3);
    assert.equal(packed.sheets.length, paper === PAPERS.a4 ? 1 : 2);
  }
  assert.equal(packInserts({ slices: slices.slice(0, 1), paper: PAPERS.a4 }).sheets[0].tiles[0].label, undefined);
});

test('a pocket larger than the printable area is left off, not shrunk', () => {
  const packed = packInserts({ slices: [{ widthMm: 400, heightMm: 400, row: 0, col: 0 }], paper: PAPERS.a4 });
  assert.equal(packed.sheets.length, 0);
  assert.equal(packed.rejected.length, 1);
});

test('toploader binders default to toploader pockets', () => {
  assert.equal(pocketPresetFor('Toploader Binder'), POCKET_PRESETS.toploader);
  assert.equal(pocketPresetFor('Binder').widthMm, 63);
});
