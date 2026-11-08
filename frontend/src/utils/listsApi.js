// The few card-list calls made from outside the Lists view (the inspector, the
// search and collection bulk bars), so each place does not re-implement them.

// Add cards to a list one at a time: the server merges a card already on the
// list into its quantity. Resolves to { added, failed, error } — `error` is the
// first refusal, which names the problem (wrong game, unknown card).
export async function addCardsToList(listId, cardIds) {
  let added = 0;
  const failed = [];
  let error = null;
  for (const cardId of [...new Set(cardIds)]) {
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
