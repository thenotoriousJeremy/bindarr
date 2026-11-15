// During a Scryfall 429 pause, a search fails fast; background work waits (PROV-16).
//
// One 429 pauses every Scryfall request (scryfallcooldown.test.js), which is right
// for a price sweep and wrong for a person: a search typed during the pause sat
// for the whole minute, or for whatever Retry-After said, uncapped. Now an
// interactive request refuses at once with the existing rate-limit error, a
// background one still waits, and no Retry-After can pause things for longer than
// five minutes. Retry-After is read as seconds or as an HTTP-date.
// Run: `node test/scryfallfailfast.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-scryfallfailfast-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.SCRYFALL_GAP_SCALE = '0';
const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');

let retryAfter = null;   // the next request answers 429 with this, once
let calls = 0;
scryfallApi.client.defaults.adapter = async (config) => {
  calls++;
  if (retryAfter !== null) {
    const ra = retryAfter;
    retryAfter = null;
    throw Object.assign(new Error('Request failed with status code 429'),
      { response: { status: 429, headers: { 'retry-after': ra }, data: {} }, config });
  }
  return { status: 200, statusText: 'OK', headers: {}, config, data: { object: 'list', data: [], has_more: false } };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  await db.initDb();
  const quiet = { warn: console.warn, error: console.error };
  console.warn = () => {};
  console.error = () => {};
  try {
    // 1. An HTTP-date Retry-After pauses until that time.
    retryAfter = new Date(Date.now() + 3000).toUTCString();
    await scryfallApi.scryGetRetried('/sets', undefined, 1).catch(() => {});
    const dated = scryfallApi.cooldownRemainingMs();
    assert.ok(dated > 1000 && dated <= 3100, `an HTTP-date Retry-After pauses until that time (${dated} ms)`);
    await sleep(dated + 50);

    // 2. A background request takes a 429 and waits the pause out...
    retryAfter = '2';
    const background = scryfallApi.scryGetRetried('/cards/collection?x=1');

    // ...while a person's search during the pause is refused at once, with the
    //    rate-limit error, and nothing is sent.
    await sleep(100);
    const before = calls;
    const t0 = Date.now();
    await assert.rejects(
      scryfallApi.searchCards({ name: 'Lightning Bolt', scope: 'internet' }),
      /RATE_LIMIT_EXCEEDED/, 'an interactive search during the pause gets the rate-limit error');
    assert.ok(Date.now() - t0 < 500, `and gets it at once (${Date.now() - t0} ms), not after the pause`);
    assert.strictEqual(calls, before, 'without sending anything');

    const first = await background;
    assert.strictEqual(first.status, 200, 'the background request still completes after the pause');

    // 3. A Retry-After of an hour is capped at five minutes.
    retryAfter = '3600';
    await scryfallApi.scryGetRetried('/cards/collection?x=2', undefined, 1).catch(() => {});
    const capped = scryfallApi.cooldownRemainingMs();
    assert.ok(capped > 0 && capped <= scryfallApi.SCRYFALL_MAX_COOLDOWN_MS, `paused for ${capped} ms, capped at five minutes`);
  } finally {
    console.warn = quiet.warn;
    console.error = quiet.error;
  }
  console.log('scryfallfailfast.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
