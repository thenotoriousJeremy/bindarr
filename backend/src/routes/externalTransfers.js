// Deals with people outside Bindarr: a friend at the league, a shop, someone online.
// A member records what they gave and what they got against a contact they keep, and
// the copies move in their own collection only: given copies go to the trash (so a
// mistaken record loses nothing for 30 days), received ones arrive unsorted and
// traced to the deal (collection.acquired_via_external_item_id).
//
// One member's own record, so the phone runs it too (routes/mounts.js): nothing here
// may reach for a Node API outside embedded/aliases.js. What it shares with the
// offers between members is utils/transferAssets.js, including the error codes.
'use strict';

const express = require('express');
const db = require('../db');
const { withTransaction } = require('../db');
const cardApi = require('../utils/cardApi');
const games = require('../utils/games');
const { splitPrice } = require('../utils/splitPrice');
const { resolveCardPrice, recordPrice } = require('../utils/priceHelpers');
const { trashEntries } = require('../utils/collectionTrash');
const { resolveCardForAdd } = require('./collection/add');
const { AddCardError, CONDITIONS, PRINTINGS } = require('./collection/shared');
const T = require('../utils/transferAssets');

const router = express.Router();
router.use('/transfers/external', T.refuseApiKeys);

function optionalText(value, label, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw T.invalid(`${label} must be a string of at most ${maxLength} characters`);
  }
  return value.trim() || null;
}

const nameTaken = () => new T.TransferError(409, 'name_taken', 'A contact with that name already exists');

// A member's contact names are unique, ignoring case (the unique index is on
// user_id, name COLLATE NOCASE). Looked up before the write, so a taken name is a
// 409 whatever SQLite is underneath. `exceptId`: the contact being renamed.
async function assertContactNameFree(userId, name, exceptId = null) {
  const taken = await db.get(
    `SELECT id FROM external_contacts
      WHERE user_id = ? AND name = ? COLLATE NOCASE${exceptId == null ? '' : ' AND id != ?'}`,
    exceptId == null ? [userId, name] : [userId, name, exceptId]
  );
  if (taken) throw nameTaken();
}

// The index refusing a write all the same. Read from the message, not the code:
// node-sqlite3 sets code SQLITE_CONSTRAINT, but the phone's SQLite plugin rejects
// with a bare message (Android: "Run: " + the SQLite message) and no code at all,
// which made a taken name a 500 there.
function isDuplicateContactError(error) {
  const message = String((error && error.message) || '');
  return /UNIQUE constraint failed/i.test(message) && /external_contacts\b/.test(message);
}

// Every game the registry knows (utils/games): absent means the legacy game, an
// unknown one is refused rather than guessed.
function readGame(value) {
  const game = games.parseGame(value);
  if (!game) throw T.invalid(`game must be one of: ${games.VALUES.join(', ')}`);
  return game;
}

function parseReceivedItems(items) {
  if (!Array.isArray(items) || items.length > T.MAX_ENTRIES) {
    throw T.invalid(`received_items must be an array of at most ${T.MAX_ENTRIES} entries`);
  }
  const parsed = items.map(item => {
    if (!item || !['card', 'sealed'].includes(item.type)) {
      throw T.invalid('received_items entries must have type card or sealed');
    }
    const quantity = T.positiveInt(item.quantity ?? 1, 'received item quantity');
    const game = readGame(item.game);
    if (item.type === 'card') {
      const cardId = optionalText(item.card_id, 'card_id', 200);
      if (!cardId) throw T.invalid('card_id is required for received cards');
      // The collection's own lists (routes/collection/shared.js), which mirror its
      // CHECK constraints.
      const condition = item.condition || 'Near Mint';
      const printing = item.printing || 'Normal';
      if (!CONDITIONS.includes(condition)) throw T.invalid(`Invalid condition. One of: ${CONDITIONS.join(', ')}`);
      if (!PRINTINGS.includes(printing)) throw T.invalid(`Invalid printing. One of: ${PRINTINGS.join(', ')}`);
      return {
        type: 'card',
        card_id: cardId,
        quantity,
        game,
        condition,
        printing,
        language: optionalText(item.language || 'English', 'language', 40) || 'English',
      };
    }

    const productName = optionalText(item.product_name, 'product_name', 200);
    if (!productName) throw T.invalid('product_name is required for received sealed products');
    return {
      type: 'sealed',
      product_id: item.product_id == null || item.product_id === ''
        ? null
        : T.positiveInt(item.product_id, 'product_id'),
      product_name: productName,
      set_name: optionalText(item.set_name, 'set_name', 200),
      sealed_type: optionalText(item.sealed_type, 'sealed_type', 80),
      game,
      image_url: optionalText(item.image_url, 'image_url', 1000),
      origin_product_name: optionalText(item.origin_product_name, 'origin_product_name', 200),
      origin_unit_number: item.origin_unit_number == null || item.origin_unit_number === ''
        ? null
        : T.positiveInt(item.origin_unit_number, 'origin_unit_number'),
      quantity,
    };
  });
  if (parsed.reduce((sum, item) => sum + item.quantity, 0) > T.MAX_COPIES) {
    throw T.invalid(`received_items cannot contain more than ${T.MAX_COPIES} copies`);
  }
  return parsed;
}

// The cards received, resolved the way every add resolves one (routes/collection/add
// resolveCardForAdd: hydrate, fetch if uncached, the printing in the copy's
// language). It may reach a provider, so it runs before the write transaction.
async function resolveReceivedCards(user, items) {
  const resolved = new Map();
  for (const item of items) {
    if (item.type !== 'card') continue;
    const key = JSON.stringify([item.card_id, item.game, item.language]);
    if (!resolved.has(key)) {
      let found;
      try {
        found = await resolveCardForAdd(user, { card_id: item.card_id, game: item.game, language: item.language });
      } catch (error) {
        if (error instanceof AddCardError) {
          throw new T.TransferError(error.status, error.status === 404 ? 'not_found' : 'invalid', error.message);
        }
        throw error;
      }
      const { card, cardId } = found;
      // The card's own game, as addCardToCollection decides it.
      const game = (games.isGame(card.game) ? card.game : null) || cardApi.gameOf(cardId, item.game) || games.LEGACY_GAME;
      resolved.set(key, { card, cardId, game });
    }
    item.resolved = resolved.get(key);
  }
}

// `quantity` of an entry's copies as an entry of their own, so they can go to the
// trash without the rest. The entry keeps the others, and any deck that holds them.
async function splitOff(entryId, quantity, userId) {
  const row = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [entryId, userId]);
  const columns = Object.keys(row).filter(column => column !== 'id');
  const copy = await db.run(
    `INSERT INTO collection (${columns.map(column => `"${column}"`).join(', ')})
     VALUES (${T.holes(columns)})`,
    columns.map(column => (column === 'quantity' ? quantity : row[column]))
  );
  await db.run(`UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?`, [quantity, entryId, userId]);
  return copy.lastID;
}

async function saveExternalTransaction(user, { contactId, type, message, givenItems, receivedItems }) {
  if (!['gift', 'trade'].includes(type)) throw T.invalid('transaction_type must be gift or trade');
  if (type === 'trade' && (!givenItems.length || !receivedItems.length)) {
    throw T.invalid('A trade must include items both given and received');
  }
  if (type === 'gift' && (givenItems.length > 0) === (receivedItems.length > 0)) {
    throw T.invalid('A gift must be either given or received, not both');
  }
  const knownContact = await db.get(`SELECT id FROM external_contacts WHERE id = ? AND user_id = ?`, [contactId, user.id]);
  if (!knownContact) throw T.notFound('Contact not found');
  await resolveReceivedCards(user, receivedItems);

  return withTransaction(async () => {
    const contact = await db.get(`SELECT id, name FROM external_contacts WHERE id = ? AND user_id = ?`, [contactId, user.id]);
    if (!contact) throw T.notFound('Contact not found');

    // What leaves is the member's own, checked the way an offer is: theirs under the
    // claim rule, unopened, and not held by a checked-out deck.
    const given = [];
    for (const item of T.mergeItems(givenItems)) given.push(await T.loadAsset(user.id, item, { asOwner: true }));

    const received = [];
    for (const item of receivedItems) {
      for (let copy = 0; copy < item.quantity; copy++) received.push(item);
    }

    // A gift costs nothing. A trade's received copies share what the given ones cost,
    // weighted by market value (splitPrice's default); one unknown cost makes them
    // unknown.
    let costs;
    if (type === 'gift') {
      costs = received.map(() => 0);
    } else if (given.some(asset => asset.purchase_cost == null)) {
      costs = received.map(() => null);
    } else {
      const total = given.reduce((sum, asset) => sum + Number(asset.purchase_cost || 0) * asset.quantity, 0);
      costs = splitPrice(received.map(item => (item.type === 'card'
        ? resolveCardPrice({ ...item.resolved.card, printing: item.printing, market_value: null }) || 0
        : 0)), total);
    }

    const warnings = await T.deckWarnings(given
      .filter(asset => asset.item_type === 'card')
      .map(asset => ({ userId: user.id, cardId: asset.row.card_id, name: asset.snapshot.name, quantity: asset.quantity })));

    const transaction = await db.run(
      `INSERT INTO external_transactions
         (user_id, contact_id, contact_name_snapshot, transaction_type, message)
       VALUES (?, ?, ?, ?, ?)`,
      [user.id, contact.id, contact.name, type, message]
    );
    const transactionId = transaction.lastID;

    // Recorded before the copies leave, while the rows they point at still exist.
    for (const asset of given) {
      for (let copy = 0; copy < asset.quantity; copy++) {
        await db.run(
          `INSERT INTO external_transaction_items
             (transaction_id, direction, item_type, source_collection_id, source_sealed_unit_id,
              quantity, purchase_cost, item_snapshot)
           VALUES (?, 'given', ?, ?, ?, 1, ?, ?)`,
          [transactionId, asset.item_type, asset.source_collection_id, asset.source_sealed_unit_id,
            asset.purchase_cost, JSON.stringify(asset.snapshot)]
        );
      }
    }

    // Given cards go to the trash, one batch for the deal, restorable for 30 days
    // (utils/collectionTrash). A sealed unit has no trash: it leaves its purchase.
    const leaving = [];
    for (const asset of given) {
      if (asset.item_type === 'card') {
        leaving.push(asset.quantity === asset.row.quantity
          ? asset.source_collection_id
          : await splitOff(asset.source_collection_id, asset.quantity, user.id));
      } else {
        await db.run(`DELETE FROM sealed_units WHERE id = ?`, [asset.source_sealed_unit_id]);
        await db.run(`UPDATE sealed_purchases SET quantity = MAX(0, quantity - 1) WHERE id = ?`, [asset.row.purchase_id]);
      }
    }
    const { batchId } = leaving.length ? await trashEntries(leaving, user.id) : { batchId: null };

    // Received copies arrive unsorted, each traced to its line of the deal. Where a
    // sealed product came from is the deal itself (GET /sealed/purchases reads it),
    // not English written into its store and notes.
    const prices = new Map();
    for (let index = 0; index < received.length; index++) {
      const item = received[index];
      const receivedCost = costs[index];
      if (item.type === 'card') {
        const { card, cardId, game } = item.resolved;
        const snapshot = {
          card_id: cardId,
          name: card.printed_name || card.name,
          set_name: card.set_name,
          number: card.number,
          rarity: card.rarity,
          image_url: card.image_url,
          game,
          condition: item.condition,
          printing: item.printing,
          language: item.language,
        };
        const copy = await db.run(
          `INSERT INTO collection
             (card_id, user_id, quantity, condition, printing, language, purchase_price,
              location_id, compartment_id, position, game)
           VALUES (?, ?, 1, ?, ?, ?, ?, NULL, NULL, 0, ?)`,
          [cardId, user.id, item.condition, item.printing, item.language, receivedCost, game]
        );
        const line = await db.run(
          `INSERT INTO external_transaction_items
             (transaction_id, direction, item_type, source_collection_id, quantity, received_cost, item_snapshot)
           VALUES (?, 'received', 'card', ?, 1, ?, ?)`,
          [transactionId, copy.lastID, receivedCost, JSON.stringify(snapshot)]
        );
        await db.run(
          `UPDATE collection SET acquired_via_external_item_id = ? WHERE id = ? AND user_id = ?`,
          [line.lastID, copy.lastID, user.id]
        );
        prices.set(cardId, card.price_trend);
      } else {
        const snapshot = {
          product_id: item.product_id,
          product_name: item.product_name,
          set_name: item.set_name,
          sealed_type: item.sealed_type,
          game: item.game,
          image_url: item.image_url,
          origin_product_name: item.origin_product_name,
          origin_unit_number: item.origin_unit_number,
        };
        const purchase = await db.run(
          `INSERT INTO sealed_purchases
             (user_id, product_id, product_name, set_name, sealed_type, game, image_url,
              store, purchase_date, unit_price, quantity, notes, source_product_name,
              source_unit_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, DATE('now'), ?, 1, NULL, ?, ?)`,
          [user.id, item.product_id, item.product_name, item.set_name, item.sealed_type,
            item.game, item.image_url, receivedCost, item.origin_product_name, item.origin_unit_number]
        );
        const unit = await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [purchase.lastID]);
        await db.run(
          `INSERT INTO external_transaction_items
             (transaction_id, direction, item_type, source_sealed_unit_id, quantity, received_cost, item_snapshot)
           VALUES (?, 'received', 'sealed', ?, 1, ?, ?)`,
          [transactionId, unit.lastID, receivedCost, JSON.stringify(snapshot)]
        );
      }
    }
    for (const [cardId, price] of prices) await recordPrice(cardId, price);

    return { transactionId, warnings, trashBatch: batchId };
  });
}

const TRANSACTION_SELECT = `
  SELECT id, contact_name_snapshot AS contact_name, transaction_type, message, created_at, completed_at
    FROM external_transactions`;

// Deals with their lines, in two queries however many deals (this was one per deal).
async function hydrateTransactions(transactions) {
  if (transactions.length === 0) return [];
  const rows = [];
  for (const part of T.chunks(transactions.map(transaction => transaction.id))) {
    rows.push(...await db.all(
      `SELECT id, transaction_id, direction, item_type, quantity, purchase_cost, received_cost, item_snapshot
         FROM external_transaction_items WHERE transaction_id IN (${T.holes(part)}) ORDER BY id`,
      part
    ));
  }
  const byTransaction = new Map();
  for (const row of rows) {
    const { transaction_id: transactionId, ...item } = row;
    if (!byTransaction.has(transactionId)) byTransaction.set(transactionId, []);
    byTransaction.get(transactionId).push({ ...item, item_snapshot: JSON.parse(item.item_snapshot) });
  }
  return transactions.map(transaction => ({ ...transaction, items: byTransaction.get(transaction.id) || [] }));
}

router.get('/transfers/external/contacts', async (req, res) => {
  try {
    const contacts = await db.all(
      `SELECT id, name, created_at FROM external_contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE`,
      [req.user.id]
    );
    res.json({ contacts });
  } catch (error) {
    T.respondError(res, error, 'Failed to retrieve contacts');
  }
});

// The name check and the write in one transaction, so nothing else on this
// connection can take the name in between; the constraint is the backstop.
router.post('/transfers/external/contacts', async (req, res) => {
  try {
    const name = optionalText(req.body?.name, 'name', 100);
    if (!name) throw T.invalid('name is required');
    const result = await withTransaction(async () => {
      await assertContactNameFree(req.user.id, name);
      return db.run(`INSERT INTO external_contacts (user_id, name) VALUES (?, ?)`, [req.user.id, name]);
    });
    res.status(201).json({ contact: { id: result.lastID, name } });
  } catch (error) {
    T.respondError(res, isDuplicateContactError(error) ? nameTaken() : error, 'Failed to create the contact');
  }
});

router.put('/transfers/external/contacts/:id', async (req, res) => {
  try {
    const id = T.positiveInt(req.params.id, 'contact id');
    const name = optionalText(req.body?.name, 'name', 100);
    if (!name) throw T.invalid('name is required');
    await withTransaction(async () => {
      const contact = await db.get(`SELECT id FROM external_contacts WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!contact) throw T.notFound('Contact not found');
      // Its own name in another case is a rename, not a clash.
      await assertContactNameFree(req.user.id, name, id);
      await db.run(`UPDATE external_contacts SET name = ? WHERE id = ? AND user_id = ?`, [name, id, req.user.id]);
    });
    res.json({ contact: { id, name } });
  } catch (error) {
    T.respondError(res, isDuplicateContactError(error) ? nameTaken() : error, 'Failed to update the contact');
  }
});

// The deals keep the name the contact had then (contact_name_snapshot).
router.delete('/transfers/external/contacts/:id', async (req, res) => {
  try {
    const id = T.positiveInt(req.params.id, 'contact id');
    const result = await db.run(`DELETE FROM external_contacts WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!result.changes) throw T.notFound('Contact not found');
    res.json({ message: 'Contact deleted' });
  } catch (error) {
    T.respondError(res, error, 'Failed to delete the contact');
  }
});

// The member's deals, newest first, paged (utils/transferAssets readPage). A deal is
// settled the moment it is recorded, so there is nothing open to carry on page one.
router.get('/transfers/external', async (req, res) => {
  try {
    const { limit, cursor } = T.readPage(req.query, T.idCursor.parse);
    const rows = await db.all(
      `${TRANSACTION_SELECT} WHERE user_id = ? ${cursor ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      [req.user.id, ...(cursor ? [cursor.id] : []), limit + 1]
    );
    const { page, nextCursor } = T.pageOf(rows, limit, T.idCursor.make);
    res.json({ transactions: await hydrateTransactions(page), next_cursor: nextCursor });
  } catch (error) {
    T.respondError(res, error, 'Failed to retrieve the outside deals');
  }
});

// Record a deal. `trash_batch` names the given cards' trash batch, for an Undo
// (POST /api/collection/trash/:batch/restore).
router.post('/transfers/external', async (req, res) => {
  try {
    const contactId = T.positiveInt(req.body?.contact_id, 'contact_id');
    const message = optionalText(req.body?.message, 'message', 1000);
    const givenItems = req.body?.given_items == null || (Array.isArray(req.body.given_items) && !req.body.given_items.length)
      ? []
      : T.parseItems(req.body.given_items, 'given_items', { required: true });
    const receivedItems = parseReceivedItems(req.body?.received_items ?? []);
    const result = await saveExternalTransaction(req.user, {
      contactId, type: req.body?.transaction_type, message, givenItems, receivedItems,
    });
    const [transaction] = await hydrateTransactions(
      await db.all(`${TRANSACTION_SELECT} WHERE id = ?`, [result.transactionId])
    );
    res.status(201).json({ transaction, warnings: result.warnings, trash_batch: result.trashBatch });
  } catch (error) {
    T.respondError(res, error, 'Failed to record the outside deal');
  }
});

module.exports = router;
