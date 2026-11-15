// New Pokémon sets: a cheap daily check, and a notice for the ones TCGplayer
// sells before the provider publishes them (PROV-13, #170).
//
// New sets arrived only with the weekly refresh, and a set TCGplayer already
// sells but TCGdex has not published could not be searched at all, with nothing
// to say why. syncJobs.checkSets is the daily check — one set-list request per
// provider, details only for new sets — and GET /api/sets/tcgplayer-unpublished
// names recent TCGplayer groups no set in the `sets` table matches, read from the
// local TCGCSV copy at no request.
//
// Offline: every provider's HTTP adapter is stubbed. Run: `node test/setscheck.test.js`
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-setscheck-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.SCRYFALL_GAP_SCALE = '0';

const express = require('express');
const db = require('../src/db');
const tcgdexApi = require('../src/tcgdexApi');
const scryfallApi = require('../src/scryfallApi');
const lorcastApi = require('../src/lorcastApi');
const { checkSets } = require('../src/utils/syncJobs');
const tcgplayerCatalog = require('../src/tcgplayerCatalog');

const requests = [];
const reply = (data) => async (config) => {
  requests.push(`${config.baseURL || ''}${config.url}`);
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19);

let server;

async function main() {
  await db.initDb();
  await db.run(`UPDATE app_settings SET pokemon_provider = 'tcgdex' WHERE id = 1`);
  const quiet = { log: console.log };
  console.log = () => {};
  try {
    // --- 1. The daily check: one list request per provider, details for new sets only.
    await db.run(`INSERT INTO sets (id, name, release_date, total, game) VALUES ('sv01', 'Scarlet & Violet', '2023/03/31', 258, 'pokemon')`);
    tcgdexApi.client.defaults.adapter = async (config) => {
      if (config.url === '/en/sets') return reply([
        { id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 } },
        { id: 'me03', name: 'Perfect Order', cardCount: { official: 120, total: 140 } },
      ])(config);
      if (config.url === '/en/series') return reply([])(config);
      return reply({ id: 'me03', releaseDate: '2026-11-14', serie: { name: 'Mega Evolution' } })(config);
    };
    scryfallApi.client.defaults.adapter = reply({ data: [{ code: 'fdn', name: 'Foundations', card_count: 300, released_at: '2024-11-15' }] });
    lorcastApi.client.defaults.adapter = reply({ results: [{ code: '7', name: 'Archazia', released_at: '2025-03-07' }] });
    await checkSets();
    assert.deepStrictEqual(requests.sort(), [
      'https://api.lorcast.com/v0/sets',
      'https://api.scryfall.com/sets',
      'https://api.tcgdex.net/v2/en/series',
      'https://api.tcgdex.net/v2/en/sets',
      'https://api.tcgdex.net/v2/en/sets/me03',
    ].sort(), 'one list per provider, and set details for the new set only');
    assert.strictEqual((await db.get(`SELECT release_date FROM sets WHERE id = 'me03'`)).release_date, '2026/11/14');
    assert.ok(await db.get(`SELECT 1 FROM sets WHERE id = 'mtg-fdn'`), 'Magic sets are listed');
    assert.ok(await db.get(`SELECT 1 FROM sets WHERE id = 'lorcana-7'`), 'Lorcana sets are listed');

    // --- 2. TCGplayer groups no set matches, recent and not supplemental. ----------
    await db.run(`UPDATE app_settings SET tcgcsv_data_version = 'v1' WHERE id = 1`);
    const groups = [
      { groupId: 1, name: 'SV01: Scarlet & Violet Base Set', abbreviation: 'SVI', publishedOn: iso(900 * DAY), isSupplemental: false },
      { groupId: 2, name: 'ME04: Chaos Rising', abbreviation: 'CRI', publishedOn: iso(5 * DAY), isSupplemental: false },
      { groupId: 3, name: 'ME03: Perfect Order', abbreviation: 'POR', publishedOn: iso(20 * DAY), isSupplemental: false },
      { groupId: 4, name: 'Prize Pack Series Eight', abbreviation: 'PPS8', publishedOn: iso(3 * DAY), isSupplemental: true },
      { groupId: 5, name: 'Old Promos', abbreviation: 'OP', publishedOn: iso(400 * DAY), isSupplemental: false },
      { groupId: 6, name: 'Undated Group', abbreviation: 'UD' },
    ];
    await db.run(`INSERT INTO tcgcsv_cache (path, data_version, results_json) VALUES ('/tcgplayer/3/groups', 'v1', ?)`, [JSON.stringify(groups)]);
    const unpublished = await tcgplayerCatalog.unpublishedSets();
    assert.deepStrictEqual(unpublished.map(g => g.groupId), [2],
      'only the recent, non-supplemental group no set matches (Perfect Order is published now)');

    // The endpoint says the same, naming the provider.
    const app = express();
    app.use('/api/sets', require('../src/routes/sets'));
    const base = await new Promise(resolve => {
      server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
    const body = await (await fetch(`${base}/api/sets/tcgplayer-unpublished?game=pokemon`)).json();
    assert.deepStrictEqual({ provider: body.provider, count: body.count, names: body.groups.map(g => g.name) },
      { provider: 'TCGdex', count: 1, names: ['ME04: Chaos Rising'] });
    const mtg = await (await fetch(`${base}/api/sets/tcgplayer-unpublished?game=mtg`)).json();
    assert.strictEqual(mtg.count, 0, 'other games have nothing to report');

    // No TCGCSV copy yet: nothing to say, not an error.
    await db.run(`UPDATE app_settings SET tcgcsv_data_version = NULL WHERE id = 1`);
    assert.deepStrictEqual(await tcgplayerCatalog.unpublishedSets(), []);
  } finally {
    console.log = quiet.log;
  }
  console.log('setscheck.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (server && server.listening) await new Promise(r => server.close(r));
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
