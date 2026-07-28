// Runnable smoke test for the Pokémon TCG client's transient-failure retry and
// the UPSTREAM_UNAVAILABLE signal (issue #22: upstream 5xx made searches look
// like "no results"). No framework — plain node + assert.
// Run: `node test/tcgretry.test.js`
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');

// Point the db module at a throwaway file before tcgApi pulls it in, and stub the
// reads searchCards does so this test never needs a real schema.
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-tcgretry-${process.pid}.db`);
const db = require('../src/db');
db.all = async () => [];
db.get = async () => undefined;
db.run = async () => ({ lastID: 0, changes: 0 });

const { searchCards, tcgClient } = require('../src/tcgApi');

// Local stand-in for api.pokemontcg.io. `/cards` fails `failCount` times with the
// configured status, then succeeds — the flaky-upstream shape issue #22 reports.
function makeServer(state) {
  return http.createServer((req, res) => {
    state.hits++;
    if (state.hits <= state.failCount) {
      res.writeHead(state.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'boom' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'x-1', name: 'Mew', number: '1', set: { id: 's', name: 'S' }, images: {} }] }));
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function withServer(state, fn) {
  const server = makeServer(state);
  const base = await listen(server);
  tcgClient.defaults.baseURL = base;
  try {
    return await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

async function main() {
  // 1. Two 500s then a 200: the caller sees success, not the first failure.
  let state = { hits: 0, failCount: 2, status: 500 };
  await withServer(state, async () => {
    const resp = await tcgClient.get('/cards', { params: { q: 'name:"Mew"' } });
    assert.strictEqual(resp.status, 200, '500s should be retried until success');
    assert.strictEqual(state.hits, 3, `expected 3 attempts, got ${state.hits}`);
  });

  // 2. 429 is an answer, not a transient: one attempt, error passed through so the
  //    RATE_LIMIT_EXCEEDED path still fires.
  state = { hits: 0, failCount: 99, status: 429 };
  await withServer(state, async () => {
    await assert.rejects(
      () => tcgClient.get('/cards'),
      err => err.response && err.response.status === 429
    );
    assert.strictEqual(state.hits, 1, `429 must not be retried, got ${state.hits} attempts`);
  });

  // 3. 401 likewise passes straight through without retrying.
  state = { hits: 0, failCount: 99, status: 401 };
  await withServer(state, async () => {
    await assert.rejects(() => tcgClient.get('/cards'), err => err.response.status === 401);
    assert.strictEqual(state.hits, 1, `401 must not be retried, got ${state.hits} attempts`);
  });

  // 4. Upstream down for every attempt: searchCards reports it instead of
  //    returning an empty list that reads as "no such card".
  state = { hits: 0, failCount: 99, status: 500 };
  await withServer(state, async () => {
    await assert.rejects(
      () => searchCards('Mew', '', '', '', 'internet'),
      err => err.message === 'UPSTREAM_UNAVAILABLE'
    );
    assert.strictEqual(state.hits, 3, `expected 3 attempts before giving up, got ${state.hits}`);
  });

  // 5. Recovering upstream still returns cards (retry doesn't break the happy path).
  state = { hits: 0, failCount: 1, status: 500 };
  await withServer(state, async () => {
    const results = await searchCards('Mew', '', '', '', 'internet');
    assert.strictEqual(results.length, 1, 'expected the card once upstream recovers');
    assert.strictEqual(results[0].name, 'Mew');
  });

  // 6. Upstream down but the card is already cached: serve the cache instead of
  //    failing the search. Applies to an internet-scope search too, which skips
  //    the local lookup on the happy path.
  db.all = async () => [{ id: 'x-1', name: 'Mew', number: '1', set_id: 's', set_name: 'S', subtypes: '[]', types: '[]', price_trend: 1.5, last_updated: '2026-07-27 00:00:00' }];
  state = { hits: 0, failCount: 99, status: 500 };
  await withServer(state, async () => {
    const results = await searchCards('Mew', '', '', '', 'internet');
    assert.strictEqual(results.length, 1, 'cached card should be served when upstream is down');
    assert.strictEqual(results[0].name, 'Mew');
    assert.deepStrictEqual(results[0].types, [], 'row should be hydrated through parseCardRow');
  });
  db.all = async () => [];

  console.log('tcgretry.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
