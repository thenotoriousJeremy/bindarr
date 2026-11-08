// The client half of the set view: which tiles to show, and what is left to buy.
//
// The counting itself (owned, missing, percent, missing value per currency) is
// done once, on the server (backend/src/utils/setCompletion.js), for both the card
// view and the variant view. This only filters and groups that answer, so the two
// toggles can change the grid without another request.

// What a card contributes in the chosen view. With variants on, a Pokémon card
// with finish data is one entry per finish (Normal, Reverse Holofoil, ...); any
// other card is the card itself, owned if any copy is.
export function entriesOf(card, variants = false) {
  if (variants && Array.isArray(card.variants) && card.variants.length) {
    return card.variants.map(v => ({ printing: v.printing, owned: v.owned > 0, price: v.price }));
  }
  return [{ printing: null, owned: card.owned > 0, price: card.price }];
}

// Complete: nothing left to get for this card in this view.
export const isComplete = (card, variants = false) => entriesOf(card, variants).every(e => e.owned);

// show: 'all' | 'owned' | 'missing'. In the variant view a card with one finish
// still to get is "missing" — there is something to buy — and only a card with
// every finish is "owned".
export function filterCards(cards, { show = 'all', variants = false } = {}) {
  if (show === 'owned') return (cards || []).filter(c => isComplete(c, variants));
  if (show === 'missing') return (cards || []).filter(c => !isComplete(c, variants));
  return cards || [];
}

// The missing entries as Mass Entry items: one per card, quantity = the finishes
// still to get. TCGplayer sells every finish of a card under one product (the
// finish is picked per listing, not per line), so two missing finishes are the
// same product bought twice. `setCode` is TCGplayer's code for the set, or null.
export function purchaseList(cards, { variants = false, setCode = null } = {}) {
  const out = [];
  for (const card of cards || []) {
    const missing = entriesOf(card, variants).filter(e => !e.owned).length;
    if (!missing) continue;
    out.push({
      quantity: missing,
      name: card.name,
      setCode,
      number: card.number,
      productId: card.tcgplayer_product_id || null,
    });
  }
  return out;
}

// [[currency, amount], ...] for the missing value, largest first, so the view can
// write "$12.30 + €4.10" without ever adding the two.
export function valueParts(missingValue) {
  return Object.entries(missingValue || {})
    .filter(([, v]) => Number(v) > 0)
    .sort((a, b) => b[1] - a[1]);
}
