// The two recurring upstream jobs, in one place so that a server (server.js) and
// the phone app running on its own (embedded/index.js) run the same list in the
// same order. A provider added to one and not the other would quietly stop
// refreshing for half the installs.
'use strict';

const scryfallApi = require('../scryfallApi');
const lorcastApi = require('../lorcastApi');

// The set tables for all three games. Unforced only fills a table that is empty;
// forced re-fetches, which is how newly released sets arrive.
//
// Which module owns the Pokémon `sets` table is asked per call rather than
// resolved once: the provider is a setting an admin can change while the app is
// running, and the next refresh has to follow it without a restart.
async function syncSets(force = false) {
  const pokemon = await require('./pokemonProvider').apiFor('English');
  await pokemon.fetchAndCacheSets(force);
  await scryfallApi.fetchAndCacheSets(force);
  await lorcastApi.fetchAndCacheSets(force);
  // Riftbound refreshes only when forced (the weekly sets-refresh job) and only on an
  // install that has used it; first use fetches the catalogue itself (riftcodexApi).
  await require('../riftcodexApi').fetchAndCacheSets(force);
}

// Every provider's price refresh, through utils/priceSweeps: its one ordered list,
// run sequentially and single-flight. Each sweep asks shouldSweepPrices whether it
// is due, so ticking far more often than price_refresh_days costs one indexed read
// per provider. Resolves, never rejects.
const sweepPrices = () => require('./priceSweeps').runPriceSweeps();

module.exports = { syncSets, sweepPrices };
