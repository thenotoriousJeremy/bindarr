// What the three routers that move cards and sealed product between owners share:
// routes/transfers.js (offers between members), routes/historicalTrades.js (trades
// recorded after the fact) and routes/externalTransfers.js (deals with people
// outside Bindarr).
//
// They must not disagree about which copies an owner may hand over (their own,
// unopened, not held by a checked-out deck, not claimed by another member), what
// an item looks like in history (its snapshot), what has to be unchanged before it
// moves, what a hand-over costs a checked-out deck, and how a refusal is answered.
//
// Device mode bundles this file (externalTransfers and sealed run on the phone),
// so it uses nothing Node-only: db and plain JavaScript.
'use strict';

const db = require('../db');
const { OWNED_UNIT_WHERE } = require('./sealedOwnership');
const { resolveCardPrice } = require('./priceHelpers');

// --- Refusals ---------------------------------------------------------------
//
// Every refusal carries a stable `code` beside its English `error`, so the app can
// say it in the user's language (frontend utils/apiError.js):
//
//   400 invalid           the request itself is malformed
//   403 api_key_refused   an API key reached a trade route (keys are for scripts)
//   403 trades_disabled   the caller has not turned trading with members on
//   403 forbidden         the caller is not the side that may do this
//   404 not_found         nothing the caller may see: a member who does not trade,
//                         an offer, or an item that is not theirs to give or not
//                         marked for trade. Never which of those.
//   409 too_many_pending  ten open offers (or records) between the two already
//   409 not_pending       the offer or record was settled already
//   409 needs_counter     a one-sided trade is countered, not accepted
//   409 asset_changed     an item is gone, or no longer what was offered
//   409 deck_allocated    copies a checked-out deck holds (`decks`: their names)
//   409 unit_claimed      a sealed unit another member claimed
//   409 already_owned     the caller already owns this graded card (its cert)
//   409 name_taken        a contact with that name exists
//   500 server_error
class TransferError extends Error {
  constructor(status, code, message, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const invalid = (message) => new TransferError(400, 'invalid', message);
const forbidden = (message) => new TransferError(403, 'forbidden', message);
const notFound = (message = 'Not found') => new TransferError(404, 'not_found', message);
const notPending = (message = 'This offer is no longer pending') => new TransferError(409, 'not_pending', message);
const assetChanged = (message = 'An item changed after it was offered') => new TransferError(409, 'asset_changed', message);
const unitClaimed = () => new TransferError(409, 'unit_claimed', 'Another member claimed this sealed unit');
// `params` too, for apiErrorText's placeholder.
const deckAllocated = (decks) => new TransferError(
  409, 'deck_allocated', 'A checked-out deck holds these copies. Return the deck first.',
  { decks, params: { decks: decks.join(', ') } }
);

function respondError(res, error, fallback) {
  if (error instanceof TransferError) {
    return res.status(error.status).json({ error: error.message, code: error.code, ...(error.extra || {}) });
  }
  console.error(`${fallback}:`, error);
  return res.status(500).json({ error: fallback, code: 'server_error' });
}

// An API key is read-only and lives in some script's config. What trades and
// deals reveal (who trades with whom, what for, at what cost) is not what a key
// was handed out to read, so every /api/transfers route refuses one outright.
function refuseApiKeys(req, res, next) {
  if (req.user && req.user.via_api_key) {
    return res.status(403).json({ error: 'API keys cannot reach trades. Use a login session.', code: 'api_key_refused' });
  }
  next();
}

// --- Trading with other members is opt-in (users.trades_enabled) -------------

async function assertTradesEnabled(userId) {
  const row = await db.get(`SELECT trades_enabled FROM users WHERE id = ?`, [userId]);
  if (!row || !row.trades_enabled) {
    throw new TransferError(403, 'trades_disabled', 'Turn on trading with other members in Settings first.');
  }
}

// A member who may be traded with: one who turned trading on. No such account and
// trading off are the same 404, so ids cannot be probed for who has an account.
async function tradingMember(userId) {
  const row = await db.get(`SELECT id, username FROM users WHERE id = ? AND trades_enabled = 1`, [userId]);
  if (!row) throw notFound('Member not found');
  return row;
}

// --- Request parsing -----------------------------------------------------------

// A number or a numeric string only: Number(true) and Number([7]) are numbers too.
function positiveInt(value, label) {
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalid(`${label} must be a positive integer`);
  return parsed;
}

function readMessage(value, maxLength = 1000) {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalid('message must be text');
  return value.trim().slice(0, maxLength) || null;
}

// [{ type: 'card', id: entryId, quantity }, { type: 'sealed', id: unitId }]: what
// an offer, a request or an outside deal hands over. Bounded, because every copy
// becomes a row written inside one transaction.
const MAX_ENTRIES = 100;
const MAX_COPIES = 100;
function parseItems(value, label, { required = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw invalid(`${label} must be a${required ? ' non-empty' : 'n'} array`);
  }
  if (value.length > MAX_ENTRIES) throw invalid(`${label} cannot contain more than ${MAX_ENTRIES} entries`);
  const items = value.map((item) => {
    if (!item || !['card', 'sealed'].includes(item.type)) {
      throw invalid(`${label} entries must have type 'card' or 'sealed'`);
    }
    return {
      type: item.type,
      id: positiveInt(item.id, `${label} item id`),
      quantity: item.type === 'card' ? positiveInt(item.quantity ?? 1, `${label} quantity`) : 1,
    };
  });
  if (items.reduce((sum, item) => sum + item.quantity, 0) > MAX_COPIES) {
    throw invalid(`${label} cannot contain more than ${MAX_COPIES} copies`);
  }
  return items;
}

// The same entry or unit named twice is one request for the sum: checked against
// what the owner has as a whole, not twice against the full amount.
function mergeItems(items) {
  const merged = new Map();
  for (const item of items) {
    const key = assetKey(item.type, item.id);
    const seen = merged.get(key);
    if (seen && item.type === 'sealed') throw invalid('A sealed unit can only be listed once');
    if (seen) seen.quantity += item.quantity;
    else merged.set(key, { ...item });
  }
  return [...merged.values()];
}

const assetKey = (type, id) => `${type}:${id}`;

// --- Pagination ------------------------------------------------------------------
//
// ?limit= 1..100 (default 50) and ?cursor= (opaque: whatever next_cursor said).
// The first page also carries every open item whatever its age, so nothing waiting
// on the user is ever on page two; later pages are settled items only.
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

function readPage(query, parseCursor) {
  let limit = PAGE_DEFAULT;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (typeof query.limit !== 'string' || !Number.isInteger(n) || n < 1 || n > PAGE_MAX) {
      throw invalid(`limit must be a whole number from 1 to ${PAGE_MAX}`);
    }
    limit = n;
  }
  let cursor = null;
  if (query.cursor !== undefined && query.cursor !== '') {
    cursor = typeof query.cursor === 'string' ? parseCursor(query.cursor) : null;
    if (!cursor) throw invalid('cursor is not one this list handed out');
  }
  return { limit, cursor };
}

// Rows fetched with LIMIT limit + 1: the page, and the cursor past its last row.
function pageOf(rows, limit, makeCursor) {
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return { page, nextCursor: more ? makeCursor(page[page.length - 1]) : null };
}

// Offers and outside deals list newest first, which is id order.
const idCursor = {
  parse: (s) => (/^[1-9]\d{0,15}$/.test(s) ? { id: Number(s) } : null),
  make: (row) => String(row.id),
};

function chunks(list, size = 500) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
const holes = (list) => list.map(() => '?').join(',');

// --- Checked-out decks -------------------------------------------------------------
//
// A checked-out deck HOLDS the exact copies it took (deck_allocations, keyed by the
// collection entry; utils/deckAllocation.js). Those copies are not anyone's to hand
// over: a hand-over may take at most an entry's copies that no checked-out deck holds.

// entry id -> { held, decks: [deck name] }, for the entries a checked-out deck holds.
async function deckHoldings(entryIds) {
  const ids = [...new Set(entryIds.filter(Boolean))];
  const map = new Map();
  for (const part of chunks(ids)) {
    const rows = await db.all(
      `SELECT a.entry_id, a.quantity, d.name
         FROM deck_allocations a
         JOIN decks d ON d.id = a.deck_id AND d.checked_out = 1
        WHERE a.entry_id IN (${holes(part)})`,
      part
    );
    for (const row of rows) {
      const holding = map.get(row.entry_id) || { held: 0, decks: [] };
      holding.held += Number(row.quantity) || 1;
      if (!holding.decks.includes(row.name)) holding.decks.push(row.name);
      map.set(row.entry_id, holding);
    }
  }
  return map;
}

// What a checked-out deck can lose to a hand-over is a copy it is still MISSING: a
// deck short of a card (its list changed after checkout, or a copy it held was
// deleted) could be filled from the free copies of that card, and handing those
// away leaves it short. The copies it holds never leave (deckAllocated).
//
// deckState reads, for one user and these cards: what their checked-out decks still
// miss (card id -> { missing, decks }) and their free copies (card id -> count).
async function deckState(userId, cardIds) {
  const ids = [...new Set(cardIds.filter(Boolean))];
  const missing = new Map();
  const free = new Map();
  for (const part of chunks(ids)) {
    const needs = await db.all(
      `SELECT dc.card_id, d.name,
              dc.quantity - COALESCE((SELECT SUM(a.quantity) FROM deck_allocations a
                                       WHERE a.deck_id = d.id AND a.card_id = dc.card_id), 0) AS missing
         FROM decks d
         JOIN deck_cards dc ON dc.deck_id = d.id
        WHERE d.user_id = ? AND d.checked_out = 1 AND dc.card_id IN (${holes(part)})`,
      [userId, ...part]
    );
    for (const row of needs) {
      if (!(row.missing > 0)) continue;
      const need = missing.get(row.card_id) || { missing: 0, decks: [] };
      need.missing += row.missing;
      if (!need.decks.includes(row.name)) need.decks.push(row.name);
      missing.set(row.card_id, need);
    }
    const copies = await db.all(
      `SELECT c.card_id, SUM(MAX(0, c.quantity - COALESCE(held.quantity, 0))) AS free
         FROM collection c
         LEFT JOIN (SELECT a.entry_id, a.quantity FROM deck_allocations a
                      JOIN decks d ON d.id = a.deck_id AND d.checked_out = 1) held ON held.entry_id = c.id
        WHERE c.user_id = ? AND c.list_type = 'collection' AND c.card_id IN (${holes(part)})
        GROUP BY c.card_id`,
      [userId, ...part]
    );
    for (const row of copies) free.set(row.card_id, Number(row.free) || 0);
  }
  return { missing, free };
}

// The warnings for one user handing over `outgoing` (card id -> { name, quantity }):
// a card a checked-out deck still misses, where this hand-over takes copies that
// could have filled it. copies_short is how short the decks are of it afterwards.
function warningsFor(state, userId, outgoing) {
  const warnings = [];
  for (const [cardId, { name, quantity }] of outgoing) {
    const need = state.missing.get(cardId);
    if (!need) continue;
    const free = state.free.get(cardId) || 0;
    const before = Math.max(0, need.missing - free);
    const after = Math.max(0, need.missing - Math.max(0, free - quantity));
    if (after <= before) continue;
    warnings.push({
      user_id: userId,
      card_id: cardId,
      card_name: name,
      copies_short: after,
      decks: need.decks,
      message: `This may leave a checked-out deck short ${after} ${after === 1 ? 'copy' : 'copies'} of ${name}.`,
    });
  }
  return warnings;
}

// copies: [{ userId, cardId, name, quantity }] from any number of users.
async function deckWarnings(copies) {
  const byUser = new Map();
  for (const copy of copies) {
    if (copy.userId == null || !copy.cardId) continue;
    const cards = byUser.get(copy.userId) || new Map();
    const card = cards.get(copy.cardId) || { name: copy.name, quantity: 0 };
    card.quantity += copy.quantity || 1;
    cards.set(copy.cardId, card);
    byUser.set(copy.userId, cards);
  }
  const warnings = [];
  for (const [userId, cards] of byUser) {
    const state = await deckState(userId, [...cards.keys()]);
    warnings.push(...warningsFor(state, userId, cards));
  }
  return warnings;
}

// --- Loading what an owner hands over ----------------------------------------------
//
// loadAsset(ownerId, { type, id, quantity }, options) reads one asset and refuses it
// unless `ownerId` may hand it over now. Options:
//
//   asOwner        the caller IS the owner (their own offer, or their side of an
//                  offer they accept). They get the precise reason. Anyone else is
//                  told only not_found / asset_changed, never what the other member
//                  holds or how (which decks, which state).
//   requireMarked  only an item marked for trade: what may be requested of others.
//   settled        at acceptance: the item was already disclosed in the offer, so
//                  gone is asset_changed rather than not_found.
//
// Returns { item_type, source_collection_id, source_sealed_unit_id, quantity,
// purchase_cost, market_value, row, snapshot }.
async function loadAsset(ownerId, item, options = {}) {
  return item.type === 'card'
    ? loadCard(ownerId, item, options)
    : loadSealed(ownerId, item, options);
}

const CARD_COLUMNS = `c.*, cc.name, cc.printed_name, cc.set_name, cc.number, cc.rarity, cc.image_url,
       cc.game AS card_game, cc.price_trend, cc.price_normal, cc.price_holofoil,
       cc.price_reverse_holofoil, cc.price_1st_edition`;

async function loadCard(ownerId, item, { asOwner = true, requireMarked = false, settled = false } = {}) {
  const quantity = item.quantity || 1;
  const gone = () => (settled ? assetChanged('A card in this offer is no longer available') : notFound('Card not found'));
  const row = await db.get(
    `SELECT ${CARD_COLUMNS}
       FROM collection c
       JOIN card_cache cc ON cc.id = c.card_id
      WHERE c.id = ? AND c.user_id = ? AND c.list_type = 'collection'`,
    [item.id, ownerId]
  );
  if (!row || (requireMarked && !row.is_trade)) throw gone();
  if (row.cert_number && quantity !== 1) throw invalid('A graded card is one physical copy');
  const holding = (await deckHoldings([row.id])).get(row.id) || { held: 0, decks: [] };
  const free = Math.max(0, row.quantity - holding.held);
  // Someone else's copies a deck holds are, to the caller, simply not on offer.
  if (!asOwner && free === 0) throw gone();
  if (quantity > row.quantity) throw assetChanged('Not enough copies remain');
  if (quantity > free) throw asOwner ? deckAllocated(holding.decks) : assetChanged('Not enough copies remain');
  return {
    item_type: 'card',
    source_collection_id: row.id,
    source_sealed_unit_id: null,
    quantity,
    purchase_cost: row.purchase_price,
    market_value: resolveCardPrice(row) || 0,
    row,
    snapshot: cardSnapshot(row),
  };
}

const SEALED_COLUMNS = `u.id AS unit_id, u.opened_at, u.is_trade, u.claimed_by_user_id,
       p.id AS purchase_id, p.user_id AS purchase_owner_id, p.product_id, p.product_name, p.set_name,
       p.sealed_type, p.game, p.image_url, p.unit_price, p.expected_packs, p.expected_cards,
       p.contents_note, p.market_value, p.market_value_source, p.market_value_at,
       COALESCE(p.source_product_name, parent.product_name) AS origin_product_name,
       COALESCE(p.source_unit_number,
         (SELECT COUNT(*) FROM sealed_units source_number
           WHERE source_number.purchase_id = parent.id AND source_number.id <= source_unit.id)
       ) AS origin_unit_number`;

// Whose a sealed unit is follows utils/sealedOwnership (OWNED_UNIT_WHERE): its
// claimant's when someone claimed it, else its buyer's. A unit from the owner's own
// purchase that another member claimed is not theirs to give: unit_claimed.
async function loadSealed(ownerId, item, { asOwner = true, requireMarked = false, settled = false } = {}) {
  const gone = () => (settled ? assetChanged('A sealed product in this offer is no longer available') : notFound('Sealed product not found'));
  const row = await db.get(
    `SELECT ${SEALED_COLUMNS}
       FROM sealed_units u
       JOIN sealed_purchases p ON p.id = u.purchase_id
       LEFT JOIN sealed_units source_unit ON source_unit.id = p.source_unit_id
       LEFT JOIN sealed_purchases parent ON parent.id = source_unit.purchase_id
      WHERE u.id = ? AND ${OWNED_UNIT_WHERE}`,
    [item.id, ownerId, ownerId]
  );
  if (!row) {
    if (asOwner || settled) {
      const claimed = await db.get(
        `SELECT 1 FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id
          WHERE u.id = ? AND p.user_id = ? AND u.claimed_by_user_id IS NOT NULL AND u.claimed_by_user_id != ?`,
        [item.id, ownerId, ownerId]
      );
      if (claimed) throw unitClaimed();
    }
    throw gone();
  }
  if (requireMarked && !row.is_trade) throw gone();
  if (row.opened_at) {
    throw asOwner || settled ? assetChanged('Only unopened sealed products can change hands') : gone();
  }
  return {
    item_type: 'sealed',
    source_collection_id: null,
    source_sealed_unit_id: row.unit_id,
    quantity: 1,
    purchase_cost: row.unit_price,
    market_value: Number(row.market_value) > 0 ? Number(row.market_value) : 0,
    row,
    snapshot: sealedSnapshot(row),
  };
}

// What history shows of a copy: the printing and the physical copy, never where it
// sits or what it is linked to.
function cardSnapshot(row) {
  return {
    card_id: row.card_id,
    name: row.printed_name || row.name,
    set_name: row.set_name,
    number: row.number,
    rarity: row.rarity,
    image_url: row.image_url,
    game: row.game || row.card_game,
    condition: row.condition,
    printing: row.printing,
    language: row.language,
    grader: row.grader,
    grade: row.grade,
    cert_number: row.cert_number,
    purchase_cost: row.purchase_price,
    market_value: row.market_value,
  };
}

function sealedSnapshot(row) {
  return {
    product_id: row.product_id,
    product_name: row.product_name,
    set_name: row.set_name,
    sealed_type: row.sealed_type,
    game: row.game,
    image_url: row.image_url,
    purchase_cost: row.unit_price,
    market_value: row.market_value,
    market_value_source: row.market_value_source,
    market_value_at: row.market_value_at,
    origin_product_name: row.origin_product_name,
    origin_unit_number: row.origin_unit_number,
  };
}

// What was offered is what moves: the same printing in the same condition, the same
// slab. Anything else the owner changed since (a price, a note, where it is filed)
// is theirs to change and does not make it another card.
const CARD_IDENTITY = ['card_id', 'condition', 'printing', 'language', 'grader', 'grade', 'cert_number'];
const SEALED_IDENTITY = ['product_id', 'product_name'];
const comparable = (value) => (value === undefined || value === '' ? null : value);

function sameAsset(itemType, offered, current) {
  const keys = itemType === 'card' ? CARD_IDENTITY : SEALED_IDENTITY;
  return keys.every(key => comparable(offered[key]) === comparable(current[key]));
}

// --- Moving sealed units -----------------------------------------------------------

// A unit that changes hands starts over with its new owner: unclaimed (the new
// purchase is theirs), not for trade, and with its contents not yet applied, so
// opening it gives the new owner what is inside. A claim left in place kept the unit
// its old holder's under the claim rule, wherever its purchase now was.
async function moveSealedUnit(unitId, fromPurchaseId, toPurchaseId) {
  const moved = await db.run(
    `UPDATE sealed_units
        SET purchase_id = ?, claimed_by_user_id = NULL, is_trade = 0, components_applied_at = NULL
      WHERE id = ? AND purchase_id = ? AND opened_at IS NULL`,
    [toPurchaseId, unitId, fromPurchaseId]
  );
  if (moved.changes !== 1) throw assetChanged('A sealed product in this offer is no longer available');
  await db.run(`UPDATE sealed_purchases SET quantity = MAX(0, quantity - 1) WHERE id = ?`, [fromPurchaseId]);
}

// --- Account deletion ----------------------------------------------------------------

// Nothing may stay pending against an account that is about to go: its open offers
// are cancelled and the trade records waiting on (or from) it are rejected. The rows
// themselves stay, SET NULL on the account (db/schema.js), with the names snapshotted,
// so the other member keeps their history.
async function closePendingTradesFor(userId) {
  await db.run(
    `UPDATE user_transfers SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'pending' AND (proposer_id = ? OR recipient_id = ?)`,
    [userId, userId]
  );
  await db.run(
    `UPDATE historical_trades SET status = 'rejected'
      WHERE status = 'pending_confirmation' AND (creator_id = ? OR recipient_id = ?)`,
    [userId, userId]
  );
}

// --- Where a sealed purchase came from ------------------------------------------------
//
// For GET /sealed/purchases and /sealed/units (routes/sealed.js): the trade, gift or
// outside deal that brought a purchase in, shown in the user's language from these
// fields rather than from English written into store/notes. Only for purchases
// `ownerId` bought, and only the latest hand-over that delivered one of its units to
// them. purchase id -> { acquired_transfer_partner, acquired_transfer_type,
// acquired_external_contact, acquired_external_transaction_type }.
async function sealedProvenance(purchaseIds, ownerId) {
  const out = new Map();
  const ids = [...new Set(purchaseIds.filter(Boolean))];
  const entry = (id) => {
    if (!out.has(id)) out.set(id, {});
    return out.get(id);
  };
  for (const part of chunks(ids)) {
    const transfers = await db.all(
      `SELECT u.purchase_id, t.transfer_type,
              CASE WHEN t.recipient_id = i.to_user_id
                   THEN COALESCE(proposer.username, t.proposer_name)
                   ELSE COALESCE(recipient.username, t.recipient_name) END AS partner
         FROM sealed_units u
         JOIN sealed_purchases p ON p.id = u.purchase_id AND p.user_id = ?
         JOIN user_transfer_items i
           ON i.source_sealed_unit_id = u.id AND i.item_type = 'sealed' AND i.to_user_id = p.user_id
         JOIN user_transfers t ON t.id = i.transfer_id AND t.status = 'accepted'
         LEFT JOIN users proposer ON proposer.id = t.proposer_id
         LEFT JOIN users recipient ON recipient.id = t.recipient_id
        WHERE u.purchase_id IN (${holes(part)})
        ORDER BY i.id`,
      [ownerId, ...part]
    );
    for (const row of transfers) {
      Object.assign(entry(row.purchase_id), {
        acquired_transfer_partner: row.partner || null,
        acquired_transfer_type: row.transfer_type,
      });
    }
    const external = await db.all(
      `SELECT u.purchase_id, t.transaction_type, t.contact_name_snapshot
         FROM sealed_units u
         JOIN sealed_purchases p ON p.id = u.purchase_id AND p.user_id = ?
         JOIN external_transaction_items i
           ON i.source_sealed_unit_id = u.id AND i.item_type = 'sealed' AND i.direction = 'received'
         JOIN external_transactions t ON t.id = i.transaction_id AND t.user_id = p.user_id
        WHERE u.purchase_id IN (${holes(part)})
        ORDER BY i.id`,
      [ownerId, ...part]
    );
    for (const row of external) {
      Object.assign(entry(row.purchase_id), {
        acquired_external_contact: row.contact_name_snapshot,
        acquired_external_transaction_type: row.transaction_type,
      });
    }
  }
  return out;
}

// Stamp rows (purchases or units) with sealedProvenance's fields, null where none.
// `purchaseIdOf(row)` names the row's purchase; rows `ownerId` did not buy get nulls.
async function attachSealedProvenance(rows, ownerId, purchaseIdOf, isOwnerOf) {
  const owned = rows.filter(isOwnerOf);
  const provenance = owned.length ? await sealedProvenance(owned.map(purchaseIdOf), ownerId) : new Map();
  for (const row of rows) {
    const found = (isOwnerOf(row) && provenance.get(purchaseIdOf(row))) || {};
    row.acquired_transfer_partner = found.acquired_transfer_partner ?? null;
    row.acquired_transfer_type = found.acquired_transfer_type ?? null;
    row.acquired_external_contact = found.acquired_external_contact ?? null;
    row.acquired_external_transaction_type = found.acquired_external_transaction_type ?? null;
  }
  return rows;
}

module.exports = {
  TransferError,
  invalid,
  forbidden,
  notFound,
  notPending,
  assetChanged,
  unitClaimed,
  deckAllocated,
  respondError,
  refuseApiKeys,
  assertTradesEnabled,
  tradingMember,
  positiveInt,
  readMessage,
  parseItems,
  mergeItems,
  assetKey,
  readPage,
  pageOf,
  idCursor,
  chunks,
  holes,
  deckHoldings,
  deckState,
  warningsFor,
  deckWarnings,
  loadAsset,
  cardSnapshot,
  sealedSnapshot,
  sameAsset,
  moveSealedUnit,
  closePendingTradesFor,
  sealedProvenance,
  attachSealedProvenance,
  MAX_ENTRIES,
  MAX_COPIES,
};
