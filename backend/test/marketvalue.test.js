// Runnable checks for per-copy values (typed or fetched) and the read-only API key.
//
// Two features, one file, because they meet in one place: a graded copy's value is
// what makes a net worth figure correct, and the API key is what lets something
// outside Bindarr read that figure.
//
// What is worth locking down:
//   1. market_value beats every provider price. If it does not, a PSA 10 is valued
//      at the raw card's price and the collection total is wrong by thousands.
//   2. Clearing it is possible. A mistyped 10000 must not be permanent.
//   3. The API key is read-only. It is a long-lived credential that lives in some
//      other machine's config file; a POST that gets through makes it a liability.
//   4. The graded-price provider refuses what it cannot answer (raw cards, MTG,
//      half grades, no key) instead of guessing a number someone banks on.
//
// No framework, no network — plain node + assert. Run: `node test/marketvalue.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-value-${process.pid}.db`);
const db = require('../src/db');
const { resolveCardPrice } = require('../src/utils/priceHelpers');
const gradedPrices = require('../src/gradedPrices');
const { authenticateToken } = require('../src/middleware/auth');
const { hashSessionToken } = require('../src/utils/authHelpers');

// Recorded from the live API. Two shapes matter and both appear here: an exact
// `tcgPlayerId` lookup answers with `data` as a single OBJECT, a search answers
// with `data` as an ARRAY. Grades live under `ebay.salesByGrade`, keyed
// `psa10`/`bgs9_5`/`cgc8`, and collector numbers arrive as '4/102', not '4'.
const bucket = (price, count) => ({ count, averagePrice: price, medianPrice: price, smartMarketPrice: { price, confidence: 'medium' } });
const PPT_SEARCH = {
  data: [
    { name: 'Charizard (4)', cardNumber: '4/102', ebay: { salesByGrade: { psa8: bucket(900, 4), psa9: bucket(2400, 9), psa10: bucket(12000, 11), ungraded: bucket(300, 40) } } },
    { name: 'Charizard (11)', cardNumber: '11/102', ebay: { salesByGrade: { psa10: bucket(300, 2), bgs9_5: bucket(450, 1) } } },
  ],
};
const PPT_BY_ID = { data: PPT_SEARCH.data[0] };

// Minimal express req/res doubles: enough for the middleware, nothing more.
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
async function runAuth(token, method = 'GET') {
  const req = { headers: { authorization: `Bearer ${token}` }, method };
  const res = fakeRes();
  let passed = false;
  await authenticateToken(req, res, () => { passed = true; });
  return { req, res, passed };
}

(async () => {
  await db.initDb();

  // --- 1. Price resolution -----------------------------------------------------
  const holo = { printing: 'Holofoil', price_holofoil: 12, price_trend: 5 };
  assert.strictEqual(resolveCardPrice(holo), 12, 'printing price still wins over price_trend');

  const slab = { ...holo, market_value: 2400 };
  assert.strictEqual(resolveCardPrice(slab), 2400, 'a value set on the copy beats every provider price');

  // Zero and null mean "not set", not "worthless". A slab valued at 0 by a bad
  // fetch must fall back to the card price rather than zero out the collection.
  assert.strictEqual(resolveCardPrice({ ...holo, market_value: 0 }), 12);
  assert.strictEqual(resolveCardPrice({ ...holo, market_value: null }), 12);
  // A bare card_cache row has no such column at all.
  assert.strictEqual(resolveCardPrice({ price_trend: 7 }), 7);

  // --- 2. The column round-trips, including being cleared ----------------------
  await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('valuetest', 'x', 'member', 'valuetest-share')`);
  const user = await db.get(`SELECT id FROM users WHERE username = 'valuetest'`);
  await db.run(
    `INSERT INTO card_cache (id, name, set_id, set_name, number, game, price_trend) VALUES ('base1-4', 'Charizard', 'base1', 'Base Set', '4', 'pokemon', 300)`
  );
  const ins = await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing, grader, grade, cert_number) VALUES ('base1-4', ?, 1, 'Holofoil', 'PSA', 9, '82613901')`,
    [user.id]
  );
  const entryId = ins.lastID;

  await db.run(
    `UPDATE collection SET market_value = ?, market_value_source = 'manual', market_value_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [2400, entryId]
  );
  let row = await db.get(
    `SELECT c.market_value, c.market_value_source, c.printing, cc.price_trend
     FROM collection c JOIN card_cache cc ON cc.id = c.card_id WHERE c.id = ?`, [entryId]
  );
  assert.strictEqual(resolveCardPrice(row), 2400, 'the stored value is what a collection query resolves to');
  assert.strictEqual(row.market_value_source, 'manual');

  await db.run(`UPDATE collection SET market_value = NULL, market_value_source = NULL WHERE id = ?`, [entryId]);
  row = await db.get(
    `SELECT c.market_value, c.printing, cc.price_trend FROM collection c JOIN card_cache cc ON cc.id = c.card_id WHERE c.id = ?`,
    [entryId]
  );
  assert.strictEqual(resolveCardPrice(row), 300, 'clearing the value returns the card to its provider price');

  // --- 3. The API key is read-only --------------------------------------------
  await db.run(`UPDATE users SET api_key = 'bnd_testkey' WHERE id = ?`, [user.id]);

  const readOk = await runAuth('bnd_testkey', 'GET');
  assert.ok(readOk.passed, 'a GET authenticates with an API key');
  assert.strictEqual(readOk.req.user.id, user.id);
  assert.strictEqual(readOk.req.user.via_api_key, true, 'the request must be marked so admin routes can refuse it');

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const write = await runAuth('bnd_testkey', method);
    assert.ok(!write.passed, `${method} must not pass with an API key`);
    assert.strictEqual(write.res.statusCode, 403, `${method} with an API key is 403, not 401`);
  }

  const bogus = await runAuth('bnd_nosuchkey', 'GET');
  assert.ok(!bogus.passed);
  assert.strictEqual(bogus.res.statusCode, 401, 'an unknown key is rejected as a bad credential');

  // A session token still authenticates a write — the API-key branch must not have
  // swallowed the normal path.
  await db.run(
    `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, DATETIME('now', '+1 day'))`,
    [user.id, hashSessionToken('session-token')]
  );
  const sessionWrite = await runAuth('session-token', 'POST');
  assert.ok(sessionWrite.passed, 'a real session still writes');
  assert.notStrictEqual(sessionWrite.req.user.via_api_key, true);

  // --- 4. Graded prices: refuse what cannot be answered ------------------------
  const refuses = async (args, fragment) => {
    await assert.rejects(
      () => gradedPrices.fetchGradedPrice(args),
      (e) => {
        assert.ok(e.message.toLowerCase().includes(fragment), `expected "${fragment}" in: ${e.message}`);
        assert.ok(e.status >= 400 && e.status < 500, 'a refusal is the caller\'s problem, not a 500');
        return true;
      }
    );
  };
  const base = { game: 'pokemon', name: 'Charizard', setName: 'Base Set', number: '4', grader: 'PSA', grade: 10, apiKey: 'k' };
  await refuses({ ...base, game: 'mtg' }, 'pok');
  await refuses({ ...base, grader: 'Raw', grade: null }, 'grader and a numeric grade');
  await refuses({ ...base, grade: null }, 'grader and a numeric grade');
  await refuses({ ...base, apiKey: '' }, 'no graded-price api key');

  // --- 5. Graded prices: the happy path, against a stubbed transport -----------
  const realGet = gradedPrices.client.get;
  const calls = [];
  gradedPrices.client.get = async (url, config) => {
    calls.push(config.params);
    assert.strictEqual(config.headers.Authorization, 'Bearer testkey');
    assert.strictEqual(config.params.includeEbay, true, 'graded prices cost an extra credit and must be asked for');
    return { data: config.params.tcgPlayerId ? PPT_BY_ID : PPT_SEARCH };
  };
  try {
    const hit = await gradedPrices.fetchGradedPrice({ ...base, apiKey: 'testkey' });
    assert.strictEqual(hit.price, 12000, 'PSA 10 reads the psa10 bucket');
    assert.strictEqual(hit.source, 'pokemonpricetracker');
    assert.ok(hit.basis.includes('PSA 10'), 'the answer says what the number is');
    assert.ok(hit.basis.includes('11 sold'), 'and how many sales it rests on');
    assert.strictEqual(calls[0].search, 'Charizard');
    // The credit ceiling is the whole reason this is a button and not a sweep.
    assert.ok(calls[0].limit <= 5, 'a name search must stay small: the provider bills per card returned');

    const nine = await gradedPrices.fetchGradedPrice({ ...base, grade: 9, apiKey: 'testkey' });
    assert.strictEqual(nine.price, 2400, 'PSA 9 reads the psa9 bucket');

    // Half grades are real on BGS and CGC labels, and the provider keys them
    // 'bgs9_5'. Rounding one to PSA 9 would price a slab the card does not have.
    const bgs = await gradedPrices.fetchGradedPrice({ ...base, number: '11', grader: 'BGS', grade: 9.5, apiKey: 'testkey' });
    assert.strictEqual(bgs.price, 450);

    // An exact TCGplayer id returns ONE card as a bare object, not an array — and
    // costs 2 credits instead of a page's worth, which is why it is tried first.
    calls.length = 0;
    const byId = await gradedPrices.fetchGradedPrice({ ...base, tcgPlayerId: 85320, apiKey: 'testkey' });
    assert.strictEqual(byId.price, 12000);
    assert.strictEqual(calls.length, 1, 'an id hit must not also run the name search');
    assert.strictEqual(calls[0].tcgPlayerId, '85320');
    assert.strictEqual(calls[0].limit, 1);

    // The collector number separates two cards of the same name. Asking for #11
    // must not return #4's twelve thousand dollars.
    const other = await gradedPrices.fetchGradedPrice({ ...base, number: '11', apiKey: 'testkey' });
    assert.strictEqual(other.price, 300, 'the number picks the printing, not the name');

    // No match, and a grade with no sales, are refusals rather than a silent zero.
    await refuses({ ...base, number: '99', apiKey: 'testkey' }, 'none numbered');
    await refuses({ ...base, number: '11', grade: 9, apiKey: 'testkey' }, 'no psa 9 sales');
    // And the refusal says which grades DO have sales, so it ends in a decision.
    await assert.rejects(
      () => gradedPrices.fetchGradedPrice({ ...base, grader: 'PSA', grade: 2, apiKey: 'testkey' }),
      (e) => { assert.ok(/PSA10/.test(e.message.replace(/\s/g, '')), `expected recorded grades in: ${e.message}`); return true; }
    );
  } finally {
    gradedPrices.client.get = realGet;
  }

  // --- 6. Shapes the provider actually returns --------------------------------
  // '4/102' and '4' are the same card; so are '004' and '4'.
  assert.strictEqual(gradedPrices.normalizeNumber('4/102'), '4');
  assert.strictEqual(gradedPrices.normalizeNumber('004'), '4');
  assert.strictEqual(gradedPrices.normalizeNumber('XY29'), 'xy29');
  assert.ok(gradedPrices.pickCard([{ cardNumber: '004/102' }], '4'), 'padded and slashed numbers still match');
  // data as a bare object (id lookup) and as an array (search) both mean "cards".
  assert.strictEqual(gradedPrices.cardsOf(PPT_BY_ID).length, 1);
  assert.strictEqual(gradedPrices.cardsOf(PPT_SEARCH).length, 2);
  // Grade keys: PSA 10 -> psa10, BGS 9.5 -> bgs9_5, and a raw copy has none.
  assert.strictEqual(gradedPrices.gradeKey('PSA', 10), 'psa10');
  assert.strictEqual(gradedPrices.gradeKey('BGS', 9.5), 'bgs9_5');
  assert.strictEqual(gradedPrices.gradeKey('Raw', null), null);
  // smartMarketPrice is the provider's own filtered estimate and wins over the
  // raw mean, which a single outlier sale drags a long way.
  assert.strictEqual(gradedPrices.priceOf({ averagePrice: 100, medianPrice: 90, smartMarketPrice: { price: 95 } }), 95);
  assert.strictEqual(gradedPrices.priceOf({ averagePrice: 100 }), 100);
  assert.strictEqual(gradedPrices.priceOf({ averagePrice: 0 }), null);
  assert.strictEqual(gradedPrices.priceOf(undefined), null);

  console.log('marketvalue self-check passed');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
