// Deck construction rules, enforced server-side so every path that writes
// deck_cards (deck builder POST, the collection "add to deck" bulk action)
// obeys them — the frontend checks were advisory and easy to bypass.
//
// The rules themselves live in shared/deckRules.mjs, the one copy the deck builder
// imports too. It is an ES module because the browser needs one; CommonJS reaches
// it through import(), which every supported Node has (require() of an ES module
// needs Node 20.19 or 22.12). Loaded once, on first use.
const db = require('../db');

let rulesModule = null;
function loadRules() {
  if (!rulesModule) rulesModule = import('../../../shared/deckRules.mjs');
  return rulesModule;
}

// The card_cache columns the shared rules read.
const RULE_COLUMNS = 'id, name, supertype, subtypes, types, game, oracle_id, oracle_text';

// Validate setting a deck's copy count of `cardId` to `newQty`.
// Returns { ok: true } or { ok: false, error }. Enforces:
//   1. can't exceed the copies actually owned in the collection — for a deck that
//      accepts any printing, owned copies of every printing count, shared with the
//      deck's other printings of the same card;
//   2. the format's copy limit per card name (4 in constructed, 1 in Commander;
//      basics and cards that say otherwise are exempt).
// Lowering a count always passes: a deck left over a limit (copies sold since, a
// format changed under it) has to be fixable one click at a time.
async function validateDeckAddition({ deckId, userId, cardId, newQty, dbClient }) {
  const client = dbClient || db;
  const qty = parseInt(newQty, 10);
  if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: 'Invalid quantity' };

  const rules = await loadRules();
  const card = await client.get(`SELECT ${RULE_COLUMNS} FROM card_cache WHERE id = ?`, [cardId]);
  if (!card) return { ok: false, error: 'Card not found' };

  const deck = await client.get(`SELECT game, format, any_printing FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
  const game = (deck && deck.game) || card.game || 'pokemon';
  const anyPrinting = !!(deck && deck.any_printing) && rules.supportsAnyPrinting(game);

  // Every row of this deck that is this card by name or by printing — or, for a
  // game that decides "the same card" itself (Riftbound's printings carry the
  // printing in their names), every row, for its copyKey to sort out.
  const ownKey = rules.copyKey(card, game) !== rules.copyKey({ name: card.name }, 'pokemon');
  const deckRows = await client.all(
    `SELECT dc.card_id, dc.quantity, cc.name, cc.oracle_id, cc.supertype, cc.subtypes
     FROM deck_cards dc JOIN card_cache cc ON dc.card_id = cc.id
     WHERE dc.deck_id = ? AND (? = 1 OR dc.card_id = ? OR cc.name = ? OR cc.oracle_id = ?)`,
    [deckId, ownKey ? 1 : 0, cardId, card.name, card.oracle_id]
  );
  const current = deckRows.filter(r => r.card_id === cardId).reduce((s, r) => s + r.quantity, 0);
  if (qty <= current) return { ok: true };

  const owned = await client.all(
    `SELECT c.card_id, c.quantity, cc.name, cc.oracle_id
     FROM collection c JOIN card_cache cc ON c.card_id = cc.id
     WHERE c.user_id = ? AND c.list_type = 'collection'
       AND (c.card_id = ? OR (? = 1 AND (cc.name = ? OR cc.oracle_id = ?)))`,
    [userId, cardId, anyPrinting ? 1 : 0, card.name, card.oracle_id]
  );
  const ownedQty = owned
    .filter(o => rules.sameCard(card, o, game, anyPrinting))
    .reduce((s, o) => s + (o.quantity || 0), 0);
  const sharing = deckRows
    .filter(r => r.card_id !== cardId && rules.sameCard(card, r, game, anyPrinting))
    .reduce((s, r) => s + r.quantity, 0);
  if (sharing + qty > ownedQty) {
    return { ok: false, error: `You only own ${ownedQty} ${ownedQty === 1 ? 'copy' : 'copies'} of ${card.name}.` };
  }

  // Copies of the same NAME already in the deck under a different card_id
  // (alt arts / reprints) count toward the limit.
  const limit = rules.copyLimit(card, rules.rulesFor(game, deck && deck.format));
  const other = deckRows
    .filter(r => r.card_id !== cardId && rules.copyKey(r, game) === rules.copyKey(card, game))
    .reduce((s, r) => s + r.quantity, 0);
  if (other + qty > limit) {
    return { ok: false, error: `Cannot have more than ${limit} ${limit === 1 ? 'copy' : 'copies'} of ${card.name}.` };
  }

  return { ok: true };
}

module.exports = { loadRules, validateDeckAddition };
