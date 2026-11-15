// Trades between two members that happened before (or outside of) Bindarr's offers,
// recorded after the fact. One member writes down what changed hands and when,
// optionally naming which of their copies each card was; the other confirms it,
// naming theirs, or declines. Confirming reconciles both collections: the copies
// given leave, the copies received are traced to the record.
//
// Same opt-in as offers (routes/transfers.js): recording or confirming needs trading
// turned on, and only a member who turned it on can be named in a record. Declining
// and cancelling stay open, so a member who turned it off can still settle what
// they have. Server-only, like the offers (routes/mounts.js). The paths are the ones
// these routes had inside routes/transfers.js.
'use strict';

const express = require('express');
const db = require('../db');
const { withTransaction } = require('../db');
const T = require('../utils/transferAssets');

const router = express.Router();
router.use('/transfers/history', T.refuseApiKeys);

// Records waiting for confirmation between two members, both directions together.
const MAX_PENDING_BETWEEN = 10;

const TRADE_SELECT = `
  SELECT h.*,
         COALESCE(creator.username, h.creator_name) AS creator_username,
         COALESCE(recipient.username, h.recipient_name) AS recipient_username
    FROM historical_trades h
    LEFT JOIN users creator ON creator.id = h.creator_id
    LEFT JOIN users recipient ON recipient.id = h.recipient_id`;

// Newest trade first by the date it happened, so a cursor is the last row's date
// and id.
const tradeCursor = {
  parse: (s) => {
    const m = /^(.{1,40})_([1-9]\d{0,15})$/.exec(s);
    return m ? { completedAt: m[1], id: Number(m[2]) } : null;
  },
  make: (row) => `${row.completed_at}_${row.id}`,
};
const newestFirst = (a, b) => (a.completed_at < b.completed_at ? 1 : a.completed_at > b.completed_at ? -1 : b.id - a.id);

async function hydrateTrades(trades, viewerId) {
  if (trades.length === 0) return [];
  const rows = [];
  for (const part of T.chunks(trades.map(trade => trade.id))) {
    rows.push(...await db.all(
      `SELECT id, trade_id, from_user_id, to_user_id, card_id, quantity, item_snapshot,
              creator_collection_id, recipient_collection_id
         FROM historical_trade_items WHERE trade_id IN (${T.holes(part)}) ORDER BY id`,
      part
    ));
  }
  const byTrade = new Map();
  for (const row of rows) {
    if (!byTrade.has(row.trade_id)) byTrade.set(row.trade_id, []);
    byTrade.get(row.trade_id).push(row);
  }
  return trades.map(trade => ({
    ...trade,
    items: (byTrade.get(trade.id) || []).map(item => ({
      id: item.id,
      from_user_id: item.from_user_id,
      to_user_id: item.to_user_id,
      card_id: item.card_id,
      quantity: item.quantity,
      item_snapshot: JSON.parse(item.item_snapshot),
      my_collection_id: viewerId === trade.creator_id ? item.creator_collection_id : item.recipient_collection_id,
    })),
  }));
}

async function tradeById(id, viewerId) {
  const trade = await db.get(`${TRADE_SELECT} WHERE h.id = ?`, [id]);
  return (await hydrateTrades([trade], viewerId))[0];
}

async function assertPendingRoom(a, b) {
  const { n } = await db.get(
    `SELECT COUNT(*) AS n FROM historical_trades
      WHERE status = 'pending_confirmation'
        AND ((creator_id = ? AND recipient_id = ?) OR (creator_id = ? AND recipient_id = ?))`,
    [a, b, b, a]
  );
  if (n >= MAX_PENDING_BETWEEN) {
    throw new T.TransferError(409, 'too_many_pending',
      `There are already ${MAX_PENDING_BETWEEN} records waiting between you two. Settle some first.`,
      { params: { max: MAX_PENDING_BETWEEN } });
  }
}

// A record the caller is `role` ('creator' or 'recipient') of, still waiting.
async function loadPendingTrade(id, userId, role, message) {
  const trade = await db.get(`SELECT * FROM historical_trades WHERE id = ?`, [id]);
  if (!trade) throw T.notFound('Trade record not found');
  const side = trade.creator_id === userId ? 'creator'
    : trade.recipient_id === userId ? 'recipient' : null;
  if (side !== role) throw T.forbidden(message);
  if (trade.status !== 'pending_confirmation') {
    throw T.notPending('This record is no longer awaiting confirmation');
  }
  return trade;
}

function readCompletedAt(value) {
  const completedAt = typeof value === 'string' ? value : '';
  const parsed = new Date(`${completedAt}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(completedAt)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== completedAt) {
    throw T.invalid('completed_at must be a valid date');
  }
  if (completedAt > new Date().toISOString().slice(0, 10)) {
    throw T.invalid('completed_at cannot be in the future');
  }
  return completedAt;
}

function validateHistoricalItems(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > T.MAX_ENTRIES) {
    throw T.invalid(`A trade record must contain 2 to ${T.MAX_ENTRIES} card entries`);
  }
  const result = value.map(item => {
    if (!item || !['given', 'received'].includes(item.direction)) {
      throw T.invalid('Each card must be marked given or received');
    }
    const cardId = typeof item.card_id === 'string' ? item.card_id.trim() : '';
    if (!cardId) throw T.invalid('Each card needs a card_id');
    return {
      direction: item.direction,
      cardId,
      quantity: T.positiveInt(item.quantity ?? 1, 'quantity'),
      collectionId: item.collection_entry_id == null || item.collection_entry_id === ''
        ? null
        : T.positiveInt(item.collection_entry_id, 'collection_entry_id'),
    };
  });
  if (!result.some(item => item.direction === 'given') || !result.some(item => item.direction === 'received')) {
    throw T.invalid('A trade record needs cards on both sides');
  }
  if (result.reduce((sum, item) => sum + item.quantity, 0) > T.MAX_COPIES) {
    throw T.invalid(`A trade record cannot contain more than ${T.MAX_COPIES} copies`);
  }
  return result;
}

// The copies one member named for a record (`field`: creator_collection_id or
// recipient_collection_id), checked against their collection now: a copy they gave
// must still have that many copies no checked-out deck holds; a copy they received
// must be one whole entry, not already traced to another record. `asOwner`: the
// caller named these, and is told which deck holds a copy.
async function validateHistoricalMapping(userId, items, field, { asOwner }) {
  const given = new Map();
  const received = new Set();
  const rows = new Map();
  for (const item of items) {
    const entryId = item[field];
    if (entryId == null) continue;
    const row = rows.get(entryId) || await db.get(
      `SELECT id, card_id, quantity, acquired_via_historical_trade_item_id FROM collection
        WHERE id = ? AND user_id = ? AND list_type = 'collection'`,
      [entryId, userId]
    );
    if (!row || row.card_id !== item.card_id) throw T.assetChanged('A linked collection card is no longer available');
    rows.set(row.id, row);
    if (item.from_user_id === userId) {
      if (received.has(row.id)) throw T.invalid('One collection entry cannot be both sides of a trade');
      given.set(row.id, (given.get(row.id) || 0) + item.quantity);
    } else {
      if (received.has(row.id) || given.has(row.id)) throw T.invalid('One collection entry cannot be both sides of a trade');
      if (item.quantity !== row.quantity || row.acquired_via_historical_trade_item_id != null) {
        throw T.assetChanged('A received card must link to one whole collection entry of its own');
      }
      received.add(row.id);
    }
  }
  const holdings = await T.deckHoldings([...given.keys()]);
  for (const [entryId, quantity] of given) {
    const row = rows.get(entryId);
    if (quantity > row.quantity) throw T.assetChanged('A linked collection card no longer has enough copies');
    const holding = holdings.get(entryId);
    if (holding && quantity > row.quantity - holding.held) {
      throw asOwner ? T.deckAllocated(holding.decks) : T.assetChanged('A linked collection card no longer has enough copies');
    }
  }
}

async function applyHistoricalMapping(userId, items, field) {
  const given = new Map();
  const received = [];
  for (const item of items) {
    const entryId = item[field];
    if (entryId == null) continue;
    if (item.from_user_id === userId) given.set(entryId, (given.get(entryId) || 0) + item.quantity);
    else received.push(item);
  }
  for (const [entryId, quantity] of given) {
    const row = await db.get(`SELECT quantity FROM collection WHERE id = ? AND user_id = ?`, [entryId, userId]);
    if (quantity === row.quantity) {
      await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [entryId, userId]);
    } else {
      await db.run(`UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?`, [quantity, entryId, userId]);
    }
  }
  for (const item of received) {
    await db.run(
      `UPDATE collection SET acquired_via_historical_trade_item_id = ? WHERE id = ? AND user_id = ?`,
      [item.id, item[field], userId]
    );
  }
}

// The caller's records, newest trade first. Paged like offers (utils/transferAssets
// readPage): the first page also holds every record still awaiting confirmation. A
// record the other member declined stays its creator's to see.
router.get('/transfers/history', async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit, cursor } = T.readPage(req.query, tradeCursor.parse);
    const visible = `(h.creator_id = ? OR h.recipient_id = ?) AND (h.status != 'rejected' OR h.creator_id = ?)`;
    const open = cursor ? [] : await db.all(
      `${TRADE_SELECT} WHERE ${visible} AND h.status = 'pending_confirmation'
        ORDER BY h.completed_at DESC, h.id DESC`,
      [userId, userId, userId]
    );
    const closed = await db.all(
      `${TRADE_SELECT} WHERE ${visible} AND h.status != 'pending_confirmation'
        ${cursor ? 'AND (h.completed_at < ? OR (h.completed_at = ? AND h.id < ?))' : ''}
        ORDER BY h.completed_at DESC, h.id DESC LIMIT ?`,
      [userId, userId, userId, ...(cursor ? [cursor.completedAt, cursor.completedAt, cursor.id] : []), limit + 1]
    );
    const { page, nextCursor } = T.pageOf(closed, limit, tradeCursor.make);
    const trades = [...open, ...page].sort(newestFirst);
    res.json({ trades: await hydrateTrades(trades, userId), next_cursor: nextCursor });
  } catch (error) {
    T.respondError(res, error, 'Failed to retrieve trade records');
  }
});

router.post('/transfers/history', async (req, res) => {
  try {
    await T.assertTradesEnabled(req.user.id);
    const recipientId = T.positiveInt(req.body?.recipient_id, 'recipient_id');
    if (recipientId === req.user.id) throw T.invalid('You cannot record a trade with yourself');
    const completedAt = readCompletedAt(req.body?.completed_at);
    const requestItems = validateHistoricalItems(req.body?.items);
    const message = T.readMessage(req.body?.message);
    const tradeId = await withTransaction(async () => {
      const recipient = await T.tradingMember(recipientId);
      const creator = await db.get(`SELECT username FROM users WHERE id = ?`, [req.user.id]);
      await assertPendingRoom(req.user.id, recipientId);
      const trade = await db.run(
        `INSERT INTO historical_trades (creator_id, recipient_id, creator_name, recipient_name, completed_at, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.id, recipientId, creator.username, recipient.username, completedAt, message]
      );
      const items = [];
      for (const item of requestItems) {
        const card = await db.get(
          `SELECT id, name, printed_name, set_name, number, rarity, image_url, game
             FROM card_cache WHERE id = ?`,
          [item.cardId]
        );
        if (!card) throw T.notFound('A selected card was not found');
        let copy = null;
        if (item.collectionId != null) {
          copy = await db.get(
            `SELECT id, card_id, condition, printing, language
               FROM collection WHERE id = ? AND user_id = ? AND list_type = 'collection'`,
            [item.collectionId, req.user.id]
          );
          if (!copy || copy.card_id !== item.cardId) {
            throw T.assetChanged('A linked collection card is no longer available');
          }
        }
        const fromUserId = item.direction === 'given' ? req.user.id : recipientId;
        const toUserId = item.direction === 'given' ? recipientId : req.user.id;
        const snapshot = {
          card_id: card.id,
          name: card.printed_name || card.name,
          set_name: card.set_name,
          number: card.number,
          rarity: card.rarity,
          image_url: card.image_url,
          game: card.game,
          condition: copy?.condition || null,
          printing: copy?.printing || null,
          language: copy?.language || null,
        };
        const inserted = await db.run(
          `INSERT INTO historical_trade_items
             (trade_id, from_user_id, to_user_id, card_id, quantity, item_snapshot, creator_collection_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [trade.lastID, fromUserId, toUserId, card.id, item.quantity, JSON.stringify(snapshot), item.collectionId]
        );
        items.push({
          id: inserted.lastID,
          from_user_id: fromUserId,
          to_user_id: toUserId,
          card_id: card.id,
          quantity: item.quantity,
          creator_collection_id: item.collectionId,
        });
      }
      await validateHistoricalMapping(req.user.id, items, 'creator_collection_id', { asOwner: true });
      return trade.lastID;
    });
    res.status(201).json({ trade: await tradeById(tradeId, req.user.id) });
  } catch (error) {
    T.respondError(res, error, 'Failed to record the trade');
  }
});

// The other member confirms, naming for each card which of their copies it was (or
// none). Both members' copies are checked again and reconciled in one transaction.
router.put('/transfers/history/:id/confirm', async (req, res) => {
  try {
    await T.assertTradesEnabled(req.user.id);
    const id = T.positiveInt(req.params.id, 'trade record id');
    await withTransaction(async () => {
      const trade = await loadPendingTrade(id, req.user.id, 'recipient', 'Only the other member can confirm this record');
      const items = await db.all(
        `SELECT id, from_user_id, to_user_id, card_id, quantity, creator_collection_id
           FROM historical_trade_items WHERE trade_id = ? ORDER BY id`,
        [id]
      );
      const mappings = req.body?.items;
      if (!Array.isArray(mappings) || mappings.length !== items.length) {
        throw T.invalid('Choose how to reconcile every card');
      }
      const mappingById = new Map();
      for (const mapping of mappings) {
        const itemId = T.positiveInt(mapping?.id, 'item id');
        if (mappingById.has(itemId)) throw T.invalid('Each card can only be mapped once');
        mappingById.set(itemId, mapping.collection_entry_id == null || mapping.collection_entry_id === ''
          ? null
          : T.positiveInt(mapping.collection_entry_id, 'collection_entry_id'));
      }
      for (const item of items) {
        if (!mappingById.has(item.id)) throw T.invalid('Choose how to reconcile every card');
        item.recipient_collection_id = mappingById.get(item.id);
      }
      // The record's creator is gone (SET NULL): nothing of theirs to reconcile.
      if (trade.creator_id != null) {
        await validateHistoricalMapping(trade.creator_id, items, 'creator_collection_id', { asOwner: false });
      }
      await validateHistoricalMapping(trade.recipient_id, items, 'recipient_collection_id', { asOwner: true });
      for (const item of items) {
        await db.run(
          `UPDATE historical_trade_items SET recipient_collection_id = ? WHERE id = ?`,
          [item.recipient_collection_id, item.id]
        );
      }
      if (trade.creator_id != null) await applyHistoricalMapping(trade.creator_id, items, 'creator_collection_id');
      await applyHistoricalMapping(trade.recipient_id, items, 'recipient_collection_id');
      const updated = await db.run(
        `UPDATE historical_trades SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending_confirmation'`,
        [id]
      );
      if (updated.changes !== 1) throw T.notPending('This record is no longer awaiting confirmation');
    });
    res.json({ trade: await tradeById(id, req.user.id) });
  } catch (error) {
    T.respondError(res, error, 'Failed to confirm the trade record');
  }
});

router.put('/transfers/history/:id/reject', async (req, res) => {
  try {
    const id = T.positiveInt(req.params.id, 'trade record id');
    await withTransaction(async () => {
      await loadPendingTrade(id, req.user.id, 'recipient', 'Only the other member can decline this record');
      const updated = await db.run(
        `UPDATE historical_trades SET status = 'rejected' WHERE id = ? AND status = 'pending_confirmation'`,
        [id]
      );
      if (updated.changes !== 1) throw T.notPending('This record is no longer awaiting confirmation');
    });
    res.json({ message: 'Historical trade rejected' });
  } catch (error) {
    T.respondError(res, error, 'Failed to decline the trade record');
  }
});

// Its creator withdraws a record nobody has confirmed yet.
router.delete('/transfers/history/:id', async (req, res) => {
  try {
    const id = T.positiveInt(req.params.id, 'trade record id');
    await withTransaction(async () => {
      await loadPendingTrade(id, req.user.id, 'creator', 'Only the member who recorded this can cancel it');
      const deleted = await db.run(
        `DELETE FROM historical_trades WHERE id = ? AND status = 'pending_confirmation'`,
        [id]
      );
      if (deleted.changes !== 1) throw T.notPending('This record can no longer be cancelled');
    });
    res.json({ message: 'Historical trade cancelled' });
  } catch (error) {
    T.respondError(res, error, 'Failed to cancel the trade record');
  }
});

module.exports = router;
