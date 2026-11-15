// Trades and gifts between the members of one Bindarr. One member offers copies
// (and, in a trade, asks for some the other marked for trade); the other accepts,
// rejects or counters. Accepting moves the cards and sealed units between the two
// collections in one transaction.
//
// Trading is opt-in (users.trades_enabled). A member who has not turned it on is
// not listed to anyone and cannot be sent an offer, and cannot list members or make,
// counter or accept one; the offers they already have stay visible, and they can
// still reject or cancel them.
//
// Server-only (routes/mounts.js): a phone has no other members. Trades recorded
// after the fact are routes/historicalTrades.js, deals with people outside Bindarr
// routes/externalTransfers.js; what the three share is utils/transferAssets.js,
// including the error codes every refusal here carries.
'use strict';

const express = require('express');
const db = require('../db');
const { withTransaction } = require('../db');
const { splitPrice } = require('../utils/splitPrice');
const { OWNED_UNIT_WHERE, getOwnedUnit } = require('../utils/sealedOwnership');
const T = require('../utils/transferAssets');

const router = express.Router();
router.use('/transfers', T.refuseApiKeys);

// Open offers between two members, both directions together. Each one asks the
// other member to act, so an unbounded number is a way to flood them.
const MAX_PENDING_BETWEEN = 10;

// The names the history shows: the account's current name, or the one snapshotted
// when the offer was made if the account has since been deleted.
const TRANSFER_SELECT = `
  SELECT t.*,
         COALESCE(proposer.username, t.proposer_name) AS proposer_username,
         COALESCE(recipient.username, t.recipient_name) AS recipient_username
    FROM user_transfers t
    LEFT JOIN users proposer ON proposer.id = t.proposer_id
    LEFT JOIN users recipient ON recipient.id = t.recipient_id`;

async function assertPendingRoom(a, b) {
  const { n } = await db.get(
    `SELECT COUNT(*) AS n FROM user_transfers
      WHERE status = 'pending'
        AND ((proposer_id = ? AND recipient_id = ?) OR (proposer_id = ? AND recipient_id = ?))`,
    [a, b, b, a]
  );
  if (n >= MAX_PENDING_BETWEEN) {
    throw new T.TransferError(409, 'too_many_pending',
      `There are already ${MAX_PENDING_BETWEEN} open offers between you two. Settle some first.`,
      { params: { max: MAX_PENDING_BETWEEN } });
  }
}

// An offer the caller is `role` ('proposer' or 'recipient') of, still pending. A
// member who is neither side, or the wrong one, is refused (403).
async function loadPendingTransfer(id, userId, role, message) {
  const transfer = await db.get(`SELECT * FROM user_transfers WHERE id = ?`, [id]);
  if (!transfer) throw T.notFound('Offer not found');
  const side = transfer.proposer_id === userId ? 'proposer'
    : transfer.recipient_id === userId ? 'recipient' : null;
  if (side !== role) throw T.forbidden(message);
  if (transfer.status !== 'pending') throw T.notPending();
  return transfer;
}

// --- Reading ---------------------------------------------------------------------

// The offers with their items and the viewer's deck warnings, in a fixed number of
// queries however many offers there are (this used to be a query per offer, and
// another per card for the warnings).
async function hydrateTransfers(transfers, viewerId) {
  if (transfers.length === 0) return [];
  const items = [];
  for (const part of T.chunks(transfers.map(t => t.id))) {
    items.push(...await db.all(
      `SELECT * FROM user_transfer_items WHERE transfer_id IN (${T.holes(part)}) ORDER BY id`,
      part
    ));
  }
  const byTransfer = new Map();
  for (const item of items) {
    if (!byTransfer.has(item.transfer_id)) byTransfer.set(item.transfer_id, []);
    byTransfer.get(item.transfer_id).push(item);
  }

  // Warnings are the viewer's own, on open offers only: what handing over their
  // side would cost a checked-out deck of theirs.
  const outgoing = new Map();
  const cardIds = new Set();
  for (const transfer of transfers) {
    if (transfer.status !== 'pending') continue;
    const cards = new Map();
    for (const item of byTransfer.get(transfer.id) || []) {
      if (item.item_type !== 'card' || item.from_user_id !== viewerId) continue;
      const snapshot = JSON.parse(item.item_snapshot);
      const card = cards.get(snapshot.card_id) || { name: snapshot.name, quantity: 0 };
      card.quantity += item.quantity;
      cards.set(snapshot.card_id, card);
      cardIds.add(snapshot.card_id);
    }
    if (cards.size) outgoing.set(transfer.id, cards);
  }
  const state = cardIds.size ? await T.deckState(viewerId, [...cardIds]) : null;

  return transfers.map(transfer => ({
    ...transfer,
    items: (byTransfer.get(transfer.id) || []).map(item => hydrateItem(item, transfer, viewerId)),
    deck_warnings: outgoing.has(transfer.id) ? T.warningsFor(state, viewerId, outgoing.get(transfer.id)) : [],
  }));
}

// Each side sees what it paid, never the other's cost basis.
function hydrateItem(item, transfer, viewerId) {
  const snapshot = JSON.parse(item.item_snapshot);
  const sentByViewer = item.from_user_id === viewerId;
  if (!sentByViewer) delete snapshot.purchase_cost;
  // Offered (proposer to recipient) or requested (the other way). Read from whichever
  // end still has an account: a deleted member's end is NULL.
  const offered = item.from_user_id != null
    ? item.from_user_id === transfer.proposer_id
    : item.to_user_id === transfer.recipient_id;
  return {
    ...item,
    from_username: offered ? transfer.proposer_username : transfer.recipient_username,
    to_username: offered ? transfer.recipient_username : transfer.proposer_username,
    purchase_cost: sentByViewer ? item.purchase_cost : null,
    received_cost: item.to_user_id === viewerId ? item.received_cost : null,
    item_snapshot: snapshot,
  };
}

async function transferById(id, viewerId) {
  const transfer = await db.get(`${TRANSFER_SELECT} WHERE t.id = ?`, [id]);
  return (await hydrateTransfers([transfer], viewerId))[0];
}

// --- Making an offer -----------------------------------------------------------------

// Writes the offer and its items. Everything is read and checked first, so a refused
// item writes nothing. Inside the caller's transaction.
//
// `allowedRequestedItems` (assetKey set): items a counter may ask back although they
// are not marked for trade, because the other member offered them in the first place.
async function createTransfer({
  proposerId, recipientId, transferType, offeredItems, requestedItems,
  responseToTransferId = null, message = null, allowedRequestedItems = new Set(),
}) {
  if (!['gift', 'trade'].includes(transferType)) throw T.invalid('transfer_type must be gift or trade');
  if (transferType === 'gift' && requestedItems.length > 0) throw T.invalid('A gift cannot ask for items in return');
  if (proposerId === recipientId) throw T.invalid('You cannot send an offer to yourself');
  const recipient = await T.tradingMember(recipientId);
  const proposer = await db.get(`SELECT id, username FROM users WHERE id = ?`, [proposerId]);
  await assertPendingRoom(proposerId, recipientId);

  const sides = [
    { items: T.mergeItems(offeredItems), from: proposerId, to: recipientId, requested: false, assets: [] },
    { items: T.mergeItems(requestedItems), from: recipientId, to: proposerId, requested: true, assets: [] },
  ];
  for (const side of sides) {
    for (const item of side.items) {
      // The caller's own items get the precise refusal; the other member's are
      // either marked for trade and free, or not found.
      side.assets.push(await T.loadAsset(side.from, item, side.requested
        ? { asOwner: false, requireMarked: !allowedRequestedItems.has(T.assetKey(item.type, item.id)) }
        : { asOwner: true }));
    }
  }

  const transfer = await db.run(
    `INSERT INTO user_transfers
       (proposer_id, recipient_id, proposer_name, recipient_name, transfer_type, response_to_transfer_id, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [proposerId, recipientId, proposer.username, recipient.username, transferType, responseToTransferId, message]
  );
  // One row per copy: each copy is costed, received and traced on its own.
  for (const side of sides) {
    for (const asset of side.assets) {
      for (let copy = 0; copy < asset.quantity; copy++) {
        await db.run(
          `INSERT INTO user_transfer_items
             (transfer_id, from_user_id, to_user_id, item_type, source_collection_id,
              source_sealed_unit_id, quantity, purchase_cost, item_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [transfer.lastID, side.from, side.to, asset.item_type, asset.source_collection_id,
            asset.source_sealed_unit_id, asset.purchase_cost, JSON.stringify(asset.snapshot)]
        );
      }
    }
  }
  return transfer.lastID;
}

// --- Accepting ------------------------------------------------------------------------

// The whole hand-over in one transaction. Every item is checked before anything
// moves: still there, still its owner's to give (not claimed by someone else, not
// held by a checked-out deck), and still the copy that was offered. Returns the
// caller's deck warnings.
async function acceptTransfer(transferId, userId) {
  return withTransaction(async () => {
    const transfer = await loadPendingTransfer(transferId, userId, 'recipient', 'Only the recipient can accept this offer');
    const items = await db.all(`SELECT * FROM user_transfer_items WHERE transfer_id = ? ORDER BY id`, [transferId]);
    if (items.length === 0) throw T.assetChanged('This offer has no items');
    if (transfer.transfer_type === 'trade' && !items.some(item => item.from_user_id === transfer.recipient_id)) {
      throw new T.TransferError(409, 'needs_counter', 'A one-sided trade has to be countered before it can be accepted');
    }

    // The copies of one entry, or the one unit, each item names.
    const groups = new Map();
    const groupOf = (item) => groups.get(T.assetKey(item.item_type,
      item.item_type === 'card' ? item.source_collection_id : item.source_sealed_unit_id));
    for (const item of items) {
      const sourceId = item.item_type === 'card' ? item.source_collection_id : item.source_sealed_unit_id;
      // A source that was deleted (SET NULL), or a side whose account is gone.
      if (!sourceId || item.from_user_id == null || item.to_user_id == null) throw T.assetChanged();
      const key = T.assetKey(item.item_type, sourceId);
      if (!groups.has(key)) groups.set(key, { type: item.item_type, id: sourceId, ownerId: item.from_user_id, items: [] });
      const group = groups.get(key);
      if (group.ownerId !== item.from_user_id || (group.type === 'sealed' && group.items.length)) throw T.assetChanged();
      group.items.push(item);
    }

    for (const group of groups.values()) {
      group.asset = await T.loadAsset(group.ownerId, { type: group.type, id: group.id, quantity: group.items.length },
        { asOwner: group.ownerId === userId, settled: true });
      // What was offered is what moves; the snapshot stays as it was offered.
      for (const item of group.items) {
        if (!T.sameAsset(group.type, JSON.parse(item.item_snapshot), group.asset.snapshot)) {
          throw T.assetChanged('An item changed after it was offered');
        }
      }
      const { snapshot } = group.asset;
      if (group.type === 'card' && snapshot.cert_number) {
        const toUserId = group.items[0].to_user_id;
        const duplicate = await db.get(
          `SELECT 1 FROM collection WHERE user_id = ? AND grader = ? AND cert_number = ?`,
          [toUserId, snapshot.grader, snapshot.cert_number]
        );
        // Whether the OTHER member holds that slab is theirs to know.
        if (duplicate) {
          throw toUserId === userId
            ? new T.TransferError(409, 'already_owned', 'You already own this graded card')
            : T.assetChanged();
        }
      }
    }

    // Cost basis: a gift costs nothing; in a trade each side's received items share
    // what its outgoing items cost, weighted by their market value (splitPrice's
    // default, as everywhere else): a $100 card for a $95 card and a $5 card gives
    // them $95 and $5, not $50 each. An outgoing cost nobody knows makes the received
    // ones unknown too.
    for (const item of items) item.purchase_cost = groupOf(item).asset.purchase_cost;
    if (transfer.transfer_type === 'gift') {
      for (const item of items) item.received_cost = 0;
    } else {
      for (const ownerId of [transfer.proposer_id, transfer.recipient_id]) {
        const outgoing = items.filter(item => item.from_user_id === ownerId);
        const incoming = items.filter(item => item.to_user_id === ownerId);
        if (incoming.length === 0) continue;
        if (outgoing.some(item => item.purchase_cost == null)) {
          for (const item of incoming) item.received_cost = null;
          continue;
        }
        const total = outgoing.reduce((sum, item) => sum + Number(item.purchase_cost || 0), 0);
        const shares = splitPrice(incoming.map(item => groupOf(item).asset.market_value), total);
        incoming.forEach((item, index) => { item.received_cost = shares[index]; });
      }
    }
    for (const item of items) {
      await db.run(
        `UPDATE user_transfer_items SET purchase_cost = ?, received_cost = ? WHERE id = ?`,
        [item.purchase_cost, item.received_cost, item.id]
      );
    }

    const warnings = await T.deckWarnings(items
      .filter(item => item.item_type === 'card')
      .map(item => ({
        userId: item.from_user_id,
        cardId: groupOf(item).asset.row.card_id,
        name: groupOf(item).asset.snapshot.name,
        quantity: 1,
      })));

    for (const group of groups.values()) {
      if (group.type !== 'card') continue;
      const count = group.items.length;
      if (group.asset.row.quantity === count) {
        await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [group.id, group.ownerId]);
      } else {
        await db.run(`UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?`, [count, group.id, group.ownerId]);
      }
    }

    // The received copies land unsorted. They take the copy (printing, condition,
    // grading, its market value) and nothing of the sender's own: not their notes,
    // not the sealed unit they pulled it from.
    for (const item of items) {
      if (item.item_type !== 'card') continue;
      const source = groupOf(item).asset.row;
      await db.run(
        `INSERT INTO collection
           (card_id, user_id, quantity, condition, printing, language, purchase_price,
            location_id, compartment_id, position, favorite, is_trade, list_type, game,
            added_at, notes, grader, grade, cert_number, market_value,
            market_value_source, market_value_at, sealed_unit_id, acquired_via_transfer_item_id)
         VALUES (?, ?, 1, ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 'collection', ?,
                 CURRENT_TIMESTAMP, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [source.card_id, item.to_user_id, source.condition, source.printing, source.language,
          item.received_cost, source.game || source.card_game, source.grader, source.grade,
          source.cert_number, source.market_value, source.market_value_source,
          source.market_value_at, item.id]
      );
    }

    // A sealed unit moves into a purchase of the recipient's own. Where it came from
    // is not written into store/notes (English, in one member's words): GET
    // /sealed/purchases reads it from this transfer. The parent unit stays a snapshot
    // (source_product_name/number): it belongs to another account.
    for (const group of groups.values()) {
      if (group.type !== 'sealed') continue;
      const [item] = group.items;
      const source = group.asset.row;
      const purchase = await db.run(
        `INSERT INTO sealed_purchases
           (user_id, product_id, product_name, set_name, sealed_type, game, image_url,
            store, purchase_date, unit_price, quantity, notes, expected_packs,
            expected_cards, contents_note, source_unit_id, source_product_name,
            source_unit_number, market_value, market_value_source, market_value_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, DATE('now'), ?, 1, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [item.to_user_id, source.product_id, source.product_name, source.set_name,
          source.sealed_type, source.game, source.image_url, item.received_cost,
          source.expected_packs, source.expected_cards, source.contents_note,
          source.origin_product_name, source.origin_unit_number, source.market_value,
          source.market_value_source, source.market_value_at]
      );
      await T.moveSealedUnit(source.unit_id, source.purchase_id, purchase.lastID);
    }

    const settled = await db.run(
      `UPDATE user_transfers SET status = 'accepted', updated_at = CURRENT_TIMESTAMP,
         completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
      [transferId]
    );
    if (settled.changes !== 1) throw T.notPending();
    return warnings.filter(warning => warning.user_id === userId);
  });
}

// --- Routes ------------------------------------------------------------------------------

// The members the caller can trade with: everyone else who turned trading on.
router.get('/transfers/users', async (req, res) => {
  try {
    await T.assertTradesEnabled(req.user.id);
    const users = await db.all(
      `SELECT id, username FROM users WHERE id != ? AND trades_enabled = 1 ORDER BY username COLLATE NOCASE`,
      [req.user.id]
    );
    res.json({ users });
  } catch (error) {
    T.respondError(res, error, 'Failed to retrieve members');
  }
});

// What a member marked for trade: what an offer to them may ask for. Copies a
// checked-out deck holds are not on offer, so `quantity` is the free copies. Never
// the cost basis.
router.get('/transfers/marked/:userId', async (req, res) => {
  try {
    await T.assertTradesEnabled(req.user.id);
    const userId = T.positiveInt(req.params.userId, 'userId');
    await T.tradingMember(userId);
    const rows = await db.all(
      `SELECT c.id AS entry_id, c.card_id, c.quantity, c.condition, c.printing, c.language,
              c.grader, c.grade,
              cc.name, cc.printed_name, cc.set_name, cc.number, cc.rarity, cc.image_url, cc.game
         FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.list_type = 'collection' AND c.is_trade = 1
        ORDER BY cc.name, cc.set_name, cc.number`,
      [userId]
    );
    const holdings = await T.deckHoldings(rows.map(row => row.entry_id));
    const cards = rows
      .map(row => ({ ...row, quantity: row.quantity - (holdings.get(row.entry_id)?.held || 0) }))
      .filter(row => row.quantity > 0);
    const sealed = await db.all(
      `SELECT u.id AS unit_id, p.product_id, p.product_name, p.set_name, p.sealed_type,
              p.game, p.image_url,
              COALESCE(p.source_product_name, parent.product_name) AS origin_product_name
         FROM sealed_units u
         JOIN sealed_purchases p ON p.id = u.purchase_id
         LEFT JOIN sealed_units source_unit ON source_unit.id = p.source_unit_id
         LEFT JOIN sealed_purchases parent ON parent.id = source_unit.purchase_id
        WHERE ${OWNED_UNIT_WHERE} AND u.opened_at IS NULL AND u.is_trade = 1
        ORDER BY p.product_name`,
      [userId, userId]
    );
    res.json({ cards, sealed });
  } catch (error) {
    T.respondError(res, error, 'Failed to retrieve trade-marked items');
  }
});

// Mark (or unmark) one of the caller's unopened sealed units for trade, like
// is_trade on a card. Whose a unit is follows the claim rule (utils/sealedOwnership).
// Not opt-in: marking is the caller's own business.
router.put('/transfers/sealed/:unitId/trade', async (req, res) => {
  try {
    const unitId = T.positiveInt(req.params.unitId, 'unitId');
    if (typeof req.body?.is_trade !== 'boolean') throw T.invalid('is_trade must be a boolean');
    const unit = await getOwnedUnit(req.user.id, unitId);
    if (!unit) throw T.notFound('Sealed unit not found');
    if (unit.opened_at) throw T.assetChanged('Opened sealed products cannot be marked for trade');
    await db.run(`UPDATE sealed_units SET is_trade = ? WHERE id = ?`, [req.body.is_trade ? 1 : 0, unitId]);
    res.json({ id: unitId, is_trade: req.body.is_trade });
  } catch (error) {
    T.respondError(res, error, 'Failed to update sealed trade status');
  }
});

// The caller's offers, sent and received, newest first. Paged (utils/transferAssets
// readPage): the first page also holds every open offer, however old.
router.get('/transfers', async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit, cursor } = T.readPage(req.query, T.idCursor.parse);
    const mine = `(t.proposer_id = ? OR t.recipient_id = ?)`;
    const open = cursor ? [] : await db.all(
      `${TRANSFER_SELECT} WHERE ${mine} AND t.status = 'pending' ORDER BY t.id DESC`,
      [userId, userId]
    );
    const closed = await db.all(
      `${TRANSFER_SELECT} WHERE ${mine} AND t.status != 'pending' ${cursor ? 'AND t.id < ?' : ''}
        ORDER BY t.id DESC LIMIT ?`,
      [userId, userId, ...(cursor ? [cursor.id] : []), limit + 1]
    );
    const { page, nextCursor } = T.pageOf(closed, limit, T.idCursor.make);
    const transfers = [...open, ...page].sort((a, b) => b.id - a.id);
    res.json({ transfers: await hydrateTransfers(transfers, userId), next_cursor: nextCursor });
  } catch (error) {
    T.respondError(res, error, 'Failed to retrieve offers');
  }
});

router.post('/transfers', async (req, res) => {
  try {
    await T.assertTradesEnabled(req.user.id);
    const recipientId = T.positiveInt(req.body?.recipient_id, 'recipient_id');
    const offeredItems = T.parseItems(req.body?.offered_items, 'offered_items', { required: true });
    const requestedItems = T.parseItems(req.body?.requested_items ?? [], 'requested_items');
    const message = T.readMessage(req.body?.message);
    const transferId = await withTransaction(() => createTransfer({
      proposerId: req.user.id, recipientId, transferType: req.body?.transfer_type,
      offeredItems, requestedItems, message,
    }));
    res.status(201).json({ transfer: await transferById(transferId, req.user.id) });
  } catch (error) {
    T.respondError(res, error, 'Failed to create the offer');
  }
});

// The recipient answers with an offer of their own: the original is settled as
// 'countered' and the counter goes back to its proposer. It may ask back anything the
// original offered, marked for trade or not.
router.post('/transfers/:id/counter', async (req, res) => {
  try {
    await T.assertTradesEnabled(req.user.id);
    const transferId = T.positiveInt(req.params.id, 'transfer id');
    const offeredItems = T.parseItems(req.body?.offered_items, 'offered_items', { required: true });
    const requestedItems = T.parseItems(req.body?.requested_items, 'requested_items', { required: true });
    const message = T.readMessage(req.body?.message);
    const counterId = await withTransaction(async () => {
      const original = await loadPendingTransfer(transferId, req.user.id, 'recipient', 'Only the recipient can counter this offer');
      const originalOffered = await db.all(
        `SELECT item_type, source_collection_id, source_sealed_unit_id
           FROM user_transfer_items WHERE transfer_id = ? AND from_user_id = ?`,
        [original.id, original.proposer_id]
      );
      const allowedRequestedItems = new Set(originalOffered.map(item => T.assetKey(item.item_type,
        item.item_type === 'card' ? item.source_collection_id : item.source_sealed_unit_id)));
      // Settled first, so the counter does not count against the cap it replaces.
      const settled = await db.run(
        `UPDATE user_transfers SET status = 'countered', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'`,
        [original.id]
      );
      if (settled.changes !== 1) throw T.notPending();
      return createTransfer({
        proposerId: req.user.id,
        recipientId: original.proposer_id,
        transferType: 'trade',
        offeredItems,
        requestedItems,
        responseToTransferId: original.id,
        message,
        allowedRequestedItems,
      });
    });
    res.status(201).json({ transfer: await transferById(counterId, req.user.id) });
  } catch (error) {
    T.respondError(res, error, 'Failed to create the counteroffer');
  }
});

router.put('/transfers/:id/accept', async (req, res) => {
  try {
    await T.assertTradesEnabled(req.user.id);
    const id = T.positiveInt(req.params.id, 'transfer id');
    const deckWarnings = await acceptTransfer(id, req.user.id);
    res.json({ transfer: await transferById(id, req.user.id), deck_warnings: deckWarnings });
  } catch (error) {
    T.respondError(res, error, 'Failed to accept the offer');
  }
});

// Rejecting and cancelling stay open to a member who turned trading off: they are
// how the offers they already have get settled.
function settleRoute(role, status, refusal, done, failure) {
  return async (req, res) => {
    try {
      const id = T.positiveInt(req.params.id, 'transfer id');
      await withTransaction(async () => {
        await loadPendingTransfer(id, req.user.id, role, refusal);
        const updated = await db.run(
          `UPDATE user_transfers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
          [status, id]
        );
        if (updated.changes !== 1) throw T.notPending();
      });
      res.json({ message: done });
    } catch (error) {
      T.respondError(res, error, failure);
    }
  };
}

router.put('/transfers/:id/reject', settleRoute(
  'recipient', 'rejected', 'Only the recipient can reject this offer', 'Transfer rejected', 'Failed to reject the offer'
));
router.put('/transfers/:id/cancel', settleRoute(
  'proposer', 'cancelled', 'Only the proposer can cancel this offer', 'Transfer cancelled', 'Failed to cancel the offer'
));

module.exports = router;
