import test from 'node:test';
import assert from 'node:assert/strict';
import { windowRange, trackCount, measureStride, rowOffset } from './windowing.js';
import { restOffsets, mergePages, loadCollectionPages } from './collectionPages.js';

test('windowRange mounts the rows in view plus overscan, padding the rest', () => {
  // 1000 items, 4 columns = 250 rows of 300px; viewport 900px tall, scrolled 30 rows in.
  const r = windowRange({ count: 1000, cols: 4, stride: 300, viewTop: 9000, viewBottom: 9900, overscanRows: 2 });
  assert.equal(r.firstRow, 28);
  assert.equal(r.lastRow, 35);
  assert.equal(r.start, 112);
  assert.equal(r.end, 140);
  assert.equal(r.padTop, 28 * 300);
  assert.equal(r.padBottom, (250 - 35) * 300);
  // The padding plus the mounted rows is exactly the height of the whole grid.
  assert.equal(r.padTop + (r.lastRow - r.firstRow) * 300 + r.padBottom, 250 * 300);
});

test('windowRange clamps at both ends and handles a grid that starts below the fold', () => {
  const top = windowRange({ count: 50, cols: 5, stride: 100, viewTop: -400, viewBottom: 300, overscanRows: 1 });
  assert.deepEqual([top.start, top.end, top.padTop], [0, 20, 0], 'rows 0-3: three in view plus one of overscan');
  const end = windowRange({ count: 50, cols: 5, stride: 100, viewTop: 900, viewBottom: 1600, overscanRows: 1 });
  assert.equal(end.end, 50);
  assert.equal(end.padBottom, 0);
  assert.equal(end.start, 40);
});

test('windowRange: a partial last row and a viewport far past the end still mount a row', () => {
  const r = windowRange({ count: 7, cols: 3, stride: 50, viewTop: 5000, viewBottom: 5500 });
  assert.deepEqual([r.firstRow, r.lastRow, r.start, r.end], [2, 3, 6, 7], 'the last, one-item row');
  assert.equal(r.padTop, 100);
  assert.equal(r.padBottom, 0);
});

test('windowRange before anything is measured mounts a first screenful only', () => {
  const r = windowRange({ count: 20000, cols: 6, stride: 0, viewTop: 0, viewBottom: 800, overscanRows: 3 });
  assert.equal(r.start, 0);
  assert.equal(r.end, 10 * 6);
  assert.deepEqual(windowRange({ count: 0, cols: 6, stride: 300, viewTop: 0, viewBottom: 800 }).end, 0);
});

test('trackCount reads resolved grid-template-columns', () => {
  assert.equal(trackCount('180px 180px 180px 180px'), 4);
  assert.equal(trackCount('repeat(3, 120px)'), 3);
  assert.equal(trackCount('[a] 100px [b] 100px'), 2);
  assert.equal(trackCount('none'), 1);
  assert.equal(trackCount(''), 1);
});

test('measureStride uses the spread of rendered rows, or one row plus the gap', () => {
  assert.equal(measureStride([100, 420, 740, 1060], 300, 20), 320);
  assert.equal(measureStride([100], 300, 20), 320);
  assert.equal(measureStride([], 0, 20), 0);
  assert.equal(rowOffset(13, 4, 320), 3 * 320);
});

test('restOffsets plans the pages after the first', () => {
  assert.deepEqual(restOffsets(20000, 120, 5000), [120, 5120, 10120, 15120]);
  assert.deepEqual(restOffsets(120, 120, 5000), []);
  assert.deepEqual(restOffsets(121, 120, 5000), [120]);
});

test('mergePages keeps page order and drops a row a shifted boundary repeated', () => {
  const rows = (...ids) => ids.map(entry_id => ({ entry_id }));
  assert.deepEqual(mergePages([rows(9, 8, 7), rows(7, 6), rows(5)]).map(r => r.entry_id), [9, 8, 7, 6, 5]);
});

test('loadCollectionPages: first page early, then the rest together, in order', async () => {
  const all = Array.from({ length: 23 }, (_, i) => ({ entry_id: 100 - i }));
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const q = new URL(url, 'http://x');
    const limit = Number(q.searchParams.get('limit'));
    const offset = Number(q.searchParams.get('offset'));
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h === 'X-Total-Count' ? String(all.length) : null) },
      json: async () => all.slice(offset, offset + limit),
    };
  };
  const pushed = [];
  const rows = await loadCollectionPages('/api/collection?fields=grid', {
    fetchImpl, firstSize: 5, pageSize: 8, push: (r) => pushed.push(r.length),
  });
  assert.deepEqual(rows.map(r => r.entry_id), all.map(r => r.entry_id));
  assert.deepEqual(pushed, [5], 'the first page was shown on its own');
  assert.deepEqual(requested, [
    '/api/collection?fields=grid&limit=5&offset=0',
    '/api/collection?fields=grid&limit=8&offset=5',
    '/api/collection?fields=grid&limit=8&offset=13',
    '/api/collection?fields=grid&limit=8&offset=21',
  ]);

  // A list that fits the first page is one request and no early push.
  requested.length = 0;
  pushed.length = 0;
  all.length = 4;
  const small = await loadCollectionPages('/api/collection', { fetchImpl, firstSize: 5, push: (r) => pushed.push(r.length) });
  assert.equal(small.length, 4);
  assert.equal(requested.length, 1);
  assert.deepEqual(pushed, []);
});
