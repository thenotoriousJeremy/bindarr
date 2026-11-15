// The toast for a finished bulk action (POST /api/collection/bulk), in the
// interface language. The server's `message` is English, so it is shown only
// when the answer says something phrased here would leave out: a deck that
// refused some cards (the reason is the server's), a container that filled up
// part way, a price split or a sealed link (the amounts and split method are in
// the message alone), or an action this build does not know.

// Actions whose whole result is how many cards they touched (`affected`).
const COUNTED = {
  delete: 'bulk.result.deleted',
  trade: 'bulk.result.trade',
  untrade: 'bulk.result.untrade',
  condition: 'bulk.result.condition',
  printing: 'bulk.result.printing',
  language: 'bulk.result.language',
  add_to_deck: 'bulk.result.addedToDeck',
};

const LIST_TYPES = { collection: 'bulk.result.movedToCollection', wishlist: 'bulk.result.movedToWishlist' };

// The translation key for a bulk answer, or null when the server's own words
// are needed.
export function bulkResultKey(action, value, data) {
  if (!data || typeof data.affected !== 'number') return null;
  // Part of the selection was left out, for a reason only the server states.
  // rule_rejected: cards a container's rules refused, left where they were.
  if (data.rejected > 0 || data.skipped > 0 || data.rule_rejected > 0 || data.container_full) return null;
  if (action === 'list_type') return LIST_TYPES[value] || null;
  // A move to no container is a move to Unsorted.
  if (action === 'move') return value ? 'bulk.result.moved' : 'bulk.result.unfiled';
  // Linking to a unit allocates its price, which only the message carries;
  // clearing the link (value null) is a plain count.
  if (action === 'set_sealed_unit') return value ? null : 'bulk.result.unlinked';
  return COUNTED[action] || null;
}

export function bulkResultText(t, action, value, data) {
  const key = bulkResultKey(action, value, data);
  if (key) return t(key, { count: data.affected });
  return (data && typeof data.message === 'string' && data.message) || t('bulk.done');
}
