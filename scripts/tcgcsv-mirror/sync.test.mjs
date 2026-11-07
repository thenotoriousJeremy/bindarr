// Offline tests for the TCGCSV mirror sync. Every run points --base at a local
// fixture server; nothing here may reach tcgcsv.com.
//
//   node --test scripts/tcgcsv-mirror/sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'sync.mjs');

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
    assert.deepEqual(await listFiles(out), expected);
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
