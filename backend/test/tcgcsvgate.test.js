// Magic/Lorcana sealed tracking gates TCGCSV categories 1 and 71.
//
// Pricing Magic and Lorcana sealed product means the daily sync walks every MTG
// and Lorcana group, a multiple of the Pokémon requests, and per-install volume
// is what got Bindarr blocked by TCGCSV once. So 1 and 71 are off until an admin
// turns them on, and turning them on mid-dataset fetches ONLY those categories:
// the current version is resumed, not re-downloaded.
//
// Offline: axios's adapter is replaced, nothing reaches tcgcsv.com.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-tcgcsvgate-${process.pid}.db`);
process.env.TCGCSV_BASE_URL = 'https://tcgcsv-cache.example.test';
const tcgcsv = require('../src/tcgcsvApi');
const db = require('../src/db');

const VERSION = '2026-11-07T20:05:50+0000';
const requests = [];
tcgcsv.client.defaults.adapter = async (config) => {
  requests.push(config.url);
  const groups = config.url.match(/^\/tcgplayer\/(\d+)\/groups$/);
  const data = config.url === '/last-updated.txt'
    ? VERSION
    : { success: true, results: groups ? [{ groupId: Number(groups[1]) * 10, name: 'G', abbreviation: 'G' }] : [] };
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
const categoryOf = (p) => (p.match(/^\/tcgplayer\/(\d+)\//) || [])[1];
const waitFor = async (cond) => {
  for (let i = 0; i < 200 && !(await cond()); i++) await new Promise(r => setTimeout(r, 25));
};

(async () => {
  try {
    await db.initDb();

    assert.strictEqual(await tcgcsv.sealedExtraEnabled(), false, 'off by default');
    assert.deepStrictEqual(await tcgcsv.syncCategories(), [3, 85]);

    // A fresh database: nothing to price, so the automatic sync (boot, schedule,
    // price sweep) makes ZERO requests, and says so once rather than every tick.
    const logged = [];
    const realLog = console.log;
    console.log = (...a) => { logged.push(a.join(' ')); };
    let skipped;
    try {
      skipped = await tcgcsv.syncIfUpdated();
      await tcgcsv.syncIfUpdated();
      await tcgcsv.syncIfUpdatedSafely('price update');
    } finally {
      console.log = realLog;
    }
    assert.strictEqual(skipped.skipped, 'no-demand');
    assert.strictEqual(requests.length, 0, `a fresh database must not contact TCGCSV (saw ${requests.join(', ')})`);
    assert.strictEqual(logged.filter(l => /TCGCSV sync skipped/.test(l)).length, 1, 'the skip is logged once');
    console.log('PASS: a fresh database makes zero TCGCSV requests, and logs the skip once');

    // One Pokémon card in one collection is enough for the next sync to run.
    const user = (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('g', 'x', 'g')`)).lastID;
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('gate-card', 'Gate', 'pokemon')`);
    await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES ('gate-card', ?, 1)`, [user]);

    // Off: the sync never asks for Magic or Lorcana.
    await tcgcsv.syncIfUpdated();
    const offCategories = new Set(requests.map(categoryOf).filter(Boolean));
    assert.deepStrictEqual([...offCategories].sort(), ['3', '85'], `only 3/85 while off (saw ${requests.join(', ')})`);
    assert.strictEqual(requests.length, 1 + 2 + 2 * 2, 'last-updated + 2 group lists + products/prices for 2 groups');
    console.log('PASS: categories 1 and 71 are not requested while Magic/Lorcana sealed tracking is off');

    // The product map refuses to build Magic from the cache while off.
    const catalog = require('../src/tcgplayerCatalog');
    catalog.start('mtg');
    await waitFor(async () => !catalog.state());
    const { last } = await catalog.summary('mtg');
    assert.strictEqual(last?.phase, 'error', 'mtg product map refused while off');
    assert.match(last.message, /Instance Settings/);
    assert.ok(requests.every(p => !['1', '71'].includes(categoryOf(p))), 'and fetched nothing for it');
    console.log('PASS: the Magic product map will not build while off');

    // On: only the newly enabled categories are fetched, from the current version.
    const before = requests.length;
    await tcgcsv.setSealedExtraEnabled(true);
    await waitFor(async () => (await db.get(`SELECT tcgcsv_pending_version p FROM app_settings WHERE id = 1`)).p === null
      && requests.length > before);
    const added = requests.slice(before);
    assert.ok(added.length > 0, 'enabling fetches the new categories without waiting for tomorrow');
    assert.ok(added.every(p => ['1', '71'].includes(categoryOf(p))),
      `enabling re-downloads nothing it already has, and skips last-updated.txt (saw ${added.join(', ')})`);
    assert.strictEqual(added.length, 2 + 2 * 2, '2 group lists + products/prices for 2 groups');
    assert.strictEqual((await db.get(`SELECT tcgcsv_data_version v FROM app_settings WHERE id = 1`)).v, VERSION);
    assert.strictEqual((await tcgcsv.getGroups(1))[0].groupId, 10, 'Magic groups now read from the cache');
    assert.strictEqual((await tcgcsv.getGroups(3))[0].groupId, 30, 'Pokémon cache kept through the resume');
    console.log('PASS: enabling fetches only categories 1 and 71, resuming the current version');

    // Gate on but no Magic/Lorcana sealed purchase: the AUTOMATIC sync still leaves
    // 1/71 out (enabling above was explicit). One purchase brings them back.
    assert.deepStrictEqual(await tcgcsv.demandedCategories(), [3, 85], 'gate on, no MTG/Lorcana purchase');
    await db.run(`INSERT INTO sealed_purchases (user_id, product_name, game) VALUES (?, 'Bundle', 'lorcana')`, [user]);
    assert.deepStrictEqual(await tcgcsv.demandedCategories(), [3, 85, 1, 71], 'gate on and a Lorcana purchase');
    console.log('PASS: 1/71 sync automatically only with the gate on AND a Magic/Lorcana sealed purchase');

    // Off again: no request, and the next sync leaves 1/71 out.
    await tcgcsv.setSealedExtraEnabled(false);
    assert.deepStrictEqual(await tcgcsv.syncCategories(), [3, 85]);
    console.log('PASS: turning it off drops 1/71 from the next sync');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch { /* gone */ } }
  }
})();
