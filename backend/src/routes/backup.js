// A full backup of one account: everything it owns, in one JSON file that
// restores onto any Bindarr — the same install, a fresh one, a phone running in
// device mode, or a server that phone is moving to.
//
// The CSV/JSON export in importExport.js is a card list for spreadsheets and other
// apps. It cannot rebuild an account: it has no decks or notes, no binder pages or
// their filing rules, and it names each copy's location by text. This file holds
// the rows themselves.
//
// Restore REPLACES the account's collection, storage, decks and notes. A merge
// would have to decide which of two binders called "Main Binder" a copy belongs in,
// and every way of guessing files cards somewhere their owner did not put them.
// Card data (card_cache, price history, product ids) is shared across accounts, so
// it is only ever added to, never overwritten: whatever the install already holds
// is at least as fresh as the backup's copy.
//
// Ids are renumbered on the way in, because the restoring database has its own
// sequences, and every reference between the rows is remapped to match. Columns
// are copied by name, limited to the ones both the backup and this schema have, so
// a backup from an older or newer version restores what it can rather than failing.
'use strict';

const express = require('express');
const db = require('../db');

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

    // The cards those rows name, so the backup restores onto an install that has
    // never cached them — a new phone, or a server that has never seen this game.
    const cardIds = [...new Set([...collection.map(c => c.card_id), ...deckCards.map(d => d.card_id)])];
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

  try {
    const cols = {};
    for (const t of ['locations', 'compartments', 'compartment_assignments', 'collection', 'decks',
      'deck_cards', 'notes', 'card_cache', 'price_history', 'tcgplayer_product']) {
      cols[t] = (await columnsOf(t)).filter(c => c !== 'id' || ['card_cache'].includes(t));
    }
    const counts = {};

    await db.withTransaction(async () => {
      // Shared card data first: the collection's card_id references card_cache.
      for (const row of list('card_cache')) {
        if (row && row.id) await insert('card_cache', cols.card_cache, row, {}, 'INSERT OR IGNORE');
      }
      for (const row of list('price_history')) {
        if (row && row.card_id) await insert('price_history', cols.price_history, row, {}, 'INSERT OR IGNORE');
      }
      for (const row of list('tcgplayer_product')) {
        if (row && row.card_id) await insert('tcgplayer_product', cols.tcgplayer_product, row, {}, 'INSERT OR IGNORE');
      }

      // Then out with this account's own rows. Compartments and their filing rules
      // go with their locations (ON DELETE CASCADE); deck cards with their decks.
      await db.run(`DELETE FROM collection WHERE user_id = ?`, [uid]);
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
        });
      }
      const deckMap = new Map();
      for (const row of list('decks')) {
        deckMap.set(row.id, await insert('decks', cols.decks, row, { user_id: uid }));
      }
      for (const row of list('deck_cards')) {
        const deckId = deckMap.get(row.deck_id);
        if (deckId == null) continue;
        await insert('deck_cards', cols.deck_cards, row, { deck_id: deckId }, 'INSERT OR IGNORE');
      }
      for (const row of list('notes')) {
        await insert('notes', cols.notes, row, { user_id: uid });
      }

      Object.assign(counts, {
        cards: list('collection').length - skipped,
        skipped,
        locations: locMap.size,
        decks: deckMap.size,
        notes: list('notes').length,
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
