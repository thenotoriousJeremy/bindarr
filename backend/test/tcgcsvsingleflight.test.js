// Two TCGCSV syncs must never run side by side (PROV-09).
//
// syncIfUpdated checked `syncPromise`, then awaited the demand query, and only
// then set `syncPromise`. The scheduler's tick and a settings change landing in
// that gap both got past the check, and the mirror was asked for every path
// twice. The claim is now made before the first await. An admin's explicit sync
// arriving while an on-demand one runs waits for it and then runs as asked.
//
// Offline: axios's adapter is replaced. Run: `node test/tcgcsvsingleflight.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-tcgcsvsingleflight-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.TCGCSV_BASE_URL = 'https://tcgcsv-cache.example.test';
delete process.env.BINDARR_DISABLE_TCGCSV_SYNC;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const tcgcsv = require('../src/tcgcsvApi');
const db = require('../src/db');

const VERSION = '2026-11-07T20:05:50+0000';
const requests = [];
tcgcsv.client.defaults.adapter = async (config) => {
  requests.push(config.url);
  // Slow enough that a second caller arrives while the first is mid-sync.
  await new Promise(r => setTimeout(r, 5));
  const data = config.url === '/last-updated.txt' ? VERSION : { success: true, results: [] };
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};

async function main() {
  await db.initDb();
  const quiet = { log: console.log };
  console.log = () => {};
  try {
    // 1. Nothing demanded yet: an on-demand sync skips. An explicit one that
    //    arrives meanwhile must not be answered with that skip.
    const [onDemand, explicit] = await Promise.all([
      tcgcsv.syncIfUpdated(), tcgcsv.syncIfUpdated({ explicit: true }),
    ]);
    assert.strictEqual(onDemand.skipped, 'no-demand');
    assert.strictEqual(explicit.updated, true, 'the explicit sync ran after the on-demand one');
    assert.strictEqual(requests.filter(u => u === '/last-updated.txt').length, 1);

    // 2. A Pokémon card is owned; a new version is published. The scheduler and a
    //    settings change ask at the same moment: one sync, one request per path.
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('sv1-1', 'Card', 'pokemon')`);
    await db.run(`INSERT INTO collection (user_id, card_id, quantity, game) VALUES (1, 'sv1-1', 1, 'pokemon')`);
    await db.run(`UPDATE app_settings SET tcgcsv_data_version = 'old', tcgcsv_last_checked_at = NULL WHERE id = 1`);
    requests.length = 0;
    const [a, b] = await Promise.all([tcgcsv.syncIfUpdated(), tcgcsv.syncIfUpdated()]);
    assert.strictEqual(a, b, 'the second caller joins the first run');
    assert.strictEqual(requests.filter(u => u === '/last-updated.txt').length, 1,
      `one sync, not two (saw ${requests.join(', ')})`);
    assert.strictEqual(new Set(requests).size, requests.length, 'no path asked for twice');
  } finally {
    console.log = quiet.log;
  }
  console.log('tcgcsvsingleflight.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
