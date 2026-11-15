// The Storage tab's reads (LocationManager), kept free of React so node:test
// can run them.
import { LatestRequest, fetchJson } from './request.js';

// Only the newest load of one kind counts: switching containers quickly must
// not let container A's pages land under container B, and a slow read of the
// collection must not overwrite a newer one. load() resolves { data } for the
// newest load and { stale: true } for one a newer load (or cancel) replaced; a
// failed newest load throws.
//
// The replaced request is left to finish rather than aborted: App.jsx's fetch
// wrapper takes any failed /api request, an abort included, for the server
// being unreachable, which would flash the offline banner and refuse writes.
export function createLatestLoader({ fetchImpl } = {}) {
  const latest = new LatestRequest();
  return {
    async load(url) {
      const req = latest.begin();
      try {
        const { data } = await fetchJson(url, fetchImpl ? { fetchImpl } : {});
        return req.isLatest() ? { data } : { stale: true };
      } catch (err) {
        if (!req.isLatest()) return { stale: true };
        throw err;
      }
    },
    cancel() { latest.cancel(); },
  };
}

// Fold a fresh read of a few compartments and entries into the cached
// collection. Every cached row filed in one of `compartments`, and every cached
// row of an entry in `entries`, gives way to `rows`: what the server holds now
// for those compartments and entries. An entry that is gone (deleted) simply
// has no row there.
export function applyCardPatch(cards, { compartments = [], entries = [], rows = [] }) {
  const comps = new Set(compartments.filter(id => id != null).map(String));
  const fresh = new Map();
  for (const row of rows) fresh.set(String(row.entry_id), row);
  const replaced = new Set([...entries.map(String), ...fresh.keys()]);
  const kept = cards.filter(card => !replaced.has(String(card.entry_id))
    && !(card.compartment_id != null && comps.has(String(card.compartment_id))));
  return [...kept, ...fresh.values()];
}

// The Storage tab's copy of the collection. A whole read (every row) replaces
// it; after a one-card action a patch refreshes just the compartments and
// entries that action touched (applyCardPatch), so filing a card no longer
// downloads the whole collection again. Reads are ordered by when they were
// sent: a patch sent after the whole read in flight is newer than that read's
// snapshot, so it is applied again on top of the read when the read lands; a
// patch sent before the last whole read to land is older than it, and dropped.
//
//   const ticket = store.issue();               // as the patch's reads are sent
//   if (store.accept(ticket, patch)) apply(patch);
//   const stamp = store.beginRead();            // as a whole read is sent
//   setCards(store.landRead(rows, stamp));      // or store.failRead(stamp)
export function createCardStore() {
  let issued = 0;     // patches sent so far
  let reading = null; // patches sent before the whole read in flight
  let landed = 0;     // patches sent before the last whole read that landed
  let again = [];     // [ticket, patch]: sent after `reading`, to apply again
  return {
    issue: () => (issued += 1),
    beginRead() {
      reading = issued;
      again = [];
      return reading;
    },
    landRead(rows, stamp) {
      if (stamp !== reading) return rows;
      const out = again
        .sort((a, b) => a[0] - b[0])
        .reduce((cards, [, patch]) => applyCardPatch(cards, patch), rows);
      landed = stamp;
      reading = null;
      again = [];
      return out;
    },
    failRead(stamp) {
      if (stamp === reading) { reading = null; again = []; }
    },
    accept(ticket, patch) {
      if (ticket <= landed) return false;
      if (reading !== null && ticket > reading) again.push([ticket, patch]);
      return true;
    },
  };
}

// The reads behind a patch: each compartment's current cards
// (GET /api/collection?compartment_id=) and each entry's current row
// (GET /api/collection/:id, none once it is deleted).
export async function readCardPatch({ compartments = [], entries = [] }, { fetchImpl } = {}) {
  const opts = fetchImpl ? { fetchImpl } : {};
  const comps = [...new Set(compartments.filter(id => id != null))];
  const ids = [...new Set(entries.filter(id => id != null))];
  const parts = await Promise.all([
    ...comps.map(id => fetchJson(`/api/collection?compartment_id=${encodeURIComponent(id)}`, opts).then(r => r.data)),
    ...ids.map(id => fetchJson(`/api/collection/${encodeURIComponent(id)}`, opts)
      .then(r => [r.data], err => (err && err.status === 404 ? [] : Promise.reject(err)))),
  ]);
  return { compartments: comps, entries: ids, rows: parts.flat().filter(Boolean) };
}

// The toast after saving a container's settings or a page's or row's rules:
// how many stored cards the new rules sent back to Unsorted, if any.
export const evictedText = (t, data, doneKey, evictedKey) => {
  const evicted = Number(data && data.evicted) || 0;
  return evicted > 0 ? t(evictedKey, { count: evicted }) : t(doneKey);
};

// The toast after Auto-File All (POST /locations/:id/apply-all): filed of total,
// phrased here; the server's English message only for an answer without counts.
export const applyAllText = (t, data) => {
  if (data && Number.isInteger(data.filed) && Number.isInteger(data.total)) {
    return t('loc.filedOfTotal', { count: data.total, filed: data.filed });
  }
  return (data && typeof data.message === 'string' && data.message) || t('bulk.done');
};

// The toast after a ManaBox container import (POST /api/import-container): the
// new container and its card count, plus the cards not found in Unsorted.
export const importContainerText = (t, data, name) => {
  if (!data || !Number.isInteger(data.count)) return (data && data.message) || t('bulk.done');
  const created = t('loc.importedContainer', { count: data.count, name });
  const missing = Number(data.missing) || 0;
  return missing > 0 ? `${created} ${t('loc.importedContainerMissing', { count: missing })}` : created;
};
