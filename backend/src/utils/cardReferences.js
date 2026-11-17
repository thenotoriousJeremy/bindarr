// What refers to a card, and taking back card rows nothing refers to.
//
// For a module that wrote card_cache rows a provider no longer serves: the
// TCGplayer fallbacks for Pokémon (pokemonTcgplayer.js) and Riftbound
// (riftboundTcgplayer.js), once the real provider covers the set or TCGplayer
// drops it. A card someone holds, decks, lists, keeps in a sealed recipe or traded
// stays exactly as it was; the rest go, with the rows that only described them.
//
// What refers to a card is read from the database itself: every table with a
// `card_id` column other than the rows that only describe a card. A table added
// later counts without anyone remembering to list it here. A failed read throws
// rather than counting as "nothing refers to it": that would delete a card someone
// owns.
'use strict';

const db = require('../db');

const DESCRIBING_ROWS = ['price_history', 'tcgplayer_product', 'notification_price_state'];
const quoteName = (name) => `"${String(name).replace(/"/g, '""')}"`;
// Bound parameters per statement: under the 999 older SQLite allows.
const CHUNK = 400;

async function referencingTables() {
  const tables = await db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  const out = [];
  for (const { name } of tables) {
    if (name === 'card_cache' || DESCRIBING_ROWS.includes(name)) continue;
    const columns = await db.all(`PRAGMA table_info(${quoteName(name)})`);
    if (columns.some(c => c.name === 'card_id')) out.push(name);
  }
  return out;
}

// Of `ids`, the ones some table in `tables` refers to.
async function referencedIds(ids, tables) {
  const owned = new Set();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(',');
    for (const table of tables) {
      const refs = await db.all(`SELECT DISTINCT card_id FROM ${quoteName(table)} WHERE card_id IN (${marks})`, chunk);
      for (const r of refs) owned.add(r.card_id);
    }
  }
  return owned;
}

// Delete the cards of `ids` that nothing refers to, with the rows that only
// described them. Call it inside the transaction that worked out `ids`, so a card
// added to a collection between the two is never deleted from under it; `tables`
// is referencingTables(), read before that transaction opened. Returns
// { removed, kept }: the ids deleted, and the ids kept because something holds them.
async function deleteUnreferenced(ids, tables) {
  const unique = [...new Set(ids)];
  const owned = unique.length ? await referencedIds(unique, tables) : new Set();
  const doomed = unique.filter(id => !owned.has(id));
  for (let i = 0; i < doomed.length; i += CHUNK) {
    const chunk = doomed.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(',');
    for (const table of DESCRIBING_ROWS) {
      await db.run(`DELETE FROM ${table} WHERE card_id IN (${marks})`, chunk);
    }
    await db.run(`DELETE FROM card_cache WHERE id IN (${marks})`, chunk);
  }
  return { removed: doomed, kept: unique.filter(id => owned.has(id)) };
}

module.exports = { DESCRIBING_ROWS, referencingTables, referencedIds, deleteUnreferenced };
