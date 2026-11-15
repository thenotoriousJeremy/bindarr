// Offline tests for the TCGCSV mirror sync. Every run points --base at a local
// fixture server; nothing here may reach tcgcsv.com.
//
//   node --test scripts/tcgcsv-mirror/sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'sync.mjs');
const { productsDue } = await import('./sync.mjs');

const LAST_UPDATED = '2026-11-06T20:05:50+0000\n';
const envelope = (results) => JSON.stringify({ totalItems: results.length, success: true, errors: [], results });

// Two categories, three groups: 1 + 2 + 3 * 2 = 9 requests for a full sync.
// Bodies keep TCGCSV's own spacing quirks out of JSON.stringify's hands on
// purpose, so the byte-for-byte check below would notice a re-serialisation.
function fixtureRoutes() {
  const routes = new Map();
  routes.set('/last-updated.txt', { body: LAST_UPDATED, type: 'text/plain' });
  routes.set('/tcgplayer/3/groups', { body: envelope([
    { groupId: 101, name: 'Base Set', abbreviation: 'BS', categoryId: 3 },
    { groupId: 102, name: 'Jungle', abbreviation: 'JU', categoryId: 3 },
  ]) });
  routes.set('/tcgplayer/85/groups', { body: envelope([
    { groupId: 201, name: 'SV1S: Scarlet ex', abbreviation: 'SV1S', categoryId: 85 },
  ]) });
  for (const [cat, group] of [[3, 101], [3, 102], [85, 201]]) {
    routes.set(`/tcgplayer/${cat}/${group}/products`, {
      body: `{"totalItems":1,"success":true,"errors":[],"results":[{"productId":${group}0,"name":"Card ${group}","extendedData":[{"name":"Number","value":"1/102"}]}]}`,
    });
    routes.set(`/tcgplayer/${cat}/${group}/prices`, {
      body: `{"totalItems":1,"success":true,"errors":[],"results":[{"productId":${group}0,"marketPrice":1.23,"subTypeName":"Normal"}]}`,
    });
  }
  return routes;
}

async function startServer(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, at: performance.now(), userAgent: req.headers['user-agent'] });
    const route = routes.get(req.url);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    // `failFirst`: answer this many requests with `failStatus` before the body.
    if (route.failFirst > 0) {
      route.failFirst--;
      res.writeHead(route.failStatus || 503, { 'Content-Type': 'text/plain' });
      return res.end('upstream trouble');
    }
    res.writeHead(route.status || 200, {
      'Content-Type': route.type || 'application/json',
      ...(route.headers || {}),
    });
    res.end(route.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function runSync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

// Each test gets its own server and output directory.
async function withFixture(routes, fn) {
  const server = await startServer(routes);
  const out = await mkdtemp(path.join(os.tmpdir(), 'bindarr-tcgcsv-mirror-'));
  try {
    await fn({ server, out, base: ['--base', server.base, '--out', out, '--interval-ms', '100'] });
  } finally {
    await server.close();
    await rm(out, { recursive: true, force: true });
  }
}

test('skips the full sync when last-updated.txt has not moved', async () => {
  await withFixture(fixtureRoutes(), async ({ server, out, base }) => {
    const r = await runSync([...base, '--previous-last-updated', LAST_UPDATED.trim()]);
    assert.equal(r.code, 78, r.stderr);
    assert.deepEqual(server.requests.map(q => q.path), ['/last-updated.txt']);
    assert.deepEqual(await listFiles(out), [], 'an unchanged run must write nothing to publish');
  });
});

test('reads the previous timestamp from a file, as the workflow passes it', async () => {
  await withFixture(fixtureRoutes(), async ({ server, out, base }) => {
    const marker = path.join(out, '..', `prev-${process.pid}.txt`);
    await writeFile(marker, LAST_UPDATED);
    try {
      const r = await runSync([...base, '--previous-last-updated', marker]);
      assert.equal(r.code, 78, r.stderr);
      assert.equal(server.requests.length, 1);
    } finally {
      await rm(marker, { force: true });
    }
  });
});

test('a newer timestamp mirrors every path byte for byte, marker last', async () => {
  const routes = fixtureRoutes();
  await withFixture(routes, async ({ server, out, base }) => {
    const r = await runSync([...base, '--categories', '3,85', '--previous-last-updated', '2026-11-05T20:05:50+0000']);
    assert.equal(r.code, 0, r.stderr);

    const expected = [...routes.keys()].sort();
    // Everything TCGCSV serves, byte for byte; the bundles and their index live
    // under /bindarr/ beside it (tested below).
    assert.deepEqual((await listFiles(out)).filter(p => !p.startsWith('/bindarr/')), expected);
    for (const p of expected) {
      const written = await readFile(path.join(out, ...p.split('/').filter(Boolean)));
      assert.ok(written.equals(Buffer.from(routes.get(p).body)), `${p} must be served exactly as TCGCSV sent it`);
    }

    assert.equal(server.requests.length, 9);
    assert.equal(server.requests[0].path, '/last-updated.txt', 'last-updated.txt is always fetched first');
    assert.ok(!server.requests.some(q => /archive/i.test(q.path)), 'price archives are never fetched');
  });
});

test('no previous timestamp means a full sync', async () => {
  await withFixture(fixtureRoutes(), async ({ server, base }) => {
    const r = await runSync(base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(server.requests.length, 9);
  });
});

test('requests are serial and at least 100 ms apart', async () => {
  await withFixture(fixtureRoutes(), async ({ server, base }) => {
    const r = await runSync(base);
    assert.equal(r.code, 0, r.stderr);
    for (let i = 1; i < server.requests.length; i++) {
      const gap = server.requests[i].at - server.requests[i - 1].at;
      assert.ok(gap >= 100,`request ${i} came ${gap.toFixed(1)} ms after the previous one`);
    }
  });
});

test('every request sends the BindarrMirror User-Agent', async () => {
  const { version } = JSON.parse(await readFile(path.join(HERE, '../../backend/package.json'), 'utf8'));
  await withFixture(fixtureRoutes(), async ({ server, base }) => {
    const r = await runSync(base);
    assert.equal(r.code, 0, r.stderr);
    for (const q of server.requests) {
      assert.equal(q.userAgent, `BindarrMirror/${version} (+https://github.com/thenotoriousJeremy/bindarr)`);
    }
  });
});

test('403 stops the run immediately, with no retry and nothing marked complete', async () => {
  const routes = fixtureRoutes();
  routes.set('/tcgplayer/3/groups', { status: 403, body: 'blocked', type: 'text/plain' });
  await withFixture(routes, async ({ server, out, base }) => {
    const r = await runSync(base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /blocked: HTTP 403/);
    assert.deepEqual(server.requests.map(q => q.path), ['/last-updated.txt', '/tcgplayer/3/groups']);
    assert.ok(!(await listFiles(out)).includes('/last-updated.txt'));
  });
});

test('429 part-way through stops the run too', async () => {
  const routes = fixtureRoutes();
  routes.set('/tcgplayer/3/102/products', { status: 429, body: 'slow down', type: 'text/plain', headers: { 'Retry-After': '3600' } });
  await withFixture(routes, async ({ server, out, base }) => {
    const r = await runSync(base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 429.*retry-after 3600/);
    assert.equal(server.requests.at(-1).path, '/tcgplayer/3/102/products');
    assert.equal(server.requests.filter(q => q.path === '/tcgplayer/3/102/products').length, 1);
    assert.ok(!(await listFiles(out)).includes('/last-updated.txt'));
  });
});

test('refuses a full sync the request cap cannot finish', async () => {
  await withFixture(fixtureRoutes(), async ({ server, base }) => {
    // 9 needed, 5 allowed: stops after the group lists instead of half a sync.
    const r = await runSync([...base, '--max-requests', '5']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /needs 9 requests.*cap of 5/);
    assert.equal(server.requests.length, 3);
  });
});

test('the request cap is a hard stop, not just a forecast', async () => {
  await withFixture(fixtureRoutes(), async ({ server, base }) => {
    const r = await runSync([...base, '--max-requests', '2']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /request cap of 2 reached/);
    assert.equal(server.requests.length, 2);
  });
});

test('rejects settings that would break TCGCSV rules before any request', async () => {
  await withFixture(fixtureRoutes(), async ({ server, out }) => {
    const common = ['--base', server.base, '--out', out];
    assert.equal((await runSync([...common, '--interval-ms', '50'])).code, 2);
    assert.equal((await runSync([...common, '--max-requests', '9000'])).code, 2);
    assert.equal((await runSync([...common, '--categories', '3,../x'])).code, 2);
    assert.equal(server.requests.length, 0);
  });
});

test('sealed-only categories keep just sealed product and its prices', async () => {
  const routes = fixtureRoutes();
  routes.set('/tcgplayer/1/groups', { body: envelope([{ groupId: 301, name: 'Foundations', abbreviation: 'FDN', categoryId: 1 }]) });
  routes.set('/tcgplayer/1/301/products', { body: envelope([
    { productId: 9001, name: 'Lightning Bolt', extendedData: [{ name: 'Number', value: '123' }] },
    { productId: 9002, name: 'Foundations Play Booster Box', extendedData: [] },
    { productId: 9003, name: 'Foundations Bundle' },
  ]) });
  routes.set('/tcgplayer/1/301/prices', { body: envelope([
    { productId: 9001, marketPrice: 2.5, subTypeName: 'Normal' },
    { productId: 9001, marketPrice: 9.5, subTypeName: 'Foil' },
    { productId: 9002, marketPrice: 140, subTypeName: 'Normal' },
    { productId: 9003, marketPrice: 45, subTypeName: 'Normal' },
  ]) });
  await withFixture(routes, async ({ out, base }) => {
    const r = await runSync([...base, '--categories', '3,1']);
    assert.equal(r.code, 0, r.stderr);
    const read = async (p) => JSON.parse(await readFile(path.join(out, ...p.split('/').filter(Boolean)), 'utf8'));
    const products = await read('/tcgplayer/1/301/products');
    assert.deepEqual(products.results.map(p => p.productId), [9002, 9003], 'cards are dropped, sealed product kept');
    assert.equal(products.totalItems, 2);
    assert.equal(products.success, true);
    const prices = await read('/tcgplayer/1/301/prices');
    assert.deepEqual(prices.results.map(p => p.productId), [9002, 9003], 'only the kept products keep prices');
    // Pokémon stays byte for byte.
    const pokemon = await readFile(path.join(out, 'tcgplayer', '3', '101', 'products'));
    assert.ok(pokemon.equals(Buffer.from(routes.get('/tcgplayer/3/101/products').body)));
  });
});

// --- bundles, the products policy, optional categories ------------------------

const read = async (out, p) => JSON.parse(await readFile(path.join(out, ...p.split('/').filter(Boolean)), 'utf8'));

test('publishes slim per-category bundles and an index of their hashes', async () => {
  await withFixture(fixtureRoutes(), async ({ out, base }) => {
    const r = await runSync([...base, '--categories', '3,85']);
    assert.equal(r.code, 0, r.stderr);
    const index = await read(out, '/bindarr/index.json');
    assert.equal(index.version, LAST_UPDATED.trim());
    assert.equal(typeof index.slim, 'number');
    const paths = Object.keys(index.files).sort();
    const want = [3, 85].flatMap(c => ['groups', 'prices', 'products'].map(k => `/bindarr/v${index.slim}/${c}/${k}`)).sort();
    assert.deepEqual(paths, want);
    for (const p of paths) {
      const body = await readFile(path.join(out, ...p.split('/').filter(Boolean)));
      assert.equal(index.files[p], createHash('sha256').update(body).digest('hex').slice(0, 20), `${p} hash`);
      const bundle = JSON.parse(body);
      assert.equal(bundle.version, undefined, 'no version in a bundle: unchanged rows must be byte-identical day to day');
      assert.equal(bundle.slim, index.slim);
    }
    const products = await read(out, `/bindarr/v${index.slim}/3/products`);
    // The fixture's card has no picture, which the slim row records as imageUrl: null.
    assert.deepEqual(products.results['101'], [{ productId: 1010, name: 'Card 101', number: '1/102', imageUrl: null }],
      'slim, keyed by group');
    const prices = await read(out, `/bindarr/v${index.slim}/3/prices`);
    assert.deepEqual(prices.results['102'], [{ productId: 1020, subTypeName: 'Normal', marketPrice: 1.23, midPrice: null }]);
  });
});

test('keeps a group\'s products from the previous run unless they may have changed', async () => {
  const routes = fixtureRoutes();
  // Old sets, unchanged since the last run: only their prices are due, apart from
  // whichever group the weekly rotation picks today.
  const groups = [
    { groupId: 101, name: 'Base Set', abbreviation: 'BS', categoryId: 3, publishedOn: '1999-01-09T00:00:00', modifiedOn: '2020-01-01T00:00:00' },
    { groupId: 102, name: 'Jungle', abbreviation: 'JU', categoryId: 3, publishedOn: '1999-06-16T00:00:00', modifiedOn: '2020-01-01T00:00:00' },
  ];
  routes.set('/tcgplayer/3/groups', { body: envelope(groups) });
  await withFixture(routes, async ({ server, out, base }) => {
    let r = await runSync([...base, '--categories', '3', '--previous-last-updated', '2026-11-05T20:05:50+0000']);
    assert.equal(r.code, 0, r.stderr);
    // A group dropped from TCGCSV's list leaves no directory behind.
    await mkdir(path.join(out, 'tcgplayer', '3', '999'), { recursive: true });
    routes.set('/last-updated.txt', { body: '2026-11-07T20:05:50+0000\n', type: 'text/plain' });
    server.requests.length = 0;
    r = await runSync([...base, '--categories', '3', '--previous-last-updated', LAST_UPDATED.trim()]);
    assert.equal(r.code, 0, r.stderr);
    const prev = new Map(groups.map(g => [g.groupId, g.modifiedOn]));
    const due = groups.filter(g => productsDue(g, { previous: prev, haveFile: true, refreshAll: false, now: Date.now() }));
    const fetched = server.requests.map(q => q.path);
    assert.equal(fetched.filter(p => p.endsWith('/products')).length, due.length, 'only the rotation\'s group re-fetches products');
    assert.equal(fetched.filter(p => p.endsWith('/prices')).length, 2, 'prices always');
    const kept = await readFile(path.join(out, 'tcgplayer', '3', '101', 'products'));
    assert.ok(kept.equals(Buffer.from(routes.get('/tcgplayer/3/101/products').body)), 'a kept file is still byte for byte');
    assert.deepEqual((await readdir(path.join(out, 'tcgplayer', '3'))).filter(n => /^\d+$/.test(n)).sort(), ['101', '102'],
      'the delisted group is pruned');
  });
});

test('products are due for a new, changed or recently published group', async () => {
  const now = Date.parse('2026-11-15T00:00:00Z');
  const day = Math.floor(now / 86400000) % 7;
  const id = [8, 15, 22, 29, 36, 43, 50].find(n => n % 7 !== day);   // not on today's rotation
  const prev = new Map([[id, '2020-01-01']]);
  const old = { groupId: id, modifiedOn: '2020-01-01', publishedOn: '2010-01-01' };
  assert.equal(productsDue(old, { previous: prev, haveFile: true, now }), false, 'unchanged and old: kept');
  assert.equal(productsDue({ ...old, modifiedOn: '2026-11-14' }, { previous: prev, haveFile: true, now }), true, 'modifiedOn moved');
  assert.equal(productsDue({ ...old, groupId: 99 }, { previous: prev, haveFile: true, now }), true, 'a group not listed last time');
  assert.equal(productsDue({ ...old, publishedOn: '2026-10-20' }, { previous: prev, haveFile: true, now }), true, 'a set still filling in');
  assert.equal(productsDue(old, { previous: prev, haveFile: false, now }), true, 'no copy yet');
  assert.equal(productsDue(old, { previous: prev, haveFile: true, refreshAll: true, now }), true, '--refresh-products');
  const rotating = { ...old, groupId: [7, 8, 9, 10, 11, 12, 13].find(n => n % 7 === day) };
  assert.equal(productsDue(rotating, { previous: new Map([[rotating.groupId, '2020-01-01']]), haveFile: true, now }), true,
    'every group once a week');
});

test('optional categories are checked by name and only taken while they fit the cap', async () => {
  const routes = fixtureRoutes();
  routes.set('/tcgplayer/categories', { body: envelope([
    { categoryId: 3, name: 'Pokemon' }, { categoryId: 68, name: 'One Piece Card Game', displayName: 'One Piece Card Game' },
    { categoryId: 63, name: 'Dragon Ball Super CCG' },
  ]) });
  routes.set('/tcgplayer/68/groups', { body: envelope([{ groupId: 601, name: 'Romance Dawn', abbreviation: 'OP01', categoryId: 68 }]) });
  routes.set('/tcgplayer/68/601/products', { body: envelope([{
    productId: 6010, name: 'Monkey.D.Luffy', groupId: 601, imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/6010_200w.jpg',
    extendedData: [{ name: 'Number', value: 'OP01-003' }, { name: 'Rarity', value: 'Leader' },
      { name: 'Color', value: 'Red;Green' }, { name: 'Description', value: 'x'.repeat(200) }],
  }]) });
  routes.set('/tcgplayer/68/601/prices', { body: envelope([
    { productId: 6010, marketPrice: 3.5, subTypeName: 'Normal' }, { productId: 6010, marketPrice: 40, subTypeName: 'Foil' },
  ]) });
  await withFixture(routes, async ({ server, out, base }) => {
    const r = await runSync([...base, '--categories', '3,85', '--optional-categories', '68,63']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(server.requests.some(q => q.path === '/tcgplayer/categories'), 'names are checked');
    assert.ok(!server.requests.some(q => q.path.startsWith('/tcgplayer/63/')), 'a category that is not the game is never fetched');
    const index = await read(out, '/bindarr/index.json');
    const products = await read(out, `/bindarr/v${index.slim}/68/products`);
    assert.deepEqual(products.results['601'], [{
      productId: 6010, name: 'Monkey.D.Luffy', number: 'OP01-003', groupId: 601, rarity: 'Leader', ext: { Color: 'Red;Green' },
    }], 'a catalogue card keeps its short fields, never the rules text or the standard image url');
    const prices = await read(out, `/bindarr/v${index.slim}/68/prices`);
    assert.deepEqual(prices.results['601'].map(p => p.subTypeName), ['Normal', 'Foil'], 'every finish with a price');
  });
  // A cap that fits the core categories but not the optional one skips it.
  await withFixture(routes, async ({ server, base }) => {
    // last-updated + categories + 2 group lists + 3 groups x 2 = 10 for the core, and
    // 68's group list makes 11; its products and prices would make 13.
    const r = await runSync([...base, '--categories', '3,85', '--optional-categories', '68', '--max-requests', '11']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!server.requests.some(q => /^\/tcgplayer\/68\/\d+\//.test(q.path)), 'no product or price request for a category that does not fit');
    assert.match(r.stdout + r.stderr, /skipped 68/);
  });
});

test('a group that 404s is skipped, and the rest of the run completes', async () => {
  const routes = fixtureRoutes();
  routes.delete('/tcgplayer/3/102/products');
  routes.delete('/tcgplayer/3/102/prices');
  await withFixture(routes, async ({ server, out, base }) => {
    const r = await runSync(base);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /\/tcgplayer\/3\/102\/products is not on TCGCSV \(404\); skipping this group/);
    const files = await listFiles(out);
    assert.ok(!files.includes('/tcgplayer/3/102/products'), 'the missing group is left out of the tree');
    assert.ok(files.includes('/tcgplayer/85/201/prices'), 'groups after it are still mirrored');
    assert.ok(files.includes('/last-updated.txt'), 'and the run is marked complete');
    assert.equal(server.requests.filter(q => q.path === '/tcgplayer/3/102/products').length, 1, 'a 404 is not retried');
    assert.ok(!server.requests.some(q => q.path === '/tcgplayer/3/102/prices'), 'a group with no products costs no prices request');
  });
});

test('a group whose prices alone 404 keeps its products', async () => {
  const routes = fixtureRoutes();
  routes.delete('/tcgplayer/85/201/prices');
  await withFixture(routes, async ({ out, base }) => {
    const r = await runSync(base);
    assert.equal(r.code, 0, r.stderr);
    const files = await listFiles(out);
    assert.ok(files.includes('/tcgplayer/85/201/products'));
    assert.ok(!files.includes('/tcgplayer/85/201/prices'));
  });
});

test('a 5xx is retried, and the retried answer is mirrored byte for byte', async () => {
  const routes = fixtureRoutes();
  routes.get('/tcgplayer/3/101/prices').failFirst = 1;
  await withFixture(routes, async ({ server, out, base }) => {
    const r = await runSync(base);
    assert.equal(r.code, 0, r.stderr);
    const asked = server.requests.filter(q => q.path === '/tcgplayer/3/101/prices');
    assert.equal(asked.length, 2, 'asked once more after the 503');
    assert.ok(asked[1].at - asked[0].at >= 900, 'after a backoff well beyond the usual gap');
    const written = await readFile(path.join(out, 'tcgplayer', '3', '101', 'prices'));
    assert.ok(written.equals(Buffer.from(routes.get('/tcgplayer/3/101/prices').body)));
  });
});

test('a 5xx that persists ends the run after a bounded number of retries', async () => {
  const routes = fixtureRoutes();
  Object.assign(routes.get('/tcgplayer/3/101/products'), { failFirst: 99, failStatus: 500 });
  await withFixture(routes, async ({ server, out, base }) => {
    const r = await runSync(base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 500 for \/tcgplayer\/3\/101\/products/);
    assert.equal(server.requests.filter(q => q.path === '/tcgplayer/3/101/products').length, 3, 'one try and two retries');
    assert.ok(!(await listFiles(out)).includes('/last-updated.txt'), 'nothing is marked complete');
  });
});
