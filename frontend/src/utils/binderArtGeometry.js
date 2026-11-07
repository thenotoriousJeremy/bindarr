// Geometry for binder artwork (issue #104), all in millimetres until the very
// last step that turns a pocket into canvas pixels.
//
// Adapted from michiGeometry.js in jimbo19922003's fork (commit 9b2617af,
// "binder artwork planning and actual-size pocket inserts", MIT licence). Added
// here: pocket spacing, image-pixel crop rectangles and canvas matrices, page
// overlays for the binder view, and optional placement labels on the print.
//
// The model: one picture, placed on a page (or a two-page spread) by its centre,
// one width and a rotation. Its own aspect gives the height, so nothing is ever
// stretched. The pockets listed in the mask show the picture; every other pocket
// keeps holding a real card and is never printed.

import { pageGrid } from './binderLayout.js';

export const PAPERS = {
  a4: { id: 'a4', name: 'A4', widthMm: 210, heightMm: 297, cssSize: 'A4' },
  letter: { id: 'letter', name: 'US Letter', widthMm: 215.9, heightMm: 279.4, cssSize: 'letter' },
};

// A standard card insert is 63 x 88 mm; a toploader pocket is larger.
export const POCKET_PRESETS = {
  card: { widthMm: 63, heightMm: 88, gapMm: 0 },
  toploader: { widthMm: 76, heightMm: 102, gapMm: 0 },
};

export const PRINT_DPI = 300;
export const CALIBRATION_MM = 50;
const MM_PER_INCH = 25.4;

export function pocketPresetFor(locationType) {
  return locationType === 'Toploader Binder' ? POCKET_PRESETS.toploader : POCKET_PRESETS.card;
}

export function mmToPx(mm, dpi = PRINT_DPI) {
  return (mm / MM_PER_INCH) * dpi;
}

// One page of pockets. Spacing sits between neighbouring pockets only, which is
// how a pocket page is built: the picture under a seam is simply not printed.
export function pageGeometry({ columns, rows, widthMm, heightMm, gapMm = 0 }) {
  const cols = Math.max(1, columns | 0);
  const rowCount = Math.max(1, rows | 0);
  const w = Number(widthMm);
  const h = Number(heightMm);
  const gap = Math.max(0, Number(gapMm) || 0);
  if (!(w > 0) || !(h > 0)) throw new TypeError('A pocket needs a positive width and height in millimetres.');
  return {
    columns: cols,
    rows: rowCount,
    pocketWidthMm: w,
    pocketHeightMm: h,
    gapMm: gap,
    widthMm: cols * w + (cols - 1) * gap,
    heightMm: rowCount * h + (rowCount - 1) * gap,
  };
}

// The page, or the page and its facing page side by side. The pages are one
// pocket gap apart, the same seam as between two pockets.
export function compositionOf(anchor, facing, spread) {
  const useFacing = !!(spread && facing);
  const pages = [{ side: 'left', page: anchor, originX: 0, originY: 0 }];
  if (useFacing) pages.push({ side: 'right', page: facing, originX: anchor.widthMm + anchor.gapMm, originY: 0 });
  return {
    spread: useFacing,
    widthMm: useFacing ? anchor.widthMm + anchor.gapMm + facing.widthMm : anchor.widthMm,
    heightMm: useFacing ? Math.max(anchor.heightMm, facing.heightMm) : anchor.heightMm,
    pages,
  };
}

export function pocketRect(composition, side, row, col) {
  const placed = composition.pages.find(p => p.side === side);
  if (!placed) return null;
  const { page, originX, originY } = placed;
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= page.rows || col >= page.columns) return null;
  return {
    side,
    row,
    col,
    x: originX + col * (page.pocketWidthMm + page.gapMm),
    y: originY + row * (page.pocketHeightMm + page.gapMm),
    widthMm: page.pocketWidthMm,
    heightMm: page.pocketHeightMm,
  };
}

// Every pocket of the composition, which is what a fresh upload shows on.
export function fullMask(composition) {
  const mask = [];
  for (const placed of composition.pages) {
    for (let row = 0; row < placed.page.rows; row += 1) {
      for (let col = 0; col < placed.page.columns; col += 1) mask.push({ side: placed.side, row, col });
    }
  }
  return mask;
}

// A layout change keeps the millimetre placement and drops pockets that no
// longer exist.
export function remapMask(mask, composition) {
  return (mask || []).filter(e => pocketRect(composition, e.side || 'left', e.row, e.col));
}

export function imageHeightMm(aspect, widthMm) {
  if (!(aspect > 0) || !(widthMm > 0)) throw new TypeError('Artwork needs its own aspect ratio and a width.');
  return widthMm / aspect;
}

// Centred and just large enough to cover the whole composition.
export function coverTransform(composition, aspect) {
  if (!(aspect > 0)) throw new TypeError('Artwork needs its own aspect ratio.');
  return {
    xMm: composition.widthMm / 2,
    yMm: composition.heightMm / 2,
    widthMm: Math.max(composition.widthMm, composition.heightMm * aspect),
    rotationDeg: 0,
  };
}

function rotate(x, y, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: x * c - y * s, y: x * s + y * c };
}

// Page millimetres to picture coordinates (0..1 across, 0..1 down).
export function pagePointToImageUv(point, aspect, transform) {
  const h = imageHeightMm(aspect, transform.widthMm);
  const local = rotate(point.x - transform.xMm, point.y - transform.yMm, -(transform.rotationDeg || 0));
  return { u: local.x / transform.widthMm + 0.5, v: local.y / h + 0.5 };
}

// The pockets that show the picture, as page rectangles.
export function artworkSlices({ composition, mask }) {
  const slices = [];
  for (const entry of mask || []) {
    const rect = pocketRect(composition, entry.side || 'left', entry.row, entry.col);
    if (rect) slices.push(rect);
  }
  return slices;
}

// The 2D matrix (canvas setTransform order: a, b, c, d, e, f) that draws the
// picture's own pixels into one pocket's canvas at `dpi`. Drawing the whole
// image through it and letting the canvas clip is what crops the piece, and it
// handles rotation for free.
export function pieceMatrix({ pocket, transform, image, dpi = PRINT_DPI }) {
  const aspect = image.width / image.height;
  const s = mmToPx(1, dpi); // canvas px per mm
  const k = transform.widthMm / image.width; // mm per image px
  const rad = ((transform.rotationDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const half = rotate(transform.widthMm / 2, imageHeightMm(aspect, transform.widthMm) / 2, transform.rotationDeg || 0);
  return [
    s * k * cos,
    s * k * sin,
    -s * k * sin,
    s * k * cos,
    s * (transform.xMm - half.x - pocket.x),
    s * (transform.yMm - half.y - pocket.y),
  ];
}

export function pieceSizePx(pocket, dpi = PRINT_DPI) {
  return { width: Math.round(mmToPx(pocket.widthMm, dpi)), height: Math.round(mmToPx(pocket.heightMm, dpi)) };
}

// Which part of the picture, in its own pixels, lands in a pocket: the bounding
// box of the pocket's corners mapped back through the matrix. Unrotated, this is
// exactly the crop rectangle; it can run past the picture's edge, where the
// insert prints blank.
export function pieceSourceRect({ pocket, transform, image }) {
  const [a, b, c, d, e, f] = pieceMatrix({ pocket, transform, image, dpi: MM_PER_INCH });
  const det = a * d - b * c;
  const toImage = (x, y) => ({ x: (d * (x - e) - c * (y - f)) / det, y: (-b * (x - e) + a * (y - f)) / det });
  // At dpi = 25.4 one canvas px is one mm, so the corners are the pocket size.
  const corners = [[0, 0], [pocket.widthMm, 0], [pocket.widthMm, pocket.heightMm], [0, pocket.heightMm]].map(([x, y]) => toImage(x, y));
  const xs = corners.map(p => p.x);
  const ys = corners.map(p => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// CSS for the picture inside one pocket element, in percentages of that pocket,
// so the binder view can show each piece in its real pocket at any zoom.
export function pocketImageStyle(pocket, transform) {
  return {
    leftPct: ((transform.xMm - pocket.x) / pocket.widthMm) * 100,
    topPct: ((transform.yMm - pocket.y) / pocket.heightMm) * 100,
    widthPct: (transform.widthMm / pocket.widthMm) * 100,
    rotationDeg: transform.rotationDeg || 0,
  };
}

export function layerTransform(layer) {
  return { xMm: layer.x_mm, yMm: layer.y_mm, widthMm: layer.width_mm, rotationDeg: layer.rotation_deg || 0 };
}

export function layerPage(layer, compartment, pageColumns) {
  return pageGeometry({
    ...pageGrid(compartment.capacity, pageColumns),
    widthMm: layer.pocket_w_mm,
    heightMm: layer.pocket_h_mm,
    gapMm: layer.gap_mm,
  });
}

// Every saved layer turned into what the binder view draws: for each page, the
// pockets (0-based slot index) that show artwork and how. A spread layer reaches
// onto the page after its own. A page's own layer wins over a spread reaching
// onto it, so the later pass overwrites.
export function artPocketsByPage({ layers, compartments, pageColumns }) {
  const out = new Map();
  const indexOf = new Map(compartments.map((c, i) => [c.id, i]));
  const ordered = [...(layers || [])].sort((x, y) => Number(!!y.spread) - Number(!!x.spread));
  for (const layer of ordered) {
    const idx = indexOf.get(layer.compartment_id);
    if (idx == null) continue;
    const anchor = compartments[idx];
    const facing = layer.spread ? compartments[idx + 1] || null : null;
    const anchorPage = layerPage(layer, anchor, pageColumns);
    const facingPage = facing ? layerPage(layer, facing, pageColumns) : null;
    const composition = compositionOf(anchorPage, facingPage, !!facing);
    const transform = layerTransform(layer);
    const pagesBySide = { left: { id: anchor.id, page: anchorPage }, right: facing ? { id: facing.id, page: facingPage } : null };
    for (const rect of artworkSlices({ composition, mask: layer.mask })) {
      const target = pagesBySide[rect.side];
      if (!target) continue;
      if (!out.has(target.id)) out.set(target.id, new Map());
      out.get(target.id).set(rect.row * target.page.columns + rect.col, {
        artworkId: layer.artwork_id,
        imageUrl: layer.image_url || null,
        style: pocketImageStyle(rect, transform),
      });
    }
  }
  return out;
}

function cutGuides(tile, markMm) {
  const { x, y, widthMm: w, heightMm: h } = tile;
  const m = markMm;
  return [
    { x1: x - m, y1: y, x2: x, y2: y }, { x1: x, y1: y - m, x2: x, y2: y },
    { x1: x + w, y1: y, x2: x + w + m, y2: y }, { x1: x + w, y1: y - m, x2: x + w, y2: y },
    { x1: x - m, y1: y + h, x2: x, y2: y + h }, { x1: x, y1: y + h, x2: x, y2: y + h + m },
    { x1: x + w, y1: y + h, x2: x + w + m, y2: y + h }, { x1: x + w, y1: y + h, x2: x + w, y2: y + h + m },
  ];
}

// Lay the pieces out on sheets at actual size, row by row. A piece that cannot
// fit the printable area at 100% is reported rather than shrunk: a scaled insert
// is the wrong size for its pocket. The defaults fit a 3 x 3 page of 63 x 88 mm
// inserts on one A4 sheet (2 rows on Letter). A label sits in the gap under its
// tile, so labels only cost height below the last row.
export const LABEL_MM = 4;
export function packInserts({ slices, paper, marginMm = 5, gapMm = 5, labels = false, guideMm = 2, markerBandMm = 8 }) {
  const labelMm = labels ? LABEL_MM : 0;
  const innerW = paper.widthMm - marginMm * 2;
  const usableH = paper.heightMm - marginMm * 2 - markerBandMm;
  const sheets = [];
  const rejected = [];
  let sheet = null;
  let x = 0;
  let y = 0;
  let rowH = 0;
  const open = () => {
    sheet = {
      paper: paper.id,
      widthMm: paper.widthMm,
      heightMm: paper.heightMm,
      markerMm: Math.min(CALIBRATION_MM, innerW),
      markerX: marginMm,
      markerY: paper.heightMm - marginMm - markerBandMm / 2,
      tiles: [],
    };
    sheets.push(sheet);
    x = 0;
    y = 0;
    rowH = 0;
  };
  for (const slice of slices) {
    if (slice.widthMm > innerW || slice.heightMm + labelMm > usableH) {
      rejected.push(slice);
      continue;
    }
    if (!sheet) open();
    if (x > 0 && x + slice.widthMm > innerW) {
      y += rowH + Math.max(gapMm, labelMm);
      x = 0;
      rowH = 0;
    }
    if (y + slice.heightMm + labelMm > usableH) open();
    const tile = { ...slice, x: marginMm + x, y: marginMm + y };
    tile.guides = cutGuides(tile, guideMm);
    if (labels) tile.label = { x: tile.x, y: tile.y + slice.heightMm + 1, widthMm: slice.widthMm };
    sheet.tiles.push(tile);
    x += slice.widthMm + gapMm;
    rowH = Math.max(rowH, slice.heightMm);
  }
  return { sheets, rejected };
}
