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
'use strict';

const express = require('express');
const db = require('../db');
const cardApi = require('../utils/cardApi');
const { importLimiter } = require('../middleware/auth');

const router = express.Router();

const FORMAT = 'bindarr-backup';
const VERSION = 1;
const CHUNK = 500;   // SQLite caps bound parameters per statement

async function columnsOf(table) {
  return (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name);
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
    const sealedTemplates = await db.all(`SELECT * FROM sealed_templates WHERE user_id = ?`, [uid]);
    const sealedComponents = await rowsWhereIn('sealed_template_components', 'template_id', sealedTemplates.map(t => t.id));
    const sealedPurchases = await db.all(`SELECT * FROM sealed_purchases WHERE user_id = ?`, [uid]);
    const sealedUnits = await rowsWhereIn('sealed_units', 'purchase_id', sealedPurchases.map(p => p.id));
    const lists = await db.all(`SELECT * FROM card_lists WHERE user_id = ?`, [uid]);
    const listItems = await rowsWhereIn('card_list_items', 'list_id', lists.map(l => l.id));

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
        card_cache: cards, price_history: priceHistory, tcgplayer_product: products,
      },
    });
  } catch (error) {
    console.error('Backup failed:', error);
    res.status(500).json({ error: 'Backup failed' });
  }
});

// Insert one row with only the columns this schema has, overriding some.
async function insert(table, cols, row, overrides = {}, verb = 'INSERT') {
  const values = { ...row, ...overrides };
  const names = cols.filter(c => c in values);
  const result = await db.run(
    `${verb} INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map(n => values[n])
  );
  return result.lastID;
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

router.post('/backup/restore', importLimiter, async (req, res) => {
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

  try {
    const fetchedCards = trusted ? null : await fetchMissingCards(referencedCardIds(list), req.user);
    const cols = {};
    for (const t of ['locations', 'compartments', 'compartment_assignments', 'collection', 'decks',
      'deck_cards', 'notes', 'card_cache', 'price_history', 'tcgplayer_product', 'sealed_templates',
      'sealed_template_components', 'sealed_purchases', 'sealed_units', 'card_lists', 'card_list_items']) {
      cols[t] = (await columnsOf(t)).filter(c => c !== 'id' || ['card_cache'].includes(t));
    }
    const counts = {};
    const cardKnown = async (id) => !!(await db.get(`SELECT 1 FROM card_cache WHERE id = ?`, [id]));

    await db.withTransaction(async () => {
      // Shared card data first, from an admin's file only (top of this file): the
      // collection's card_id references card_cache.
      for (const row of trusted ? list('card_cache') : []) {
        if (row && row.id) await insert('card_cache', cols.card_cache, row, {}, 'INSERT OR IGNORE');
      }
      for (const row of trusted ? list('price_history') : []) {
        if (row && row.card_id) await insert('price_history', cols.price_history, row, {}, 'INSERT OR IGNORE');
      }
      for (const row of trusted ? list('tcgplayer_product') : []) {
        if (row && row.card_id) await insert('tcgplayer_product', cols.tcgplayer_product, row, {}, 'INSERT OR IGNORE');
      }

      // Then out with this account's own rows. Compartments and their filing rules
      // go with their locations (ON DELETE CASCADE); deck cards with their decks;
      // units with their purchases, components with their templates, items with
      // their lists.
      await db.run(`DELETE FROM card_lists WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM collection WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM sealed_purchases WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM sealed_templates WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM decks WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM notes WHERE user_id = ?`, [uid]);
      await db.run(`DELETE FROM locations WHERE user_id = ?`, [uid]);

      const locMap = new Map();
      for (const row of list('locations')) {
        locMap.set(row.id, await insert('locations', cols.locations, row, { user_id: uid }));
      }
      const compMap = new Map();
      for (const row of list('compartments')) {
        const locationId = locMap.get(row.location_id);
        if (locationId == null) continue;
        compMap.set(row.id, await insert('compartments', cols.compartments, row, { location_id: locationId }));
      }
      for (const row of list('compartment_assignments')) {
        const compartmentId = compMap.get(row.compartment_id);
        if (compartmentId == null) continue;
        await insert('compartment_assignments', cols.compartment_assignments, row, { compartment_id: compartmentId }, 'INSERT OR IGNORE');
      }

      // Sealed product before the collection, whose copies can name the unit they
      // were opened from. A purchase that was itself opened out of another unit
      // points at that unit, which only exists once every purchase's units do.
      const templateMap = new Map();
      for (const row of list('sealed_templates')) {
        templateMap.set(row.id, await insert('sealed_templates', cols.sealed_templates, row, { user_id: uid }));
      }
      for (const row of list('sealed_template_components')) {
        const templateId = templateMap.get(row.template_id);
        if (templateId == null) continue;
        if (row.card_id && !(await cardKnown(row.card_id))) continue;
        await insert('sealed_template_components', cols.sealed_template_components, row, { template_id: templateId });
      }
      const purchaseMap = new Map();
      for (const row of list('sealed_purchases')) {
        purchaseMap.set(row.id, await insert('sealed_purchases', cols.sealed_purchases, row, {
          user_id: uid,
          template_id: row.template_id == null ? null : (templateMap.get(row.template_id) ?? null),
          source_unit_id: null,
        }));
      }
      const unitMap = new Map();
      for (const row of list('sealed_units')) {
        const purchaseId = purchaseMap.get(row.purchase_id);
        if (purchaseId != null) unitMap.set(row.id, await insert('sealed_units', cols.sealed_units, row, { purchase_id: purchaseId }));
      }
      for (const row of list('sealed_purchases')) {
        const unitId = row.source_unit_id == null ? null : unitMap.get(row.source_unit_id);
        if (unitId != null) await db.run(`UPDATE sealed_purchases SET source_unit_id = ? WHERE id = ?`, [unitId, purchaseMap.get(row.id)]);
      }

      // A copy whose card the backup could not supply would break the card_cache
      // foreign key; it is skipped and counted rather than failing the restore.
      let skipped = 0;
      for (const row of list('collection')) {
        const known = await db.get(`SELECT 1 FROM card_cache WHERE id = ?`, [row.card_id]);
        if (!known) { skipped++; continue; }
        await insert('collection', cols.collection, row, {
          user_id: uid,
          location_id: row.location_id == null ? null : (locMap.get(row.location_id) ?? null),
          compartment_id: row.compartment_id == null ? null : (compMap.get(row.compartment_id) ?? null),
          sealed_unit_id: row.sealed_unit_id == null ? null : (unitMap.get(row.sealed_unit_id) ?? null),
        });
      }
      const deckMap = new Map();
      for (const row of list('decks')) {
        deckMap.set(row.id, await insert('decks', cols.decks, row, { user_id: uid }));
      }
      for (const row of list('deck_cards')) {
        const deckId = deckMap.get(row.deck_id);
        if (deckId == null || !(await cardKnown(row.card_id))) continue;
        await insert('deck_cards', cols.deck_cards, row, { deck_id: deckId }, 'INSERT OR IGNORE');
      }
      // Lists after decks: a deck's missing-cards list points at the deck. Items
      // naming a card the backup could not supply are skipped, as copies are.
      const listMap = new Map();
      for (const row of list('card_lists')) {
        listMap.set(row.id, await insert('card_lists', cols.card_lists, row, {
          user_id: uid,
          deck_id: row.deck_id == null ? null : (deckMap.get(row.deck_id) ?? null),
        }));
      }
      for (const row of list('card_list_items')) {
        const listId = listMap.get(row.list_id);
        if (listId == null) continue;
        if (!(await db.get(`SELECT 1 FROM card_cache WHERE id = ?`, [row.card_id]))) continue;
        await insert('card_list_items', cols.card_list_items, row, { list_id: listId }, 'INSERT OR IGNORE');
      }
      for (const row of list('notes')) {
        await insert('notes', cols.notes, row, { user_id: uid });
      }

      Object.assign(counts, {
        cards: list('collection').length - skipped,
        skipped,
        locations: locMap.size,
        decks: deckMap.size,
        lists: listMap.size,
        notes: list('notes').length,
        sealed: purchaseMap.size,
        ...(fetchedCards ? { fetched_cards: fetchedCards.fetched } : {}),
      });
    });

    // The in-memory set order compartment sorting reads may now be missing sets
    // the restored cards belong to; cheap to reload.
    await require('../utils/compartmentSort').loadSetsCache(db).catch(() => {});
    res.json({ message: 'Backup restored', ...counts });
  } catch (error) {
    console.error('Restore failed:', error);
    res.status(500).json({ error: 'Restore failed. Nothing was changed.' });
  }
});

module.exports = router;
module.exports.FORMAT = FORMAT;
