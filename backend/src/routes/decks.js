const express = require('express');
const db = require('../db');
const tcgApi = require('../tcgApi');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

// Get User Decks
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT
        d.id,
        d.name,
        d.description,
        d.game,
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
  const { name, description = '', game = 'pokemon' } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Deck name is required' });
  }
  const deckGame = ['pokemon', 'mtg'].includes(game) ? game : 'pokemon';

  try {
    const result = await db.run(
      `INSERT INTO decks (name, description, game, user_id) VALUES (?, ?, ?, ?)`,
      [name, description, deckGame, req.user.id]
    );
    res.status(201).json({ message: 'Deck created successfully', id: result.lastID });
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

    const cardsQuery = `
      SELECT
        dc.quantity,
        cc.id,
        cc.name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        (SELECT COALESCE(SUM(quantity), 0) FROM collection WHERE card_id = cc.id AND user_id = ? AND list_type = 'collection') AS owned_qty
      FROM deck_cards dc
      JOIN card_cache cc ON dc.card_id = cc.id
      WHERE dc.deck_id = ?
    `;
    const cards = await db.all(cardsQuery, [req.user.id, id]);

    const formatted = cards.map(c => ({
      ...c,
      subtypes: JSON.parse(c.subtypes || '[]'),
      types: JSON.parse(c.types || '[]')
    }));

    res.json({
      ...deck,
      cards: formatted
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
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });

    // Find how many of each card are in the deck
    const requiredCards = await db.all(`SELECT card_id, quantity FROM deck_cards WHERE deck_id = ?`, [id]);
    const requiredMap = new Map(requiredCards.map(r => [r.card_id, r.quantity]));

    // Find all owned instances of those cards
    const query = `
      SELECT 
        c.id as entry_id, c.card_id, c.quantity as owned_qty, c.position, c.location_id, c.compartment_id,
        cc.name as card_name, cc.set_name, cc.number,
        l.name as location_name, l.type as location_type,
        cp.label as compartment_label, cp.idx as compartment_idx
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      WHERE c.user_id = ? AND c.list_type = 'collection' AND c.card_id IN (SELECT card_id FROM deck_cards WHERE deck_id = ?)
      ORDER BY (c.location_id IS NOT NULL) DESC, cc.name ASC, c.added_at DESC
    `;
    const instances = await db.all(query, [req.user.id, id]);
    
    // Group them and figure out what to tell the user
    // We only need to tell them where to find \`required\` amount.
    const results = [];
    for (const [cardId, requiredQty] of requiredMap.entries()) {
      let needed = requiredQty;
      const cardInstances = instances.filter(i => i.card_id === cardId);
      
      const foundLocations = [];
      for (const inst of cardInstances) {
        if (needed <= 0) break;
        const take = Math.min(inst.owned_qty, needed);
        needed -= take;
        
        const isBinder = inst.location_type === 'Binder' || inst.location_type === 'Toploader Binder';
        let compDisplay = inst.compartment_label;
        if (!compDisplay && inst.compartment_idx !== null) {
          compDisplay = isBinder ? `Page ${inst.compartment_idx}` : `Row ${inst.compartment_idx}`;
        }

        foundLocations.push({
          take,
          card_name: inst.card_name,
          set_name: inst.set_name,
          number: inst.number,
          location_name: inst.location_name || 'Unassigned Pile',
          location_type: inst.location_type,
          compartment_display: compDisplay,
          position: inst.location_name ? inst.position : null,
          location_id: inst.location_id,
          compartment_id: inst.compartment_id,
          entry_id: inst.entry_id
        });
      }
      
      results.push({
        card_id: cardId,
        required: requiredQty,
        found: requiredQty - needed,
        missing: needed,
        locations: foundLocations
      });
    }

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve card locations' });
  }
});

// Update Deck Metadata
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Deck name is required' });
  }

  try {
    const result = await db.run(
      `UPDATE decks SET name = ?, description = ? WHERE id = ? AND user_id = ?`,
      [name, description || '', id, req.user.id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
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
    // Verify ownership
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    // Manual cascade deletion
    await db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [id]);
    await db.run(`DELETE FROM decks WHERE id = ?`, [id]);

    res.json({ message: 'Deck deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete deck' });
  }
});

// Add/Update Card in Deck
router.post('/:id/cards', async (req, res) => {
  const { id } = req.params;
  const { card_id, quantity = 1 } = req.body;

  if (!card_id) {
    return res.status(400).json({ error: 'card_id is required' });
  }

  try {
    // Verify deck ownership
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    // Ensure card metadata exists in cache
    let card = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      console.log(`Card ${card_id} not in cache. Fetching...`);
      const apiCard = await tcgApi.getCardById(card_id, req.user.tcg_api_key);
      if (!apiCard) {
        return res.status(404).json({ error: 'Card not found on Pokémon TCG API.' });
      }
    }

    // Insert or update quantities
    await db.run(`
      INSERT INTO deck_cards (deck_id, card_id, quantity)
      VALUES (?, ?, ?)
      ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = ?
    `, [id, card_id, parseInt(quantity, 10), parseInt(quantity, 10)]);

    // Record initial price history trend if card is added
    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [card_id]);
    if (cacheCard && cacheCard.price_trend > 0) {
      await db.run(`INSERT OR IGNORE INTO price_history (card_id, price) VALUES (?, ?)`, [card_id, cacheCard.price_trend]);
    }

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
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    await db.run(`DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [id, card_id]);
    res.json({ message: 'Card removed from deck successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card from deck' });
  }
});

// Checkout Deck (mark as in play)
router.put('/:id/checkout', async (req, res) => {
  const { id } = req.params;
  try {
    const deck = await db.get(`SELECT id, name FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    // Validate that we have enough cards physically available
    const validationQuery = `
      SELECT 
        dc.card_id, 
        cc.name, 
        dc.quantity AS required_qty,
        (SELECT COALESCE(SUM(quantity), 0) FROM collection WHERE card_id = dc.card_id AND user_id = ? AND list_type = 'collection') AS owned_qty,
        (SELECT COALESCE(SUM(dc2.quantity), 0) FROM deck_cards dc2 JOIN decks d2 ON dc2.deck_id = d2.id WHERE d2.checked_out = 1 AND d2.user_id = ? AND d2.id != ? AND dc2.card_id = dc.card_id) AS locked_qty
      FROM deck_cards dc
      JOIN card_cache cc ON dc.card_id = cc.id
      WHERE dc.deck_id = ?
    `;
    const cards = await db.all(validationQuery, [req.user.id, req.user.id, id, id]);
    
    let errors = [];
    for (const card of cards) {
      const available = card.owned_qty - card.locked_qty;
      if (card.required_qty > available) {
        const deficit = card.required_qty - available;
        errors.push(`Missing ${deficit}x ${card.name} (Owned: ${card.owned_qty}, In Use: ${card.locked_qty})`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Not enough cards available to check out this deck.', details: errors });
    }

    await db.run(
      `UPDATE decks SET checked_out = 1, checked_out_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );
    res.json({ message: 'Deck checked out successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to checkout deck' });
  }
});

// Return Deck (mark as returned to storage)
router.put('/:id/return', async (req, res) => {
  const { id } = req.params;
  try {
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }
    await db.run(
      `UPDATE decks SET checked_out = 0, checked_out_at = NULL WHERE id = ?`,
      [id]
    );
    res.json({ message: 'Deck returned to storage successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to return deck' });
  }
});

module.exports = router;
