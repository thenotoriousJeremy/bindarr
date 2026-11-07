// Which physical copies a deck uses.
//
// A checked-out deck HOLDS copies: deck_allocations names each collection entry it
// took, keyed by the entry, so one physical card is in one deck at a time. A deck
// that is not checked out holds nothing; its page and pull list show what checkout
// WOULD take, worked out the same way from the copies no checked-out deck holds.
//
// Which copies: every card's exact printing first, then — for a deck that accepts
// any printing — other printings of the same card; within each, copies filed in a
// container before loose ones, newest first (the order the checkout guide has
// always used). Exact printings are handed out before any substitute, so a deck
// listing two printings of a card gets each one before either takes the other's.
//
// Everything here is a fixed number of set-based queries per deck, whatever its
// size: the deck page, the pull list and checkout used to run up to three
// correlated subqueries per card, each rescanning the collection.
const db = require('../db');
const { loadRules } = require('./deckRules');
const { compartmentLabel } = require('./compartmentSort');

class DeckAllocationError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || null;
  }
}

async function loadDeckState(deck, userId) {
  const rules = await loadRules();
  const game = deck.game || 'pokemon';
  const anyPrinting = !!deck.any_printing && rules.supportsAnyPrinting(game);

  const cards = await db.all(`
    SELECT dc.card_id, dc.quantity, cc.name, cc.printed_name, cc.oracle_id
    FROM deck_cards dc JOIN card_cache cc ON cc.id = dc.card_id
    WHERE dc.deck_id = ? AND dc.quantity > 0
    ORDER BY dc.rowid
  `, [deck.id]);

  // Every copy that could fill one of those cards, once, with whichever checked-out
  // deck holds it. Without any-printing that is the deck's own printings; with it,
  // also anything sharing a name or oracle id, which sameCard then narrows.
  const copies = await db.all(`
    SELECT c.id AS entry_id, c.card_id, c.quantity, c.position, c.location_id, c.compartment_id,
           cc.name, cc.printed_name, cc.oracle_id, cc.set_name, cc.number,
           l.name AS location_name, l.type AS location_type,
           cp.label AS compartment_label, cp.idx AS compartment_idx,
           hd.id AS held_by, hd.name AS held_by_name, a.card_id AS held_for, a.quantity AS held_qty
    FROM collection c
    JOIN card_cache cc ON cc.id = c.card_id
    LEFT JOIN locations l ON l.id = c.location_id
    LEFT JOIN compartments cp ON cp.id = c.compartment_id
    LEFT JOIN deck_allocations a ON a.entry_id = c.id
    LEFT JOIN decks hd ON hd.id = a.deck_id AND hd.checked_out = 1
    WHERE c.user_id = ? AND c.list_type = 'collection' AND c.quantity > 0
      AND (
        c.card_id IN (SELECT card_id FROM deck_cards WHERE deck_id = ?)
        OR (? = 1 AND cc.game = ? AND (
          cc.name IN (SELECT dcc.name FROM deck_cards d2 JOIN card_cache dcc ON dcc.id = d2.card_id WHERE d2.deck_id = ?)
          OR cc.oracle_id IN (SELECT dcc.oracle_id FROM deck_cards d2 JOIN card_cache dcc ON dcc.id = d2.card_id
                              WHERE d2.deck_id = ? AND dcc.oracle_id IS NOT NULL)
        ))
      )
    ORDER BY (c.location_id IS NOT NULL) DESC, c.added_at DESC, c.id DESC
  `, [userId, deck.id, anyPrinting ? 1 : 0, game, deck.id, deck.id]);

  const matches = (card, copy) => rules.sameCard(card, copy, game, anyPrinting);
  return { cards, copies, matches, anyPrinting };
}

// Pure: which copies go to which card. `keepHeld` starts from what the deck already
// holds (a checked-out deck keeps the copies that were pulled for it); `topUp` then
// fills what is still short from copies nobody holds. Returns one entry per card:
// { card, need (still missing), takes: [{ copy, take }], owned, locked, lockedBy }.
function planDeck({ cards, copies, matches, anyPrinting, deckId, keepHeld, topUp }) {
  const plan = cards.map(card => ({ card, need: card.quantity, takes: [], owned: 0, locked: 0, lockedBy: new Set() }));
  const byCard = new Map(plan.map(p => [p.card.card_id, p]));
  const given = new Map();
  const left = (copy) => (copy.quantity || 1) - (given.get(copy.entry_id) || 0);
  const give = (p, copy, n) => {
    p.takes.push({ copy, take: n });
    p.need -= n;
    given.set(copy.entry_id, (given.get(copy.entry_id) || 0) + n);
  };
  // A copy this deck holds is its own to re-use; one another checked-out deck holds
  // is not available at all.
  const usable = (copy) => copy.held_by == null || copy.held_by === deckId;

  for (const p of plan) {
    for (const copy of copies) {
      if (!matches(p.card, copy)) continue;
      p.owned += copy.quantity || 1;
      if (!usable(copy)) {
        p.locked += copy.quantity || 1;
        p.lockedBy.add(copy.held_by_name);
      }
    }
  }

  if (keepHeld) {
    for (const copy of copies) {
      if (copy.held_by !== deckId) continue;
      const p = byCard.get(copy.held_for);
      if (!p || p.need <= 0 || !matches(p.card, copy)) continue;
      give(p, copy, Math.min(copy.held_qty || 1, left(copy), p.need));
    }
  }

  if (topUp) {
    const fill = (accept) => {
      for (const p of plan) {
        for (const copy of copies) {
          if (p.need <= 0) break;
          if (usable(copy) && left(copy) > 0 && accept(p, copy)) give(p, copy, Math.min(left(copy), p.need));
        }
      }
    };
    fill((p, copy) => copy.card_id === p.card.card_id);
    if (anyPrinting) fill((p, copy) => copy.card_id !== p.card.card_id && matches(p.card, copy));
  }

  return plan;
}

// The deck's cards with what they have to work with. For a checked-out deck that is
// what it holds; otherwise what a checkout would take right now.
async function deckAvailability(deck, userId) {
  const state = await loadDeckState(deck, userId);
  const checkedOut = !!deck.checked_out;
  const plan = planDeck({ ...state, deckId: deck.id, keepHeld: checkedOut, topUp: !checkedOut });
  return new Map(plan.map(p => [p.card.card_id, p]));
}

// The pull list: where to find each card, and how many are missing.
function locationsFor(entries) {
  return [...entries.values()].map(p => ({
    card_id: p.card.card_id,
    // Display-only, so the name as printed — nothing downstream keys off it.
    card_name: p.card.printed_name || p.card.name,
    required: p.card.quantity,
    found: p.card.quantity - p.need,
    missing: p.need,
    locations: p.takes.map(({ copy, take }) => ({
      take,
      card_name: copy.printed_name || copy.name,
      set_name: copy.set_name,
      number: copy.number,
      // Another printing filling the slot, for a deck that accepts any.
      substitute: copy.card_id !== p.card.card_id,
      location_name: copy.location_name || 'Unassigned Pile',
      location_type: copy.location_type,
      compartment_display: copy.compartment_idx !== null && copy.compartment_idx !== undefined
        ? compartmentLabel({ label: copy.compartment_label, idx: copy.compartment_idx }, copy.location_type)
        : copy.compartment_label,
      position: copy.location_name ? copy.position : null,
      location_id: copy.location_id,
      compartment_id: copy.compartment_id,
      entry_id: copy.entry_id,
    })),
  }));
}

// Claim the planned copies for `deckId`. The entry is the table's key, so this can
// only take a copy nobody else holds: the upsert overwrites a row only when it is
// this deck's own, or left behind by a deck that is no longer checked out. In
// `strict` mode a copy that turned out to be taken — claimed since the plan was
// read — fails the whole claim, and the caller's transaction rolls back.
async function claimCopies(deckId, plan, { strict }) {
  const rows = plan.flatMap(p => p.takes.map(({ copy, take }) => [copy.entry_id, deckId, p.card.card_id, take]));
  let claimed = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const result = await db.run(`
      INSERT INTO deck_allocations (entry_id, deck_id, card_id, quantity)
      VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')}
      ON CONFLICT(entry_id) DO UPDATE SET
        deck_id = excluded.deck_id, card_id = excluded.card_id, quantity = excluded.quantity,
        allocated_at = CURRENT_TIMESTAMP
      WHERE deck_allocations.deck_id = excluded.deck_id
         OR NOT EXISTS (SELECT 1 FROM decks d WHERE d.id = deck_allocations.deck_id AND d.checked_out = 1)
    `, chunk.flat());
    claimed += result.changes;
  }
  if (strict && claimed !== rows.length) {
    throw new DeckAllocationError(409, 'Some of these cards were just checked out with another deck. Try again.');
  }
}

const shortfall = (plan) => plan
  .filter(p => p.need > 0)
  .map(p => `Missing ${p.need}x ${p.card.printed_name || p.card.name} (Owned: ${p.owned}, In Use: ${p.locked})`);

// Check a deck out: claim every copy it needs, or nothing. Runs as one transaction,
// which holds the connection until it settles (db.withTransaction), so a second
// checkout racing for the same copies sees them taken and fails cleanly instead of
// both decks counting the same cards.
function checkoutDeck(deckId, userId) {
  return db.withTransaction(async () => {
    const deck = await db.get(`SELECT * FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
    if (!deck) throw new DeckAllocationError(404, 'Deck not found or unauthorized');
    if (deck.checked_out) throw new DeckAllocationError(409, 'This deck is already checked out.');

    const state = await loadDeckState(deck, userId);
    const plan = planDeck({ ...state, deckId: deck.id, keepHeld: false, topUp: true });
    const missing = shortfall(plan);
    if (missing.length) {
      throw new DeckAllocationError(400, 'Not enough cards available to check out this deck.', missing);
    }

    // Anything this deck still has on record is left from an earlier checkout.
    await db.run(`DELETE FROM deck_allocations WHERE deck_id = ?`, [deck.id]);
    await claimCopies(deck.id, plan, { strict: true });
    const flipped = await db.run(
      `UPDATE decks SET checked_out = 1, checked_out_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND checked_out = 0`,
      [deck.id, userId]
    );
    if (flipped.changes !== 1) throw new DeckAllocationError(409, 'This deck is already checked out.');
  });
}

// Return a deck: release everything it holds.
function returnDeck(deckId, userId) {
  return db.withTransaction(async () => {
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
    if (!deck) throw new DeckAllocationError(404, 'Deck not found or unauthorized');
    await db.run(`DELETE FROM deck_allocations WHERE deck_id = ?`, [deckId]);
    await db.run(`UPDATE decks SET checked_out = 0, checked_out_at = NULL WHERE id = ? AND user_id = ?`, [deckId, userId]);
  });
}

// Delete a deck along with its cards and whatever copies it holds.
function deleteDeck(deckId, userId) {
  return db.withTransaction(async () => {
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
    if (!deck) throw new DeckAllocationError(404, 'Deck not found or unauthorized');
    await db.run(`DELETE FROM deck_allocations WHERE deck_id = ?`, [deckId]);
    await db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [deckId]);
    await db.run(`DELETE FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
  });
}

// Bring a checked-out deck's holdings in line with its cards after they change: a
// card that left gives its copies back, one that came in takes free copies if there
// are any. Copies already pulled stay with the card they were pulled for. A shortfall
// is not an error here — the deck is already out, and its page shows what is missing.
function syncDeckAllocation(deckId, userId) {
  return db.withTransaction(async () => {
    const deck = await db.get(`SELECT * FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
    if (!deck || !deck.checked_out) return;
    const state = await loadDeckState(deck, userId);
    const plan = planDeck({ ...state, deckId: deck.id, keepHeld: true, topUp: true });
    const keep = new Set(plan.flatMap(p => p.takes.map(t => t.copy.entry_id)));
    const held = await db.all(`SELECT entry_id FROM deck_allocations WHERE deck_id = ?`, [deck.id]);
    const release = held.map(h => h.entry_id).filter(id => !keep.has(id));
    for (let i = 0; i < release.length; i += 100) {
      const chunk = release.slice(i, i + 100);
      await db.run(`DELETE FROM deck_allocations WHERE deck_id = ? AND entry_id IN (${chunk.map(() => '?').join(', ')})`, [deck.id, ...chunk]);
    }
    await claimCopies(deck.id, plan, { strict: false });
  });
}

module.exports = {
  DeckAllocationError,
  planDeck,
  deckAvailability,
  locationsFor,
  claimCopies,
  checkoutDeck,
  returnDeck,
  deleteDeck,
  syncDeckAllocation,
};
