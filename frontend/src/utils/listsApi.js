// The few card-list calls made from outside the Lists view (the inspector, the
// search and collection bulk bars), so each place does not re-implement them.

// Cards per request; the server takes at most this many (routes/lists.js BULK_MAX).
const BULK_MAX = 500;

// The kinds a list can be (utils/listOwnership.js LIST_KINDS on the server).
export const LIST_KINDS = ['wishlist', 'buylist', 'missing', 'custom'];

// Add cards to a list, as many as fit in one request each: the server merges a
// card already on the list into its quantity. Resolves to { added, failed, error }
// — `error` is the first refusal, which names the problem (wrong game, unknown card).
export async function addCardsToList(listId, cardIds) {
  const ids = [...new Set(cardIds)];
  let added = 0;
  const failed = [];
  let error = null;
  for (let i = 0; i < ids.length; i += BULK_MAX) {
    const chunk = ids.slice(i, i + BULK_MAX);
    try {
      const res = await fetch(`/api/lists/${listId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_ids: chunk, quantity_wanted: 1 }),
      });
      const body = (await res.json().catch(() => null)) || {};
      // A server from before the bulk form (an app newer than its server) refuses
      // card_ids without saying what was added; it still takes one card at a time.
      if (res.status === 400 && !('added' in body)) {
        const one = await addOneByOne(listId, chunk);
        added += one.added;
        failed.push(...one.failed);
        error = error || one.error;
        continue;
      }
      added += Number(body.added) || 0;
      if (Array.isArray(body.failed)) failed.push(...body.failed);
      else if (!res.ok) failed.push(...chunk);
      error = error || body.error || null;
    } catch {
      failed.push(...chunk);
    }
  }
  return { added, failed, error };
}

// The single-card form, one request per card.
async function addOneByOne(listId, cardIds) {
  let added = 0;
  const failed = [];
  let error = null;
  for (const cardId of cardIds) {
    try {
      const res = await fetch(`/api/lists/${listId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: cardId, quantity_wanted: 1 }),
      });
      if (res.ok) { added++; continue; }
      const body = await res.json().catch(() => ({}));
      error = error || body.error || null;
      failed.push(cardId);
    } catch {
      failed.push(cardId);
    }
  }
  return { added, failed, error };
}

// A new list for one game (null: any game). Resolves to the created list or null.
export async function createList(name, game, kind = 'wishlist') {
  const res = await fetch('/api/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, game: game || null, kind }),
  });
  return res.ok ? res.json() : null;
}
