const express = require('express');
const axios = require('axios');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// The Pokémon providers an admin may pick. TCGdex is the default; pokemontcg.io
// stays selectable only for installs still pinned to it until they migrate.
const POKEMON_PROVIDERS = ['tcgdex', 'pokemontcg', 'pokemontcgapi'];

// --- Version + update check ---

// backend/package.json is what the release workflow bumps, so it is the running
// build's version. The repo-root package.json is not bumped and would lie.
const APP_VERSION = require('../../package.json').version;
const RELEASES_API = 'https://api.github.com/repos/thenotoriousJeremy/bindarr/releases/latest';
const RELEASES_PAGE = 'https://github.com/thenotoriousJeremy/bindarr/releases';
// GitHub allows 60 unauthenticated calls/hour per IP, shared by every user of
// this instance. Cache hard: a new release is not urgent to the minute.
const UPDATE_CACHE_MS = 1000 * 60 * 60 * 6;
let updateCache = { at: 0, data: null };

// "1.4.9" < "1.4.10" — string compare gets this wrong, so compare numerically
// part by part. Anything non-numeric (a "-beta" suffix) is ignored.
function isNewer(candidate, current) {
  const parts = v => String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function checkForUpdate() {
  if (updateCache.data && Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.data;
  const resp = await axios.get(RELEASES_API, {
    timeout: 8000,
    headers: { 'User-Agent': 'Bindarr', Accept: 'application/vnd.github+json' }
  });
  const latest = String(resp.data.tag_name || '').replace(/^v/i, '');
  const data = {
    latest,
    update_available: !!latest && isNewer(latest, APP_VERSION),
    release_url: resp.data.html_url || RELEASES_PAGE,
    published_at: resp.data.published_at || null
  };
  updateCache = { at: Date.now(), data };
  return data;
}

// Current version always answers offline; the update check is best-effort and
// reports its own failure rather than pretending the app is up to date.
router.get('/version', async (req, res) => {
  const base = { version: APP_VERSION, releases_url: RELEASES_PAGE };
  if (req.query.check !== '1') return res.json(base);
  try {
    res.json({ ...base, ...(await checkForUpdate()) });
  } catch (error) {
    console.warn('Update check failed:', error.message);
    res.json({ ...base, check_failed: true });
  }
});

async function getEffectiveSettings() {
  const row = await db.get(`
    SELECT public_base_url, pokemon_provider, mtg_price_source, price_refresh_days,
           scan_exclude_tokens, scan_exclude_art_cards, scan_exclude_jumpstart, scan_exclude_promos,
           scan_exclude_digital, setup_complete, setup_step, sealed_tcg_extra_enabled
    FROM app_settings WHERE id = 1
  `);
  const public_base_url = (row && row.public_base_url) || process.env.PUBLIC_BASE_URL || '';
  // TCGdex unless the row explicitly holds another provider: pokemontcg.io is only
  // ever the upgrade pin for installs whose data it numbers (db.js), never a default.
  const pokemon_provider = POKEMON_PROVIDERS.includes(row && row.pokemon_provider) ? row.pokemon_provider : 'tcgdex';
  const mtg_price_source = row && row.mtg_price_source === 'cardmarket' ? 'cardmarket' : 'tcgplayer';
  const scan_exclude_tokens = !!(row && row.scan_exclude_tokens);
  const scan_exclude_art_cards = !!(row && row.scan_exclude_art_cards);
  const scan_exclude_jumpstart = !!(row && row.scan_exclude_jumpstart);
  const scan_exclude_promos = !!(row && row.scan_exclude_promos);
  // Defaults ON, so a missing row (or a read before the migration lands) must
  // read as excluded rather than as included — see the column comment in db.js.
  const scan_exclude_digital = row ? !!row.scan_exclude_digital : true;
  const setup_complete = !!(row && row.setup_complete);
  const setup_step = (row && typeof row.setup_step === 'string') ? row.setup_step : '';
  // Magic/Lorcana sealed tracking: TCGCSV categories 1 and 71 in the daily sync.
  const sealed_tcg_extra_enabled = !!(row && row.sealed_tcg_extra_enabled);
  // Daily unless an admin says otherwise, matching what every install did before
  // the column existed. 0 means automatic refreshes are off.
  const n = Number(row && row.price_refresh_days);
  const price_refresh_days = Number.isInteger(n) && n >= 0 ? n : 1;
  return {
    public_base_url,
    pokemon_provider,
    mtg_price_source,
    price_refresh_days,
    scan_exclude_tokens,
    scan_exclude_art_cards,
    scan_exclude_jumpstart,
    scan_exclude_promos,
    scan_exclude_digital,
    setup_complete,
    setup_step,
    sealed_tcg_extra_enabled,
  };
}

// Any logged-in user can read effective settings (needed to render share links)
router.get('/', async (req, res) => {
  try {
    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// Only admins can override settings
router.put('/', requireAdmin, async (req, res) => {
  const {
    public_base_url,
    pokemon_provider,
    mtg_price_source,
    price_refresh_days,
    scan_exclude_tokens,
    scan_exclude_art_cards,
    scan_exclude_jumpstart,
    scan_exclude_promos,
    scan_exclude_digital,
    setup_complete,
    setup_step,
    sealed_tcg_extra_enabled,
  } = req.body;

  // Every field is validated before anything is written, so a bad value cannot
  // leave the other fields of the same save half-applied -- some used to be
  // checked only after earlier ones had been saved. Rejected rather than coerced:
  // silently falling back to TCGplayer on a typo would look, from the admin's
  // side, like the setting not working.
  const scryfallApi = require('../scryfallApi');
  if (mtg_price_source !== undefined && !scryfallApi.MTG_PRICE_SOURCES.includes(mtg_price_source)) {
    return res.status(400).json({ error: `MTG price source must be one of: ${scryfallApi.MTG_PRICE_SOURCES.join(', ')}.` });
  }
  let provider;
  if (pokemon_provider !== undefined) {
    // A typo used to land on pokemontcg.io, which re-numbers every Pokémon set on
    // the install behind the admin's back.
    if (!POKEMON_PROVIDERS.includes(pokemon_provider)) {
      return res.status(400).json({ error: `Pokémon provider must be one of: ${POKEMON_PROVIDERS.join(', ')}.` });
    }
    provider = pokemon_provider;
    if (provider === 'pokemontcgapi' && !require('../pokemontcgapi').hasKey()) {
      return res.status(400).json({ error: 'Set POKEMONTCGAPI_KEY on the server before selecting this provider.' });
    }
  }
  if (sealed_tcg_extra_enabled !== undefined && typeof sealed_tcg_extra_enabled !== 'boolean') {
    return res.status(400).json({ error: 'Magic/Lorcana sealed tracking must be true or false.' });
  }
  // The wizard's step, by name (see the column in db/migrations.js). Only checked
  // for shape: the step names are the wizard's, and one it no longer has simply
  // reopens it at the start.
  if (setup_step !== undefined && (typeof setup_step !== 'string' || !/^[a-z]{0,32}$/.test(setup_step))) {
    return res.status(400).json({ error: 'Setup step must be a step name.' });
  }
  let refreshDays;
  if (price_refresh_days !== undefined) {
    // Rejected rather than clamped: a typo that silently becomes 365 is a
    // collection whose prices quietly stop moving, which looks like the app
    // being broken and not like a setting being wrong.
    refreshDays = Number(price_refresh_days);
    if (!Number.isInteger(refreshDays) || refreshDays < 0 || refreshDays > 30) {
      return res.status(400).json({ error: 'Price refresh interval must be a whole number of days from 0 (off) to 30.' });
    }
  }
  let baseUrl;
  if (public_base_url !== undefined) {
    if (typeof public_base_url !== 'string') {
      return res.status(400).json({ error: 'Public base URL must be text' });
    }
    const trimmed = public_base_url.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ error: 'Public base URL must start with http:// or https://' });
    }
    baseUrl = trimmed.replace(/\/+$/, '');
  }

  try {
    const before = await db.get(`SELECT mtg_price_source, pokemon_provider FROM app_settings WHERE id = 1`);
    // Then every write, in one transaction: all of the save or none of it.
    const flag = (v) => (v ? 1 : 0);
    const writes = [
      ['mtg_price_source', mtg_price_source],
      ['pokemon_provider', provider],
      ['price_refresh_days', refreshDays],
      ['scan_exclude_tokens', scan_exclude_tokens === undefined ? undefined : flag(scan_exclude_tokens)],
      ['scan_exclude_art_cards', scan_exclude_art_cards === undefined ? undefined : flag(scan_exclude_art_cards)],
      ['scan_exclude_jumpstart', scan_exclude_jumpstart === undefined ? undefined : flag(scan_exclude_jumpstart)],
      ['scan_exclude_promos', scan_exclude_promos === undefined ? undefined : flag(scan_exclude_promos)],
      ['scan_exclude_digital', scan_exclude_digital === undefined ? undefined : flag(scan_exclude_digital)],
      ['setup_complete', setup_complete === undefined ? undefined : flag(setup_complete)],
      ['setup_step', setup_step],
      ['public_base_url', baseUrl],
    ].filter(([, value]) => value !== undefined);
    await db.withTransaction(async () => {
      for (const [column, value] of writes) {
        await db.run(`UPDATE app_settings SET ${column} = ? WHERE id = 1`, [value]);
      }
    });

    // What the saved values set in motion, once they are saved.
    if (mtg_price_source !== undefined) {
      // Takes effect for every card normalized from here on (normalizeCard reads
      // the in-memory copy), then re-prices what is already cached so collections
      // switch currency too. In the background: it is a Scryfall sweep, and the
      // admin's save should not wait on it.
      scryfallApi.setPriceSource(mtg_price_source);
      if (((before && before.mtg_price_source) || 'tcgplayer') !== mtg_price_source) {
        console.log(`MTG price source changed to ${mtg_price_source} — re-pricing cached Magic cards.`);
        // utils/backgroundWork: on a phone, a background job of its own.
        require('../utils/backgroundWork').start('Magic re-price', () => scryfallApi.repriceForSourceChange()).catch(e => {
          console.error(`MTG re-price after price source change failed: ${e.message}`);
        });
      }
    }
    // Switching provider re-numbers everything downstream of it, and leaving the
    // old numbering in place is worse than the switch itself: the `sets` table
    // would list one provider's ids while new cards cache under the other's, and
    // the TCGplayer product map resolves scans through set ids it took FROM that
    // table. Both are rebuilt here, in the background — the set walk is one
    // request plus a detail pass, the map is ~30 seconds.
    // An unset or unknown stored value is read as TCGdex, the default.
    const previous = POKEMON_PROVIDERS.includes(before && before.pokemon_provider) ? before.pokemon_provider : 'tcgdex';
    if (provider !== undefined && previous !== provider) {
      console.log(`Pokémon provider changed to ${provider} — re-syncing sets and the TCGplayer product map.`);
      // utils/backgroundWork: on a phone, a background job of its own.
      require('../utils/backgroundWork').start('Pokémon provider switch', async () => {
        // First, and apart from the rest: Bindarr's Pokémon scan catalog is keyed by
        // TCGdex ids, so it goes on with TCGdex and off without, whether or not the
        // provider below can be reached. Local work only (state files).
        await require('../catalogReleases').applyProvider().catch((e) => {
          console.error(`Provider switch: the Pokémon scan catalog could not follow: ${e.message}`);
        });
        try {
          const source = await require('../utils/pokemonProvider').apiFor('en');
          await source.fetchAndCacheSets(true);
          await require('../utils/compartmentSort').loadSetsCache(db);
          require('../tcgplayerCatalog').start();
        } catch (e) {
          console.error(`Provider switch follow-up failed: ${e.message}`);
        }
      });
    }
    // Its own write, which also queues the fetch of newly enabled categories, so
    // it runs after the transaction rather than inside it.
    if (sealed_tcg_extra_enabled !== undefined) {
      await require('../tcgcsvApi').setSealedExtraEnabled(sealed_tcg_extra_enabled);
    }

    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error('Failed to update settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
// Exported for tests.
module.exports.isNewer = isNewer;
