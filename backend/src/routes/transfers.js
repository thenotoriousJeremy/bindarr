const express = require('express');
const db = require('../db');
const { withTransaction } = require('../db');
const { splitPrice } = require('../utils/splitPrice');

const router = express.Router();

class TransferError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respondError(res, error, fallback) {
  if (error instanceof TransferError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(error);
  return res.status(500).json({ error: fallback });
}

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TransferError(400, `${label} must be a positive integer`);
  }
  return parsed;
}

function parseItems(value, label, { required = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new TransferError(400, `${label} must be a non-empty array`);
  }
  if (value.length > 100) throw new TransferError(400, `${label} cannot contain more than 100 entries`);
  const items = value.map((item) => {
    if (!item || !['card', 'sealed'].includes(item.type)) {
      throw new TransferError(400, `${label} entries must have type 'card' or 'sealed'`);
    }
    return {
      type: item.type,
      id: positiveInt(item.id, `${label} item id`),
      quantity: item.type === 'card' ? positiveInt(item.quantity ?? 1, `${label} quantity`) : 1
    };
  });
  if (items.reduce((sum, item) => sum + item.quantity, 0) > 100) {
    throw new TransferError(400, `${label} cannot contain more than 100 copies`);
  }
  return items;
}

async function loadAsset(ownerId, item, { requireTradeMarker = false } = {}) {
  if (item.type === 'card') {
    const row = await db.get(
      `SELECT c.*, cc.name, cc.printed_name, cc.set_name, cc.number, cc.rarity, cc.image_url, cc.game AS card_game
         FROM collection c
         JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.id = ? AND c.user_id = ? AND c.list_type = 'collection'`,
      [item.id, ownerId]
    );
    if (!row) throw new TransferError(404, 'Card is not in the expected user’s collection');
    if (item.quantity > row.quantity) throw new TransferError(409, 'Not enough copies remain for this offer');
    if (requireTradeMarker && !row.is_trade) throw new TransferError(400, 'Requested cards must be marked for trade');
    if (row.cert_number && item.quantity !== 1) {
      throw new TransferError(400, 'A graded card can only be offered as one physical copy');
    }
    return {
      item_type: 'card',
      source_collection_id: row.id,
      source_sealed_unit_id: null,
      quantity: item.quantity,
      purchase_cost: row.purchase_price,
      row,
      snapshot: {
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
        sealed_unit_id: row.sealed_unit_id
      }
    };
  }

  const row = await db.get(
    `SELECT u.id AS unit_id, u.opened_at, u.is_trade,
            p.id AS purchase_id, p.user_id, p.product_id, p.product_name, p.set_name,
            p.sealed_type, p.game, p.image_url, p.unit_price, p.store, p.purchase_date,
            p.expected_packs, p.expected_cards, p.contents_note, p.market_value,
            p.market_value_source, p.market_value_at,
            p.source_product_name, p.source_unit_number,
            COALESCE(p.source_product_name, parent.product_name) AS origin_product_name,
            COALESCE(p.source_unit_number,
              (SELECT COUNT(*) FROM sealed_units source_number
                WHERE source_number.purchase_id = parent.id AND source_number.id <= source_unit.id)
            ) AS origin_unit_number
       FROM sealed_units u
       JOIN sealed_purchases p ON p.id = u.purchase_id
       LEFT JOIN sealed_units source_unit ON source_unit.id = p.source_unit_id
       LEFT JOIN sealed_purchases parent ON parent.id = source_unit.purchase_id
      WHERE u.id = ? AND p.user_id = ?`,
    [item.id, ownerId]
  );
  if (!row) throw new TransferError(404, 'Sealed product is not owned by the expected user');
  if (row.opened_at) throw new TransferError(409, 'Only unopened sealed products can be transferred');
  if (requireTradeMarker && !row.is_trade) throw new TransferError(400, 'Requested sealed products must be marked for trade');
  return {
    item_type: 'sealed',
    source_collection_id: null,
    source_sealed_unit_id: row.unit_id,
    quantity: 1,
    purchase_cost: row.unit_price,
    row,
    snapshot: {
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
      origin_unit_number: row.origin_unit_number
    }
  };
}

async function createTransferInTransaction({
  proposerId, recipientId, transferType, offeredItems, requestedItems,
  responseToTransferId = null, message = null, allowedRequestedItems = new Set()
}) {
  const recipient = await db.get(`SELECT id FROM users WHERE id = ?`, [recipientId]);
  if (!recipient) throw new TransferError(404, 'Recipient not found');
  if (proposerId === recipientId) throw new TransferError(400, 'You cannot transfer items to yourself');
  if (!['gift', 'trade'].includes(transferType)) throw new TransferError(400, 'transfer_type must be gift or trade');
  if (transferType === 'trade' && requestedItems.length === 0 && responseToTransferId) {
    throw new TransferError(400, 'A counterproposal must request at least one item');
  }
  if (transferType === 'gift' && requestedItems.length > 0) {
    throw new TransferError(400, 'A gift cannot request items in return');
  }

  const transfer = await db.run(
    `INSERT INTO user_transfers
       (proposer_id, recipient_id, transfer_type, response_to_transfer_id, message)
     VALUES (?, ?, ?, ?, ?)`,
    [proposerId, recipientId, transferType, responseToTransferId, message]
  );

  for (const [items, fromUserId, toUserId, isRequest] of [
    [offeredItems, proposerId, recipientId, false],
    [requestedItems, recipientId, proposerId, true]
  ]) {
    const quantitiesByAsset = new Map();
    for (const item of items) {
      const key = `${item.type}:${item.id}`;
      const quantity = (quantitiesByAsset.get(key) || 0) + item.quantity;
      if (item.type === 'sealed' && quantity > 1) {
        throw new TransferError(400, 'A sealed unit can only appear once in a proposal');
      }
      quantitiesByAsset.set(key, quantity);
      const asset = await loadAsset(fromUserId, { ...item, quantity }, {
        requireTradeMarker: isRequest && !allowedRequestedItems.has(key)
      });
      const copies = asset.item_type === 'card' ? item.quantity : 1;
      for (let i = 0; i < copies; i++) {
        await db.run(
          `INSERT INTO user_transfer_items
             (transfer_id, from_user_id, to_user_id, item_type, source_collection_id,
              source_sealed_unit_id, quantity, purchase_cost, item_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [transfer.lastID, fromUserId, toUserId, asset.item_type, asset.source_collection_id,
            asset.source_sealed_unit_id, asset.purchase_cost, JSON.stringify(asset.snapshot)]
        );
      }
    }
  }
  return transfer.lastID;
}

async function getDeckWarnings(items) {
  const cardsByOwner = new Map();
  for (const item of items) {
    if (item.item_type !== 'card') continue;
    const snapshot = JSON.parse(item.item_snapshot);
    const key = `${item.from_user_id}:${snapshot.card_id}`;
    const record = cardsByOwner.get(key) || {
      userId: item.from_user_id,
      cardId: snapshot.card_id,
      name: snapshot.name,
      outgoing: 0
    };
    record.outgoing += item.quantity;
    cardsByOwner.set(key, record);
  }

  const warnings = [];
  for (const card of cardsByOwner.values()) {
    const availability = await db.get(
      `SELECT
         (SELECT COALESCE(SUM(quantity), 0) FROM collection
           WHERE user_id = ? AND card_id = ? AND list_type = 'collection') AS owned,
         (SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc
           JOIN decks d ON d.id = dc.deck_id
          WHERE d.user_id = ? AND d.checked_out = 1 AND dc.card_id = ?) AS locked`,
      [card.userId, card.cardId, card.userId, card.cardId]
    );
    const shortage = Math.max(0, availability.locked + card.outgoing - availability.owned);
    if (shortage > 0) {
      warnings.push({
        user_id: card.userId,
        card_id: card.cardId,
        card_name: card.name,
        copies_short: shortage,
        message: `This transfer may leave a checked-out deck short ${shortage} ${shortage === 1 ? 'copy' : 'copies'} of ${card.name}.`
      });
    }
  }
  return warnings;
}

async function transferResponse(transfer, viewerId) {
  const items = await db.all(
    `SELECT i.*, sender.username AS from_username, recipient.username AS to_username
       FROM user_transfer_items i
       JOIN users sender ON sender.id = i.from_user_id
       JOIN users recipient ON recipient.id = i.to_user_id
      WHERE i.transfer_id = ?
      ORDER BY i.id`,
    [transfer.id]
  );
  const hydrated = items.map(item => {
    const snapshot = JSON.parse(item.item_snapshot);
    if (item.from_user_id !== viewerId) delete snapshot.purchase_cost;
    return {
      ...item,
      purchase_cost: item.from_user_id === viewerId ? item.purchase_cost : null,
      received_cost: item.to_user_id === viewerId ? item.received_cost : null,
      item_snapshot: snapshot
    };
  });
  const warnings = transfer.status === 'pending' ? await getDeckWarnings(items) : [];
  return {
    ...transfer,
    items: hydrated,
    deck_warnings: warnings.filter(warning => warning.user_id === viewerId)
  };
}

async function loadTransferForUpdate(id) {
  const transfer = await db.get(`SELECT * FROM user_transfers WHERE id = ?`, [id]);
  if (!transfer) throw new TransferError(404, 'Transfer not found');
  if (transfer.status !== 'pending') throw new TransferError(409, 'This transfer is no longer pending');
  return transfer;
}

async function currentTransferItems(transferId) {
  return db.all(`SELECT * FROM user_transfer_items WHERE transfer_id = ? ORDER BY id`, [transferId]);
}

function assertSameAsset(proposed, current) {
  const oldSnapshot = JSON.parse(proposed.item_snapshot);
  const now = current.snapshot;
  const same = proposed.item_type === 'card'
    ? oldSnapshot.card_id === now.card_id
    : oldSnapshot.product_id === now.product_id && oldSnapshot.product_name === now.product_name;
  if (!same) throw new TransferError(409, 'An offered item changed after this proposal was made');
}

async function acceptTransfer(transferId, recipientId) {
  return withTransaction(async () => {
    const transfer = await loadTransferForUpdate(transferId);
    if (transfer.recipient_id !== recipientId) throw new TransferError(403, 'Only the recipient can accept this transfer');
    const items = await currentTransferItems(transferId);
    if (items.length === 0) throw new TransferError(409, 'This transfer has no items');
    if (transfer.transfer_type === 'trade'
      && !items.some(item => item.from_user_id === transfer.recipient_id)) {
      throw new TransferError(409, 'A one-sided trade proposal must be countered before it can be accepted');
    }

    const loadedAssets = [];
    for (const item of items) {
      const sourceId = item.item_type === 'card' ? item.source_collection_id : item.source_sealed_unit_id;
      if (!sourceId) throw new TransferError(409, 'An offered item is no longer available');
      const request = item.item_type === 'card'
        ? { type: 'card', id: sourceId, quantity: 1 }
        : { type: 'sealed', id: sourceId, quantity: 1 };
      const asset = await loadAsset(item.from_user_id, request);
      assertSameAsset(item, asset);
      item.purchase_cost = asset.purchase_cost;
      item.item_snapshot = JSON.stringify(asset.snapshot);
      loadedAssets.push(asset);
    }

    const groupedCards = new Map();
    for (const item of items) {
      if (item.item_type !== 'card') continue;
      const group = groupedCards.get(item.source_collection_id) || { count: 0, ownerId: item.from_user_id };
      group.count += 1;
      groupedCards.set(item.source_collection_id, group);
    }
    for (const [entryId, group] of groupedCards) {
      const row = await db.get(
        `SELECT quantity FROM collection WHERE id = ? AND user_id = ? AND list_type = 'collection'`,
        [entryId, group.ownerId]
      );
      if (!row || row.quantity < group.count) throw new TransferError(409, 'Not enough copies remain for this offer');
    }

    for (const item of items) {
      if (item.item_type !== 'sealed') continue;
      const latest = await db.get(
        `SELECT u.id FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id
          WHERE u.id = ? AND p.user_id = ? AND u.opened_at IS NULL`,
        [item.source_sealed_unit_id, item.from_user_id]
      );
      if (!latest) throw new TransferError(409, 'A sealed item is no longer unopened or owned by its sender');
    }

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.item_type !== 'card') continue;
      const snapshot = loadedAssets[index].snapshot;
      if (!snapshot.cert_number) continue;
      const duplicate = await db.get(
        `SELECT id FROM collection
          WHERE user_id = ? AND grader = ? AND cert_number = ?`,
        [item.to_user_id, snapshot.grader, snapshot.cert_number]
      );
      if (duplicate) throw new TransferError(409, 'The recipient already owns this graded card');
    }

    if (transfer.transfer_type === 'gift') {
      for (const item of items) item.received_cost = 0;
    } else {
      for (const ownerId of [transfer.proposer_id, transfer.recipient_id]) {
        const outgoing = items.filter(item => item.from_user_id === ownerId);
        const incoming = items.filter(item => item.to_user_id === ownerId);
        if (incoming.length === 0) continue;
        const unknownCost = outgoing.some(item => item.purchase_cost == null);
        if (unknownCost) {
          for (const item of incoming) item.received_cost = null;
        } else {
          const total = outgoing.reduce((sum, item) => sum + Number(item.purchase_cost || 0), 0);
          const shares = splitPrice(Array(incoming.length).fill(1), total, 'equal');
          incoming.forEach((item, index) => { item.received_cost = shares[index]; });
        }
      }
    }

    for (const item of items) {
      await db.run(
        `UPDATE user_transfer_items
            SET purchase_cost = ?, received_cost = ?, item_snapshot = ?
          WHERE id = ?`,
        [item.purchase_cost, item.received_cost, item.item_snapshot, item.id]
      );
    }

    const warnings = await getDeckWarnings(items);

    for (const [entryId, group] of groupedCards) {
      const { count } = group;
      const source = await db.get(
        `SELECT * FROM collection WHERE id = ? AND user_id = ?`,
        [entryId, group.ownerId]
      );
      if (source.quantity === count) {
        await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [entryId, group.ownerId]);
      } else {
        await db.run(`UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?`,
          [count, entryId, group.ownerId]);
      }
    }

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const asset = loadedAssets[index];
      if (item.item_type === 'card') {
        const source = asset.row;
        await db.run(
          `INSERT INTO collection
             (card_id, user_id, quantity, condition, printing, language, purchase_price,
              location_id, compartment_id, position, favorite, is_trade, list_type, game,
              added_at, notes, grader, grade, cert_number, market_value,
              market_value_source, market_value_at, sealed_unit_id, acquired_via_transfer_item_id)
           VALUES (?, ?, 1, ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 'collection', ?,
                   CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [source.card_id, item.to_user_id, source.condition, source.printing, source.language,
            item.received_cost, source.game, source.notes, source.grader, source.grade,
            source.cert_number, source.market_value, source.market_value_source,
            source.market_value_at, source.sealed_unit_id, item.id]
        );
      } else {
        const source = asset.row;
        const sender = await db.get(`SELECT username FROM users WHERE id = ?`, [item.from_user_id]);
        const purchase = await db.run(
          `INSERT INTO sealed_purchases
             (user_id, product_id, product_name, set_name, sealed_type, game, image_url,
              store, purchase_date, unit_price, quantity, notes, expected_packs,
              expected_cards, contents_note, source_unit_id, source_product_name,
              source_unit_number, market_value, market_value_source, market_value_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE('now'), ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.to_user_id, source.product_id, source.product_name, source.set_name,
            source.sealed_type, source.game, source.image_url, `Transfer from ${sender.username}`,
            item.received_cost, `Transferred from ${sender.username}`, source.expected_packs,
            source.expected_cards, source.contents_note, source.source_unit_id,
            source.origin_product_name, source.origin_unit_number, source.market_value,
            source.market_value_source, source.market_value_at]
        );
        await db.run(
          `UPDATE sealed_units SET purchase_id = ?, is_trade = 0
            WHERE id = ? AND opened_at IS NULL`,
          [purchase.lastID, item.source_sealed_unit_id]
        );
        await db.run(
          `UPDATE sealed_purchases SET quantity = MAX(0, quantity - 1) WHERE id = ?`,
          [source.purchase_id]
        );
      }
    }

    await db.run(
      `UPDATE user_transfers SET status = 'accepted', updated_at = CURRENT_TIMESTAMP,
         completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [transferId]
    );
    return warnings;
  });
}

router.get('/transfers/marked/:userId', async (req, res) => {
  try {
    const userId = positiveInt(req.params.userId, 'userId');
    const user = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const cards = await db.all(
      `SELECT c.id AS entry_id, c.card_id, c.quantity, c.condition, c.printing, c.language,
              cc.name, cc.printed_name, cc.set_name, cc.number, cc.rarity, cc.image_url, cc.game
         FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.list_type = 'collection' AND c.is_trade = 1
        ORDER BY cc.name, cc.set_name, cc.number`,
      [userId]
    );
    const sealed = await db.all(
      `SELECT u.id AS unit_id, p.product_id, p.product_name, p.set_name, p.sealed_type,
              p.game, p.image_url,
              COALESCE(p.source_product_name, parent.product_name) AS origin_product_name
         FROM sealed_units u
         JOIN sealed_purchases p ON p.id = u.purchase_id
         LEFT JOIN sealed_units source_unit ON source_unit.id = p.source_unit_id
         LEFT JOIN sealed_purchases parent ON parent.id = source_unit.purchase_id
        WHERE p.user_id = ? AND u.opened_at IS NULL AND u.is_trade = 1
        ORDER BY p.product_name`,
      [userId]
    );
    res.json({ cards, sealed });
  } catch (error) {
    respondError(res, error, 'Failed to retrieve trade-marked items');
  }
});

router.get('/transfers/users', async (req, res) => {
  try {
    const users = await db.all(
      `SELECT id, username FROM users WHERE id != ? ORDER BY username COLLATE NOCASE`,
      [req.user.id]
    );
    res.json({ users });
  } catch (error) {
    respondError(res, error, 'Failed to retrieve users');
  }
});

router.put('/transfers/sealed/:unitId/trade', async (req, res) => {
  try {
    const unitId = positiveInt(req.params.unitId, 'unitId');
    if (typeof req.body?.is_trade !== 'boolean') {
      return res.status(400).json({ error: 'is_trade must be a boolean' });
    }
    const unit = await db.get(
      `SELECT u.id, u.opened_at FROM sealed_units u
       JOIN sealed_purchases p ON p.id = u.purchase_id
       WHERE u.id = ? AND p.user_id = ?`,
      [unitId, req.user.id]
    );
    if (!unit) return res.status(404).json({ error: 'Sealed unit not found' });
    if (unit.opened_at) return res.status(409).json({ error: 'Opened sealed products cannot be marked for trade' });
    await db.run(`UPDATE sealed_units SET is_trade = ? WHERE id = ?`, [req.body.is_trade ? 1 : 0, unitId]);
    res.json({ id: unitId, is_trade: req.body.is_trade });
  } catch (error) {
    respondError(res, error, 'Failed to update sealed trade status');
  }
});

router.get('/transfers', async (req, res) => {
  try {
    const transfers = await db.all(
      `SELECT t.*, proposer.username AS proposer_username, recipient.username AS recipient_username
         FROM user_transfers t
         JOIN users proposer ON proposer.id = t.proposer_id
         JOIN users recipient ON recipient.id = t.recipient_id
        WHERE t.proposer_id = ? OR t.recipient_id = ?
        ORDER BY t.created_at DESC, t.id DESC`,
      [req.user.id, req.user.id]
    );
    const results = [];
    for (const transfer of transfers) results.push(await transferResponse(transfer, req.user.id));
    res.json({ transfers: results });
  } catch (error) {
    respondError(res, error, 'Failed to retrieve transfers');
  }
});

router.post('/transfers', async (req, res) => {
  try {
    const recipientId = positiveInt(req.body?.recipient_id, 'recipient_id');
    const transferType = req.body?.transfer_type;
    const offeredItems = parseItems(req.body?.offered_items, 'offered_items', { required: true });
    const requestedItems = parseItems(req.body?.requested_items ?? [], 'requested_items');
    const message = req.body?.message == null ? null : String(req.body.message).trim().slice(0, 1000);
    const transferId = await withTransaction(() => createTransferInTransaction({
      proposerId: req.user.id, recipientId, transferType, offeredItems, requestedItems, message
    }));
    const transfer = await db.get(`SELECT * FROM user_transfers WHERE id = ?`, [transferId]);
    res.status(201).json({ transfer: await transferResponse(transfer, req.user.id) });
  } catch (error) {
    respondError(res, error, 'Failed to create transfer proposal');
  }
});

router.post('/transfers/:id/counter', async (req, res) => {
  try {
    const transferId = positiveInt(req.params.id, 'transfer id');
    const offeredItems = parseItems(req.body?.offered_items, 'offered_items', { required: true });
    const requestedItems = parseItems(req.body?.requested_items, 'requested_items', { required: true });
    const message = req.body?.message == null ? null : String(req.body.message).trim().slice(0, 1000);
    const counterId = await withTransaction(async () => {
      const original = await loadTransferForUpdate(transferId);
      if (original.recipient_id !== req.user.id) {
        throw new TransferError(403, 'Only the recipient can counter this transfer');
      }
      const originalOffered = await db.all(
        `SELECT item_type, source_collection_id, source_sealed_unit_id
           FROM user_transfer_items WHERE transfer_id = ? AND from_user_id = ?`,
        [original.id, original.proposer_id]
      );
      const allowedRequestedItems = new Set(originalOffered.map(item =>
        item.item_type === 'card'
          ? `card:${item.source_collection_id}`
          : `sealed:${item.source_sealed_unit_id}`
      ));
      const newId = await createTransferInTransaction({
        proposerId: original.recipient_id,
        recipientId: original.proposer_id,
        transferType: 'trade',
        offeredItems,
        requestedItems,
        responseToTransferId: original.id,
        message,
        allowedRequestedItems
      });
      await db.run(
        `UPDATE user_transfers SET status = 'countered', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [original.id]
      );
      return newId;
    });
    const transfer = await db.get(`SELECT * FROM user_transfers WHERE id = ?`, [counterId]);
    res.status(201).json({ transfer: await transferResponse(transfer, req.user.id) });
  } catch (error) {
    respondError(res, error, 'Failed to create counterproposal');
  }
});

router.put('/transfers/:id/accept', async (req, res) => {
  try {
    const id = positiveInt(req.params.id, 'transfer id');
    const deckWarnings = await acceptTransfer(id, req.user.id);
    const transfer = await db.get(`SELECT * FROM user_transfers WHERE id = ?`, [id]);
    res.json({
      transfer: await transferResponse(transfer, req.user.id),
      deck_warnings: deckWarnings.filter(warning => warning.user_id === req.user.id)
    });
  } catch (error) {
    respondError(res, error, 'Failed to accept transfer');
  }
});

router.put('/transfers/:id/reject', async (req, res) => {
  try {
    const id = positiveInt(req.params.id, 'transfer id');
    const updated = await withTransaction(async () => {
      const transfer = await loadTransferForUpdate(id);
      if (transfer.recipient_id !== req.user.id) throw new TransferError(403, 'Only the recipient can reject this transfer');
      return db.run(
        `UPDATE user_transfers SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'`,
        [id]
      );
    });
    if (updated.changes === 0) return res.status(409).json({ error: 'This transfer is no longer pending' });
    res.json({ message: 'Transfer rejected' });
  } catch (error) {
    respondError(res, error, 'Failed to reject transfer');
  }
});

router.put('/transfers/:id/cancel', async (req, res) => {
  try {
    const id = positiveInt(req.params.id, 'transfer id');
    const updated = await withTransaction(async () => {
      const transfer = await loadTransferForUpdate(id);
      if (transfer.proposer_id !== req.user.id) throw new TransferError(403, 'Only the proposer can cancel this transfer');
      return db.run(
        `UPDATE user_transfers SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'`,
        [id]
      );
    });
    if (updated.changes === 0) return res.status(409).json({ error: 'This transfer is no longer pending' });
    res.json({ message: 'Transfer cancelled' });
  } catch (error) {
    respondError(res, error, 'Failed to cancel transfer');
  }
});

module.exports = router;
