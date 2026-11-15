// The TCGdex set refresh must not blank release dates (PROV-08).
//
// It used to INSERT OR REPLACE every set with an empty release_date and then
// refetch all ~220 set details, dropping the ones that failed. One TCGdex hiccup
// left those sets undated for a week, and chronological binders sorted them first.
// Now the list is an upsert that leaves the detail columns alone, and details are
// fetched only for sets that do not have them — a new release, or one an earlier
// refresh failed to date — so a refresh is one request plus one per such set.
//
// Offline: axios's default adapter is stubbed. Run: `node test/tcgdexsets.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-tcgdexsets-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const axios = require('axios');
const requests = [];
let failDetailsFor = new Set();
const LIST = [
  { id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 } },
  { id: 'sv02', name: 'Paldea Evolved', cardCount: { official: 193, total: 279 } },
  { id: 'me03', name: 'Brand New Set', cardCount: { official: 100, total: 120 } },
];
axios.defaults.adapter = async (config) => {
  const url = `${String(config.baseURL || '').replace(/\/+$/, '')}${config.url}`;
  requests.push(url);
  const reply = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config, request: {} });
  if (url.endsWith('/en/sets')) return reply(LIST);
  if (url.endsWith('/en/series')) return reply([]);
  const m = url.match(/\/en\/sets\/([^/]+)$/);
  if (m) {
    if (failDetailsFor.has(m[1])) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return reply({ id: m[1], releaseDate: '2026-11-14', serie: { name: 'Mega Evolution' }, logo: 'l', symbol: 's' });
  }
  throw new Error(`unexpected ${url}`);
};

const db = require('../src/db');
const tcgdexApi = require('../src/tcgdexApi');

const set = (id) => db.get(`SELECT * FROM sets WHERE id = ?`, [id]);
const detailRequests = () => requests.filter(u => /\/en\/sets\/[^/]+$/.test(u)).map(u => u.split('/').pop());

async function main() {
  await db.initDb();
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  try {
    // Two sets already dated by an earlier refresh.
    for (const [id, date] of [['sv01', '2023/03/31'], ['sv02', '2023/06/09']]) {
      await db.run(
        `INSERT INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
         VALUES (?, 'old name', 'Scarlet & Violet', 1, 1, ?, '', 's', 'l', 'pokemon')`, [id, date]
      );
    }

    // 1. A refresh fetches details for the new set only, and blanks nothing.
    await tcgdexApi.fetchAndCacheSets(true);
    assert.deepStrictEqual(detailRequests(), ['me03'], 'details only for the set that has none');
    assert.strictEqual((await set('sv01')).release_date, '2023/03/31', 'a dated set keeps its date');
    assert.strictEqual((await set('sv01')).series, 'Scarlet & Violet', 'and its series');
    assert.strictEqual((await set('sv01')).name, 'Scarlet & Violet', 'the list still refreshes the name');
    assert.strictEqual((await set('sv01')).total, 258, 'and the card count');
    assert.strictEqual((await set('me03')).release_date, '2026/11/14', 'the new set is dated');

    // 2. A failed detail fetch leaves that set undated, and the next refresh retries it.
    await db.run(`DELETE FROM sets WHERE id = 'me03'`);
    requests.length = 0;
    failDetailsFor = new Set(['me03']);
    await tcgdexApi.fetchAndCacheSets(true);
    assert.strictEqual((await set('me03')).release_date, '', 'no date yet');
    assert.strictEqual((await set('sv02')).release_date, '2023/06/09', 'a hiccup never blanks a dated set');
    failDetailsFor = new Set();
    requests.length = 0;
    await tcgdexApi.fetchAndCacheSets(true);
    assert.deepStrictEqual(detailRequests(), ['me03'], 'the undated set is asked again');
    assert.strictEqual((await set('me03')).release_date, '2026/11/14');

    // 3. Nothing missing: the refresh is the one list request.
    requests.length = 0;
    await tcgdexApi.fetchAndCacheSets(true);
    assert.deepStrictEqual(requests.map(u => u.split('/v2')[1]), ['/en/sets'], 'one request when every set is dated');
  } finally {
    console.log = quiet.log;
  }
  console.log('tcgdexsets.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
