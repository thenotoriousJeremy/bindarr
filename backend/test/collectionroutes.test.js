// The collection router's route table, pinned.
//
// routes/collection.js was one 1,900-line file and is now composed from
// routes/collection/*. Every module registers onto the one router, so the table
// below — what is reachable, with which methods, behind which limiter — is
// exactly the one the single file declared. A route that goes missing, picks up
// or loses searchLimiter, or lands behind GET /collection/:id fails here rather
// than in a client.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-collectionroutes-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const router = require('../src/routes/collection');
const { searchLimiter } = require('../src/middleware/auth');

const table = router.stack.map((layer) => {
  assert.ok(layer.route, 'the collection router holds routes only: no nested routers, no router-level middleware');
  const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
  const limited = layer.route.stack.some(l => l.handle === searchLimiter);
  return `${methods.join(',').toUpperCase()} ${layer.route.path}${limited ? ' [searchLimiter]' : ''}`;
});

// Every route the single file declared. Order within the file is free except
// where two paths can match one request (checked below).
const EXPECTED = [
  '_ALL /search [searchLimiter]',
  'GET /collection/cert/:certNumber [searchLimiter]',
  'GET /scan-sets',
  'POST /scan-match [searchLimiter]',
  'GET /collection',
  'GET /collection/:id',
  'GET /cards/:id/printing',
  'POST /collection',
  'POST /collection/bulk-add',
  'PUT /collection/:id',
  'POST /collection/:id/market-value/fetch [searchLimiter]',
  'POST /collection/:id/place',
  'POST /collection/restore-placement',
  'DELETE /collection/:id',
  'POST /collection/bulk',
];
assert.deepStrictEqual([...table].sort(), [...EXPECTED].sort(), `route table changed:\n${table.join('\n')}`);
console.log('PASS: every route, method and limiter is where the single file had it');

// GET /collection/:id passes non-numeric ids on with next(); the cert lookup has
// to be tried first.
const at = (entry) => table.findIndex(t => t.startsWith(entry));
assert.ok(at('GET /collection/cert/:certNumber') < at('GET /collection/:id'), 'cert lookup must precede GET /collection/:id');
console.log('PASS: cert lookup precedes GET /collection/:id');

// The literal POST paths must not sit behind a parameterised POST that could
// swallow them. There is none today; this keeps it that way.
for (const literal of ['POST /collection/bulk-add', 'POST /collection/restore-placement', 'POST /collection/bulk']) {
  const shadow = table.slice(0, at(literal)).find(t => /^POST \/collection\/:[^/]+$/.test(t));
  assert.ok(!shadow, `${literal} is behind ${shadow}`);
}
console.log('PASS: no parameterised POST shadows a literal one');

// What other modules import off the router: sealed.js and lists.js add through
// addCardToCollection / resolveCardForAdd and catch AddCardError, and
// cardsearchsql tests normalizeSearchParams.
for (const name of ['normalizeSearchParams', 'addCardToCollection', 'resolveCardForAdd', 'AddCardError']) {
  assert.strictEqual(typeof router[name], 'function', `router.${name} must still be exported`);
}
assert.ok(new router.AddCardError(404, 'x', 'card_not_found') instanceof Error);
console.log('PASS: router helpers are still exported');

for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch { /* never opened */ } }
console.log('collectionroutes.test.js: all checks passed');
process.exit(0);
