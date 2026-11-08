// The camera scanner's two routes. Matching is cvScan's; naming the matches is
// scanCandidates'. This is the HTTP in between.
const cvScan = require('../../cvScan');
const tcgplayerCatalog = require('../../tcgplayerCatalog');
const languages = require('../../utils/languages');
const games = require('../../utils/games');
const { searchLimiter } = require('../../middleware/auth');
const { parseSetList } = require('../../utils/setQuery');
const { toEmbedding, resolveCandidates, isUnresolvedPublished } = require('../../scanCandidates');

// 1b. Identify a scanned card image by visual-feature match.
// Which sets the scanner can actually answer for, and how completely.
//
// Not admin-only: this is what the set filter needs to stop offering sets that
// match nothing. Read-only counts, no build controls.
async function scanSets(req, res) {
  const { game = 'pokemon', lang } = req.query;
  if (!games.hasFeature(game, 'scan')) return res.status(400).json({ error: 'Invalid game' });
  try {
    // `builtLangs` rides along because the scanner's language picker has no other
    // way to know: it offered all eleven languages, and for ten of them a Pokémon
    // scan is answered by the English catalog and filed as an English printing.
    // Offering a choice without its consequence is what made that a surprise.
    res.json({
      ...await require('../../catalog').setCounts(game, languages.toName(lang)),
      builtLangs: cvScan.builtLangs(game),
    });
  } catch (e) {
    console.error('scan-sets failed:', e.message);
    res.status(500).json({ error: 'Could not read catalog set counts' });
  }
}

async function scanMatch(req, res) {
  try {
    const { game = 'pokemon', image, set = '', lang, cropped = false, embedding, thumb, detected } = req.body || {};
    if (!games.hasFeature(game, 'scan')) return res.status(400).json({ error: 'Invalid game' });
    // A photo, or the embedding of one. The phone app in device mode has no server
    // to send pixels to, so it runs milo on its own crop and sends the 128 numbers;
    // the sweep and everything after it is the same scan.
    const scanEmbedding = toEmbedding(embedding);
    let buf = null;
    if (!scanEmbedding) {
      if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Missing image' });
      const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
      buf = Buffer.from(base64, 'base64');
      if (buf.length < 100) return res.status(400).json({ error: 'Invalid image data' });
    }

    const langName = languages.toName(lang);

    // Set scoping is a FILTER over the catalog, not a different pipeline. The ORB
    // path needed a per-set index built before it could scope a scan (that was the
    // client's "preparing set" wait); a cosine sweep just skips rows that do not
    // belong. A scoped scan is the same scan over fewer candidates — cheaper and
    // more accurate, with nothing to build.
    //
    // Language is not a gate either. A card's artwork is the same in every
    // language, so the English catalog answers "which card is this" for a Spanish
    // or Japanese photo; when a catalog exists in the scanned language cvScan uses
    // it instead. Measured 100% right-card on Spanish/Japanese/French/Italian MTG
    // off the English catalog.
    if (!cvScan.isBuilt(game, langName)) {
      // There is no second matcher to fall back to. Say what is missing and what
      // fixes it, rather than an empty candidate list that reads to the user as
      // "your card could not be identified".
      return res.status(503).json({
        game, lang: langName, candidates: [], verified: false, notBuilt: true,
        error: 'No scan catalog is built for this game and language yet. An admin can build one from Admin → Catalogs.',
      });
    }

    const result = await cvScan.match(buf, game, 8, {
      sets: parseSetList(set), lang: langName, cropped: !!cropped,
      ...(scanEmbedding ? {
        embedding: scanEmbedding,
        thumb: typeof thumb === 'string' && thumb.startsWith('data:image/') ? thumb : null,
        detected: detected !== false,
      } : {}),
    });

    result.candidates = await resolveCandidates(result.candidates, {
      game, langName, tcgApiKey: req.user.tcg_api_key,
    });

    // See isUnresolvedPublished: a ready-made Pokémon catalog hit that this
    // install has no way to name. An install-state problem, and it says so.
    if (isUnresolvedPublished(game, result.candidates)) {
      const map = await tcgplayerCatalog.summary();
      console.log('scan-match: ready-made Pokemon catalog hit but no product id could be named'
        + ` — product map holds ${map.rows} rows${map.progress ? ' (building)' : ''}`);
      return res.json({
        ...result,
        unresolvedPublished: true,
        productMapRows: map.rows,
        error: map.progress
          ? 'The TCGplayer product map is still building — the ready-made Pokémon catalog cannot name'
            + ' its matches until it finishes.'
          : 'The ready-made Pokémon catalog recognises cards by TCGplayer product id, and this install'
            + ' has no product map to look them up in. An admin can build it in Admin → Scan catalogs.',
      });
    }

    return res.json(result);
  } catch (error) {
    console.error('scan-match failed:', error.message);
    res.status(500).json({ error: 'Scan match failed' });
  }
}

function register(router) {
  router.get('/scan-sets', scanSets);
  router.post('/scan-match', searchLimiter, scanMatch);
}

module.exports = { register };
