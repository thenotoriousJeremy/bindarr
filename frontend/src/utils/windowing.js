// Windowing math for the long card grids (the collection, the Unsorted queue).
// Pure, so the arithmetic is tested without a DOM; useWindowedGrid measures the
// page and feeds it in.
//
// A grid of `count` items in `cols` columns is `rows` rows, each `stride` px
// apart (row height plus the row gap). Only the rows near the viewport are
// mounted; the ones above and below are stood in for by padding, so the
// scrollbar and the scroll position are those of the whole list. The stride is
// measured from rows that are on screen, never guessed, and every tile in these
// grids is a fixed height (single-line text under a fixed aspect-ratio image),
// so the padding is exact rather than an estimate that drifts.

// The visible slice. viewTop/viewBottom are the viewport's edges in px relative
// to the top of the grid's first row (negative when the grid starts below the
// viewport's top edge). overscanRows extra rows are kept on each side so a
// quick scroll does not show blank space before the next update.
export function windowRange({ count, cols = 1, stride, viewTop, viewBottom, overscanRows = 3 }) {
  const c = Math.max(1, Math.floor(cols) || 1);
  const rows = Math.ceil(Math.max(0, count) / c);
  if (rows === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, firstRow: 0, lastRow: 0 };
  if (!(stride > 0)) {
    // Nothing measured yet: mount a first screenful so there is something to measure.
    const lastRow = Math.min(rows, overscanRows * 2 + 4);
    return { start: 0, end: Math.min(count, lastRow * c), padTop: 0, padBottom: 0, firstRow: 0, lastRow };
  }
  const top = Math.min(viewTop, viewBottom);
  const bottom = Math.max(viewTop, viewBottom);
  let firstRow = Math.floor(top / stride) - overscanRows;
  let lastRow = Math.ceil(bottom / stride) + overscanRows;
  firstRow = Math.min(Math.max(0, firstRow), rows);
  lastRow = Math.min(Math.max(firstRow, lastRow), rows);
  // Scrolled clean past the grid (a long page above or below it): keep at
  // least one row mounted at the near end, so there is a row to measure.
  if (lastRow === firstRow) {
    if (firstRow >= rows) firstRow = rows - 1;
    lastRow = firstRow + 1;
  }
  return {
    start: firstRow * c,
    end: Math.min(count, lastRow * c),
    padTop: firstRow * stride,
    padBottom: (rows - lastRow) * stride,
    firstRow,
    lastRow,
  };
}

// The number of tracks in a resolved grid-template-columns value
// ("180px 180px 180px", or "repeat(3, 180px)" from some engines). 1 for a
// non-grid ("none") or anything unparseable.
export function trackCount(template) {
  const value = String(template || '').trim();
  if (!value || value === 'none') return 1;
  let count = 0;
  const rest = value.replace(/repeat\(\s*(\d+)\s*,[^)]*\)/g, (_, n) => { count += Number(n); return ' '; });
  // Line names in brackets are not tracks.
  count += rest.replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, count);
}

// Row stride from the tops of the rendered items' rows: the distance from the
// first rendered row to the last, over the rows between them. One rendered row
// falls back to its height plus the gap.
export function measureStride(rowTops, firstHeight, rowGap = 0) {
  if (rowTops.length >= 2) {
    const span = rowTops[rowTops.length - 1] - rowTops[0];
    if (span > 0) return span / (rowTops.length - 1);
  }
  return firstHeight > 0 ? firstHeight + rowGap : 0;
}

// Scroll target for one item: the top of its row, relative to the grid.
export const rowOffset = (index, cols, stride) => Math.floor(index / Math.max(1, cols)) * stride;
