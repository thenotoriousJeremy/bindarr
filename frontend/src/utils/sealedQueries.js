// The reads behind the Sealed tab (components/SealedList.jsx), kept free of
// React so they can be checked with node:test.

// "Link cards from this pack": the collection's own copies of one game, in the
// grid's slim column set (fields=grid carries the name, set, number, sealed
// link and added_at the panel shows and filters on), newest first as the
// server orders them. The panel used to download the whole collection with
// every column, every game, to show a short list.
export function linkableCardsUrl(game) {
  const params = new URLSearchParams({ list_type: 'collection', fields: 'grid' });
  if (game) params.set('game', game);
  return `/api/collection?${params}`;
}

// The purchases list, with or without units other members claimed.
export const purchasesUrl = (showClaimedByOthers) =>
  `/api/sealed/purchases${showClaimedByOthers ? '?show_claimed_by_others=1' : ''}`;

// The purchases out of a response body: a list, whatever came back.
export const purchasesFrom = (body) => (body && Array.isArray(body.purchases) ? body.purchases : []);
