// Device mode: requests and background jobs must not share a transaction (MOB-02).
//
// On a server, db.js tells a transaction's own statements from everyone else's
// with AsyncLocalStorage. A WebView has no async context, so in device mode every
// statement issued while ANY transaction is open joins it (embedded/shims/
// async_hooks.js). That was harmless only as long as nothing ran beside a
// request, and background jobs do: the price sweep, the TCGCSV sync, the
// Pokémon product map. These are the two ways it went wrong, reproduced.
const assert = require('assert');
const { loadEmbedded, gate, sleep } = require('./deviceHarness');

let nextSavepoint = null;   // set by a test: called when the driver sees a SAVEPOINT
const { embedded, db, cleanup } = loadEmbedded('devicelock', {
  observe(sql) {
    if (nextSavepoint && /^SAVEPOINT /.test(sql)) {
      const fn = nextSavepoint;
      nextSavepoint = null;
      fn();
    }
  },
});

let token;
async function call(method, url, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await embedded.handle({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}

const count = async (sql, params = []) => (await db.get(sql, params)).n;

// A background job's transaction is open — the product map writing one group,
// say — when the user saves something. The job then fails and rolls back.
// The user's save was answered 201 and must still be there.
async function testBackgroundRollbackKeepsTheRequest() {
  const job = gate();
  const background = db.withTransaction(async () => {
    await db.run(`INSERT INTO notes (user_id, title) VALUES (1, 'background row')`);
    await job.promise;
    throw new Error('the background job failed');
  }).then(() => null, err => err);
  await sleep(20);

  const request = call('POST', '/api/notes', { title: 'saved by the user' });
  await sleep(50);
  job.open();
  const [res, failure] = await Promise.all([request, background]);

  assert.match(String(failure && failure.message), /background job failed/);
  assert.strictEqual(res.status, 201, JSON.stringify(res.json));
  assert.strictEqual(await count(`SELECT COUNT(*) n FROM notes WHERE title = 'saved by the user'`), 1,
    'a request answered 201 keeps its rows when a background transaction rolls back');
  assert.strictEqual(await count(`SELECT COUNT(*) n FROM notes WHERE title = 'background row'`), 0);
}

// The other order: the request's own transaction opens inside the background
// one (as a savepoint) and the background job commits first. The request then
// fails at RELEASE although its rows were committed, so the client is told it
// failed and a retry adds the copy twice.
async function testBackgroundCommitDoesNotStrandTheRequest() {
  const binder = (await db.get(`SELECT id FROM locations WHERE name = 'Main Binder'`)).id;
  const before = await count(`SELECT COUNT(*) n FROM compartments WHERE location_id = ?`, [binder]);
  const job = gate();
  const background = db.withTransaction(async () => {
    await db.run(`INSERT INTO notes (user_id, title) VALUES (1, 'background commit')`);
    await job.promise;
  });
  await sleep(20);

  // Commit the background transaction the moment the request's savepoint opens,
  // so it lands between the request's statements. If no savepoint opens (the
  // request waited instead of joining), the job finishes on its own a little later.
  nextSavepoint = job.open;
  const request = call('POST', `/api/locations/${binder}/compartments`, {});
  await sleep(100);
  nextSavepoint = null;
  job.open();
  const [res] = await Promise.all([request, background]);

  const after = await count(`SELECT COUNT(*) n FROM compartments WHERE location_id = ?`, [binder]);
  assert.strictEqual(res.status, 201, `the request must not fail after its rows committed: ${JSON.stringify(res.json)}`);
  assert.strictEqual(after, before + 1, 'exactly one new page');
  assert.strictEqual(await count(`SELECT COUNT(*) n FROM notes WHERE title = 'background commit'`), 1);
}

// A route that holds its turn until the test lets it go: a request that is in the
// middle of a provider call, say. Added after every real mount, so nothing else
// answers its path.
const held = { entered: null, release: null };
embedded.app.post('/api/__device-lock-test/hold', async (req, res) => {
  held.entered();
  await held.release;
  await db.run(`INSERT INTO notes (user_id, title) VALUES (?, 'held request')`, [req.user.id]);
  res.json({ ok: true });
});

// The other direction: a background job's transactions wait for the request
// already running, instead of opening under it.
async function testBackgroundUnitWaitsForTheRequest() {
  const entered = gate();
  const release = gate();
  held.entered = entered.open;
  held.release = release.promise;
  const request = call('POST', '/api/__device-lock-test/hold', {});
  await entered.promise;

  let ran = false;
  const job = embedded.background('test job', async () => {
    ran = true;
    await db.withTransaction(() => db.run(`INSERT INTO notes (user_id, title) VALUES (1, 'job row')`));
  });
  await sleep(50);
  assert.strictEqual(ran, false, 'a background unit does not start while a request holds the turn');

  release.open();
  const [res] = await Promise.all([request, job]);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(ran, true);
  assert.strictEqual(await count(`SELECT COUNT(*) n FROM notes WHERE title IN ('job row', 'held request')`), 2);
}

// A long background unit (the product map writes hundreds of groups) lets a
// queued request go between two of its transactions, rather than making the app
// wait for the whole job.
async function testBackgroundUnitYieldsBetweenTransactions() {
  const order = [];
  const between = gate();
  const job = embedded.background('two groups', async () => {
    await db.withTransaction(async () => { order.push('group 1'); });
    await between.promise;
    await db.withTransaction(async () => { order.push('group 2'); });
  });
  await sleep(20);
  const request = call('POST', '/api/notes', { title: 'between two groups' }).then((res) => {
    order.push('request');
    return res;
  });
  await sleep(20);
  between.open();
  const [, res] = await Promise.all([job, request]);
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(order, ['group 1', 'request', 'group 2']);
}

// A search the user has already typed past is aborted by the app; while it is
// still waiting for its turn it is dropped, and never reaches a provider (MOB-16).
async function testAbortedWhileQueuedNeverRuns() {
  const release = gate();
  const job = embedded.background('busy', () => release.promise);
  await sleep(10);
  const controller = new AbortController();
  const queued = embedded.handle({
    method: 'POST',
    url: '/api/notes',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'superseded' }),
  }, { signal: controller.signal });
  await sleep(10);
  controller.abort();
  const res = await queued;
  assert.strictEqual(res.aborted, true);
  release.open();
  await job;
  await sleep(20);
  assert.strictEqual(await count(`SELECT COUNT(*) n FROM notes WHERE title = 'superseded'`), 0);
  // Aborted before it was even sent: refused at once.
  const already = new AbortController();
  already.abort();
  const refused = await embedded.handle({ method: 'GET', url: '/api/notes', headers: { Authorization: `Bearer ${token}` } }, { signal: already.signal });
  assert.strictEqual(refused.aborted, true);
}

// Resolves with the promise's value, or 'still waiting' after `ms`.
const within = (promise, ms) => {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

// A background unit's provider requests (any axios instance) go out with the
// turn let go, so the app is not queued behind a download; and the unit's code
// after a download runs only once it holds the turn again, however many of its
// downloads were under way at once. A unit that ends before a download it did not
// wait for is not handed the turn back (which nobody would then let go).
async function testDownloadsLetTheTurnGo() {
  const downloads = [gate(), gate(), gate()];
  let started = 0;
  const provider = require('axios').create({
    adapter: async (config) => {
      const i = started++;
      await downloads[i].promise;
      return { data: i, status: 200, statusText: 'OK', headers: {}, config };
    },
  });
  const after = [];
  // Plain statements: two transactions open at once inside one unit would be one
  // transaction here whatever the downloads did (no async context; see the shim).
  const job = embedded.background('two downloads at once', () => Promise.all([0, 1].map(async (i) => {
    await provider.get(`/download/${i}`);
    after.push(i);
    await db.run(`INSERT INTO notes (user_id, title) VALUES (1, ?)`, [`after download ${i}`]);
  })));
  await sleep(20);
  assert.strictEqual(started, 2, 'both downloads under way');
  const during = await within(call('POST', '/api/notes', { title: 'during the downloads' }), 1000);
  assert.notStrictEqual(during, 'still waiting', 'a request is answered while the job downloads');
  assert.strictEqual(during.status, 201);

  // A download comes back while a request holds the turn: the job's code after it
  // waits for that request, rather than running beside it.
  const entered = gate();
  const release = gate();
  held.entered = entered.open;
  held.release = release.promise;
  const request = call('POST', '/api/__device-lock-test/hold', {});
  await entered.promise;
  downloads[0].open();
  await sleep(50);
  assert.deepStrictEqual(after, [], 'nothing of the job runs while the request holds the turn');
  release.open();
  await request;
  downloads[1].open();
  await within(job, 1000);
  assert.deepStrictEqual(after.sort(), [0, 1]);
  assert.strictEqual(await count(`SELECT COUNT(*) n FROM notes WHERE title LIKE 'after download %'`), 2);

  // A job that ends with a download still out: once that download is back, the
  // turn is still free for everyone.
  await embedded.background('leaves a download behind', async () => { provider.get('/download/2').catch(() => {}); });
  downloads[2].open();
  await sleep(20);
  const later = await within(call('POST', '/api/notes', { title: 'after the job ended' }), 1000);
  assert.notStrictEqual(later, 'still waiting', 'nobody holds the turn for a job that has ended');
  assert.strictEqual(later.status, 201);
}

// Work several callers share — a module's "already in flight, return that" branch
// (riftcodexApi.refreshCatalogue, pokemontcgapi.request) — run by a job that has
// let its turn go for a download. A request that wants the same work waits for it
// with its own turn let go (utils/backgroundWork.join): the work needs a turn to
// finish, and a request holding its turn while it waited would wait for ever.
let sharedWork = null;
embedded.app.post('/api/__device-lock-test/join', async (req, res) => {
  res.json({ result: await require('../src/utils/backgroundWork').join(sharedWork) });
});
async function testJoiningSharedWorkDoesNotDeadlock() {
  const download = gate();
  const provider = require('axios').create({
    adapter: async (config) => {
      await download.promise;
      return { data: 'fetched', status: 200, statusText: 'OK', headers: {}, config };
    },
  });
  const job = embedded.background('a job running shared work', () => {
    sharedWork = (async () => {
      const { data } = await provider.get('/shared');
      await db.withTransaction(() => db.run(`INSERT INTO notes (user_id, title) VALUES (1, 'written by the shared work')`));
      return data;
    })();
    return sharedWork;
  });
  await sleep(20);   // the job is at its download, with its turn let go
  const request = call('POST', '/api/__device-lock-test/join', {});
  await sleep(20);   // the request holds the turn, waiting for the shared work
  download.open();
  const res = await within(request, 2000);
  assert.notStrictEqual(res, 'still waiting', 'a request waiting on shared work a job is running does not deadlock');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json, { result: 'fetched' });
  assert.strictEqual(await within(job, 1000), 'fetched');
  assert.strictEqual(await count(`SELECT COUNT(*) n FROM notes WHERE title = 'written by the shared work'`), 1);
}

async function main() {
  try {
    ({ token } = await embedded.start({ background: false }));
    await testBackgroundRollbackKeepsTheRequest();
    await testBackgroundCommitDoesNotStrandTheRequest();
    await testBackgroundUnitWaitsForTheRequest();
    await testBackgroundUnitYieldsBetweenTransactions();
    await testAbortedWhileQueuedNeverRuns();
    await testDownloadsLetTheTurnGo();
    await testJoiningSharedWorkDoesNotDeadlock();
  } finally {
    await cleanup();
  }
}

main()
  .then(() => console.log('Device-mode request/background isolation check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
