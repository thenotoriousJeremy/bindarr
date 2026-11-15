// Helpers more than one collection route module needs. Each is here because two
// write paths must not be able to disagree about it (who owns a sealed unit,
// what a grader is, which printing a language change lands on).
const db = require('../../db');
const cardApi = require('../../utils/cardApi');
const tcgdexApi = require('../../tcgdexApi');
const { getOwnedUnit } = require('../../utils/sealedOwnership');
const { wantCards } = require('../../utils/defaultWishlist');
const { trashEntries } = require('../../utils/collectionTrash');

// In chunks of ids: a selection can be the whole collection, past SQLite's limit
// on bound variables for one IN (...).
async function conflictingSealedLinks(ids, userId, unitId) {
  if (!unitId) return [];
  const names = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = await db.all(
      `SELECT DISTINCT p.product_name
         FROM collection c
         JOIN sealed_units u ON u.id = c.sealed_unit_id
         JOIN sealed_purchases p ON p.id = u.purchase_id
        WHERE c.id IN (${part.map(() => '?').join(',')})
          AND c.user_id = ? AND c.sealed_unit_id IS NOT NULL AND c.sealed_unit_id != ?`,
      [...part, userId, unitId]
    );
    rows.forEach(r => names.add(r.product_name));
  }
  return [...names].map(product_name => ({ product_name }));
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
// What a request may say for list_type. Every copy is 'collection': wanted cards
// live on the Lists feature's default Wishlist (utils/defaultWishlist.js), not in
// the collection. 'wishlist' is still accepted because older apps send it to move
// a copy to the wishlist; moveCopiesToWishlist below is what that means now.
const LIST_TYPES = ['collection', 'wishlist'];

// An older app setting list_type 'wishlist' on copies the user holds: "I want
// this card, I don't have it". The card goes on the default Wishlist and the
// copies go to the trash, where they can be restored for 30 days, so nothing is
// silently lost. A copy whose card cannot go on a list (card_cache lost it) stays
// where it is. One transaction. Resolves { cards, trashed, batchId }.
async function moveCopiesToWishlist(entryIds, userId) {
  const ids = [...new Set((entryIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger))];
  return db.withTransaction(async () => {
    const rows = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      rows.push(...await db.all(
        `SELECT id, card_id FROM collection WHERE id IN (${part.map(() => '?').join(',')}) AND user_id = ?`,
        [...part, userId]
      ));
    }
    if (rows.length === 0) return { cards: 0, trashed: 0, batchId: null };
    const { added, merged, missing } = await wantCards(userId, rows.map(r => ({ card_id: r.card_id, quantity: 1 })));
    const { batchId, trashed } = await trashEntries(rows.filter(r => !missing.includes(r.card_id)).map(r => r.id), userId);
    return { cards: added + merged, trashed, batchId };
  });
}

// What was paid for a copy: a finite amount of 0 or more, or null when the field
// is blank. Anything else is refused rather than stored as text in a REAL column,
// where it reads as 0 in one sum and breaks the next.
function readPurchasePrice(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return { error: 'purchase_price must be a number of 0 or more' };
  return { value: n };
}

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
  LIST_TYPES,
  moveCopiesToWishlist,
  readPurchasePrice,
  ownsSealedUnit,
  cardIdForLanguage,
};
