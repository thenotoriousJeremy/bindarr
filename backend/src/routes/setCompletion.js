// Per-set completion: every card in a set, owned or not.
//
// GET /api/set-completion?set=<id>[&game=][&lang=][&refresh=1]
//   The set's full card list (setListing.js, cached), each card marked with the
//   copies the user owns, plus a completion summary and the value of what is
//   missing. `game` and `lang` may be left out when the set is one the user owns
//   cards from — the dashboard's set-progress list links here with a set id only.
// GET /api/set-completion/sets[?game=]
//   The sets the user owns cards from, most-collected first, for the set picker.
const express = require('express');
const db = require('../db');
const setListing = require('../setListing');
const languages = require('../utils/languages');
const { buildCompletion } = require('../utils/setCompletion');

const router = express.Router();

// Provider set ids are short and plain: sv01, sv03.5, swsh12pt5tg, mtg-fdn,
// lorcana-1, pokemontcgapi-SV1. Anything else is refused before it reaches a URL.
const SET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const CARD_COLUMNS = `id, name, printed_name, number, rarity, image_url, image_url_back, language, set_id, set_name,
  price_trend, price_normal, price_holofoil, price_reverse_holofoil, price_1st_edition, price_currency,
  price_source, tcgplayer_product_id`;

async function cardRows(ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...await db.all(
      `SELECT ${CARD_COLUMNS} FROM card_cache WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk
    ));
  }
  return rows;
}

// The language most of the user's copies of a set are in. Only matters for
// Pokémon, whose non-English sets are separate sets with their own ids.
function dominantLanguage(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.language, (counts.get(r.language) || 0) + 1);
  let best = null;
  for (const [lang, n] of counts) if (!best || n > best.n) best = { lang, n };
  return best ? best.lang : 'English';
}

// Display metadata the listing did not carry, from the `sets` table — which keys
// Magic sets as mtg-<code> while card_cache stores the bare code.
async function setRow(game, setId) {
  const id = game === 'mtg' ? `mtg-${setId}` : setId;
  return db.get(
    `SELECT id, name, series, printed_total, total, release_date, symbol_url, logo_url
       FROM sets WHERE game = ? AND (LOWER(id) = LOWER(?) OR LOWER(ptcgo_code) = LOWER(?))
      ORDER BY (LOWER(id) = LOWER(?)) DESC LIMIT 1`,
    [game, id, setId, id]
  );
}

router.get('/', async (req, res) => {
  const setId = String(req.query.set || '').trim();
  if (!SET_ID.test(setId)) return res.status(400).json({ error: 'A valid set id is required.' });
  let game = req.query.game ? String(req.query.game).toLowerCase() : null;
  if (game && !setListing.supports(game)) return res.status(400).json({ error: `Set completion is not available for ${game}.` });

  try {
    // The user's own copies of this set id, which also answer what game and
    // language a bare dashboard link means.
    const mine = await db.all(
      `SELECT cc.game, cc.language, cc.set_name FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND LOWER(cc.set_id) = LOWER(?) ${game ? 'AND cc.game = ?' : ''} LIMIT 500`,
      game ? [req.user.id, setId, game] : [req.user.id, setId]
    );
    // Failing that, the prefix the sets table gives Magic and Lorcana ids.
    if (!game) game = mine.length ? mine[0].game : ((/^(mtg|lorcana)-/i.exec(setId) || [])[1] || '').toLowerCase() || null;
    if (!game || !setListing.supports(game)) return res.status(400).json({ error: 'Which game is this set from? Pass game=pokemon, mtg or lorcana.' });
    const lang = req.query.lang
      ? languages.toCode(req.query.lang)
      : (game === 'pokemon' ? languages.toCode(dominantLanguage(mine.filter(r => r.game === game))) : 'en');

    const listing = await setListing.getListing(game, setId, lang, {
      refresh: req.query.refresh === '1',
      name: mine.length ? mine[0].set_name : null,
    });
    if (!listing) return res.status(404).json({ error: 'The provider lists no cards for this set.' });

    const rows = await cardRows(listing.ids);
    const byId = new Map(rows.map(r => [r.id, r]));
    const cards = listing.ids.map(id => byId.get(id)).filter(Boolean);
    const meta = await setRow(game, listing.set.id) || {};
    const set = {
      ...meta,
      ...Object.fromEntries(Object.entries(listing.set).filter(([, v]) => v != null && v !== '')),
      id: listing.set.id,
      name: listing.set.name || meta.name || (cards[0] && cards[0].set_name) || listing.set.id,
    };
    // TCGplayer's own code for the set, for Mass Entry lines. Magic's codes are
    // TCGplayer's too; Pokémon's comes from the TCGCSV group the listing matched.
    if (game === 'mtg') set.tcgplayer_set_code = String(set.id).toUpperCase();

    // The user's copies, wishlist included (marked, not counted). Pokémon reads
    // every copy of the game and lets buildCompletion match the set by id or name,
    // so copies filed under the other provider's numbering of the same set still
    // count; Magic and Lorcana codes are the same everywhere, so SQL narrows them.
    const narrow = game === 'pokemon' ? '' : 'AND LOWER(cc.set_id) = LOWER(?)';
    const owned = await db.all(
      `SELECT c.quantity, c.printing, c.list_type, cc.set_id, cc.set_name, cc.number
         FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND cc.game = ? ${narrow}`,
      game === 'pokemon' ? [req.user.id, game] : [req.user.id, game, set.id]
    );

    res.json({
      game,
      lang,
      set,
      fetched_at: listing.fetched_at,
      stale: !!listing.stale,
      ...buildCompletion({ game, set, cards, owned }),
    });
  } catch (error) {
    console.error(`Set completion failed for ${game || '?'} ${setId}:`, error.message);
    // A provider that is down or refusing us is a 502 the user can retry; anything
    // else is ours.
    const upstream = error.isAxiosError || error.response || /^(UPSTREAM_UNAVAILABLE|RATE_LIMIT_EXCEEDED|INVALID_API_KEY|POKEMONTCGAPI_)/.test(error.message);
    res.status(upstream ? 502 : 500).json({
      error: upstream ? 'Could not load this set from its provider. Try again later.' : 'Failed to compute set completion',
    });
  }
});

router.get('/sets', async (req, res) => {
  const game = req.query.game ? String(req.query.game).toLowerCase() : null;
  try {
    const rows = await db.all(
      `SELECT cc.game, cc.set_id, cc.language, MAX(cc.set_name) AS set_name, COUNT(DISTINCT cc.number) AS owned
         FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.list_type = 'collection' AND COALESCE(cc.set_id, '') <> ''
          ${game ? 'AND cc.game = ?' : ''}
        GROUP BY cc.game, cc.set_id, cc.language`,
      game ? [req.user.id, game] : [req.user.id]
    );
    // One entry per set. A Pokémon set's language is the one most of its copies
    // are in; distinct numbers are summed across languages as an upper bound for
    // ordering only — the set view itself is what counts.
    const bySet = new Map();
    for (const r of rows) {
      if (!setListing.supports(r.game)) continue;
      const key = `${r.game}|${String(r.set_id).toLowerCase()}`;
      const entry = bySet.get(key) || { game: r.game, set_id: r.set_id, set_name: r.set_name, owned: 0, lang: 'en', best: -1 };
      entry.owned += r.owned;
      if (r.game === 'pokemon' && r.owned > entry.best) { entry.best = r.owned; entry.lang = languages.toCode(r.language); }
      bySet.set(key, entry);
    }
    const sets = [...bySet.values()]
      .map(({ best, ...s }) => s)
      .sort((a, b) => b.owned - a.owned || String(a.set_name).localeCompare(String(b.set_name)));
    res.json(sets.slice(0, 300));
  } catch (error) {
    console.error('Listing owned sets failed:', error.message);
    res.status(500).json({ error: 'Failed to list your sets' });
  }
});

module.exports = router;
