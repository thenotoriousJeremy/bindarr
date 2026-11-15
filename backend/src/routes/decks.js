const express = require('express');
const db = require('../db');
const cardApi = require('../utils/cardApi');
const games = require('../utils/games');
const { parseCardRow, recordPrice } = require('../utils/priceHelpers');
const { validateDeckAddition, loadRules } = require('../utils/deckRules');
const {
  DeckAllocationError, deckAvailability, locationsFor, checkoutDeck, returnDeck, deleteDeck, syncDeckAllocation,
} = require('../utils/deckAllocation');
const scryfallApi = require('../scryfallApi');
const { parseManaboxText, parseDecklistLine } = require('../utils/csvMappers');

const router = express.Router();

// A deck card's copy count, or null. Whole numbers only, from 1: parseInt turned
// 2.5 into 2 and let 0 through as a row nobody could see, and removing a card is
// DELETE /:id/cards/:card_id, which is what the deck builder sends for zero.
const MAX_DECK_QUANTITY = 999;
function deckQuantity(raw) {
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  return Number.isInteger(n) && n >= 1 && n <= MAX_DECK_QUANTITY ? n : null;
}

// A pasted decklist as [card_id, quantity] pairs, in line order, from cached cards
// only: the printing a line names (set code and collector number, English first)
// when it is cached, else the first cached card of that name. Lines that match
// nothing are dropped, as they always were.
//
// One query per kind of lookup for the whole list, not one per line: matching a
// lower-cased name cannot use an index, so every line was a scan of card_cache —
// 8 ms a line at 20,000 cached cards.
async function resolveDecklistLines(text, game) {
  // The name without the set code, collector number and *F* marker an MTG Arena
  // or Moxfield line carries: with them it matched no card.
  const lines = text.split('\n').map(parseDecklistLine).filter(p => p && p.quantity > 0);
  // Lower-cased the way SQLite's LOWER() does it: ASCII letters only.
  const lower = (v) => String(v || '').replace(/[A-Z]/g, c => c.toLowerCase());
  const CHUNK = 300;
  const byPrinting = new Map();
  const printings = [...new Set(lines.filter(p => p.set_code && p.collector_number)
    .map(p => JSON.stringify([lower(p.set_code), String(p.collector_number)])))].map(k => JSON.parse(k));
  for (let i = 0; i < printings.length; i += CHUNK) {
    const part = printings.slice(i, i + CHUNK);
    const rows = await db.all(
      `SELECT id, LOWER(set_id) AS set_key, number FROM card_cache
        WHERE game = ? AND (LOWER(set_id), number) IN (VALUES ${part.map(() => '(?, ?)').join(', ')})
        ORDER BY language = 'English' DESC, rowid`,
      [game, ...part.flat()]
    );
    for (const r of rows) {
      const key = JSON.stringify([r.set_key, r.number]);
      if (!byPrinting.has(key)) byPrinting.set(key, r.id);
    }
  }
  const byName = new Map();
  const names = [...new Set(lines.map(p => lower(p.name)).filter(Boolean))];
  for (let i = 0; i < names.length; i += CHUNK) {
    const part = names.slice(i, i + CHUNK);
    const rows = await db.all(
      `SELECT id, LOWER(name) AS name_key FROM card_cache
        WHERE game = ? AND LOWER(name) IN (${part.map(() => '?').join(', ')})
        ORDER BY rowid`,
      [game, ...part]
    );
    for (const r of rows) if (!byName.has(r.name_key)) byName.set(r.name_key, r.id);
  }
  const out = [];
  for (const p of lines) {
    const printing = p.set_code && p.collector_number
      ? byPrinting.get(JSON.stringify([lower(p.set_code), String(p.collector_number)]))
      : null;
    const cardId = printing || byName.get(lower(p.name));
    if (cardId) out.push([cardId, p.quantity]);
  }
  return out;
}

// An allocation refusal carries its own status (and, for a short checkout, the
// cards missing); anything else is a genuine 500.
function sendAllocationError(res, error, fallback) {
  if (error instanceof DeckAllocationError) {
    return res.status(error.status).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
  }
  console.error(error);
  return res.status(500).json({ error: fallback });
}

// Get User Decks
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT
        d.id,
        d.name,
        d.description,
        d.game,
        d.format,
        d.category,
        d.accent_color,
        d.target_size,
        d.any_printing,
        d.created_at,
        d.checked_out,
        d.checked_out_at,
        COUNT(dc.card_id) as total_card_types,
        COALESCE(SUM(dc.quantity), 0) as total_cards
      FROM decks d
      LEFT JOIN deck_cards dc ON d.id = dc.deck_id
      WHERE d.user_id = ?
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `;
    const rows = await db.all(query, [req.user.id]);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve decks' });
  }
});

// Create Deck
router.post('/', async (req, res) => {
  const { 
    name, 
    description = '', 
    game = 'pokemon',
    format = 'Standard',
    category = 'Competitive',
    accent_color = '#eab308',
    target_size = 60,
    any_printing,
    decklist_text = '',
    decklist_format = 'plain'
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Deck name is required', code: 'deck_name_required' });
  }
  // A game the registry does not know is refused; it used to become a Pokémon deck.
  const deckGame = games.parseGame(game);
  if (!deckGame || !games.hasFeature(deckGame, 'decks')) {
    return res.status(400).json({ error: 'Invalid game' });
  }
  const targetSizeNum = parseInt(target_size, 10) || 60;

  try {
    // Unset means the game's default: on for Magic and Lorcana, never for Pokémon,
    // whose printings are not interchangeable.
    const rules = await loadRules();
    const anyPrinting = rules.supportsAnyPrinting(deckGame)
      && (any_printing === undefined ? rules.defaultAnyPrinting(deckGame) : !!any_printing);

    // Optional decklist import, resolved to [card_id, quantity] pairs BEFORE
    // anything is written: the deck used to be inserted first and the cards looked
    // up after, so a Scryfall failure left half a deck, and the retry made another.
    let deckCards = [];
    if (decklist_text && typeof decklist_text === 'string') {
      if (decklist_format === 'manabox' && deckGame === 'mtg') {
        // ManaBox identifies a printing by set and collector number, so resolve
        // those identifiers in batches instead of guessing from a card name shared
        // by many printings.
        const items = parseManaboxText(decklist_text);
        const { cards, pairs } = await scryfallApi.bulkFetchByIdentifier(items.map(item => ({
          ...item,
          set_id: item.set_code,
          number: item.collector_number
        })));
        await scryfallApi.cacheCards(cards);
        deckCards = pairs.map(({ row, card }) => [card.id, row.quantity]);
      } else {
        deckCards = await resolveDecklistLines(decklist_text, deckGame);
      }
    }

    // The deck and its cards together, or neither.
    const newDeckId = await db.withTransaction(async () => {
      const result = await db.run(
        `INSERT INTO decks (name, description, game, format, category, accent_color, target_size, any_printing, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, description, deckGame, format, category, accent_color, targetSizeNum, anyPrinting ? 1 : 0, req.user.id]
      );
      for (const [cardId, quantity] of deckCards) {
        await db.run(
          `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = quantity + EXCLUDED.quantity`,
          [result.lastID, cardId, quantity]
        );
      }
      return result.lastID;
    });

    res.status(201).json({ message: 'Deck created successfully', id: newDeckId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create deck' });
  }
});

// Get Deck Details (with Cards)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const deck = await db.get(`SELECT * FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found' });
    }

    // The card text the deck rules read comes along (shared/deckRules.mjs runs in
    // the deck builder too); ownership comes from the allocation plan, one pass over
    // the collection for the whole deck.
    const cards = await db.all(`
      SELECT
        dc.quantity,
        dc.is_commander,
        cc.id,
        cc.name, cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.cmc,
        cc.color_identity,
        cc.oracle_id,
        cc.oracle_text,
        cc.game,
        cc.orientation
      FROM deck_cards dc
      JOIN card_cache cc ON dc.card_id = cc.id
      WHERE dc.deck_id = ?
    `, [id]);
    const availability = await deckAvailability(deck, req.user.id);

    res.json({
      ...deck,
      cards: cards.map(row => {
        const p = availability.get(row.id);
        return {
          ...parseCardRow(row),
          // Copies of this card (any printing, when the deck accepts it) owned, and
          // how many of those other checked-out decks hold.
          owned_qty: p ? p.owned : 0,
          locked_qty: p ? p.locked : 0,
          locked_decks: p && p.lockedBy.size ? [...p.lockedBy].join(', ') : null,
          // How many copies the deck has to play with — what it holds when checked
          // out, what a checkout would take otherwise — and how many it lacks.
          allocated_qty: p ? row.quantity - p.need : 0,
          missing_qty: p ? p.need : row.quantity,
        };
      })
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve deck details' });
  }
});

// Get physical locations for cards in a deck
router.get('/:id/locations', async (req, res) => {
  const { id } = req.params;
  try {
    const deck = await db.get(`SELECT * FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });

    // A checked-out deck's pull list is the copies it actually holds; any other
    // deck's is what checking it out would take. Copies another checked-out deck
    // holds are never offered — they are not in storage to be pulled.
    res.json(locationsFor(await deckAvailability(deck, req.user.id)));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve card locations' });
  }
});

// Update Deck Metadata
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description = '', format, category, accent_color, target_size, any_printing } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Deck name is required', code: 'deck_name_required' });
  }
  const targetSize = target_size === undefined ? null : parseInt(target_size, 10);
  if (target_size !== undefined && (!Number.isInteger(targetSize) || targetSize < 1 || targetSize > 300)) {
    return res.status(400).json({ error: 'target_size must be between 1 and 300' });
  }

  try {
    const deck = await db.get(`SELECT id, game, checked_out, any_printing FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }
    const rules = await loadRules();
    const anyPrinting = any_printing === undefined
      ? null
      : (rules.supportsAnyPrinting(deck.game || 'pokemon') && !!any_printing ? 1 : 0);

    await db.run(
      `UPDATE decks
       SET name = ?, description = ?, format = COALESCE(?, format), category = COALESCE(?, category),
           accent_color = COALESCE(?, accent_color), target_size = COALESCE(?, target_size),
           any_printing = COALESCE(?, any_printing)
       WHERE id = ? AND user_id = ?`,
      [String(name).trim(), description, format, category, accent_color, targetSize, anyPrinting, id, req.user.id]
    );

    // Out on the table, a deck that stops accepting other printings gives those
    // copies back (and one that starts may pick some up).
    if (deck.checked_out && anyPrinting !== null && anyPrinting !== deck.any_printing) {
      await syncDeckAllocation(deck.id, req.user.id);
    }

    res.json({ message: 'Deck updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update deck' });
  }
});

// Delete Deck
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Ownership is checked inside, and the cascade (cards, held copies) is manual.
    await deleteDeck(id, req.user.id);
    res.json({ message: 'Deck deleted successfully' });
  } catch (error) {
    sendAllocationError(res, error, 'Failed to delete deck');
  }
});

// Add/Update Card in Deck
router.post('/:id/cards', async (req, res) => {
  const { id } = req.params;
  const { card_id } = req.body;
  const quantity = deckQuantity(req.body.quantity === undefined ? 1 : req.body.quantity);

  if (!card_id) {
    return res.status(400).json({ error: 'card_id is required' });
  }
  if (quantity === null) {
    return res.status(400).json({ error: `quantity must be a whole number from 1 to ${MAX_DECK_QUANTITY}` });
  }
  if (typeof card_id !== 'string') {
    return res.status(400).json({ error: 'card_id must be a string' });
  }

  try {
    // Verify deck ownership
    const deck = await db.get(`SELECT id, checked_out FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    // Ensure card metadata exists in cache. Dispatch on the ID, because only the
    // provider that minted it can resolve it: this asked pokemontcg.io for every
    // uncached card, and tcgApi.getCardById short-circuits on 'mtg-' and
    // 'tcgdex-' ids to whatever is cached — so an uncached MTG or non-English
    // Pokémon card came back null and the deck refused it as "not found on the
    // Pokémon TCG API", for a card that exists on a provider it never asked.
    let card = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      console.log(`Card ${card_id} not in cache. Fetching...`);
      const apiCard = await cardApi.getCardById(card_id, { tcgApiKey: req.user.tcg_api_key });
      if (!apiCard) {
        return res.status(404).json({ error: `Card ${card_id} not found on any card provider.` });
      }
    }

    // Enforce deck rules (owned-copy cap + the format's copy limit per name).
    // quantity here is the absolute new count for this card, so validate it directly.
    const check = await validateDeckAddition({ deckId: id, userId: req.user.id, cardId: card_id, newQty: quantity });
    if (!check.ok) return res.status(400).json({ error: check.error });

    // Insert or update quantities
    await db.run(`
      INSERT INTO deck_cards (deck_id, card_id, quantity)
      VALUES (?, ?, ?)
      ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = ?
    `, [id, card_id, quantity, quantity]);
    if (deck.checked_out) await syncDeckAllocation(deck.id, req.user.id);

    // Record initial price history trend if card is added
    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [card_id]);
    if (cacheCard) await recordPrice(card_id, cacheCard.price_trend);

    res.json({ message: 'Card added/updated in deck successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add card to deck' });
  }
});

// Remove Card from Deck
router.delete('/:id/cards/:card_id', async (req, res) => {
  const { id, card_id } = req.params;
  try {
    // Verify deck ownership
    const deck = await db.get(`SELECT id, checked_out FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    await db.run(`DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [id, card_id]);
    if (deck.checked_out) await syncDeckAllocation(deck.id, req.user.id);
    res.json({ message: 'Card removed from deck successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card from deck' });
  }
});

// Mark a card as (one of) the deck's commander(s), or unmark it. Whether the
// command zone is legal — how many, which pairs, colour identity — is a warning in
// the deck builder, not a refusal here: a zone is built one card at a time.
router.put('/:id/cards/:card_id/commander', async (req, res) => {
  const { id, card_id } = req.params;
  try {
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }
    const result = await db.run(
      `UPDATE deck_cards SET is_commander = ? WHERE deck_id = ? AND card_id = ?`,
      [req.body && req.body.commander ? 1 : 0, id, card_id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Card is not in this deck' });
    }
    res.json({ message: 'Commander updated' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update commander' });
  }
});

// Checkout Deck (mark as in play). Claims the exact copies the deck takes, all or
// none: a shortfall is a 400 naming each missing card, and copies claimed by a
// concurrent checkout are a 409 — never two decks holding one card.
router.put('/:id/checkout', async (req, res) => {
  try {
    await checkoutDeck(req.params.id, req.user.id);
    res.json({ message: 'Deck checked out successfully' });
  } catch (error) {
    sendAllocationError(res, error, 'Failed to checkout deck');
  }
});

// Return Deck (mark as returned to storage), releasing the copies it held.
router.put('/:id/return', async (req, res) => {
  try {
    await returnDeck(req.params.id, req.user.id);
    res.json({ message: 'Deck returned to storage successfully' });
  } catch (error) {
    sendAllocationError(res, error, 'Failed to return deck');
  }
});

module.exports = router;
