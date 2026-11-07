import { fetchJson } from './request.js';

// Loads a collection list through GET /collection's paging: one small page to
// paint the first screen, then the rest in large pages fetched together and
// committed once. A first page that is the whole list (most collections) is
// the only request.
export const FIRST_PAGE = 120;
export const REST_PAGE = 5000;

// Offsets of the pages after the first.
export function restOffsets(total, firstSize, pageSize = REST_PAGE) {
  const offsets = [];
  for (let offset = firstSize; offset < total; offset += pageSize) offsets.push(offset);
  return offsets;
}

// Joins pages in order and drops a row already seen. Offsets are positions in a
// list that can change between two requests: a card added meanwhile pushes
// every later row down one, and the row on a page boundary would otherwise come
// back twice. (A row deleted meanwhile can be missed instead; the refetch that
// the deletion itself triggers puts that right.)
export function mergePages(pages, idOf = (row) => row.entry_id) {
  const seen = new Set();
  const out = [];
  for (const page of pages) {
    for (const row of page) {
      const id = idOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(row);
    }
  }
  return out;
}

// `baseUrl` is the /api/collection URL with its filters, without limit/offset.
// `push(rows)` (optional) receives the first page early.
export async function loadCollectionPages(baseUrl, { signal, push, fetchImpl, firstSize = FIRST_PAGE, pageSize = REST_PAGE } = {}) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  const page = (limit, offset) => fetchJson(`${baseUrl}${sep}limit=${limit}&offset=${offset}`, { signal, fetchImpl });
  const { data: first, res } = await page(firstSize, 0);
  const total = Number(res.headers.get('X-Total-Count'));
  if (!Number.isFinite(total) || first.length >= total || first.length < firstSize) return first;
  if (push) push(first);
  const rest = await Promise.all(restOffsets(total, firstSize, pageSize).map(offset => page(pageSize, offset).then(r => r.data)));
  return mergePages([first, ...rest]);
}
