// utils/providerClient: the one pacing, cooldown, retry and identity layer every
// provider module now goes through (PROV-18). Driven with a stubbed axios adapter.
// Run: `node test/providerclient.test.js`
const assert = require('assert');
const { createProviderClient, retryAfterMs, USER_AGENT } = require('../src/utils/providerClient');
const { version } = require('../package.json');

const quietLog = { warn: () => {}, log: () => {}, error: () => {} };
const ok = (config) => ({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config, request: {} });
const limited = (config, retryAfter) => Object.assign(new Error('Request failed with status code 429'),
  { config, response: { status: 429, headers: retryAfter == null ? {} : { 'retry-after': retryAfter }, data: {} } });

function stubbed(opts, respond = ok) {
  const hits = [];
  const pc = createProviderClient({ name: 'test', log: quietLog, ...opts });
  pc.client.defaults.adapter = async (config) => {
    hits.push({ url: config.url, at: Date.now(), ua: config.headers['User-Agent'] });
    return respond(config, hits.length);
  };
  return { pc, hits };
}
const gaps = (hits) => hits.slice(1).map((h, i) => h.at - hits[i].at);

async function main() {
  // Retry-After: seconds, an HTTP-date, or nothing usable.
  assert.strictEqual(retryAfterMs('2'), 2000);
  assert.strictEqual(retryAfterMs('0'), 0);
  const now = Date.parse('2026-11-15T12:00:00Z');
  assert.strictEqual(retryAfterMs('Sun, 15 Nov 2026 12:00:30 GMT', now), 30000);
  assert.strictEqual(retryAfterMs('Sun, 15 Nov 2026 11:00:00 GMT', now), 0, 'a date in the past is no wait');
  assert.strictEqual(retryAfterMs('soon'), null);
  assert.strictEqual(retryAfterMs(undefined), null);

  // Identity: the package version, on every request.
  assert.ok(USER_AGENT.startsWith(`Bindarr/${version} `));
  let { pc, hits } = stubbed({});
  await pc.get('/a');
  assert.strictEqual(hits[0].ua, USER_AGENT);

  // Pacing: the floor between starts, one at a time.
  ({ pc, hits } = stubbed({ minGapMs: 60 }));
  await Promise.all([pc.get('/a'), pc.get('/b'), pc.get('/c')]);
  for (const g of gaps(hits)) assert.ok(g >= 55, `requests at least 60 ms apart (${g})`);

  // Per-endpoint gaps: the strict endpoint waits, another does not wait on it.
  ({ pc, hits } = stubbed({ endpointGaps: [[/^\/slow\b/, 150]] }));
  await pc.get('/slow/1');
  const t0 = Date.now();
  await pc.get('/fast');
  assert.ok(Date.now() - t0 < 100, 'another endpoint is not held by the strict one');
  await pc.get('https://api.example.test/slow/2?x=1');
  assert.ok(hits[2].at - hits[0].at >= 145, 'an absolute URL is matched by its path');

  // The pause after each response (PSA's rule).
  ({ pc, hits } = stubbed({ gapAfterMs: 80 }));
  await pc.get('/a');
  await pc.get('/b');
  assert.ok(gaps(hits)[0] >= 75, `the next request waits after the previous answer (${gaps(hits)[0]})`);

  // A 429 pauses everything; a background retry waits it out; an interactive
  // request during it fails at once without sending anything.
  ({ pc, hits } = stubbed({ attempts: 3 }, (config, n) => {
    if (n === 1) throw limited(config, '1');
    return ok(config);
  }));
  const background = pc.getRetried('/a');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(pc.coolingDown(), 'the 429 armed the pause');
  const sent = hits.length;
  const t1 = Date.now();
  await assert.rejects(pc.get('/b', undefined, { interactive: true }),
    (e) => e.code === 'PROVIDER_COOLDOWN' && e.response.status === 429);
  assert.ok(Date.now() - t1 < 50, 'refused at once');
  assert.strictEqual(hits.length, sent, 'nothing was sent for it');
  assert.strictEqual((await background).status, 200, 'the background request waited and succeeded');
  assert.ok(hits[1].at - hits[0].at >= 900, 'after the second Retry-After asked for');

  // An interactive retry runs again only when the pause is already over.
  ({ pc, hits } = stubbed({ attempts: 3 }, (config, n) => {
    if (n === 1) throw limited(config, '0');
    return ok(config);
  }));
  assert.strictEqual((await pc.getRetried('/a', undefined, { interactive: true })).status, 200);
  assert.strictEqual(hits.length, 2, 'Retry-After: 0 is asked again at once');

  // Retry-After is capped; the floor applies; a missing one takes the default.
  ({ pc } = stubbed({ maxCooldownMs: 2000 }, (config) => { throw limited(config, '3600'); }));
  await pc.get('/a').catch(() => {});
  assert.ok(pc.cooldownRemainingMs() <= 2000 && pc.cooldownRemainingMs() > 1500, 'capped');
  ({ pc } = stubbed({ minCooldownMs: 3000 }, (config) => { throw limited(config, '1'); }));
  await pc.get('/a').catch(() => {});
  assert.ok(pc.cooldownRemainingMs() > 2500, 'the floor holds');
  ({ pc } = stubbed({ defaultCooldownMs: 1500 }, (config) => { throw limited(config); }));
  await pc.get('/a').catch(() => {});
  assert.ok(pc.cooldownRemainingMs() > 1000 && pc.cooldownRemainingMs() <= 1500, 'the default without a header');

  // Hooks: before can refuse a request, error sees a failure.
  const seen = [];
  ({ pc, hits } = stubbed({ hooks: {
    before: async ({ url }) => { if (url === '/refused') throw new Error('not now'); seen.push(`before ${url}`); },
    error: async (e, { url }) => { seen.push(`error ${url} ${e.response.status}`); },
  } }, (config) => { if (config.url === '/bad') throw Object.assign(new Error('x'), { config, response: { status: 503, headers: {} } }); return ok(config); }));
  await assert.rejects(pc.get('/refused'), /not now/);
  await pc.get('/good');
  await pc.get('/bad').catch(() => {});
  assert.deepStrictEqual(seen, ['before /good', 'before /bad', 'error /bad 503']);
  assert.deepStrictEqual(hits.map(h => h.url), ['/good', '/bad'], 'a refused request is never sent');

  // A client the module brings keeps its own headers.
  const own = require('axios').create({ headers: { 'User-Agent': 'Exactly/1 (as agreed)' } });
  ({ pc, hits } = stubbed({ client: own }));
  await pc.get('/a');
  assert.strictEqual(hits[0].ua, 'Exactly/1 (as agreed)');

  console.log('providerclient.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
