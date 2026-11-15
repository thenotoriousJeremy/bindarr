// The collection's own wishlist, retired (WEB-03).
//
// A wanted card used to be kept two ways that never met: as a collection row
// with list_type 'wishlist' (a copy nobody owns), which the Collection > Cards >
// Wishlist tab, the public wishlist link, the set view's marker and price alerts
// read, and as an item on the Lists feature's default Wishlist, which the hearts
// on cards write. The default Wishlist is now the only one, and this moves the
// rows of the old kind onto it.
//
// Runs at every boot, from initDb (db/migrations.js), right after the card_lists
// tables exist. Once nothing is left to move it costs one indexed lookup per user.
// Like every initDb step it talks to the connection itself (db/connection.js),
// never through db.js, so a wrapper a test or device mode puts there does not
// see a boot's statements.
//
// It runs before initDb copies a pre-compartment collection across, so the
// wishlist rows of a database that old are moved one boot later.
//
// For every user with such rows, all users in ONE transaction:
//   - their default Wishlist is made if they have none (utils/defaultWishlist,
//     the helper /api/lists/default uses);
//   - each wanted card goes on it once. The rows of one card (a stacked row, or
//     the single copies splitStackedRows cut it into) add up to the quantity
//     wanted, and their notes come along; a card already on the list keeps the
//     larger quantity and its own notes, with the rows' notes added beneath;
//   - then those collection rows are deleted. They were never owned copies:
//     the collection's counts, value, decks and sets already left them out. The
//     one place they still showed was a container's fill, where a copy moved to
//     the wishlist from a slot kept holding it; that slot is free again.
// A row whose user or card no longer exists stays where it is, since the list's
// foreign keys would refuse it, and nothing reads it.
const db = require('../db/connection');
const { wantCards } = require('./defaultWishlist');

const CHUNK = 500;

async function migrateLegacyWishlists() {
  const columns = new Set((await db.all(`PRAGMA table_info(collection)`)).map(c => c.name));
  // A database from before list_type or user_id has no wishlist rows to move:
  // both columns arrive with the wishlist feature, filled with 'collection'.
  if (!columns.has('list_type') || !columns.has('user_id')) return { users: 0, cards: 0, rows: 0 };
  const notes = columns.has('notes') ? 'c.notes' : 'NULL';
  const addedAt = columns.has('added_at') ? 'c.added_at' : 'NULL';

  const movable = `
    FROM collection c JOIN card_cache cc ON cc.id = c.card_id
   WHERE c.user_id = u.id AND c.list_type = 'wishlist'`;
  const pending = await db.get(`SELECT 1 AS yes FROM users u WHERE EXISTS (SELECT 1 ${movable}) LIMIT 1`);
  if (!pending) return { users: 0, cards: 0, rows: 0 };

  const result = await db.withTransaction(async () => {
    // Read inside the transaction: nothing can change a row between reading it
    // and deleting it.
    const rows = await db.all(`
      SELECT u.id AS user_id, c.id, c.card_id, c.quantity, ${notes} AS notes, ${addedAt} AS added_at
        FROM users u JOIN collection c ON c.user_id = u.id JOIN card_cache cc ON cc.id = c.card_id
       WHERE c.list_type = 'wishlist'
       ORDER BY u.id, c.id`);
    const byUser = new Map();
    for (const row of rows) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(row);
    }
    let cards = 0;
    for (const [userId, own] of byUser) {
      const wanted = await wantCards(userId, own, db);
      cards += wanted.added + wanted.merged;
      const ids = own.map(r => r.id);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const part = ids.slice(i, i + CHUNK);
        await db.run(`DELETE FROM collection WHERE id IN (${part.map(() => '?').join(',')}) AND list_type = 'wishlist'`, part);
      }
    }
    return { users: byUser.size, cards, rows: rows.length };
  });
  console.log(`Wishlist: moved ${result.rows} wishlist row(s) of ${result.users} user(s) from the collection onto their Wishlist list (${result.cards} card(s)).`);
  return result;
}

module.exports = { migrateLegacyWishlists };
