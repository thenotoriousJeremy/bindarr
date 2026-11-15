// A full backup of one account: everything it owns, in one JSON file that
// restores onto any Bindarr — the same install, a fresh one, a phone running in
// device mode, or a server that phone is moving to.
//
// The CSV/JSON export in importExport.js is a card list for spreadsheets and other
// apps. It cannot rebuild an account: it has no decks, notes or sealed product, no
// binder pages or their filing rules, and it names each copy's location by text.
// This file holds the rows themselves.
//
// Restore REPLACES the account's collection, storage, decks, lists, notes and
// sealed product. A merge
// would have to decide which of two binders called "Main Binder" a copy belongs in,
// and every way of guessing files cards somewhere their owner did not put them.
// Sealed recipes are the exception: shared, one per product (#168), so the file's
// are matched to the server's rather than replacing them (see the restore).
// Card data (card_cache, price history, product ids) is shared across accounts, so
// it is only ever added to, never overwritten: whatever the install already holds
// is at least as fresh as the backup's copy. And only an admin's restore adds it
// from the file. Everyone sees those rows, and a file can say anything: a member
// could otherwise plant a card with any name and image for every other account to
// find. A member's restore fetches each card the install lacks from the provider
// that minted its id instead, as an import does. (In device mode the phone's one
// account is the admin, so moving a phone to its owner's server keeps everything.)
//
// Ids are renumbered on the way in, because the restoring database has its own
// sequences, and every reference between the rows is remapped to match. Columns
// are copied by name, limited to the ones both the backup and this schema have, so
// a backup from an older or newer version restores what it can rather than failing.
// References are the exception: a column holding another row's id is remapped by
// the restore or written as NULL, never copied. The id is the source install's,
// so here it names nothing, or some other row; copied, it failed the whole
// restore on its foreign key wherever it named nothing.
//
// Trades and gifts between accounts, and trades recorded after the fact
// (routes/transfers.js), belong to both accounts, so neither one's backup carries
// them. A copy's link to the one that brought it in is kept only where this
// install holds that record as the restoring account's own receipt, which in
// practice means the same install; anywhere else the copy comes back without it.
// Deals with people outside Bindarr (routes/externalTransfers.js) are the
// account's own record, so they travel with it, renumbered like the rest.
'use strict';

const express = require('express');
const db = require('../db');
const cardApi = require('../utils/cardApi');
const { wantCards } = require('../utils/defaultWishlist');

const router = express.Router();

const FORMAT = 'bindarr-backup';
const VERSION = 1;
const CHUNK = 500;   // SQLite caps bound parameters per statement
// The most cards a member's restore asks the providers for, one request each:
// the row cap /import has (importExport.js MAX_IMPORT_ROWS), for the same reason.
// A file needing more is refused before the first request, not cut off midway.
const MAX_CARD_LOOKUPS = 5000;

// The account's deals with people outside Bindarr: whom, what and which way. A
// backup made before they existed has none of these sections (see the restore).
const EXTERNAL_TABLES = ['external_contacts', 'external_transactions', 'external_transaction_items'];

// Every table a restore writes.
const RESTORED_TABLES = ['locations', 'compartments', 'compartment_assignments', 'collection', 'decks',
  'deck_cards', 'notes', 'card_cache', 'price_history', 'tcgplayer_product', 'sealed_templates',
  'sealed_template_components', 'sealed_purchases', 'sealed_units', 'card_lists', 'card_list_items',
  ...EXTERNAL_TABLES];

// What a restore writes to `table`: the columns this schema has (not the id, which
// is renumbered, except card_cache's, which is the card's own), and which of them
// hold another row's id. Card ids are left out of those: they name shared card
// data, which the restore checks for itself before writing a row that names one.
async function shapeOf(table) {
  const cols = (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name)
    .filter(c => c !== 'id' || table === 'card_cache');
  const refs = (await db.all(`PRAGMA foreign_key_list(${table})`))
    .filter(fk => fk.table !== 'card_cache')
    .map(fk => fk.from);
  return { table, cols, refs };
}

async function rowsWhereIn(table, column, values) {
  const out = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    const part = values.slice(i, i + CHUNK);
    out.push(...await db.all(
      `SELECT * FROM ${table} WHERE ${column} IN (${part.map(() => '?').join(',')})`, part
    ));
  }
  return out;
}

router.get('/backup', async (req, res) => {
  try {
    const uid = req.user.id;
    const locations = await db.all(`SELECT * FROM locations WHERE user_id = ?`, [uid]);
    const compartments = await rowsWhereIn('compartments', 'location_id', locations.map(l => l.id));
    const assignments = await rowsWhereIn('compartment_assignments', 'compartment_id', compartments.map(c => c.id));
    const collection = await db.all(`SELECT * FROM collection WHERE user_id = ?`, [uid]);
    const decks = await db.all(`SELECT * FROM decks WHERE user_id = ?`, [uid]);
    const deckCards = await rowsWhereIn('deck_cards', 'deck_id', decks.map(d => d.id));
    const notes = await db.all(`SELECT * FROM notes WHERE user_id = ?`, [uid]);
    const sealedPurchases = await db.all(`SELECT * FROM sealed_purchases WHERE user_id = ?`, [uid]);
    const sealedUnits = await rowsWhereIn('sealed_units', 'purchase_id', sealedPurchases.map(p => p.id));
    // The recipes this account made, and the ones its purchases follow, whoever made
    // them: recipes are shared, one per product (#168), and a restore maps each onto
    // the server's own recipe for that product, or creates it where there is none.
    const sealedTemplates = await db.all(
      `SELECT * FROM sealed_templates
        WHERE user_id = ? OR id IN (SELECT template_id FROM sealed_purchases WHERE user_id = ?)
        ORDER BY id`,
      [uid, uid]
    );
    const sealedComponents = await rowsWhereIn('sealed_template_components', 'template_id', sealedTemplates.map(t => t.id));
    const lists = await db.all(`SELECT * FROM card_lists WHERE user_id = ?`, [uid]);
    const listItems = await rowsWhereIn('card_list_items', 'list_id', lists.map(l => l.id));
    // In the order they were made: a restore renumbers rows in file order, and the
    // deal history breaks ties between deals made the same second by id.
    const contacts = await db.all(`SELECT * FROM external_contacts WHERE user_id = ? ORDER BY id`, [uid]);
    const deals = await db.all(`SELECT * FROM external_transactions WHERE user_id = ? ORDER BY id`, [uid]);
    const dealItems = (await rowsWhereIn('external_transaction_items', 'transaction_id', deals.map(d => d.id)))
      .sort((a, b) => a.id - b.id);

    // The cards those rows name, so the backup restores onto an install that has
    // never cached them — a new phone, or a server that has never seen this game.
    const cardIds = [...new Set([
      ...collection.map(c => c.card_id), ...deckCards.map(d => d.card_id),
      ...sealedComponents.map(c => c.card_id).filter(Boolean),
      ...listItems.map(i => i.card_id),
    ])];
    const cards = await rowsWhereIn('card_cache', 'id', cardIds);
    const priceHistory = await rowsWhereIn('price_history', 'card_id', cardIds);
    const products = await rowsWhereIn('tcgplayer_product', 'card_id', cardIds);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename=bindarr_backup_${stamp}.json`);
    res.json({
      format: FORMAT,
      version: VERSION,
      app_version: require('../../package.json').version,
      exported_at: new Date().toISOString(),
      data: {
        locations, compartments, compartment_assignments: assignments, collection,
        decks, deck_cards: deckCards, notes,
        sealed_templates: sealedTemplates, sealed_template_components: sealedComponents,
        sealed_purchases: sealedPurchases, sealed_units: sealedUnits,
        card_lists: lists, card_list_items: listItems,
        external_contacts: contacts, external_transactions: deals, external_transaction_items: dealItems,
        card_cache: cards, price_history: priceHistory, tcgplayer_product: products,
      },
    });
  } catch (error) {
    console.error('Backup failed:', error);
    res.status(500).json({ error: 'Backup failed' });
  }
});

// Insert one row with only the columns this schema has (`shape`, from shapeOf),
// overriding some. A reference the caller does not override would carry the
// source install's id across, so it is written as NULL (top of this file).
async function insert(shape, row, overrides = {}, verb = 'INSERT') {
  const values = { ...row };
  for (const ref of shape.refs) values[ref] = null;
  Object.assign(values, overrides);
  const names = shape.cols.filter(c => c in values);
  const result = await db.run(
    `${verb} INTO ${shape.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map(n => values[n])
  );
  return result.lastID;
}

// A copy's link to the record of how it came in: a trade or gift between two
// accounts, a trade recorded after the fact, or (from a backup without the
// account's outside deals, which then stay as they are) one of those deals. Kept
// when this install holds that record as the restoring account's own receipt;
// otherwise the id is another install's, or names someone else's trade, and the
// copy comes back without the link rather than failing the restore over it.
const RECEIPTS = {
  transfer: `SELECT 1 FROM user_transfer_items WHERE id = ? AND to_user_id = ?`,
  historical: `SELECT 1 FROM historical_trade_items WHERE id = ? AND to_user_id = ?`,
  external: `SELECT 1 FROM external_transaction_items i JOIN external_transactions t ON t.id = i.transaction_id
              WHERE i.id = ? AND t.user_id = ?`,
};

async function ownReceipt(kind, id, uid) {
  if (!Number.isSafeInteger(id)) return null;
  return (await db.get(RECEIPTS[kind], [id, uid])) ? id : null;
}

const isBackup = (b) => b && b.format === FORMAT && b.data && typeof b.data === 'object';

// Every card id the account's own rows name.
function referencedCardIds(list) {
  return [...new Set([
    ...list('collection').map(r => r && r.card_id),
    ...list('deck_cards').map(r => r && r.card_id),
    ...list('card_list_items').map(r => r && r.card_id),
    ...list('sealed_template_components').map(r => r && r.card_id),
  ].filter(id => typeof id === 'string' && id))];
}

// The ids in `ids` that card_cache does not hold.
async function uncachedCardIds(ids) {
  const known = new Set();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    for (const row of await db.all(`SELECT id FROM card_cache WHERE id IN (${part.map(() => '?').join(',')})`, part)) {
      known.add(row.id);
    }
  }
  return ids.filter(id => !known.has(id));
}

// Bring each card the install does not hold into card_cache from its provider.
// Before the transaction, never inside it: the connection lock is held for a
// transaction's whole callback, and every other request would wait on the network.
// One at a time, as an import does, since the providers rate-limit. A card no
// provider has stays missing, and the rows naming it are skipped.
async function fetchMissingCards(ids, user) {
  let fetched = 0;
  let missing = 0;
  for (const id of ids) {
    if (await db.get(`SELECT 1 FROM card_cache WHERE id = ?`, [id])) continue;
    const card = await cardApi.getCardById(id, { tcgApiKey: user.tcg_api_key }).catch(() => null);
    if (card && await db.get(`SELECT 1 FROM card_cache WHERE id = ?`, [id])) fetched++;
    else missing++;
  }
  return { fetched, missing };
}

// A refusal the client can act on, thrown from inside the transaction so that
// nothing it already did is kept.
const refusal = (status, code, message) => Object.assign(new Error(message), { clientStatus: status, code });

// Counted against the import budget by server.js before the body is parsed.
router.post('/backup/restore', async (req, res) => {
  const backup = req.body && req.body.backup;
  if (!isBackup(backup)) {
    return res.status(400).json({ error: 'Not a Bindarr backup file.' });
  }
  if (!(backup.version <= VERSION)) {
    return res.status(400).json({ error: 'This backup was made by a newer Bindarr. Update this install first.' });
  }
  const list = (key) => (Array.isArray(backup.data[key]) ? backup.data[key] : []);
  const uid = req.user.id;
  const trusted = req.user.role === 'admin';
  // A backup made before outside deals were recorded says nothing about them, so
  // the account's own stay as they are; one that has them replaces them.
  const hasDeals = EXTERNAL_TABLES.some(t => Array.isArray(backup.data[t]));

  try {
    let fetchedCards = null;
    if (!trusted) {
      const uncached = await uncachedCardIds(referencedCardIds(list));
      if (uncached.length > MAX_CARD_LOOKUPS) {
        return res.status(413).json({
          error: `This backup names ${uncached.length} cards this server has not seen, and a restore looks up at most ${MAX_CARD_LOOKUPS}. `
            + 'An admin can restore it: an admin\'s restore takes the card data from the file.',
          code: 'restore_too_many_cards',
          params: { count: uncached.length, max: MAX_CARD_LOOKUPS },
        });
      }
      fetchedCards = await fetchMissingCards(uncached, req.user);
    }
    const shape = {};
    for (const t of RESTORED_TABLES) shape[t] = await shapeOf(t);
    const counts = {};
    const cardKnown = async (id) => !!(await db.get(`SELECT 1 FROM card_cache WHERE id = ?`, [id]));

    await db.withTransaction(async () => {
      // Replacing the account's sealed purchases deletes their units, and a unit
      // another account has claimed is that account's box. sealed.js refuses to
      // delete such a purchase; a restore, which deletes all of them, is refused
      // for the same reason.
      const claimedByOthers = await db.get(
        `SELECT 1 FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id
          WHERE p.user_id = ? AND u.claimed_by_user_id IS NOT NULL AND u.claimed_by_user_id != ? LIMIT 1`,
        [uid, uid]
      );
      if (claimedByOthers) {
        throw refusal(409, 'restore_claimed_units',
          'Some of your sealed purchases have units claimed by other users, and a restore would delete them. Nothing was changed.');
      }

      // Shared card data first, from an admin's file only (top of this file): the
      // collection's card_id references card_cache.
      for (const row of trusted ? list('card_cache') : []) {
        if (row && row.id) await insert(shape.card_cache, row, {}, 'INSERT OR IGNORE');
      }
      for (const row of trusted ? list('price_history') : []) {
        if (row && row.card_id) await insert(shape.price_history, row, {}, 'INSERT OR IGNORE');
      }
      for (const row of trusted ? list('tcgplayer_product') : []) {
        if (row && row.card_id) await insert(shape.tcgplayer_product, row, {}, 'INSERT OR IGNORE');
      }

      // Then out with this account's own rows. Compartments and their filing rules
      // go with their locations (ON DELETE CASCADE); deck cards with their decks;
      // units with their purchases, list items with their lists, deal items with
      // their deals. Not the recipes it made: those are shared (below).
      await db.run(`DELETE FROM card_lists WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM collection WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM sealed_purchases WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM decks WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM notes WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM locations WHERE user_id = ?`, [uid]);
      if (hasDeals) {
        await db.run(`DELETE FROM external_transactions WHERE user_id = ?`, [uid]);
        await db.run(`DELETE FROM external_contacts WHERE user_id = ?`, [uid]);
      }

      const locMap = new Map();
      for (const row of list('locations')) {
        locMap.set(row.id, await insert(shape.locations, row, { user_id: uid }));
      }
      const compMap = new Map();
      for (const row of list('compartments')) {
        const locationId = locMap.get(row.location_id);
        if (locationId == null) continue;
        compMap.set(row.id, await insert(shape.compartments, row, { location_id: locationId }));
      }
      for (const row of list('compartment_assignments')) {
        const compartmentId = compMap.get(row.compartment_id);
        if (compartmentId == null) continue;
        await insert(shape.compartment_assignments, row, { compartment_id: compartmentId }, 'INSERT OR IGNORE');
      }

      // Sealed product before the collection, whose copies can name the unit they
      // were opened from. A purchase that was itself opened out of another unit
      // points at that unit, which only exists once every purchase's units do.
      //
      // Recipes first, which the purchases follow. A recipe is shared, one per
      // product and game (#168), and other accounts' purchases follow it too, so a
      // restore never deletes or changes one, whoever made it. Each recipe in the
      // file is the server's own recipe for that product, by the identity its
      // unique indexes give it, where there is one; only a product with none gets
      // the file's recipe, components and all, as the restorer's.
      const templateMap = new Map();
      const createdTemplates = new Set();
      for (const row of list('sealed_templates')) {
        const game = row.game || 'pokemon';
        const same = row.product_id != null
          ? await db.get(`SELECT id FROM sealed_templates WHERE game = ? AND product_id = ?`, [game, row.product_id])
          : await db.get(
            `SELECT id FROM sealed_templates WHERE game = ? AND product_id IS NULL AND product_name = ? COLLATE NOCASE`,
            [game, row.product_name]
          );
        if (same) {
          templateMap.set(row.id, same.id);
          continue;
        }
        templateMap.set(row.id, await insert(shape.sealed_templates, row, { user_id: uid, game }));
        createdTemplates.add(row.id);
      }
      for (const row of list('sealed_template_components')) {
        if (!createdTemplates.has(row.template_id)) continue;   // an existing recipe keeps its own
        if (row.card_id && !(await cardKnown(row.card_id))) continue;
        await insert(shape.sealed_template_components, row, { template_id: templateMap.get(row.template_id) });
      }
      const purchaseMap = new Map();
      for (const row of list('sealed_purchases')) {
        purchaseMap.set(row.id, await insert(shape.sealed_purchases, row, {
          user_id: uid,
          template_id: row.template_id == null ? null : (templateMap.get(row.template_id) ?? null),
          source_unit_id: null,
        }));
      }
      // A unit's claim names an account on the install the file came from. Only
      // the file owner's own claim means anything here, and it becomes the
      // restorer's; any other is dropped. Copied as written, a member's file
      // could put a box into whichever account it named.
      const fileOwnerOf = new Map(list('sealed_purchases').map(p => [p && p.id, p && p.user_id]));
      const unitMap = new Map();
      for (const row of list('sealed_units')) {
        const purchaseId = purchaseMap.get(row.purchase_id);
        if (purchaseId == null) continue;
        const fileOwner = fileOwnerOf.get(row.purchase_id);
        const ownClaim = row.claimed_by_user_id != null && fileOwner != null && Number(row.claimed_by_user_id) === Number(fileOwner);
        unitMap.set(row.id, await insert(shape.sealed_units, row, {
          purchase_id: purchaseId,
          claimed_by_user_id: ownClaim ? uid : null,
        }));
      }
      for (const row of list('sealed_purchases')) {
        const unitId = row.source_unit_id == null ? null : unitMap.get(row.source_unit_id);
        if (unitId != null) await db.run(`UPDATE sealed_purchases SET source_unit_id = ? WHERE id = ?`, [unitId, purchaseMap.get(row.id)]);
      }

      // The account's outside deals, after the units their items name and before
      // the copies, which name the item that brought them in. Which copy an item
      // gave away or brought in is filled in once the copies are back, below.
      const contactMap = new Map();
      const dealMap = new Map();
      const dealItemMap = new Map();
      if (hasDeals) {
        for (const row of list('external_contacts')) {
          // Names are unique per account, ignoring case: a second "Sam" is the first.
          const same = await db.get(`SELECT id FROM external_contacts WHERE user_id = ? AND name = ? COLLATE NOCASE`, [uid, row.name]);
          contactMap.set(row.id, same ? same.id : await insert(shape.external_contacts, row, { user_id: uid }));
        }
        for (const row of list('external_transactions')) {
          dealMap.set(row.id, await insert(shape.external_transactions, row, {
            user_id: uid,
            contact_id: row.contact_id == null ? null : (contactMap.get(row.contact_id) ?? null),
          }));
        }
        for (const row of list('external_transaction_items')) {
          const dealId = dealMap.get(row.transaction_id);
          if (dealId == null) continue;
          dealItemMap.set(row.id, await insert(shape.external_transaction_items, row, {
            transaction_id: dealId,
            source_sealed_unit_id: row.source_sealed_unit_id == null ? null : (unitMap.get(row.source_sealed_unit_id) ?? null),
          }));
        }
      }

      // A copy whose card the backup could not supply would break the card_cache
      // foreign key; it is skipped and counted rather than failing the restore.
      //
      // A backup from before the collection's wishlist was retired holds wanted
      // cards as rows with list_type 'wishlist'. Those are not copies: they go on
      // the default Wishlist below, once the backup's own lists are back.
      let skipped = 0;
      let copies = 0;
      const wanted = [];
      const copyMap = new Map();
      for (const row of list('collection')) {
        const known = await db.get(`SELECT 1 FROM card_cache WHERE id = ?`, [row.card_id]);
        if (!known) { skipped++; continue; }
        if (row.list_type === 'wishlist') {
          wanted.push({ card_id: row.card_id, quantity: row.quantity, notes: row.notes, added_at: row.added_at });
          continue;
        }
        copyMap.set(row.id, await insert(shape.collection, row, {
          user_id: uid,
          list_type: 'collection',
          location_id: row.location_id == null ? null : (locMap.get(row.location_id) ?? null),
          compartment_id: row.compartment_id == null ? null : (compMap.get(row.compartment_id) ?? null),
          sealed_unit_id: row.sealed_unit_id == null ? null : (unitMap.get(row.sealed_unit_id) ?? null),
          acquired_via_transfer_item_id: await ownReceipt('transfer', row.acquired_via_transfer_item_id, uid),
          acquired_via_historical_trade_item_id: await ownReceipt('historical', row.acquired_via_historical_trade_item_id, uid),
          acquired_via_external_item_id: hasDeals
            ? (row.acquired_via_external_item_id == null ? null : (dealItemMap.get(row.acquired_via_external_item_id) ?? null))
            : await ownReceipt('external', row.acquired_via_external_item_id, uid),
        }));
        copies++;
      }
      for (const row of list('external_transaction_items')) {
        const itemId = dealItemMap.get(row.id);
        const copyId = row.source_collection_id == null ? null : copyMap.get(row.source_collection_id);
        if (itemId != null && copyId != null) {
          await db.run(`UPDATE external_transaction_items SET source_collection_id = ? WHERE id = ?`, [copyId, itemId]);
        }
      }
      const deckMap = new Map();
      for (const row of list('decks')) {
        deckMap.set(row.id, await insert(shape.decks, row, { user_id: uid }));
      }
      for (const row of list('deck_cards')) {
        const deckId = deckMap.get(row.deck_id);
        if (deckId == null || !(await cardKnown(row.card_id))) continue;
        await insert(shape.deck_cards, row, { deck_id: deckId }, 'INSERT OR IGNORE');
      }
      // Lists after decks: a deck's missing-cards list points at the deck. Items
      // naming a card the backup could not supply are skipped, as copies are.
      const listMap = new Map();
      for (const row of list('card_lists')) {
        listMap.set(row.id, await insert(shape.card_lists, row, {
          user_id: uid,
          deck_id: row.deck_id == null ? null : (deckMap.get(row.deck_id) ?? null),
        }));
      }
      for (const row of list('card_list_items')) {
        const listId = listMap.get(row.list_id);
        if (listId == null) continue;
        if (!(await db.get(`SELECT 1 FROM card_cache WHERE id = ?`, [row.card_id]))) continue;
        await insert(shape.card_list_items, row, { list_id: listId }, 'INSERT OR IGNORE');
      }
      const onWishlist = wanted.length ? await wantCards(uid, wanted) : null;
      for (const row of list('notes')) {
        await insert(shape.notes, row, { user_id: uid });
      }

      Object.assign(counts, {
        cards: copies,
        ...(onWishlist ? { wishlisted: onWishlist.added + onWishlist.merged } : {}),
        skipped,
        locations: locMap.size,
        decks: deckMap.size,
        lists: listMap.size,
        notes: list('notes').length,
        sealed: purchaseMap.size,
        external_deals: dealMap.size,
        ...(fetchedCards ? { fetched_cards: fetchedCards.fetched } : {}),
      });
    });

    // The in-memory set order compartment sorting reads may now be missing sets
    // the restored cards belong to; cheap to reload.
    await require('../utils/compartmentSort').loadSetsCache(db).catch(() => {});
    res.json({ message: 'Backup restored', ...counts });
  } catch (error) {
    if (error.clientStatus) return res.status(error.clientStatus).json({ error: error.message, code: error.code });
    console.error('Restore failed:', error);
    res.status(500).json({ error: 'Restore failed. Nothing was changed.' });
  }
});

module.exports = router;
module.exports.FORMAT = FORMAT;
