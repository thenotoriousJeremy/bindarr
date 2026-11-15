// Each user's default Wishlist: the list the heart on a card adds to, and the
// only place a wanted card lives. The collection used to keep wanted cards too,
// as rows with list_type 'wishlist'; utils/wishlistMigration.js moved those here,
// and every request that still asks for one (an older app, an older backup or
// CSV, a trashed wishlist row) puts the card on this list instead (wantCards).
//
// It is made on first use, named Wishlist, takes any game, and is otherwise an
// ordinary list: rename it, add to it from the Lists view, delete it, and the
// next want makes a new one. At most one per user (idx_card_lists_default).
const db = require('../db');

const DEFAULT_WISHLIST_NAME = 'Wishlist';
// routes/lists.js's limits on an item.
const MAX_WANTED = 9999;
const NOTES_MAX = 2000;

// `client` is what the statements run on: db.js for every caller but initDb's
// migration, which passes the connection itself (db/connection.js), as every
// initDb step talks to it, so a wrapper on db.js never sees a boot's statements.
const defaultList = (userId, client = db) =>
  client.get(`SELECT * FROM card_lists WHERE user_id = ? AND is_default = 1`, [userId]);

async function ensureDefaultList(userId, client = db) {
  // OR IGNORE: a second request racing this one finds the row the first made.
  await client.run(
    `INSERT OR IGNORE INTO card_lists (user_id, name, kind, game, is_default) VALUES (?, ?, 'wishlist', NULL, 1)`,
    [userId, DEFAULT_WISHLIST_NAME]
  );
  return defaultList(userId, client);
}

const wantedCount = (value) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_WANTED, n) : 1;
};

const noteText = (value) => (typeof value === 'string' ? value.trim() : '');

// Put cards on the user's default Wishlist, making the list if need be.
//
// `wants` are { card_id, quantity, notes, added_at }, all but card_id optional.
// Wants of one card are one item: their quantities add up (a stack of three
// wishlist rows wanted three copies) and their notes are kept, one per line.
// A card already on the list stays one item too: the same want said twice is not
// two wants, so it keeps the larger quantity, its own notes, and any new note
// beneath them. added_at, when given, dates a new item (the earliest want).
//
// A card card_cache does not hold cannot go on a list (its foreign key), so it
// is left out and named in `missing`; the caller decides what that means. Nothing
// to add makes no list. Opens no transaction of its own: inside a caller's, it is
// part of that one. Resolves { list, added, merged, missing }: cards newly on the
// list, cards that were on it already, and cards left out.
async function wantCards(userId, wants, client = db) {
  const byCard = new Map();
  for (const want of wants || []) {
    const cardId = want && typeof want.card_id === 'string' ? want.card_id.trim() : '';
    if (!cardId) continue;
    const entry = byCard.get(cardId) || { quantity: 0, notes: [], addedAt: null };
    entry.quantity = Math.min(MAX_WANTED, entry.quantity + wantedCount(want.quantity));
    const note = noteText(want.notes);
    if (note && !entry.notes.includes(note)) entry.notes.push(note);
    if (want.added_at && (!entry.addedAt || String(want.added_at) < entry.addedAt)) entry.addedAt = String(want.added_at);
    byCard.set(cardId, entry);
  }

  const known = [];
  const missing = [];
  for (const cardId of byCard.keys()) {
    if (await client.get(`SELECT 1 FROM card_cache WHERE id = ?`, [cardId])) known.push(cardId);
    else missing.push(cardId);
  }
  if (known.length === 0) return { list: null, added: 0, merged: 0, missing };

  const list = await ensureDefaultList(userId, client);
  let added = 0;
  let merged = 0;
  for (const cardId of known) {
    const want = byCard.get(cardId);
    const notes = want.notes.join('\n').slice(0, NOTES_MAX);
    const existing = await client.get(
      `SELECT id, quantity_wanted, notes FROM card_list_items WHERE list_id = ? AND card_id = ?`, [list.id, cardId]
    );
    if (!existing) {
      await client.run(
        `INSERT INTO card_list_items (list_id, card_id, quantity_wanted, notes, added_at)
         VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
        [list.id, cardId, want.quantity, notes, want.addedAt]
      );
      added++;
      continue;
    }
    const kept = existing.notes || '';
    const fresh = want.notes.filter(n => !kept.includes(n)).join('\n');
    await client.run(
      `UPDATE card_list_items SET quantity_wanted = ?, notes = ? WHERE id = ?`,
      [Math.max(existing.quantity_wanted, want.quantity), (fresh ? (kept ? `${kept}\n${fresh}` : fresh) : kept).slice(0, NOTES_MAX), existing.id]
    );
    merged++;
  }
  await client.run(`UPDATE card_lists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [list.id]);
  return { list, added, merged, missing };
}

module.exports = { DEFAULT_WISHLIST_NAME, defaultList, ensureDefaultList, wantCards };
