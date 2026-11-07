// The automatic price sweeps, and the one place that decides their order.
//
// They used to be six bare calls in server.js, written out twice (the hourly
// tick and the boot catch-up) and awaited in neither. So all six ran at once,
// "TCGCSV runs last" was true of the source order and nothing else, and no tick
// checked whether the previous one had finished: pokemontcg.io paces itself at a
// request a second, so about 3,600 stale cards was enough to make one sweep
// outlast the hour and the next tick start a second copy of it.
//
// Now one list, run in order, one sweep at a time and one run at a time:
//
//   · Sequential. Several sweeps write the same card_cache price columns, and
//     the order is the policy. TCGCSV is the better Pokémon source (TCGplayer
//     market prices in USD, 97% coverage against TCGdex's 8%), so it runs last
//     and has the final say on any card it can place.
//   · Single-flight. A tick that finds a run in progress logs and skips. The next
//     tick, an hour on, picks up whatever is still due.
//   · Isolated. Each sweep is caught on its own, so one that throws (a provider
//     down, a bug) cannot stop the ones after it.
//
// Each sweep still decides for itself whether it is due — shouldSweepPrices
// against its SWEEP_COLUMN gate in priceHelpers — so running the list when
// nothing is due costs one indexed read per provider. `key` IS that gate's key,
// and a key the map does not know is a sweep that silently never runs (tcgcsv
// once, then Lorcana), so test/pricesweeplist.test.js holds the two to each
// other. Adding a provider is one entry here plus its SWEEP_COLUMN key.
//
// Providers are required when their sweep runs rather than at load, as the calls
// in server.js always were.
const PRICE_SWEEPS = [
  { key: 'pokemon', run: () => require('../tcgApi').updateCollectionPrices() },
  { key: 'mtg', run: () => require('../scryfallApi').updateCollectionPrices() },
  { key: 'lorcana', run: () => require('../lorcastApi').updateCollectionPrices() },
  // Non-English Pokémon cards: their ids 404 on pokemontcg.io, so tcgApi's sweep
  // skips them and this is their only price refresh. No-op until one is owned.
  { key: 'tcgdex', run: () => require('../tcgdexApi').updateCollectionPrices() },
  { key: 'pokemontcgapi', run: () => require('../pokemontcgapi').updateCollectionPrices() },
  // Last of the Pokémon sweeps, on purpose (above). It brings the local TCGCSV
  // cache up to date before pricing from it, through syncIfUpdatedSafely, which
  // never throws: a failed or paused sync prices from the last complete cache.
  { key: 'tcgcsv', run: () => require('../tcgcsvApi').updateCollectionPrices() },
  // Riftbound: TCGplayer prices from TCGCSV category 89, by product id.
  { key: 'riftbound', run: () => require('../riftboundPrices').updateCollectionPrices() },
];

let running = null;       // the run in progress, or null
let stopRequested = false;

// Run every sweep in order. Resolves — never rejects — to a summary:
//   { skipped: true }                                  a run was already going
//   { skipped: false, sweeps: [{ key, status, ms, error? }] }
// where status is 'ok', 'error', or 'stopped' for a sweep never started because
// shutdown asked the run to stop.
function runPriceSweeps({ sweeps = PRICE_SWEEPS, log = console } = {}) {
  if (running) {
    log.log('Price sweeps: the previous run is still going; skipping this tick.');
    return Promise.resolve({ skipped: true, sweeps: [] });
  }
  stopRequested = false;
  const run = (async () => {
    // Yield once first, so `running` is set before any sweep starts: an async
    // function runs synchronously up to its first await, and the first sweep
    // would otherwise begin while the run still looked idle.
    await null;
    const results = [];
    for (const sweep of sweeps) {
      if (stopRequested) {
        results.push({ key: sweep.key, status: 'stopped', ms: 0 });
        continue;
      }
      const startedAt = Date.now();
      try {
        await sweep.run();
        results.push({ key: sweep.key, status: 'ok', ms: Date.now() - startedAt });
      } catch (err) {
        const error = String((err && err.message) || err);
        log.error(`Price sweep ${sweep.key} failed: ${error}`);
        results.push({ key: sweep.key, status: 'error', ms: Date.now() - startedAt, error });
      }
    }
    return { skipped: false, sweeps: results };
  })();
  running = run;
  const clear = () => { if (running === run) running = null; };
  run.then(clear, clear);
  return run;
}

// Ask the run in progress to stop before its next sweep. A sweep already going is
// left to finish: each one writes card by card, so stopping between them is the
// safe point. Returns the run's promise, or null when nothing is running.
function requestStop() {
  stopRequested = true;
  return running;
}

const current = () => running;

module.exports = { PRICE_SWEEPS, runPriceSweeps, requestStop, current };
