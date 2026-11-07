// The price sweep list and the runner that walks it (utils/priceSweeps).
//
// Three things the old six bare calls in server.js got wrong, each asserted here:
// they all started at once, so "TCGCSV runs last" described nothing; a tick never
// checked whether the last run had finished; and a gate key missing from
// SWEEP_COLUMN made a sweep go quiet with no error anywhere (tcgcsv first, then
// Lorcana) — shouldSweepPrices answers false for a key it does not know.
//
// No framework — plain node + assert, no network: every provider's sweep is
// stubbed. Run: `node test/pricesweeplist.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The provider modules open the database when they load.
const tmpDb = path.join(os.tmpdir(), `bindarr-pricesweeplist-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { PRICE_SWEEPS, runPriceSweeps, requestStop, current } = require('../src/utils/priceSweeps');
const { SWEEP_COLUMN } = require('../src/utils/priceHelpers');

// A logger that remembers instead of printing.
function quietLog() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
}

function gatesMatch() {
  const keys = PRICE_SWEEPS.map(s => s.key);
  assert.ok(keys.length >= 6, 'the sweep list is not empty');
  assert.strictEqual(new Set(keys).size, keys.length, 'no provider is listed twice');
  for (const sweep of PRICE_SWEEPS) {
    assert.strictEqual(typeof sweep.run, 'function', `${sweep.key} has a run function`);
    assert.ok(SWEEP_COLUMN[sweep.key], `sweep "${sweep.key}" has no SWEEP_COLUMN key, so it would never run`);
  }
  for (const key of Object.keys(SWEEP_COLUMN)) {
    assert.ok(keys.includes(key), `SWEEP_COLUMN has "${key}" but no sweep uses it`);
  }
  // TCGCSV has the final say on Pokémon prices, so it follows every other writer
  // of those columns.
  const at = (k) => keys.indexOf(k);
  for (const k of ['pokemon', 'tcgdex', 'pokemontcgapi']) {
    assert.ok(at(k) < at('tcgcsv'), `${k} must run before tcgcsv`);
  }
}

async function sequentialAndIsolated() {
  const events = [];
  const sweep = (key, body) => ({
    key,
    run: async () => {
      events.push(`start ${key}`);
      await new Promise(r => setTimeout(r, 15));
      if (body) await body();
      events.push(`end ${key}`);
    },
  });
  const q = quietLog();
  const result = await runPriceSweeps({
    log: q,
    sweeps: [
      sweep('a'),
      { key: 'sync-throw', run: () => { events.push('start sync-throw'); throw new Error('thrown synchronously'); } },
      sweep('reject', async () => { throw new Error('rejected'); }),
      sweep('b'),
    ],
  });
  assert.deepStrictEqual(events, ['start a', 'end a', 'start sync-throw', 'start reject', 'start b', 'end b'],
    'each sweep starts only after the one before it has finished, and a failure does not stop the rest');
  assert.strictEqual(result.skipped, false);
  assert.deepStrictEqual(result.sweeps.map(s => [s.key, s.status]),
    [['a', 'ok'], ['sync-throw', 'error'], ['reject', 'error'], ['b', 'ok']]);
  assert.strictEqual(result.sweeps[1].error, 'thrown synchronously');
  assert.strictEqual(result.sweeps[2].error, 'rejected');
  assert.ok(result.sweeps.every(s => typeof s.ms === 'number'), 'every entry carries its duration');
  assert.ok(q.lines.some(l => l.includes('reject') && l.includes('rejected')), 'a failure is logged with its sweep');
  assert.strictEqual(current(), null, 'nothing is left marked as running');
}

async function singleFlight() {
  let release;
  const hold = new Promise(r => { release = r; });
  let started;
  const begun = new Promise(r => { started = r; });
  let calls = 0;
  const q = quietLog();
  const first = runPriceSweeps({ log: q, sweeps: [{ key: 'slow', run: async () => { calls++; started(); await hold; } }] });
  await begun;
  const second = await runPriceSweeps({ log: q, sweeps: [{ key: 'slow', run: async () => { calls++; } }] });
  assert.strictEqual(second.skipped, true, 'a tick that finds a run in progress skips');
  assert.ok(q.lines.some(l => /still going/.test(l)), 'and says so');
  assert.strictEqual(current(), first, 'the run in progress is the first one');
  release();
  const done = await first;
  assert.strictEqual(done.skipped, false);
  assert.strictEqual(calls, 1, 'the sweep ran once, not twice');
  const third = await runPriceSweeps({ log: q, sweeps: [{ key: 'slow', run: async () => { calls++; } }] });
  assert.strictEqual(third.skipped, false, 'once the run finishes the next tick runs normally');
  assert.strictEqual(calls, 2);
}

async function stopsBetweenSweeps() {
  const ran = [];
  const q = quietLog();
  let handedBack;
  const run = runPriceSweeps({
    log: q,
    sweeps: [
      { key: 'one', run: async () => { ran.push('one'); handedBack = requestStop(); } },
      { key: 'two', run: async () => { ran.push('two'); } },
      { key: 'three', run: async () => { ran.push('three'); } },
    ],
  });
  const result = await run;
  assert.strictEqual(handedBack, run, 'requestStop hands back the run in progress');
  assert.deepStrictEqual(ran, ['one'], 'a stop request lets the current sweep finish and starts no other');
  assert.deepStrictEqual(result.sweeps.map(s => s.status), ['ok', 'stopped', 'stopped']);
  assert.strictEqual(requestStop(), null, 'nothing to stop once the run is over');
  const again = await runPriceSweeps({ log: q, sweeps: [{ key: 'four', run: async () => { ran.push('four'); } }] });
  assert.strictEqual(again.sweeps[0].status, 'ok', 'a later run is not stopped by an old request');
}

// The real list, with every provider stubbed: it calls each module's exported
// sweep, in order, and a TCGCSV failure is reported without taking any other
// sweep with it.
async function realListCallsTheProviders() {
  const modules = {
    pokemon: require('../src/tcgApi'),
    mtg: require('../src/scryfallApi'),
    lorcana: require('../src/lorcastApi'),
    tcgdex: require('../src/tcgdexApi'),
    pokemontcgapi: require('../src/pokemontcgapi'),
    tcgcsv: require('../src/tcgcsvApi'),
  };
  const originals = {};
  const called = [];
  for (const [key, mod] of Object.entries(modules)) {
    originals[key] = mod.updateCollectionPrices;
    mod.updateCollectionPrices = async () => {
      called.push(key);
      if (key === 'tcgcsv') throw new Error('TCGCSV is down');
    };
  }
  try {
    const q = quietLog();
    let result = await runPriceSweeps({ log: q });
    assert.deepStrictEqual(called, ['pokemon', 'mtg', 'lorcana', 'tcgdex', 'pokemontcgapi', 'tcgcsv'],
      'the real list calls every provider\'s updateCollectionPrices, TCGCSV last');
    assert.deepStrictEqual(result.sweeps.filter(s => s.status !== 'ok').map(s => [s.key, s.error]),
      [['tcgcsv', 'TCGCSV is down']], 'only the TCGCSV sweep is reported as failed');

    // An earlier sweep failing does not keep TCGCSV from running either.
    called.length = 0;
    modules.mtg.updateCollectionPrices = async () => { called.push('mtg'); throw new Error('Scryfall is down'); };
    modules.tcgcsv.updateCollectionPrices = async () => { called.push('tcgcsv'); };
    result = await runPriceSweeps({ log: q });
    assert.strictEqual(called[called.length - 1], 'tcgcsv', 'TCGCSV still runs after an earlier failure');
    assert.deepStrictEqual(result.sweeps.filter(s => s.status !== 'ok').map(s => s.key), ['mtg']);
  } finally {
    for (const [key, mod] of Object.entries(modules)) mod.updateCollectionPrices = originals[key];
  }
}

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function main() {
  gatesMatch();
  await sequentialAndIsolated();
  await singleFlight();
  await stopsBetweenSweeps();
  await realListCallsTheProviders();
  console.log('pricesweeplist.test.js: sweeps run in order, one run at a time, failures isolated, every gate known');
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async err => { console.error(err); await cleanup(); process.exit(1); });
