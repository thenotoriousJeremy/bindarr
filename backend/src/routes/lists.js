const express = require('express');
const db = require('../db');
const cardApi = require('../utils/cardApi');
const { parseCardRow } = require('../utils/priceHelpers');
const {
  LIST_KINDS, CONDITIONS, parseQuantity, evaluateItems, summarize, sameCard,
} = require('../utils/listOwnership');

// Named card lists (wishlists, buylists, missing lists) and the deck/collection
// actions that feed them. Mounted at /api, so every path is spelled in full —
// the same convention as routes/collection.js. Every query is scoped to
// req.user.id; a list id belonging to someone else is a 404, never a 403, so
// ids cannot be probed.
const router = express.Router();

// The games a list can be scoped to: whatever the backend already enumerates.
// Lazy so loading this module does not pull in the scan stack. The game
// registry replaces catalog.GAMES; this is the one line that has to follow it.
const knownGames = () => require('../catalog').GAMES;

const NAME_MAX = 120;
const NOTES_MAX = 2000;

const cleanText = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// What a list body may say, validated in one place for create and update.
// Returns { error } or { values } holding only the fields that were sent.
function listFields(body, { creating }) {
  const values = {};
  if (creating || body.name !== undefined) {
    const name = cleanText(body.name, NAME_MAX);
    if (!name) return { error: 'List name is required' };
    values.name = name;
  }
  if (body.kind !== undefined || creating) {
    const kind = body.kind === undefined ? 'wishlist' : body.kind;
    if (!LIST_KINDS.includes(kind)) return { error: `kind must be one of: ${LIST_KINDS.join(', ')}` };
    values.kind = kind;
  }
  if (body.game !== undefined) {
    const game = body.game === null || body.game === '' || body.game === 'any' ? null : body.game;
    if (game !== null && !knownGames().includes(game)) return { error: 'Invalid game' };
    values.game = game;
  }
  if (body.notes !== undefined) values.notes = cleanText(body.notes, NOTES_MAX);
  return { values };
}

// Item fields shared by add and edit. `any_printing`, `condition_min` and
// `language` decide which owned copies count, so they are checked, not trusted.
function itemFields(body) {
  const values = {};
  if (body.any_printing !== undefined) values.any_printing = body.any_printing ? 1 : 0;
  if (body.condition_min !== undefined) {
    const c = body.condition_min || null;
    if (c !== null && !CONDITIONS.includes(c)) return { error: 'Invalid condition_min' };
    values.condition_min = c;
  }
  if (body.language !== undefined) {
    values.language = body.language ? require('../utils/languages').toName(body.language) : null;
  }
  if (body.notes !== undefined) values.notes = cleanText(body.notes, NOTES_MAX);
  return { values };
}

const ownList = (listId, userId) =>
  db.get(`SELECT * FROM card_lists WHERE id = ? AND user_id = ?`, [listId, userId]);

// Whether card_cache has oracle_id yet (the deck-formats slice adds it). Asked
// once; selected only when present so the any-printing matcher can use it.
let oracleColumn = null;
async function hasOracleId() {
  if (oracleColumn === null) {
    const cols = await db.all(`PRAGMA table_info(card_cache)`);
    oracleColumn = cols.some(c => c.name === 'oracle_id');
  }
  return oracleColumn;
}

// The user's owned copies that could count toward `items`, grouped per
// (card, condition, language). A pre-filter only — exact ids plus names of the
// any-printing wants — and listOwnership.evaluateItems makes the decision.
async function ownedRows(userId, items) {
  if (items.length === 0) return [];
  const ids = [...new Set(items.map(i => i.card_id))];
  const names = [...new Set(items.filter(i => i.any_printing && i.card)
    .flatMap(i => [i.card.name, i.card.printed_name]).filter(Boolean).map(n => String(n).trim().toLowerCase()))];
  const oracle = (await hasOracleId()) ? ', cc.oracle_id' : '';
  return db.all(
    `SELECT c.card_id, c.condition, c.language, SUM(c.quantity) AS qty,
            cc.name, cc.printed_name, cc.game${oracle}
       FROM collection c JOIN card_cache cc ON cc.id = c.card_id
      WHERE c.user_id = ? AND c.list_type = 'collection'
        AND (c.card_id IN (SELECT value FROM json_each(?))
             OR lower(trim(cc.name)) IN (SELECT value FROM json_each(?))
             OR lower(trim(cc.printed_name)) IN (SELECT value FROM json_each(?)))
      GROUP BY c.card_id, c.condition, c.language`,
    [userId, JSON.stringify(ids), JSON.stringify(names), JSON.stringify(names)]
  );
}

// Items of the given lists with their card rows attached and owned/missing worked out.
async function evaluatedItems(userId, listIds) {
  if (listIds.length === 0) return [];
  const oracle = (await hasOracleId()) ? ', cc.oracle_id' : '';
  const rows = await db.all(
    `SELECT i.*, cc.name, cc.printed_name, cc.supertype, cc.subtypes, cc.types, cc.rarity,
            cc.set_id, cc.set_name, cc.number, cc.image_url, cc.price_trend, cc.price_currency,
            cc.game AS card_game, cc.language AS card_language, cc.tcgplayer_product_id${oracle}
       FROM card_list_items i JOIN card_cache cc ON cc.id = i.card_id
      WHERE i.list_id IN (SELECT value FROM json_each(?))
      ORDER BY cc.name COLLATE NOCASE, i.id`,
    [JSON.stringify(listIds)]
  );
  const items = rows.map(r => ({
    id: r.id, list_id: r.list_id, card_id: r.card_id, quantity_wanted: r.quantity_wanted,
    any_printing: r.any_printing, condition_min: r.condition_min, language: r.language,
    notes: r.notes, added_at: r.added_at,
    card: parseCardRow({
      id: r.card_id, name: r.name, printed_name: r.printed_name, supertype: r.supertype,
      subtypes: r.subtypes, types: r.types, rarity: r.rarity, set_id: r.set_id, set_name: r.set_name,
      number: r.number, image_url: r.image_url, price_trend: r.price_trend, price_currency: r.price_currency,
      game: r.card_game, language: r.card_language, tcgplayer_product_id: r.tcgplayer_product_id,
      ...(oracle ? { oracle_id: r.oracle_id } : {}),
      color_identity: null,
    }),
  }));
  return evaluateItems(items, await ownedRows(userId, items));
}

// Fetch the card into card_cache if this install has never seen it. Same
// dispatch every add uses: only the provider that minted the id can resolve it.
async function ensureCard(cardId, user) {
  let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
  if (!card) {
    await cardApi.getCardById(cardId, { tcgApiKey: user.tcg_api_key }).catch(() => null);
    card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
  }
  return card;
}

const touch = (listId) => db.run(`UPDATE card_lists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [listId]);

// --- Lists ---

router.get('/lists', async (req, res) => {
  try {
    const lists = await db.all(
      `SELECT * FROM card_lists WHERE user_id = ? ORDER BY updated_at DESC, id DESC`, [req.user.id]
    );
    const items = await evaluatedItems(req.user.id, lists.map(l => l.id));
    res.json(lists.map(l => ({ ...l, summary: summarize(items.filter(i => i.list_id === l.id)) })));
  } catch (error) {
    console.error('lists: load failed', error);
    res.status(500).json({ error: 'Failed to load lists' });
  }
});

router.post('/lists', async (req, res) => {
  const { error, values } = listFields(req.body || {}, { creating: true });
  if (error) return res.status(400).json({ error });
  try {
    const result = await db.run(
      `INSERT INTO card_lists (user_id, name, kind, game, notes) VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, values.name, values.kind, values.game ?? null, values.notes ?? '']
    );
    res.status(201).json(await ownList(result.lastID, req.user.id));
  } catch (err) {
    console.error('lists: create failed', err);
    res.status(500).json({ error: 'Failed to create list' });
  }
});

router.get('/lists/:id', async (req, res) => {
  try {
    const list = await ownList(req.params.id, req.user.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const items = await evaluatedItems(req.user.id, [list.id]);
    res.json({ ...list, items, summary: summarize(items) });
  } catch (error) {
    console.error('lists: detail failed', error);
    res.status(500).json({ error: 'Failed to load list' });
  }
});

router.put('/lists/:id', async (req, res) => {
  const { error, values } = listFields(req.body || {}, { creating: false });
  if (error) return res.status(400).json({ error });
  try {
    const list = await ownList(req.params.id, req.user.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    // Narrowing a list to one game must not strand cards of another on it.
    if (values.game) {
      const other = await db.get(
        `SELECT cc.name FROM card_list_items i JOIN card_cache cc ON cc.id = i.card_id
          WHERE i.list_id = ? AND COALESCE(cc.game, 'pokemon') != ? LIMIT 1`, [list.id, values.game]
      );
      if (other) return res.status(400).json({ error: `${other.name} on this list is from another game.` });
    }
    const cols = Object.keys(values);
    if (cols.length) {
      await db.run(
        `UPDATE card_lists SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?`,
        [...cols.map(c => values[c]), list.id, req.user.id]
      );
    }
    res.json(await ownList(list.id, req.user.id));
  } catch (err) {
    console.error('lists: update failed', err);
    res.status(500).json({ error: 'Failed to update list' });
  }
});

router.delete('/lists/:id', async (req, res) => {
  try {
    const result = await db.run(`DELETE FROM card_lists WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'List not found' });
    res.json({ message: 'List deleted' });
  } catch (error) {
    console.error('lists: delete failed', error);
    res.status(500).json({ error: 'Failed to delete list' });
  }
});

// --- Items ---

// Add a card. A card already on the list merges: the quantities add up, capped
// at the 9999 ceiling, so "add to list" twice means two copies wanted.
router.post('/lists/:id/items', async (req, res) => {
  const body = req.body || {};
  const cardId = typeof body.card_id === 'string' ? body.card_id.trim() : '';
  if (!cardId) return res.status(400).json({ error: 'card_id is required' });
  const qty = body.quantity_wanted === undefined ? 1 : parseQuantity(body.quantity_wanted);
  if (qty === null) return res.status(400).json({ error: 'quantity_wanted must be a whole number from 1 to 9999' });
  const { error, values } = itemFields(body);
  if (error) return res.status(400).json({ error });
  try {
    const list = await ownList(req.params.id, req.user.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const card = await ensureCard(cardId, req.user);
    if (!card) return res.status(404).json({ error: `Card ${cardId} not found on any card provider.` });
    const cardGame = card.game || cardApi.gameOf(card.id);
    if (list.game && cardGame !== list.game) {
      return res.status(400).json({ error: `This list only takes ${list.game} cards.` });
    }
    await db.run(
      `INSERT INTO card_list_items (list_id, card_id, quantity_wanted, any_printing, condition_min, language, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(list_id, card_id) DO UPDATE SET
         quantity_wanted = MIN(9999, quantity_wanted + excluded.quantity_wanted),
         any_printing = COALESCE(?, any_printing),
         condition_min = CASE WHEN ? THEN excluded.condition_min ELSE condition_min END,
         language = CASE WHEN ? THEN excluded.language ELSE language END,
         notes = CASE WHEN ? THEN excluded.notes ELSE notes END`,
      [list.id, cardId, qty, values.any_printing ?? 0, values.condition_min ?? null, values.language ?? null, values.notes ?? '',
        values.any_printing ?? null, 'condition_min' in values ? 1 : 0, 'language' in values ? 1 : 0, 'notes' in values ? 1 : 0]
    );
    await touch(list.id);
    const item = await db.get(`SELECT * FROM card_list_items WHERE list_id = ? AND card_id = ?`, [list.id, cardId]);
    res.status(201).json(item);
  } catch (err) {
    console.error('lists: add item failed', err);
    res.status(500).json({ error: 'Failed to add card to list' });
  }
});

// Edit an item. quantity_wanted is absolute here (the number in the field).
router.put('/lists/:id/items/:itemId', async (req, res) => {
  const body = req.body || {};
  const { error, values } = itemFields(body);
  if (error) return res.status(400).json({ error });
  if (body.quantity_wanted !== undefined) {
    const qty = parseQuantity(body.quantity_wanted);
    if (qty === null) return res.status(400).json({ error: 'quantity_wanted must be a whole number from 1 to 9999' });
    values.quantity_wanted = qty;
  }
  try {
    const list = await ownList(req.params.id, req.user.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const cols = Object.keys(values);
    if (cols.length) {
      const result = await db.run(
        `UPDATE card_list_items SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND list_id = ?`,
        [...cols.map(c => values[c]), req.params.itemId, list.id]
      );
      if (result.changes === 0) return res.status(404).json({ error: 'Item not found' });
      await touch(list.id);
    }
    const item = await db.get(`SELECT * FROM card_list_items WHERE id = ? AND list_id = ?`, [req.params.itemId, list.id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    console.error('lists: edit item failed', err);
    res.status(500).json({ error: 'Failed to update list item' });
  }
});

router.delete('/lists/:id/items/:itemId', async (req, res) => {
  try {
    const list = await ownList(req.params.id, req.user.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const result = await db.run(`DELETE FROM card_list_items WHERE id = ? AND list_id = ?`, [req.params.itemId, list.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Item not found' });
    await touch(list.id);
    res.json({ message: 'Card removed from list' });
  } catch (error) {
    console.error('lists: remove item failed', error);
    res.status(500).json({ error: 'Failed to remove card from list' });
  }
});

// --- Deck actions ---

// The copies a deck needs that the collection does not hold, counted the way
// the deck view counts them (GET /decks/:id owned_qty: exact printing,
// list_type 'collection'). decks.js keeps that inline in its SQL, so it is
// restated here rather than reached into.
async function deckShortfall(deckId, userId) {
  return db.all(
    `SELECT dc.card_id, dc.quantity AS required,
            (SELECT COALESCE(SUM(c.quantity), 0) FROM collection c
              WHERE c.card_id = dc.card_id AND c.user_id = ? AND c.list_type = 'collection') AS owned
       FROM deck_cards dc WHERE dc.deck_id = ?`,
    [userId, deckId]
  );
}

const ownDeck = (deckId, userId) =>
  db.get(`SELECT * FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);

// Create, or bring up to date, the deck's "missing" list: one item per card the
// deck needs more of, wanting exactly the shortfall. Rebuilding replaces the
// items, so a card bought since drops off instead of lingering.
router.post('/decks/:id/missing-list', async (req, res) => {
  try {
    const deck = await ownDeck(req.params.id, req.user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    const short = (await deckShortfall(deck.id, req.user.id))
      .map(r => ({ card_id: r.card_id, missing: Math.min(9999, r.required - r.owned) }))
      .filter(r => r.missing > 0);

    let listId;
    let created = false;
    await db.withTransaction(async () => {
      const existing = await db.get(
        `SELECT id FROM card_lists WHERE user_id = ? AND deck_id = ? AND kind = 'missing' ORDER BY id LIMIT 1`,
        [req.user.id, deck.id]
      );
      if (existing) {
        listId = existing.id;
        await db.run(`UPDATE card_lists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [listId]);
        await db.run(`DELETE FROM card_list_items WHERE list_id = ?`, [listId]);
      } else {
        const result = await db.run(
          `INSERT INTO card_lists (user_id, name, kind, game, notes, deck_id) VALUES (?, ?, 'missing', ?, '', ?)`,
          [req.user.id, cleanText(`${deck.name} — missing`, NAME_MAX), deck.game || null, deck.id]
        );
        listId = result.lastID;
        created = true;
      }
      for (const row of short) {
        await db.run(
          `INSERT INTO card_list_items (list_id, card_id, quantity_wanted) VALUES (?, ?, ?)`,
          [listId, row.card_id, row.missing]
        );
      }
    });
    res.status(created ? 201 : 200).json({
      list_id: listId, created, cards: short.length, copies: short.reduce((s, r) => s + r.missing, 0),
    });
  } catch (error) {
    console.error('lists: deck missing-list failed', error);
    res.status(500).json({ error: 'Failed to build the missing list' });
  }
});

// "I bought this precon": every card in the deck into the collection, through
// the same add path and validation as POST /collection, in ONE transaction —
// all of it lands or none of it does.
//
// The provider half of that path (collection.resolveCardForAdd: hydrate, fetch,
// localize, learn the English name) runs first, outside the transaction: a write
// transaction must not wait on the network. Its results are handed to the add.
router.post('/decks/:id/add-to-collection', async (req, res) => {
  const body = req.body || {};
  const locationId = body.location_id == null || body.location_id === '' ? null : Number(body.location_id);
  if (locationId !== null && !(Number.isInteger(locationId) && locationId > 0)) {
    return res.status(400).json({ error: 'Invalid location ID' });
  }
  try {
    const deck = await ownDeck(req.params.id, req.user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    if (locationId !== null && !(await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]))) {
      return res.status(400).json({ error: 'Invalid location ID' });
    }
    const cards = await db.all(
      `SELECT dc.card_id, dc.quantity, cc.language, cc.game
         FROM deck_cards dc JOIN card_cache cc ON cc.id = dc.card_id
        WHERE dc.deck_id = ? ORDER BY cc.name COLLATE NOCASE`, [deck.id]
    );
    if (cards.length === 0) return res.status(400).json({ error: 'This deck has no cards.' });

    const collection = require('./collection');
    const resolved = new Map();
    for (const c of cards) {
      const body = { card_id: c.card_id, game: c.game || cardApi.gameOf(c.card_id), language: c.language || 'English' };
      resolved.set(c.card_id, await collection.resolveCardForAdd(req.user, body));
    }

    const unplaced = [];
    let copies = 0;
    await db.withTransaction(async () => {
      for (const c of cards) {
        const result = await collection.addCardToCollection(req.user, {
          card_id: c.card_id,
          quantity: c.quantity,
          language: c.language || 'English',
          game: c.game || cardApi.gameOf(c.card_id),
          location_id: locationId,
        }, { resolvedCard: resolved.get(c.card_id) });
        copies += result.ids.length;
        if (result.container_full || result.rule_rejected) unplaced.push(c.card_id);
      }
    });
    res.json({
      message: `Added ${copies} card${copies === 1 ? '' : 's'} from ${deck.name} to your collection.`,
      cards: cards.length,
      copies,
      // Cards a full or rule-restricted container could not take; they were
      // added to the unassigned pile instead, the same as a single add.
      unplaced: unplaced.length,
    });
  } catch (error) {
    const collection = require('./collection');
    if (error instanceof collection.AddCardError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('lists: deck add-to-collection failed', error);
    res.status(500).json({ error: 'Failed to add the deck to your collection' });
  }
});

// --- Card actions ---

// Which of the user's decks hold this card: the exact printing, or another
// printing of the same card (same game, same name — listOwnership.sameCard).
router.get('/cards/:id/decks', async (req, res) => {
  try {
    const card = await db.get(`SELECT id, name, printed_name, game FROM card_cache WHERE id = ?`, [req.params.id]);
    if (!card) return res.json([]);
    const game = card.game || cardApi.gameOf(card.id);
    const names = [card.name, card.printed_name].filter(Boolean).map(n => String(n).trim().toLowerCase());
    const rows = await db.all(
      `SELECT d.id AS deck_id, d.name AS deck_name, d.game AS deck_game, d.checked_out,
              dc.card_id, dc.quantity, cc.name, cc.printed_name, cc.game
         FROM deck_cards dc
         JOIN decks d ON d.id = dc.deck_id
         JOIN card_cache cc ON cc.id = dc.card_id
        WHERE d.user_id = ?
          AND (dc.card_id = ?
               OR lower(trim(cc.name)) IN (SELECT value FROM json_each(?))
               OR lower(trim(cc.printed_name)) IN (SELECT value FROM json_each(?)))`,
      [req.user.id, card.id, JSON.stringify(names), JSON.stringify(names)]
    );
    const decks = new Map();
    for (const r of rows) {
      const exact = r.card_id === card.id;
      if (!exact && !sameCard({ ...card, game }, r)) continue;
      if (!decks.has(r.deck_id)) {
        decks.set(r.deck_id, { deck_id: r.deck_id, name: r.deck_name, game: r.deck_game, checked_out: r.checked_out, exact_qty: 0, other_printings_qty: 0 });
      }
      decks.get(r.deck_id)[exact ? 'exact_qty' : 'other_printings_qty'] += r.quantity;
    }
    res.json([...decks.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (error) {
    console.error('lists: used-in-decks failed', error);
    res.status(500).json({ error: 'Failed to load decks for this card' });
  }
});

module.exports = router;
