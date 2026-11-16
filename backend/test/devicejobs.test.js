// Device mode's background jobs (src/embedded/index.js): what a launch does once
// the database is open, the clocks that keep the weekly and daily jobs weekly and
// daily, and stopping them all when the app leaves device mode.
//
// Device mode owns the TCGCSV switch here, as on a phone. Nothing reaches the
// network: the harness fails every axios request, and the TCGCSV sync itself is
// replaced by a spy.
const assert = require('assert');
const { loadEmbedded, gate, sleep } = require('./deviceHarness');

// Every transaction the driver sees begin, while a test is watching.
const begins = { watching: false, seen: [] };
const { embedded, db, cleanup } = loadEmbedded('devicejobs', {
  ownTcgcsvSwitch: true,
  observe(sql) {
    if (begins.watching && /^\s*(BEGIN|SAVEPOINT)\b/i.test(sql)) begins.seen.push(sql);
  },
});
const tcgcsv = require('../src/tcgcsvApi');
const tcgdex = require('../src/tcgdexApi');
const tcgcsvGames = require('../src/tcgcsvGameApi');

// What the device asked TCGCSV for, and with the switch in which position. A
// test that needs the sync to do something sets syncImpl.
const syncCalls = [];
let syncResult = { updated: false, skipped: 'no-demand', requests: 0 };
let syncImpl = null;
tcgcsv.syncIfUpdatedSafely = async (context, options) => {
  syncCalls.push({ context, options, switch: process.env.BINDARR_DISABLE_TCGCSV_SYNC });
  return syncImpl ? syncImpl(context, options) : syncResult;
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

// Resolves with the promise's value, or 'still waiting' after `ms`.
const within = (promise, ms) => {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

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

// The Pokémon product map builds as a background unit: its data first, in a
// TCGCSV turn of its own, then its transactions in turn with requests (MOB-02,
// MOB-09).
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
  // Its sync writes the TCGCSV cache, so it waits its turn rather than writing
  // under a request (its downloads let the turn go again: testFirstUse...).
  assert.deepStrictEqual(syncCalls, [], 'its TCGCSV sync does not run under the request holding the turn');
  assert.strictEqual((await embedded.productMap.summary('pokemon')).progress.phase, 'queued',
    'reported as building while it waits, so the scan screen keeps polling');
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM tcgplayer_catalog`)).n, 0, 'nothing written during the request');

  release.open();
  await request;
  await until('the product map', async () => !(await embedded.productMap.summary('pokemon')).progress);
  assert.deepStrictEqual(syncCalls[0] && [syncCalls[0].context, syncCalls[0].switch, !!(syncCalls[0].options && syncCalls[0].options.explicit)],
    ['product map', undefined, true], 'its TCGCSV data is synced first, explicitly, with the switch lifted');
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM tcgplayer_catalog WHERE game = 'pokemon'`)).n, 3);
  // The build's own sync call, inside its turn, met the switch and did not wait on
  // the network (the spy saw it with the switch on).
  assert.deepStrictEqual(syncCalls.slice(1).map(c => c.switch), ['1']);
  assert.ok(Date.now() - Number(await state('tcgcsv_synced_at')) < 60 * 1000, 'the product map sync counts as this week\'s');
}

// A game served from TCGplayer's catalogue, opened for the first time: its
// category is synced and its cards written in a TCGCSV turn of their own, while
// the request that asked answers at once from the cache and says the list is
// still coming. The download goes out with the turn let go, so the app is not
// queued behind it, and a later request finds the cards (MOB-02, MOB-09).
const YGO = 2;   // its TCGplayer category (shared/games.json)
async function testFirstUseIsABackgroundUnit() {
  const downloading = gate();
  const download = gate();
  tcgcsv.client.defaults.adapter = async (config) => {
    downloading.open();
    await download.promise;
    return { data: 'v1', status: 200, statusText: 'OK', headers: {}, config };
  };
  syncCalls.length = 0;
  syncImpl = async () => {
    // The download, through tcgcsvApi's own client as the real sync makes it...
    await tcgcsv.client.get('/last-updated.txt');
    // ...then the category into the cached version, in one transaction.
    await db.withTransaction(async () => {
      const put = (p, rows) => db.run(
        `INSERT OR REPLACE INTO tcgcsv_cache (path, data_version, results_json) VALUES (?, 'v1', ?)`, [p, JSON.stringify(rows)]);
      await put(`/tcgplayer/${YGO}/groups`, [{ groupId: 501, name: 'Legend of Blue Eyes White Dragon', abbreviation: 'LOB', publishedOn: '2002-03-08' }]);
      await put(`/tcgplayer/${YGO}/501/products`, [{ productId: 5011, name: 'Dark Magician', number: 'LOB-005' }]);
      await put(`/tcgplayer/${YGO}/501/prices`, [{ productId: 5011, subTypeName: 'Unlimited', marketPrice: 30 }]);
    });
    return { updated: true, dataVersion: 'v1' };
  };

  const first = await within(call('GET', '/api/search?game=yugioh&name=Dark'), 2000);
  assert.notStrictEqual(first, 'still waiting', 'the search answers without waiting for the sync');
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(first.json, [], 'from the cache, which holds no Yu-Gi-Oh! card yet');
  assert.strictEqual(first.headers['x-catalogue-pending'], '1', 'and says the list is still coming');

  // The sync is at its download, with the turn let go: requests are answered.
  assert.strictEqual(await within(downloading.promise.then(() => 'downloading'), 2000), 'downloading');
  const during = await within(call('GET', '/api/sets?game=yugioh'), 2000);
  assert.notStrictEqual(during, 'still waiting', 'a request is not queued behind the download');
  assert.deepStrictEqual(during.json, []);
  assert.strictEqual(during.headers['x-catalogue-pending'], '1');
  const note = await within(call('POST', '/api/notes', { title: 'written during the download' }), 2000);
  assert.strictEqual(note.status, 201, 'a write too');
  assert.deepStrictEqual(syncCalls.map(c => [c.context, c.switch]), [['first use of Yu-Gi-Oh!', undefined]],
    'one sync, with the switch lifted, however many requests ask meanwhile');

  download.open();
  await until('the Yu-Gi-Oh! cards', async () => (await call('GET', '/api/search?game=yugioh&name=Dark')).json.length === 1);
  const found = await call('GET', '/api/search?game=yugioh&name=Dark');
  assert.strictEqual(found.json[0].id, 'yugioh-5011');
  assert.strictEqual(found.json[0].price_normal, 30);
  assert.strictEqual(found.headers['x-catalogue-pending'], undefined, 'and no longer says it is coming');
  const sets = await call('GET', '/api/sets?game=yugioh');
  assert.deepStrictEqual(sets.json.map(s => s.id), ['yugioh-lob']);
  assert.strictEqual(sets.headers['x-catalogue-pending'], undefined);
  assert.strictEqual(syncCalls.length, 1, 'nothing synced twice');
  assert.ok(Date.now() - Number(await state('tcgcsv_synced_at')) < 60 * 1000, "the first use's sync counts as this week's");

  // A first use that brings nothing (no network, say) is tried once: the requests
  // after it answer from the cache, and do not each start another for a while.
  syncImpl = async () => null;
  syncCalls.length = 0;
  const miss = await call('GET', '/api/search?game=onepiece&name=Luffy');
  assert.strictEqual(miss.headers['x-catalogue-pending'], '1');
  await until('the One Piece first use to end',
    async () => !(await call('GET', '/api/sets?game=onepiece')).headers['x-catalogue-pending']);
  const again = await call('GET', '/api/search?game=onepiece&name=Luffy');
  assert.deepStrictEqual(again.json, []);
  assert.strictEqual(again.headers['x-catalogue-pending'], undefined, 'not said to be coming when it is not');
  await sleep(50);
  assert.deepStrictEqual(syncCalls.map(c => c.context), ['first use of One Piece'], 'one try, not one per request');
  syncImpl = null;
}

// The jobs a launch and its timers start run as background units: the set
// refresh, which rewrites the TCGplayer-catalogue games' catalogues
// (tcgcsvGameApi.fetchAndCacheSets), and the price sweeps, which do too
// (tcgcsvGameApi.updateCollectionPrices). A transaction one opens while a request
// holds the turn waits for that request, instead of opening under it as the
// request's own — where a rollback would take the request's writes with it, and
// the request's own transaction would become a savepoint in the job's (MOB-02).
async function testScheduledJobsWaitForTheRequest() {
  const darkMagician = async () => (await db.get(`SELECT price_normal FROM card_cache WHERE id = 'yugioh-5011'`)).price_normal;
  // A new TCGCSV day on which Dark Magician's price moved: its catalogue is behind.
  async function newDay(version, price) {
    const { v } = await db.get(`SELECT tcgcsv_data_version AS v FROM app_settings WHERE id = 1`);
    await db.run(`INSERT OR REPLACE INTO tcgcsv_cache (path, data_version, results_json)
                  SELECT path, ?, results_json FROM tcgcsv_cache WHERE data_version = ?`, [version, v]);
    await db.run(`UPDATE tcgcsv_cache SET results_json = ? WHERE path = ? AND data_version = ?`,
      [JSON.stringify([{ productId: 5011, subTypeName: 'Unlimited', marketPrice: price }]), `/tcgplayer/${YGO}/501/prices`, version]);
    await db.run(`UPDATE app_settings SET tcgcsv_data_version = ? WHERE id = 1`, [version]);
  }
  // A request holds the turn while `launch` starts the jobs; then it lets go.
  async function whileARequestHoldsTheTurn(job, launch, { before, after }) {
    const entered = gate();
    const release = gate();
    held.entered = entered.open;
    held.release = release.promise;
    const request = call('POST', '/api/__device-jobs-test/hold', {});
    await entered.promise;
    begins.seen.length = 0;
    begins.watching = true;
    await launch();
    await sleep(300);
    begins.watching = false;
    assert.deepStrictEqual(begins.seen, [], `${job}: no transaction opens while a request holds the turn`);
    assert.strictEqual(await darkMagician(), before, `${job}: nothing written under the request`);
    release.open();
    assert.strictEqual((await request).status, 200);
    await until(`${job} to write once the request is done`, async () => (await darkMagician()) === after);
    await embedded.stop();   // and lets the rest of the launch's jobs finish
  }

  await embedded.stop();
  assert.strictEqual(await darkMagician(), 30, 'as the first use wrote it');

  // The set refresh every launch starts.
  await newDay('v2', 31);
  await whileARequestHoldsTheTurn('the set refresh', () => embedded.start(), { before: 30, after: 31 });

  // The launch's first price sweep, brought forward from 30 s to now. The set
  // refresh is kept off the catalogue this time, so what writes it is the sweep.
  await newDay('v3', 32);
  const fetchAndCacheSets = tcgcsvGames.fetchAndCacheSets;
  tcgcsvGames.fetchAndCacheSets = async () => {};
  try {
    await whileARequestHoldsTheTurn('the price sweep', async () => {
      const setTimeoutAsIs = global.setTimeout;
      global.setTimeout = (fn, ms, ...rest) => setTimeoutAsIs(fn, ms === 30000 ? 0 : ms, ...rest);
      try {
        await embedded.start();
      } finally {
        global.setTimeout = setTimeoutAsIs;
      }
    }, { before: 31, after: 32 });
  } finally {
    tcgcsvGames.fetchAndCacheSets = fetchAndCacheSets;
  }
  assert.deepStrictEqual(logged.filter(l => /^Device .* failed/.test(l)), [], 'no job failed');
}

// Work a request starts and does not wait for (a search's price refresh, the
// Pokémon TCGplayer rows, a re-price after a settings change: utils/backgroundWork)
// is a background unit of its own. So it opens no transaction under the request
// that started it, and a download it makes later cannot let a running job's turn
// go — which, running in nobody's turn, it did: the axios hook let go of whatever
// background unit held the turn at that moment.
const leftRunning = { entered: null, spawn: null, done: null, go: null, download: null, promise: null };
embedded.app.post('/api/__device-jobs-test/spawn', async (req, res) => {
  leftRunning.entered();
  await leftRunning.spawn;
  const provider = require('axios').create({
    adapter: async (config) => {
      await leftRunning.download;
      return { data: 'ok', status: 200, statusText: 'OK', headers: {}, config };
    },
  });
  leftRunning.promise = require('../src/utils/backgroundWork').start('test: work a request leaves running', async () => {
    await db.withTransaction(() => db.run(`INSERT INTO notes (user_id, title) VALUES (1, 'left running')`));
    await leftRunning.go;
    await provider.get('/download');
  });
  await leftRunning.done;
  res.json({ ok: true });
});
// A request that starts a real piece of such work: the Pokémon TCGplayer rows
// (routes/sets.js and tcgdexApi start them the same way), then holds its turn.
const ensuring = { entered: null, release: null };
embedded.app.post('/api/__device-jobs-test/ensure', async (req, res) => {
  require('../src/pokemonTcgplayer').ensure('Japanese').catch(() => {});
  ensuring.entered();
  await ensuring.release;
  res.json({ ok: true });
});

async function testRequestStartedWorkIsABackgroundUnit() {
  const notes = async (title) => (await db.get(`SELECT COUNT(*) n FROM notes WHERE title = ?`, [title])).n;
  const entered = gate(), spawn = gate(), done = gate(), go = gate(), download = gate();
  Object.assign(leftRunning, { entered: entered.open, spawn: spawn.promise, done: done.promise, go: go.promise, download: download.promise });
  const request = call('POST', '/api/__device-jobs-test/spawn', {});
  await entered.promise;
  // A job queued behind the request, so it holds the turn next.
  const jobIn = gate(), jobGo = gate();
  const job = embedded.background('a job', async () => {
    jobIn.open();
    await jobGo.promise;
    await db.run(`INSERT INTO notes (user_id, title) VALUES (1, 'the job')`);
  });
  await sleep(10);
  begins.seen.length = 0;
  begins.watching = true;
  spawn.open();
  await sleep(100);
  begins.watching = false;
  assert.deepStrictEqual(begins.seen, [], 'work a request starts opens no transaction while that request holds the turn');
  assert.strictEqual(await notes('left running'), 0);
  done.open();
  assert.strictEqual((await request).status, 200);

  // The job holds the turn. The work goes on to download — or would, if it ran.
  await jobIn.promise;
  const queued = call('POST', '/api/notes', { title: 'queued behind the job' });
  go.open();
  await sleep(150);
  assert.strictEqual(await within(queued, 10), 'still waiting', "the work lets nobody into a running job's turn");
  assert.strictEqual(await notes('the job'), 0);
  jobGo.open();
  await job;
  download.open();
  assert.strictEqual((await queued).status, 201);
  await within(leftRunning.promise, 2000);
  assert.strictEqual(await notes('left running'), 1, 'and runs once the job is done');

  // A real one: nothing of the Pokémon TCGplayer rows' work runs inside the request.
  const pokemonProvider = require('../src/utils/pokemonProvider');
  const providerFor = pokemonProvider.providerFor;
  let asked = 0;
  pokemonProvider.providerFor = async (...args) => { asked++; return providerFor(...args); };
  try {
    const inRequest = gate(), release = gate();
    Object.assign(ensuring, { entered: inRequest.open, release: release.promise });
    const holding = call('POST', '/api/__device-jobs-test/ensure', {});
    await inRequest.promise;
    await sleep(50);
    assert.strictEqual(asked, 0, 'the Pokémon TCGplayer rows wait for the request that asked for them');
    release.open();
    await holding;
    await until('the Pokémon TCGplayer rows to start', async () => asked > 0);
  } finally {
    pokemonProvider.providerFor = providerFor;
  }
}

async function main() {
  try {
    ({ token } = await embedded.start({ background: false }));
    await seedSets();
    await testLaunchRunsEveryStep();
    await testStopAndRestart();
    await testProductMapIsABackgroundUnit();
    await testFirstUseIsABackgroundUnit();
    await testScheduledJobsWaitForTheRequest();
    await testRequestStartedWorkIsABackgroundUnit();
  } finally {
    console.error = consoleError;
    await cleanup();
  }
}

main()
  .then(() => console.log('Device-mode background jobs check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
