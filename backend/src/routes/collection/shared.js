// Helpers more than one collection route module needs. Each is here because two
// write paths must not be able to disagree about it (who owns a sealed unit,
// what a grader is, which printing a language change lands on).
const db = require('../../db');
const cardApi = require('../../utils/cardApi');
const tcgdexApi = require('../../tcgdexApi');
const { getOwnedUnit } = require('../../utils/sealedOwnership');

async function conflictingSealedLinks(ids, userId, unitId) {
  if (!unitId) return [];
  return db.all(
    `SELECT DISTINCT p.product_name
       FROM collection c
       JOIN sealed_units u ON u.id = c.sealed_unit_id
       JOIN sealed_purchases p ON p.id = u.purchase_id
      WHERE c.id IN (${ids.map(() => '?').join(',')})
        AND c.user_id = ? AND c.sealed_unit_id IS NOT NULL AND c.sealed_unit_id != ?`,
    [...ids, userId, unitId]
  );
}

// Stamp each result with how many copies the user already owns, so browsing a
// set shows what is already in the binder instead of inviting duplicate adds.
// A collection-scope search already reports owned_qty from its own join.
async function attachOwnedQty(cards, userId) {
  if (!Array.isArray(cards) || cards.length === 0 || !userId) return;
  const ids = cards.map(c => c.id).filter(Boolean);
  if (ids.length === 0) return;
  const rows = await db.all(
    `SELECT card_id, SUM(quantity) AS qty FROM collection
     WHERE user_id = ? AND list_type = 'collection' AND card_id IN (${ids.map(() => '?').join(',')})
     GROUP BY card_id`,
    [userId, ...ids]
  );
  const owned = new Map(rows.map(r => [r.card_id, r.qty]));
  for (const c of cards) c.owned_qty = owned.get(c.id) || 0;
}

// Shared by the single add below and the bulk add after it, so one card and two
// hundred cards travel exactly the same path (cache lookup, compartment
// resolution, rebalance, price history). Throws AddCardError for caller-visible
// failures; anything else is a genuine 500.
// `code` (and `params` for its placeholders) lets the UI say it in the user's language.
class AddCardError extends Error {
  constructor(status, message, code, params) { super(message); this.status = status; this.code = code; this.params = params; }
}

// Mirrors the collection.grader CHECK constraint in db.js. 'Raw' is the default
// and means an ungraded card, not a missing value.
const GRADERS = ['Raw', 'PSA', 'BGS', 'CGC', 'SGC', 'TAG'];
// Mirror the collection.condition / collection.printing CHECK constraints in db.js:
// a value outside them fails at the INSERT/UPDATE, which surfaced as a 500.
const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const PRINTINGS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'];

// A sealed unit id is only ever linked to a card when the unit belongs to the
// same user. Shared by every write path (single add, bulk add, edit), so none of
// them can link a card to, and then read through, another user's purchase.
async function ownsSealedUnit(unitId, userId) {
  return !!(await getOwnedUnit(userId, unitId));
}

// The card a copy should reference once its language is `language`: that
// language's printing when one exists, else the card it already has. Shared by
// the single edit and the bulk action so the two cannot disagree.
async function cardIdForLanguage(cardId, language) {
  const card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
  const localized = card && await cardApi.printingInLanguage(card, language);
  if (!localized || !localized.id || localized.id === cardId) return cardId;
  await tcgdexApi.learnEnglishName(localized);
  return localized.id;
}

module.exports = {
  conflictingSealedLinks,
  attachOwnedQty,
  AddCardError,
  GRADERS,
  CONDITIONS,
  PRINTINGS,
  ownsSealedUnit,
  cardIdForLanguage,
};
