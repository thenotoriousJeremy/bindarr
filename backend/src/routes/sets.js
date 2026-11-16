const express = require('express');
const db = require('../db');
const languages = require('../utils/languages');
const router = express.Router();

// Display names for the provider the `sets` table follows, for the Browse view's
// "TCGplayer lists N sets that TCGdex hasn't published yet".
const PROVIDER_NAMES = { tcgdex: 'TCGdex', pokemontcg: 'pokemontcg.io', pokemontcgapi: 'pokemontcgapi.com' };

// GET /api/sets/tcgplayer-unpublished?game=pokemon — Pokémon sets TCGplayer
// already lists that the configured provider has not published yet
// (tcgplayerCatalog.unpublishedSets). Read from the local TCGCSV cache, so it
// costs no request. Other games: an empty list — their providers publish a
// set ahead of its release, and TCGCSV is synced for their sealed product only.
router.get('/tcgplayer-unpublished', async (req, res) => {
  try {
    const game = req.query.game || 'pokemon';
    if (game !== 'pokemon') return res.json({ game, provider: null, count: 0, groups: [] });
    const provider = await require('../utils/pokemonProvider').providerFor('en');
    const groups = await require('../tcgplayerCatalog').unpublishedSets();
    res.json({ game, provider: PROVIDER_NAMES[provider] || provider, count: groups.length, groups });
  } catch (error) {
    console.error('Error listing unpublished sets:', error.message);
    res.status(500).json({ error: 'Failed to list unpublished sets' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { game, lang } = req.query;
    if (game === 'pokemon' && await require('../utils/pokemonProvider').providerFor(lang) === 'pokemontcgapi') {
      return res.json(await require('../pokemontcgapi').listSets(lang));
    }
    // Non-English Pokémon sets are a different list entirely — Japan gets sets the
    // West never sees — and they are not in the `sets` table, which is keyed by id
    // alone while the same id exists in several languages. Ask TCGdex instead.
    if (game === 'pokemon' && !languages.isEnglish(lang)) {
      try {
        // Plus the sets TCGdex does not serve in this language, from TCGplayer
        // (Japanese: most of them). English ones are in the `sets` table already.
        // Brought up to date in the background; this list is what is cached now.
        const fallback = require('../pokemonTcgplayer');
        fallback.ensure(lang).catch(() => {});
        return res.json([...await require('../tcgdexApi').listSets(lang), ...await fallback.fallbackSets(lang)]);
      } catch (err) {
        console.error(`Failed to fetch ${lang} Pokémon sets from TCGdex:`, err.message);
        return res.json([]); // set autocomplete is a convenience; searching still works
      }
    }
    // Riftbound's sets arrive with its catalogue, which is fetched on first use —
    // opening the Riftbound search is a first use. Unreachable is not an error
    // here: the list is a convenience and searching still says what is wrong.
    // Then the sets RiftCodex lacks, written from the TCGCSV cache
    // (riftboundTcgplayer.js); a sync that has to bring them is not waited for.
    if (game === 'riftbound') {
      await require('../riftcodexApi').ensureCatalogue().catch(() => {});
      await require('../riftboundTcgplayer').ensure().catch(() => {});
    }
    // English Pokémon sets TCGdex lacks (World Championship decks, Prize Pack...)
    // are written into `sets` from TCGplayer, in the background: this list is
    // what is cached now, and opening Add Cards never waits on a download.
    if (game === 'pokemon') require('../pokemonTcgplayer').ensure('English').catch(() => {});
    // The TCGplayer-catalogue games build their set list from TCGCSV on first use.
    if (require('../tcgcsvGameApi').isTcgcsvGame(game)) {
      await require('../tcgcsvGameApi').ensureCatalogue(game).catch(() => {});
    }
    const where = game ? `WHERE game = ?` : '';
    const params = game ? [game] : [];
    const sets = await db.all(`
      SELECT id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game
      FROM sets
      ${where}
      ORDER BY release_date ASC
    `, params);
    // ?tree=1: parents only, each carrying its subsets. A Scryfall release is one
    // parent expansion plus a handful of child sets (tokens, art series, promos,
    // Commander decks) that each have their OWN set code, so a scan scoped to
    // "fdn" silently excludes every token in the box. The scanner's set filter
    // needs the family to offer them, and needs them separable so a user who is
    // not feeding tokens in can drop them. Opt-in because every other caller
    // wants the flat list it has always had.
    if (req.query.tree === '1' && game === 'mtg') {
      const { getMtgChildSetMap } = require('../cardSets');
      const childMap = await getMtgChildSetMap();
      const childCodes = new Set([...childMap.values()].flatMap(cs => cs.map(c => c.code)));
      const code = (s) => s.ptcgo_code || String(s.id || '').replace(/^mtg-/, '');
      return res.json(
        sets
          .filter(s => !childCodes.has(code(s)))
          .map(s => ({ ...s, children: childMap.get(code(s).toLowerCase().replace(/[^a-z0-9]/g, '')) || [] }))
      );
    }
    res.json(sets);
  } catch (error) {
    console.error('Error fetching sets:', error);
    res.status(500).json({ error: 'Failed to retrieve sets' });
  }
});

module.exports = router;
