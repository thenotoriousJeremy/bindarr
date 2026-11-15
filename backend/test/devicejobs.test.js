// Device mode's background jobs (src/embedded/index.js): what a launch does once
// the database is open, the clocks that keep the weekly and daily jobs weekly and
// daily, and stopping them all when the app leaves device mode.
//
// Device mode owns the TCGCSV switch here, as on a phone. Nothing reaches the
// network: the harness fails every axios request, and the TCGCSV sync itself is
// replaced by a spy.
const assert = require('assert');
const { loadEmbedded, gate, sleep } = require('./deviceHarness');

const { embedded, db, cleanup } = loadEmbedded('devicejobs', { ownTcgcsvSwitch: true });
const tcgcsv = require('../src/tcgcsvApi');
const tcgdex = require('../src/tcgdexApi');

// What the device asked TCGCSV for, and with the switch in which position.
const syncCalls = [];
let syncResult = { updated: false, skipped: 'no-demand', requests: 0 };
tcgcsv.syncIfUpdatedSafely = async (context, options) => {
  syncCalls.push({ context, options, switch: process.env.BINDARR_DISABLE_TCGCSV_SYNC });
  return syncResult;
};
tcgdex.listSets = async () => [];

// Errors the jobs logged, so a step that quietly throws fails the test.
const logged = [];
const consoleError = console.error;
console.error = (...args) => {
  logged.push(args.map(String).join(' '));
  consoleError(...args);
};

let token;
async function call(method, url, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await embedded.handle({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}

const state = async (key) => (await db.get(`SELECT value FROM device_state WHERE key = ?`, [key]).catch(() => null))?.value ?? null;
const timeouts = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

async function until(what, check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// Every game's set table already filled and refreshed this week, so the launch's
// set step reads the database and asks no provider anything.
async function seedSets() {
  for (const [id, game] of [['tst1', 'pokemon'], ['mtg-tst', 'mtg'], ['lor-tst', 'lorcana']]) {
    await db.run(`INSERT OR IGNORE INTO sets (id, name, game, total, printed_total, release_date) VALUES (?, ?, ?, 1, 1, '2020-01-01')`, [id, id, game]);
  }
  await db.run(`CREATE TABLE IF NOT EXISTS device_state (key TEXT PRIMARY KEY, value TEXT)`);
  await db.run(`INSERT OR REPLACE INTO device_state (key, value) VALUES ('sets_refreshed_at', ?)`, [String(Date.now())]);
}

// A launch runs every upkeep step: the set lists, TCGCSV, the trash. The first one
// used to call a helper that no longer exists, which threw and skipped the rest.
async function testLaunchRunsEveryStep() {
  // One copy past its 30 days in the trash, one deleted today.
  await db.run(`INSERT INTO collection_trash (batch_id, user_id, entry_id, card_id, row_json, deleted_at)
                VALUES ('00000000-0000-4000-8000-000000000001', 1, 900001, 'x', '{}', DATETIME('now', '-40 days')),
                       ('00000000-0000-4000-8000-000000000002', 1, 900002, 'y', '{}', DATETIME('now'))`);
  assert.strictEqual(process.env.BINDARR_DISABLE_TCGCSV_SYNC, '1', 'the TCGCSV switch is on from the start');

  await embedded.start();
  await until('the trash purge', async () => (await state('trash_purged_at')) !== null);

  assert.deepStrictEqual(logged.filter(l => /^Device .* failed/.test(l)), [], 'no upkeep step failed');
  const ids = (await db.all(`SELECT entry_id FROM collection_trash ORDER BY entry_id`)).map(r => r.entry_id);
  assert.deepStrictEqual(ids, [900002], 'only the copy past its 30 days is purged');

  // TCGCSV (MOB-09): asked once, with the switch lifted for that one call only.
  assert.deepStrictEqual(syncCalls.map(c => [c.context, c.switch]), [['the device weekly sync', undefined]]);
  assert.strictEqual(process.env.BINDARR_DISABLE_TCGCSV_SYNC, '1', 'and back on afterwards');
  assert.strictEqual(await state('tcgcsv_synced_at'), null, 'nothing to sync yet (no Pokémon card) does not start the week');
}

// Leaving device mode stops every timer the jobs set; coming back starts them again.
async function testStopAndRestart() {
  const running = timeouts();
  embedded.stop();
  assert.ok(timeouts() <= running - 4, `stop() clears the price, exchange-rate and upkeep timers (${running} -> ${timeouts()})`);
  const stopped = timeouts();

  syncResult = { updated: true, dataVersion: 'v1', requests: 5 };
  await embedded.start();
  assert.ok(timeouts() >= stopped + 4, 'start() after stop() schedules them again');
  await until('a recorded weekly sync', async () => (await state('tcgcsv_synced_at')) !== null);
  assert.strictEqual(syncCalls.length, 2);

  // A third launch within the week leaves TCGCSV alone.
  embedded.stop();
  await embedded.start();
  await sleep(100);
  assert.strictEqual(syncCalls.length, 2, 'at most one TCGCSV sync a week on a phone');
  embedded.stop();

  // The hourly price sweep's own sync call meets the switch: it prices from the
  // cached version instead (a real call here, not the spy).
  const { syncIfUpdated } = require('../src/tcgcsvApi');
  assert.deepStrictEqual(await syncIfUpdated(), { updated: false, disabled: true });
}

// The Pokémon product map builds as a background unit: its data first, outside
// the turn, then its transactions in turn with requests (MOB-02, MOB-09).
async function seedTcgcsvCache() {
  await db.run(`UPDATE app_settings SET tcgcsv_data_version = 'v1' WHERE id = 1`);
  const rows = {
    '/tcgplayer/3/groups': [{ groupId: 101, name: 'SV01: Test Base Set', abbreviation: 'SV01' }, { groupId: 102, name: 'Test Two', abbreviation: 'TT' }],
    '/tcgplayer/85/groups': [],
    '/tcgplayer/3/101/products': [{ productId: 1, name: 'Card A', number: '001/100' }, { productId: 2, name: 'Test Booster Box' }],
    '/tcgplayer/3/102/products': [{ productId: 3, name: 'Card B', number: '5' }],
  };
  for (const [path, results] of Object.entries(rows)) {
    await db.run(`INSERT OR REPLACE INTO tcgcsv_cache (path, data_version, results_json) VALUES (?, 'v1', ?)`, [path, JSON.stringify(results)]);
  }
}

const held = { entered: null, release: null };
embedded.app.post('/api/__device-jobs-test/hold', async (req, res) => {
  held.entered();
  await held.release;
  res.json({ ok: true });
});

async function testProductMapIsABackgroundUnit() {
  await seedTcgcsvCache();
  syncCalls.length = 0;
  // A week-old clock: the build's own sync must start the week again, or the
  // next launch would download every Pokémon group a second time.
  await db.run(`UPDATE device_state SET value = ? WHERE key = 'tcgcsv_synced_at'`, [String(Date.now() - 8 * 24 * 3600 * 1000)]);
  const entered = gate();
  const release = gate();
  held.entered = entered.open;
  held.release = release.promise;
  const request = call('POST', '/api/__device-jobs-test/hold', {});
  await entered.promise;

  const queued = embedded.productMap.start('pokemon');
  assert.strictEqual(queued.phase, 'queued');
  assert.throws(() => embedded.productMap.start('pokemon'), /already building/);
  await sleep(100);
  assert.deepStrictEqual(syncCalls.map(c => [c.context, c.switch, !!(c.options && c.options.explicit)]),
    [['product map', undefined, true]], 'its TCGCSV data is fetched first, before its turn');
  assert.strictEqual((await embedded.productMap.summary('pokemon')).progress.phase, 'queued',
    'reported as building while it waits, so the scan screen keeps polling');
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM tcgplayer_catalog`)).n, 0, 'nothing written during the request');

  release.open();
  await request;
  await until('the product map', async () => !(await embedded.productMap.summary('pokemon')).progress);
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM tcgplayer_catalog WHERE game = 'pokemon'`)).n, 3);
  // The build's own sync call, inside its turn, met the switch and did not wait on
  // the network (the spy saw it with the switch on).
  assert.deepStrictEqual(syncCalls.slice(1).map(c => c.switch), ['1']);
  assert.ok(Date.now() - Number(await state('tcgcsv_synced_at')) < 60 * 1000, 'the product map sync counts as this week\'s');
}

async function main() {
  try {
    ({ token } = await embedded.start({ background: false }));
    await seedSets();
    await testLaunchRunsEveryStep();
    await testStopAndRestart();
    await testProductMapIsABackgroundUnit();
  } finally {
    console.error = consoleError;
    await cleanup();
  }
}

main()
  .then(() => console.log('Device-mode background jobs check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
