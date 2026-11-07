// The two recurring upstream jobs, in one place so that a server (server.js) and
// the phone app running on its own (embedded/index.js) run the same list in the
// same order. A provider added to one and not the other would quietly stop
// refreshing for half the installs.
'use strict';

const tcgApi = require('../tcgApi');
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
}

// Every provider's price refresh. Not forced: each one asks shouldSweepPrices
// whether it is due against the admin's price_refresh_days, so calling this far
// more often than that costs one indexed read per provider.
function sweepPrices() {
  tcgApi.updateCollectionPrices();
  scryfallApi.updateCollectionPrices();
  lorcastApi.updateCollectionPrices();
  // Non-English Pokémon cards: their ids 404 on pokemontcg.io, so tcgApi's sweep
  // skips them and this is their only price refresh. No-op until the user
  // actually owns one.
  require('../tcgdexApi').updateCollectionPrices();
  require('../pokemontcgapi').updateCollectionPrices();
  // TCGCSV runs LAST of the Pokémon sweeps on purpose. It writes the same columns
  // as the other two and is the better source — TCGplayer market prices in USD,
  // and 97% coverage against TCGdex's 8% — so it should have the final say on any
  // card it can place.
  require('../tcgcsvApi').updateCollectionPrices();
}

module.exports = { syncSets, sweepPrices };
