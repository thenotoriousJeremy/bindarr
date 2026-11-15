// A TCGdex outage must read as an outage, not as "no such card" (PROV-14).
//
// Set fetches and per-card fetches both went through a helper that dropped
// failures, so with TCGdex down a set browse or a name search came back as an
// empty list — which the UI shows as "no results", and the user believes it.
// Now a failure reaches runSearch's handler: the cache answers if it can, and
// otherwise the search throws UPSTREAM_UNAVAILABLE, as the other providers do.
// A set this language does not have (a 404) is still just empty.
//
// Offline: axios's default adapter is stubbed before tcgdexApi creates its client.
// Run: `node test/tcgdexoutage.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-tcgdexoutage-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const axios = require('axios');
let respond = () => { throw new Error('no route'); };
axios.defaults.adapter = async (config) => {
  const url = /^https?:/.test(config.url) ? config.url : `${String(config.baseURL || '').replace(/\/+$/, '')}${config.url}`;
  return { data: await respond(url, config), status: 200, statusText: 'OK', headers: {}, config, request: {} };
};
const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`),
  { response: { status, data: {}, headers: {} } });
const networkError = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

const db = require('../src/db');
const tcgdexApi = require('../src/tcgdexApi');

const quiet = { error: console.error, warn: console.warn };

async function main() {
  await db.initDb();
  console.error = () => {};
  console.warn = () => {};
  try {
    // 1. The set endpoint is down: an outage, not an empty set.
    respond = () => { throw httpError(503); };
    await assert.rejects(
      tcgdexApi.searchCards({ set: 'sv03', scope: 'internet', lang: 'en' }),
      /UPSTREAM_UNAVAILABLE/, 'a failed set fetch is reported, not swallowed');

    // 2. A set this language does not publish is genuinely empty.
    respond = () => { throw httpError(404); };
    const { cards: none } = await tcgdexApi.searchCards({ set: 'base1', scope: 'internet', lang: 'ja' });
    assert.deepStrictEqual(none, [], 'a 404 set is no results, not an outage');

    // 3. Briefs list, but not one card can be fetched: still an outage.
    respond = (url) => {
      if (/\/en\/cards(\?|$)/.test(url)) return [{ id: 'sv03-004', localId: '004', name: 'Charizard ex' }];
      throw networkError();
    };
    await assert.rejects(
      tcgdexApi.searchCards({ name: 'Charizard', scope: 'internet', lang: 'en' }),
      /UPSTREAM_UNAVAILABLE/, 'card fetches that all fail are reported');

    // 4. With the card cached, the same outage serves the cache instead.
    await db.run(
      `INSERT INTO card_cache (id, name, set_id, number, game, language, image_url)
       VALUES ('tcgdex-en-sv03-004', 'Charizard ex', 'sv03', '004', 'pokemon', 'English', 'x')`
    );
    respond = () => { throw httpError(503); };
    const { cards: cached } = await tcgdexApi.searchCards({ set: 'sv03', scope: 'internet', lang: 'en' });
    assert.deepStrictEqual(cached.map(c => c.id), ['tcgdex-en-sv03-004'], 'the cache answers during an outage');

    // 5. Some cards fail, the rest come back: a partial page is still a page.
    respond = (url) => {
      if (/\/en\/cards(\?|$)/.test(url)) {
        return [{ id: 'sv03-005', localId: '005', name: 'Charmander' }, { id: 'sv03-006', localId: '006', name: 'Charmeleon' }];
      }
      if (url.endsWith('/cards/sv03-005')) throw networkError();
      return { id: 'sv03-006', localId: '006', name: 'Charmeleon', set: { id: 'sv03', name: 'Obsidian Flames' } };
    };
    const { cards: partial } = await tcgdexApi.searchCards({ name: 'Char', scope: 'internet', lang: 'en' });
    assert.deepStrictEqual(partial.map(c => c.id), ['tcgdex-en-sv03-006']);
  } finally {
    console.error = quiet.error;
    console.warn = quiet.warn;
  }
  console.log('tcgdexoutage.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
