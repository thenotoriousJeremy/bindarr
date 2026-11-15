// A price sweep in which every request failed is a failed sweep (PROV-05).
//
// The sweeps caught each card's error, logged it and moved on, then marked the
// sweep done. So an outage at the provider looked exactly like a successful run:
// the next attempt was a whole interval away and no admin was told. Now a sweep
// that got not one answer throws inside its own handler, which sends the
// price_sweep_failed notification and leaves the sweep due for the next tick.
// One answer among failures is still a sweep done.
//
// Offline: every provider's HTTP adapter is stubbed, and notify.emit is replaced
// so the notification can be counted. Run: `node test/sweepfailure.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-sweepfailure-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.POKEMON_TCG_API_KEY = 'test-key';
process.env.POKEMON_PRICE_GAP_MS = '1';
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const notify = require('../src/notify');
const tcgApi = require('../src/tcgApi');
const tcgdexApi = require('../src/tcgdexApi');
const lorcastApi = require('../src/lorcastApi');
const tcgcsvApi = require('../src/tcgcsvApi');
const riftboundPrices = require('../src/riftboundPrices');

const events = [];
notify.emit = (event) => { events.push(event); };

const httpError = (status, config) => Object.assign(new Error(`Request failed with status code ${status}`),
  { response: { status, data: {}, headers: {} }, config });
const down = async (config) => { throw httpError(404, config); };
const ok = (data) => async (config) => ({ data, status: 200, statusText: 'OK', headers: {}, config, request: {} });

const swept = async (col) => (await db.get(`SELECT ${col} AS at FROM app_settings WHERE id = 1`)).at;
const failures = (source) => events.filter(e => e.type === 'price_sweep_failed' && e.source === source).length;

async function own(id, fields) {
  const cols = Object.keys(fields);
  await db.run(
    `INSERT INTO card_cache (id, ${cols.join(', ')}, last_updated) VALUES (?, ${cols.map(() => '?').join(', ')}, datetime('now', '-10 days'))`,
    [id, ...Object.values(fields)]
  );
  await db.run(`INSERT INTO collection (user_id, card_id, quantity, game) VALUES (1, ?, 1, ?)`, [id, fields.game]);
}

async function main() {
  await db.initDb();
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    // --- pokemontcg.io ---------------------------------------------------------
    for (let i = 1; i <= 7; i++) {
      await own(`sv1-${i}`, { name: `Card ${i}`, set_id: 'sv1', number: String(i), game: 'pokemon', language: 'English', price_trend: 1 });
    }
    let hits = 0;
    tcgApi.tcgClient.defaults.adapter = async (config) => { hits++; return down(config); };
    await tcgApi.updateCollectionPrices(true);
    assert.strictEqual(await swept('pokemon_prices_swept_at'), null, 'pokemontcg.io: a sweep with no answer is not done');
    assert.strictEqual(failures('pokemontcg.io'), 1, 'pokemontcg.io: and the failure is reported');
    assert.strictEqual(hits, 5, 'pokemontcg.io: it gives up after a handful rather than walking every card');

    tcgApi.tcgClient.defaults.adapter = async (config) => {
      const id = config.url.split('/cards/')[1];
      if (id === 'sv1-1') return down(config);
      return ok({ data: { id, name: 'Card', number: '2', set: { id: 'sv1', name: 'S' }, tcgplayer: { prices: { normal: { market: 2 } } } } })(config);
    };
    await tcgApi.updateCollectionPrices(true);
    assert.ok(await swept('pokemon_prices_swept_at'), 'pokemontcg.io: one failure among answers is a sweep done');

    // --- TCGdex ----------------------------------------------------------------
    await own('tcgdex-ja-sv2a-004', { name: 'ヒトカゲ', set_id: 'sv2a', number: '004', game: 'pokemon', language: 'Japanese' });
    tcgdexApi.client.defaults.adapter = down;
    await tcgdexApi.updateCollectionPrices(true);
    assert.strictEqual(await swept('tcgdex_prices_swept_at'), null, 'TCGdex: not done');
    assert.strictEqual(failures('tcgdex'), 1, 'TCGdex: reported');

    // --- Lorcast ---------------------------------------------------------------
    await own('lorcana-crd_1', { name: 'Elsa', set_id: 'lorcana-1', number: '1', game: 'lorcana', language: 'English' });
    lorcastApi.client.defaults.adapter = down;
    await lorcastApi.updateCollectionPrices(true);
    assert.strictEqual(await swept('lorcana_prices_swept_at'), null, 'Lorcast: not done');
    assert.strictEqual(failures('lorcast'), 1, 'Lorcast: reported');

    // --- TCGCSV: every set's products are missing from the cache --------------------
    await db.run(`UPDATE app_settings SET tcgcsv_data_version = 'v1' WHERE id = 1`);
    for (const [category, group] of [[3, { groupId: 1, name: 'SV01: Scarlet & Violet Base Set', abbreviation: 'SV1' }], [85, { groupId: 2, name: 'Other', abbreviation: 'X' }]]) {
      await db.run(`INSERT INTO tcgcsv_cache (path, data_version, results_json) VALUES (?, 'v1', ?)`,
        [`/tcgplayer/${category}/groups`, JSON.stringify([group])]);
    }
    await tcgcsvApi.updateCollectionPrices(true);
    assert.strictEqual(await swept('tcgcsv_prices_swept_at'), null, 'TCGCSV: a sweep that priced no set is not done');

    // --- Riftbound: groups listed, no group's prices cached --------------------------
    await db.run(
      `INSERT INTO card_cache (id, name, set_id, number, game, language, tcgplayer_product_id)
       VALUES ('riftbound-ogn-1-298', 'Card', 'riftbound-ogn', '1', 'riftbound', 'English', 1001)`
    );
    await db.run(`INSERT INTO tcgcsv_cache (path, data_version, results_json) VALUES ('/tcgplayer/89/groups', 'v1', ?)`,
      [JSON.stringify([{ groupId: 24344, name: 'Origins', abbreviation: 'OGN' }])]);
    const r = await riftboundPrices.updateCollectionPrices(true);
    assert.deepStrictEqual(r, { priced: 0, skipped: 'not cached' });
    assert.strictEqual(await swept('riftbound_prices_swept_at'), null, 'Riftbound: not done');
  } finally {
    console.log = quiet.log;
    console.warn = quiet.warn;
    console.error = quiet.error;
  }
  console.log('sweepfailure.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
