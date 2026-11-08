// Preconstructed decks and Secret Lair drops (MTGJSON), into the collection or a deck.
//
// GET  /api/precons?q=&type=&set=&limit=   the deck index, filtered; `type` takes
//                                          any MTGJSON deck type, or 'secret-lair'
// GET  /api/precons/deck?file=<fileName>   one deck's card list, for a preview
// POST /api/precons/import                 { file, mode, location_id?, deck_name? }
//      mode 'collection' adds every copy to the collection (optionally filed into
//      a storage location), 'deck' builds a deck from it, 'both' does both.
//
// Cards are resolved by their Scryfall id through scryfallApi — the same bulk
// identifier lookup the ManaBox import uses, 75 cards a request — and cached like
// any other lookup. A card that does not resolve is reported by name, never
// silently dropped.
const express = require('express');
const db = require('../db');
const mtgjsonApi = require('../mtgjsonApi');
const scryfallApi = require('../scryfallApi');
const languages = require('../utils/languages');
const { importLimiter } = require('../middleware/auth');
const { resolveCompartmentAndPosition } = require('../utils/collectionHelpers');
const { rebalanceCompartmentByScheme } = require('../utils/compartmentSort');

const router = express.Router();

// Same ceiling as the file import (routes/importExport.js): every copy is a row
// written in one transaction. The largest MTGJSON boxes are a few hundred cards.
const MAX_PRECON_COPIES = 5000;
const SECRET_LAIR = 'secret-lair';
// Secret Lair is a deck type for the drops, but its Commander decks are filed as
// "Commander Deck" in set SLD, so the filter takes the sets as well.
const SECRET_LAIR_CODES = new Set(['SLD', 'SLC', 'SLU']);
const isSecretLair = (d) => d.type === 'Secret Lair Drop' || SECRET_LAIR_CODES.has(d.code);
// MTGJSON file names are letters, digits and underscores — some of the letters
// accented (DandânDeck_SLD) — and nothing else reaches a request path.
const FILE_NAME = /^[\p{L}\p{N}_-]{1,200}$/u;
const SCRYFALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function filterDecks(list, { q = '', type = '', set = '', limit = 100 } = {}) {
  const term = String(q).trim().toLowerCase();
  const code = String(set).trim().toUpperCase();
  const out = (list || []).filter(d =>
    (!type || (type === SECRET_LAIR ? isSecretLair(d) : d.type === type))
    && (!code || d.code === code)
    && (!term || d.name.toLowerCase().includes(term) || d.code.toLowerCase() === term));
  // Newest first: the deck someone just opened is the one they are looking for.
  out.sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')) || a.name.localeCompare(b.name));
  return { total: out.length, decks: out.slice(0, limit) };
}

function typeCounts(list) {
  const counts = new Map();
  for (const d of list || []) counts.set(d.type, (counts.get(d.type) || 0) + 1);
  return [
    { type: SECRET_LAIR, count: (list || []).filter(isSecretLair).length },
    ...[...counts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  ];
}

// Every card a deck imports, one entry per board line.
function deckEntries(deck) {
  return mtgjsonApi.BOARDS.flatMap(board => (deck.boards[board] || []).map(c => ({
    ...c,
    board,
    // The existing import's rule for a quantity: a whole number, at least one.
    count: Math.max(1, parseInt(c.count, 10) || 1),
  })));
}

const upstreamError = (res, what) => res.status(502).json({ error: `Could not reach MTGJSON for ${what}. Try again later.` });

router.get('/', async (req, res) => {
  try {
    const { decks, meta } = await mtgjsonApi.listDecks();
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const { total, decks: page } = filterDecks(decks, {
      q: req.query.q || '', type: req.query.type || '', set: req.query.set || '', limit,
    });
    res.json({ total, decks: page, types: typeCounts(decks), version: (meta && meta.version) || null });
  } catch (error) {
    console.error('Listing MTGJSON precons failed:', error.message);
    upstreamError(res, 'the precon list');
  }
});

router.get('/deck', async (req, res) => {
  const file = String(req.query.file || '');
  if (!FILE_NAME.test(file)) return res.status(400).json({ error: 'A precon file name is required.' });
  try {
    const deck = await mtgjsonApi.getDeck(file);
    if (!deck) return res.status(404).json({ error: 'MTGJSON lists no such deck.' });
    const entries = deckEntries(deck);
    res.json({ ...deck, copies: entries.reduce((n, e) => n + e.count, 0) });
  } catch (error) {
    console.error(`Loading MTGJSON deck ${file} failed:`, error.message);
    upstreamError(res, 'this deck');
  }
});

// Card ids for the entries: card_cache first, then Scryfall's bulk lookup for the
// rest. Returns Map(entry -> card id); an entry missing from it did not resolve.
async function resolveEntries(entries) {
  const key = (e) => (e.scryfallId && SCRYFALL_ID.test(e.scryfallId)
    ? `id:${e.scryfallId.toLowerCase()}`
    : (e.setCode && e.number ? `sn:${e.setCode.toLowerCase()}|${e.number.toLowerCase()}` : null));
  const byKey = new Map();
  const wanted = new Map();
  for (const e of entries) {
    const k = key(e);
    if (!k || wanted.has(k)) continue;
    wanted.set(k, k.startsWith('id:')
      ? { key: k, id: `mtg-${e.scryfallId.toLowerCase()}` }
      : { key: k, set_id: e.setCode.toLowerCase(), number: e.number });
  }
  const ids = [...wanted.values()].filter(r => r.id).map(r => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db.all(`SELECT id FROM card_cache WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
    for (const r of rows) byKey.set(`id:${r.id.slice(4)}`, r.id);
  }
  const toFetch = [...wanted.values()].filter(r => !byKey.has(r.key));
  if (toFetch.length) {
    try {
      const { cards, pairs } = await scryfallApi.bulkFetchByIdentifier(toFetch);
      await scryfallApi.cacheCards(cards);
      for (const { row, card } of pairs) if (row.key) byKey.set(row.key, card.id);
    } catch (e) {
      // Reported per card below rather than failing the whole import: whatever
      // was already cached can still go in.
      console.warn(`Precon import: Scryfall lookup failed: ${e.message}`);
    }
  }
  const out = new Map();
  for (const e of entries) {
    const k = key(e);
    if (k && byKey.has(k)) out.set(e, byKey.get(k));
  }
  return out;
}

router.post('/import', importLimiter, async (req, res) => {
  const { file, mode = 'collection', location_id: locationId = null, deck_name: deckName = '' } = req.body || {};
  if (!['collection', 'deck', 'both'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'collection', 'deck' or 'both'." });
  }
  if (!FILE_NAME.test(String(file || ''))) return res.status(400).json({ error: 'A precon file name is required.' });
  const toCollection = mode !== 'deck';
  const toDeck = mode !== 'collection';

  try {
    if (toCollection && locationId) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
      if (!loc) return res.status(400).json({ error: 'Invalid location ID' });
    }

    let deck;
    try {
      deck = await mtgjsonApi.getDeck(String(file));
    } catch (error) {
      console.error(`Loading MTGJSON deck ${file} failed:`, error.message);
      return upstreamError(res, 'this deck');
    }
    if (!deck) return res.status(404).json({ error: 'MTGJSON lists no such deck.' });

    const entries = deckEntries(deck);
    const copies = entries.reduce((n, e) => n + e.count, 0);
    if (!entries.length) return res.status(400).json({ error: 'This deck lists no cards.' });
    if (copies > MAX_PRECON_COPIES) {
      return res.status(413).json({ error: `Too many cards (${copies}). Import at most ${MAX_PRECON_COPIES} at a time.` });
    }

    // Resolved before the transaction: a write transaction must not wait on the network.
    const resolved = await resolveEntries(entries);
    const unresolved = entries.filter(e => !resolved.has(e)).map(e => ({
      name: e.name, set: e.setCode, number: e.number, count: e.count, board: e.board,
    }));
    if (resolved.size === 0) {
      return res.status(400).json({ error: 'None of the cards in this deck could be found on Scryfall.', unresolved });
    }

    let added = 0;
    let unplaced = 0;
    let deckId = null;
    const name = String(deckName || '').trim().slice(0, 100) || deck.name;
    await db.withTransaction(async () => {
      if (toCollection) {
        const touched = new Set();
        for (const e of entries) {
          const cardId = resolved.get(e);
          if (!cardId) continue;
          const printing = e.isFoil || e.isEtched ? 'Holofoil' : 'Normal';
          const language = languages.toName(e.language);
          // A copy is a row, as everywhere else (#64), placed one at a time so
          // each lands against the copies already filed.
          for (let i = 0; i < e.count; i++) {
            const spot = locationId
              ? (await resolveCompartmentAndPosition({ locationId, userId: req.user.id, cardId, printing, language })) || {}
              : {};
            const compartmentId = spot.compartment_id || null;
            if (locationId && !compartmentId) unplaced++;
            if (compartmentId) touched.add(compartmentId);
            await db.run(
              `INSERT INTO collection
                 (card_id, user_id, quantity, condition, printing, language, purchase_price,
                  location_id, compartment_id, position, list_type, game)
               VALUES (?, ?, 1, 'Near Mint', ?, ?, 0, ?, ?, ?, 'collection', 'mtg')`,
              [cardId, req.user.id, printing, language,
                compartmentId ? (spot.location_id || locationId) : null, compartmentId, compartmentId ? spot.position : 0]
            );
            added++;
          }
        }
        if (touched.size) {
          const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
          for (const compartmentId of touched) {
            await rebalanceCompartmentByScheme(db, compartmentId, loc && loc.sort_order, loc && loc.foil_sorting);
          }
        }
      }
      if (toDeck) {
        const commander = (deck.boards.commander || []).length > 0 || /commander/i.test(deck.type);
        const result = await db.run(
          `INSERT INTO decks (name, description, game, format, category, target_size, user_id)
           VALUES (?, ?, 'mtg', ?, 'Casual', ?, ?)`,
          [name, `${deck.type} · ${deck.code}${deck.releaseDate ? ` · ${deck.releaseDate}` : ''}`,
            commander ? 'Commander / EDH' : 'Standard', copies, req.user.id]
        );
        deckId = result.lastID;
        // Not through validateDeckAddition: a precon is a list of what the box
        // holds, and the deck view's job is to show which of those cards are not
        // owned yet — the same as a decklist pasted in when a deck is created.
        for (const e of entries) {
          const cardId = resolved.get(e);
          if (!cardId) continue;
          await db.run(
            `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
             ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
            [deckId, cardId, e.count]
          );
        }
      }
    });

    const skipped = unresolved.length
      ? ` ${unresolved.length} card${unresolved.length === 1 ? '' : 's'} could not be found on Scryfall and ${unresolved.length === 1 ? 'was' : 'were'} skipped.`
      : '';
    res.json({
      success: true,
      added,
      unplaced,
      deck: deckId ? { id: deckId, name } : null,
      unresolved,
      message: `Imported ${deck.name}.${skipped}`,
    });
  } catch (error) {
    console.error(`Precon import of ${file} failed:`, error.message);
    res.status(500).json({ error: 'Precon import failed' });
  }
});

module.exports = router;
