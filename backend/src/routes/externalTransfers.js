const express = require('express');
const db = require('../db');
const { withTransaction } = require('../db');
const cardApi = require('../utils/cardApi');
const { splitPrice } = require('../utils/splitPrice');

const router = express.Router();
const GAMES = new Set(['pokemon', 'mtg', 'lorcana']);
const CONDITIONS = new Set(['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged']);
const PRINTINGS = new Set(['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo']);

class ExternalTransferError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respondError(res, error, fallback) {
  if (error instanceof ExternalTransferError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(error);
  return res.status(500).json({ error: fallback });
}

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ExternalTransferError(400, `${label} must be a positive integer`);
  }
  return parsed;
}

function optionalText(value, label, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new ExternalTransferError(400, `${label} must be a string of at most ${maxLength} characters`);
  }
  return value.trim() || null;
}

function isDuplicateContactError(error) {
  return error.code === 'SQLITE_CONSTRAINT'
    && error.message.includes('external_contacts.user_id, external_contacts.name');
}

function parseGivenItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ExternalTransferError(400, 'given_items must be a non-empty array');
  }
  if (items.length > 100) throw new ExternalTransferError(400, 'given_items cannot contain more than 100 entries');
  const parsed = items.map(item => {
    if (!item || !['card', 'sealed'].includes(item.type)) {
      throw new ExternalTransferError(400, 'given_items entries must have type card or sealed');
    }
    return {
      type: item.type,
      id: positiveInt(item.id, 'given item id'),
      quantity: item.type === 'card' ? positiveInt(item.quantity ?? 1, 'given item quantity') : 1
    };
  });
  if (parsed.reduce((sum, item) => sum + item.quantity, 0) > 100) {
    throw new ExternalTransferError(400, 'given_items cannot contain more than 100 copies');
  }
  return parsed;
}

function parseReceivedItems(items) {
  if (!Array.isArray(items) || items.length > 100) {
    throw new ExternalTransferError(400, 'received_items must be an array of at most 100 entries');
  }
  const parsed = items.map(item => {
    if (!item || !['card', 'sealed'].includes(item.type)) {
      throw new ExternalTransferError(400, 'received_items entries must have type card or sealed');
    }
    const quantity = positiveInt(item.quantity ?? 1, 'received item quantity');
    if (item.type === 'card') {
      const cardId = optionalText(item.card_id, 'card_id', 200);
      if (!cardId) throw new ExternalTransferError(400, 'card_id is required for received cards');
      const game = item.game || 'pokemon';
      if (!GAMES.has(game)) throw new ExternalTransferError(400, 'Invalid card game');
      const condition = item.condition || 'Near Mint';
      const printing = item.printing || 'Normal';
      if (!CONDITIONS.has(condition)) throw new ExternalTransferError(400, 'Invalid card condition');
      if (!PRINTINGS.has(printing)) throw new ExternalTransferError(400, 'Invalid card printing');
      return {
        type: 'card',
        card_id: cardId,
        quantity,
        game,
        condition,
        printing,
        language: optionalText(item.language || 'English', 'language', 40) || 'English'
      };
    }

    const productName = optionalText(item.product_name, 'product_name', 200);
    if (!productName) throw new ExternalTransferError(400, 'product_name is required for received sealed products');
    const game = item.game || 'pokemon';
    if (!GAMES.has(game)) throw new ExternalTransferError(400, 'Invalid sealed product game');
    return {
      type: 'sealed',
      product_id: item.product_id == null || item.product_id === ''
        ? null
        : positiveInt(item.product_id, 'product_id'),
      product_name: productName,
      set_name: optionalText(item.set_name, 'set_name', 200),
      sealed_type: optionalText(item.sealed_type, 'sealed_type', 80),
      game,
      image_url: optionalText(item.image_url, 'image_url', 1000),
      origin_product_name: optionalText(item.origin_product_name, 'origin_product_name', 200),
      origin_unit_number: item.origin_unit_number == null || item.origin_unit_number === ''
        ? null
        : positiveInt(item.origin_unit_number, 'origin_unit_number'),
      quantity
    };
  });
  if (parsed.reduce((sum, item) => sum + item.quantity, 0) > 100) {
    throw new ExternalTransferError(400, 'received_items cannot contain more than 100 copies');
  }
  return parsed;
}

async function loadOwnedItem(userId, item, quantity) {
  if (item.type === 'card') {
    const row = await db.get(
      `SELECT c.*, cc.name, cc.printed_name, cc.set_name, cc.number, cc.image_url, cc.game AS card_game
         FROM collection c
         JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.id = ? AND c.user_id = ? AND c.list_type = 'collection'`,
      [item.id, userId]
    );
    if (!row) throw new ExternalTransferError(404, 'A card is no longer in your collection');
    if (row.quantity < quantity) throw new ExternalTransferError(409, 'Not enough copies remain in your collection');
    if (row.cert_number && quantity !== 1) {
      throw new ExternalTransferError(400, 'A graded card can only be recorded as one physical copy');
    }
    return {
      type: 'card',
      id: item.id,
      quantity,
      purchase_cost: row.purchase_price,
      row,
      snapshot: {
        card_id: row.card_id,
        name: row.printed_name || row.name,
        set_name: row.set_name,
        number: row.number,
        image_url: row.image_url,
        game: row.game || row.card_game,
        condition: row.condition,
        printing: row.printing,
        language: row.language,
        grader: row.grader,
        grade: row.grade,
        cert_number: row.cert_number
      }
    };
  }

  const row = await db.get(
    `SELECT u.id AS unit_id, u.opened_at, p.id AS purchase_id, p.user_id, p.product_id,
            p.product_name, p.set_name, p.sealed_type, p.game, p.image_url, p.unit_price,
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
    [item.id, userId]
  );
  if (!row) throw new ExternalTransferError(404, 'A sealed product is no longer in your collection');
  if (row.opened_at) throw new ExternalTransferError(409, 'Only unopened sealed products can be recorded');
  return {
    type: 'sealed',
    id: item.id,
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
      origin_product_name: row.origin_product_name,
      origin_unit_number: row.origin_unit_number
    }
  };
}

async function loadReceivedCard(cardId, game, user) {
  let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
  if (!card) {
    await cardApi.hydrate(cardId);
    card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
  }
  if (!card) {
    card = await cardApi.getCardById(cardId, { game, tcgApiKey: user.tcg_api_key });
  }
  if (!card) throw new ExternalTransferError(404, `Card ${cardId} was not found in the card catalog`);
  return card;
}

async function getDeckWarnings(userId, outgoingCopies) {
  const counts = new Map();
  for (const asset of outgoingCopies) {
    if (asset.type !== 'card') continue;
    const cardId = asset.row.card_id;
    const record = counts.get(cardId) || { cardId, name: asset.snapshot.name, quantity: 0 };
    record.quantity += 1;
    counts.set(cardId, record);
  }
  const warnings = [];
  for (const card of counts.values()) {
    const allocation = await db.get(
      `SELECT
         (SELECT COALESCE(SUM(quantity), 0) FROM collection
           WHERE user_id = ? AND card_id = ? AND list_type = 'collection') AS owned,
         (SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc
           JOIN decks d ON d.id = dc.deck_id
          WHERE d.user_id = ? AND d.checked_out = 1 AND dc.card_id = ?) AS locked`,
      [userId, card.cardId, userId, card.cardId]
    );
    const shortage = Math.max(0, allocation.locked + card.quantity - allocation.owned);
    if (shortage > 0) warnings.push({
      card_id: card.cardId,
      card_name: card.name,
      copies_short: shortage
    });
  }
  return warnings;
}

async function saveExternalTransaction(user, contactId, type, message, givenItems, receivedItems) {
  const contact = await db.get(
    `SELECT id, name FROM external_contacts WHERE id = ? AND user_id = ?`,
    [contactId, user.id]
  );
  if (!contact) throw new ExternalTransferError(404, 'Contact not found');
  if (!['gift', 'trade'].includes(type)) throw new ExternalTransferError(400, 'transaction_type must be gift or trade');
  if (type === 'trade' && (!givenItems.length || !receivedItems.length)) {
    throw new ExternalTransferError(400, 'A trade must include items both given and received');
  }
  if (type === 'gift' && (givenItems.length > 0) === (receivedItems.length > 0)) {
    throw new ExternalTransferError(400, 'A gift must be either given or received, not both');
  }

  const receivedCards = new Map();
  for (const item of receivedItems) {
    if (item.type === 'card' && !receivedCards.has(item.card_id)) {
      receivedCards.set(item.card_id, await loadReceivedCard(item.card_id, item.game, user));
    }
  }

  return withTransaction(async () => {
    const givenCopies = [];
    const totalsByAsset = new Map();
    for (const item of givenItems) {
      const key = `${item.type}:${item.id}`;
      const quantity = (totalsByAsset.get(key) || 0) + item.quantity;
      if (item.type === 'sealed' && quantity > 1) {
        throw new ExternalTransferError(400, 'A sealed unit can only be recorded once');
      }
      totalsByAsset.set(key, quantity);
      const asset = await loadOwnedItem(user.id, item, quantity);
      const copies = asset.type === 'card' ? item.quantity : 1;
      for (let index = 0; index < copies; index++) givenCopies.push({ ...asset, quantity: 1 });
    }

    const receivedCopies = [];
    for (const item of receivedItems) {
      const card = item.type === 'card' ? receivedCards.get(item.card_id) : null;
      for (let index = 0; index < item.quantity; index++) {
        receivedCopies.push({ ...item, card });
      }
    }

    let receivedCosts;
    if (type === 'gift') {
      receivedCosts = receivedCopies.map(() => 0);
    } else if (givenCopies.some(item => item.purchase_cost == null)) {
      receivedCosts = receivedCopies.map(() => null);
    } else {
      const totalCost = givenCopies.reduce((sum, item) => sum + Number(item.purchase_cost || 0), 0);
      receivedCosts = splitPrice(Array(receivedCopies.length).fill(1), totalCost, 'equal');
    }

    const warnings = await getDeckWarnings(user.id, givenCopies);
    const transaction = await db.run(
      `INSERT INTO external_transactions
         (user_id, contact_id, contact_name_snapshot, transaction_type, message)
       VALUES (?, ?, ?, ?, ?)`,
      [user.id, contact.id, contact.name, type, message]
    );
    const transactionId = transaction.lastID;

    for (const asset of givenCopies) {
      await db.run(
        `INSERT INTO external_transaction_items
           (transaction_id, direction, item_type, source_collection_id, source_sealed_unit_id,
            quantity, purchase_cost, item_snapshot)
         VALUES (?, 'given', ?, ?, ?, 1, ?, ?)`,
        [transactionId, asset.type, asset.type === 'card' ? asset.id : null,
          asset.type === 'sealed' ? asset.id : null, asset.purchase_cost, JSON.stringify(asset.snapshot)]
      );
    }

    const givenCardCounts = new Map();
    const givenSealedUnits = new Map();
    for (const asset of givenCopies) {
      if (asset.type === 'card') {
        givenCardCounts.set(asset.id, (givenCardCounts.get(asset.id) || 0) + 1);
      } else {
        givenSealedUnits.set(asset.id, asset.row.purchase_id);
      }
    }
    for (const [collectionId, count] of givenCardCounts) {
      const row = await db.get(`SELECT quantity FROM collection WHERE id = ? AND user_id = ?`, [collectionId, user.id]);
      if (!row || row.quantity < count) throw new ExternalTransferError(409, 'Not enough card copies remain in your collection');
      if (row.quantity === count) {
        await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [collectionId, user.id]);
      } else {
        await db.run(`UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?`, [count, collectionId, user.id]);
      }
    }
    for (const [unitId, purchaseId] of givenSealedUnits) {
      await db.run(`DELETE FROM sealed_units WHERE id = ?`, [unitId]);
      await db.run(`UPDATE sealed_purchases SET quantity = MAX(0, quantity - 1) WHERE id = ?`, [purchaseId]);
    }

    for (let index = 0; index < receivedCopies.length; index++) {
      const item = receivedCopies[index];
      const receivedCost = receivedCosts[index];
      let snapshot;
      let sourceCollectionId = null;
      let sourceSealedUnitId = null;
      if (item.type === 'card') {
        const card = item.card;
        const cardGame = card.game || cardApi.gameOf(card.id) || 'pokemon';
        snapshot = {
          card_id: card.id,
          name: card.printed_name || card.name,
          set_name: card.set_name,
          number: card.number,
          image_url: card.image_url,
          game: cardGame,
          condition: item.condition,
          printing: item.printing,
          language: item.language
        };
        const row = await db.run(
          `INSERT INTO collection
             (card_id, user_id, quantity, condition, printing, language, purchase_price,
              location_id, compartment_id, position, game)
           VALUES (?, ?, 1, ?, ?, ?, ?, NULL, NULL, 0, ?)`,
          [card.id, user.id, item.condition, item.printing, item.language, receivedCost, cardGame]
        );
        sourceCollectionId = row.lastID;
      } else {
        snapshot = {
          product_id: item.product_id,
          product_name: item.product_name,
          set_name: item.set_name,
          sealed_type: item.sealed_type,
          game: item.game,
          image_url: item.image_url,
          origin_product_name: item.origin_product_name,
          origin_unit_number: item.origin_unit_number
        };
        const purchase = await db.run(
          `INSERT INTO sealed_purchases
             (user_id, product_id, product_name, set_name, sealed_type, game, image_url,
              store, purchase_date, unit_price, quantity, notes, source_product_name,
              source_unit_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE('now'), ?, 1, ?, ?, ?)`,
          [user.id, item.product_id, item.product_name, item.set_name, item.sealed_type,
            item.game, item.image_url, `External: ${contact.name}`, receivedCost,
            `Recorded from ${contact.name}`, item.origin_product_name, item.origin_unit_number]
        );
        const unit = await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [purchase.lastID]);
        sourceSealedUnitId = unit.lastID;
      }
      await db.run(
        `INSERT INTO external_transaction_items
           (transaction_id, direction, item_type, source_collection_id, source_sealed_unit_id,
            quantity, received_cost, item_snapshot)
         VALUES (?, 'received', ?, ?, ?, 1, ?, ?)`,
        [transactionId, item.type, sourceCollectionId, sourceSealedUnitId,
          receivedCost, JSON.stringify(snapshot)]
      );
    }

    const result = await db.get(
      `SELECT id, contact_name_snapshot AS contact_name, transaction_type, message, created_at, completed_at
         FROM external_transactions WHERE id = ?`,
      [transactionId]
    );
    return { transaction: result, warnings };
  });
}

router.get('/transfers/external/contacts', async (req, res) => {
  try {
    const contacts = await db.all(
      `SELECT id, name, created_at FROM external_contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE`,
      [req.user.id]
    );
    res.json({ contacts });
  } catch (error) {
    respondError(res, error, 'Failed to retrieve external contacts');
  }
});

router.post('/transfers/external/contacts', async (req, res) => {
  try {
    const name = optionalText(req.body?.name, 'name', 100);
    if (!name) throw new ExternalTransferError(400, 'name is required');
    const result = await db.run(`INSERT INTO external_contacts (user_id, name) VALUES (?, ?)`, [req.user.id, name]);
    res.status(201).json({ contact: { id: result.lastID, name } });
  } catch (error) {
    if (isDuplicateContactError(error)) {
      return res.status(409).json({ error: 'A contact with that name already exists' });
    }
    respondError(res, error, 'Failed to create external contact');
  }
});

router.put('/transfers/external/contacts/:id', async (req, res) => {
  try {
    const id = positiveInt(req.params.id, 'contact id');
    const name = optionalText(req.body?.name, 'name', 100);
    if (!name) throw new ExternalTransferError(400, 'name is required');
    const result = await db.run(`UPDATE external_contacts SET name = ? WHERE id = ? AND user_id = ?`, [name, id, req.user.id]);
    if (!result.changes) throw new ExternalTransferError(404, 'Contact not found');
    res.json({ contact: { id, name } });
  } catch (error) {
    if (isDuplicateContactError(error)) {
      return res.status(409).json({ error: 'A contact with that name already exists' });
    }
    respondError(res, error, 'Failed to update external contact');
  }
});

router.delete('/transfers/external/contacts/:id', async (req, res) => {
  try {
    const id = positiveInt(req.params.id, 'contact id');
    const result = await db.run(`DELETE FROM external_contacts WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!result.changes) throw new ExternalTransferError(404, 'Contact not found');
    res.json({ message: 'Contact deleted' });
  } catch (error) {
    respondError(res, error, 'Failed to delete external contact');
  }
});

router.get('/transfers/external', async (req, res) => {
  try {
    const transactions = await db.all(
      `SELECT id, contact_name_snapshot AS contact_name, transaction_type, message, created_at, completed_at
         FROM external_transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
      [req.user.id]
    );
    for (const transaction of transactions) {
      const rows = await db.all(
        `SELECT id, direction, item_type, quantity, purchase_cost, received_cost, item_snapshot
           FROM external_transaction_items WHERE transaction_id = ? ORDER BY id`,
        [transaction.id]
      );
      transaction.items = rows.map(item => ({ ...item, item_snapshot: JSON.parse(item.item_snapshot) }));
    }
    res.json({ transactions });
  } catch (error) {
    respondError(res, error, 'Failed to retrieve external transaction history');
  }
});

router.post('/transfers/external', async (req, res) => {
  try {
    const contactId = positiveInt(req.body?.contact_id, 'contact_id');
    const type = req.body?.transaction_type;
    const message = optionalText(req.body?.message, 'message', 1000);
    const givenItems = req.body?.given_items?.length ? parseGivenItems(req.body.given_items) : [];
    const receivedItems = parseReceivedItems(req.body?.received_items ?? []);
    const result = await saveExternalTransaction(req.user, contactId, type, message, givenItems, receivedItems);
    const items = await db.all(
      `SELECT id, direction, item_type, quantity, purchase_cost, received_cost, item_snapshot
         FROM external_transaction_items WHERE transaction_id = ? ORDER BY id`,
      [result.transaction.id]
    );
    result.transaction.items = items.map(item => ({ ...item, item_snapshot: JSON.parse(item.item_snapshot) }));
    res.status(201).json(result);
  } catch (error) {
    respondError(res, error, 'Failed to record external transaction');
  }
});

module.exports = router;
