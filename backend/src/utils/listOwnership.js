// Owned vs wanted for card lists. Pure functions: the route loads rows, this
// decides what counts. Kept free of the database so the rules can be tested on
// plain objects, and so there is exactly one definition of "the same card".

const LIST_KINDS = ['wishlist', 'buylist', 'missing', 'custom'];
// Best first. Mirrors the collection.condition CHECK constraint in db.js.
const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const { MAX_QUANTITY: MAX_QTY, readQuantity } = require('./requestBounds');

// A wanted quantity, by the same rule as every copy count a request carries
// (utils/requestBounds): a whole number 1-9999. Null when refused, so the
// caller can say so rather than round a typo into an order.
function parseQuantity(value) {
  const { value: n, error } = readQuantity(value === undefined ? null : value);
  return error ? null : n;
}

const nameKeys = (card) => [card && card.name, card && card.printed_name]
  .filter(Boolean).map(n => String(n).trim().toLowerCase());

// Whether two printings are the same card, for an any-printing want.
//
// Same game, then the name — English `name` or the localized `printed_name`, the
// same invariant PUT /collection/:id uses to allow a change of printing.
//
// SEAM: Magic printings share an oracle_id, which is the right identity there
// (deck-formats adds card_cache.oracle_id). When both rows carry one it decides;
// a row cached before the column existed falls back to the name. The route
// selects the column only when the schema has it (see lists.js ownedRows).
function sameCard(a, b) {
  if (!a || !b) return false;
  if ((a.game || 'pokemon') !== (b.game || 'pokemon')) return false;
  if (a.oracle_id && b.oracle_id) return a.oracle_id === b.oracle_id;
  const theirs = nameKeys(b);
  return nameKeys(a).some(k => theirs.includes(k));
}

const conditionRank = (c) => {
  const i = CONDITIONS.indexOf(c || 'Near Mint');
  return i === -1 ? CONDITIONS.length : i;
};

// Does an owned row (grouped per card_id/condition/language) count toward a want?
function countsToward(item, owned) {
  const exact = owned.card_id === item.card_id;
  if (!exact && !(item.any_printing && sameCard(item.card, owned))) return false;
  if (item.condition_min && conditionRank(owned.condition) > conditionRank(item.condition_min)) return false;
  if (item.language && String(owned.language || 'English').toLowerCase() !== String(item.language).toLowerCase()) return false;
  return true;
}

// Index owned rows so each item looks up its candidates instead of scanning the
// whole collection: by card_id for exact wants, by name for any-printing ones.
function indexOwned(ownedRows) {
  const byId = new Map();
  const byName = new Map();
  for (const row of ownedRows) {
    if (!byId.has(row.card_id)) byId.set(row.card_id, []);
    byId.get(row.card_id).push(row);
    for (const k of nameKeys(row)) {
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(row);
    }
  }
  return { byId, byName };
}

const cents = (n) => Math.round(n * 100) / 100;

// A card's market price, or null when nobody prices it. Zero is "no price" here,
// as it is everywhere else in the app (resolveCardPrice falls through to 0).
const knownPrice = (card) => {
  const p = Number(card && card.price_trend);
  return Number.isFinite(p) && p > 0 ? p : null;
};

// Each item with `owned`, `missing` and what the missing copies would cost.
// `items` carry `card` (their card_cache row); `ownedRows` are the user's
// collection rows grouped by (card_id, condition, language) with `qty`.
function evaluateItems(items, ownedRows) {
  const { byId, byName } = indexOwned(ownedRows);
  return items.map(item => {
    const candidates = new Set(byId.get(item.card_id) || []);
    if (item.any_printing) {
      for (const k of nameKeys(item.card)) for (const row of byName.get(k) || []) candidates.add(row);
    }
    let owned = 0;
    for (const row of candidates) if (countsToward(item, row)) owned += Number(row.qty) || 0;
    const missing = Math.max(0, item.quantity_wanted - owned);
    const unitPrice = knownPrice(item.card);
    return {
      ...item,
      owned,
      missing,
      unit_price: unitPrice,
      price_currency: (item.card && item.card.price_currency) || 'USD',
      // Null, not 0, when the card has no price: an unpriced card is not free.
      missing_value: missing === 0 ? 0 : (unitPrice == null ? null : cents(unitPrice * missing)),
    };
  });
}

// Totals for a list. Money is kept per currency — a Cardmarket EUR price and a
// TCGplayer USD price are never added together — and only known prices are
// summed; `unpriced` counts the missing items that have no price at all.
function summarize(evaluated) {
  const summary = { items: evaluated.length, complete: 0, wanted: 0, owned: 0, missing: 0, missing_value: {}, unpriced: 0 };
  for (const it of evaluated) {
    summary.wanted += it.quantity_wanted;
    summary.owned += Math.min(it.owned, it.quantity_wanted);
    summary.missing += it.missing;
    if (it.missing === 0) summary.complete++;
    else if (it.missing_value == null) summary.unpriced++;
    else summary.missing_value[it.price_currency] = cents((summary.missing_value[it.price_currency] || 0) + it.missing_value);
  }
  return summary;
}

module.exports = {
  LIST_KINDS, CONDITIONS, MAX_QTY,
  parseQuantity, sameCard, countsToward, evaluateItems, summarize, knownPrice,
};
