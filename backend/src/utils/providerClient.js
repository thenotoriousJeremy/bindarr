// One HTTP client for every outside provider: card data, prices, sets, exchange
// rates.
//
// Each provider module used to hand-roll the same few things, each a little
// differently: a request queue and the gap between requests, a pause after a 429,
// a retry loop, a User-Agent, and metrics. Seven queues, six retry loops and five
// User-Agents later, only one module read a Retry-After given as a date, one sent
// no User-Agent at all, the model downloads claimed to be a browser, and MTGJSON,
// RiftCodex and the exchange rates had no metrics. This is that logic once:
//
//   pacing     one request at a time (`serial`), at least `minGapMs` between
//              starts, `gapAfterMs` after each response (PSA's rule), and per-
//              endpoint gaps (`endpointGaps`, Scryfall's 2/second card endpoints);
//   cooldown   a 429 (or another of `cooldownStatuses`) pauses every request to
//              the provider for Retry-After — seconds or an HTTP-date — or
//              `defaultCooldownMs`, kept within [`minCooldownMs`, `maxCooldownMs`].
//              Background requests wait the pause out; an `interactive` one fails
//              at once with a 429-shaped error (code PROVIDER_COOLDOWN), which
//              callers already turn into their rate-limit answer, because a person
//              should not wait a minute for a search;
//   retry      getRetried/postRetried make up to `attempts` tries of a request
//              that hit a rate limit, each one queued behind the pause;
//   identity   the User-Agent below, from package.json, unless the module brings
//              a client with headers of its own (TCGCSV's are part of an agreement
//              with its maintainer and stay exactly as they are);
//   metrics    every request is counted under the provider's name
//              (utils/metrics), plus `hooks` for what a provider needs on top.
//
// The axios instance stays the provider's own `client` export, and every request
// goes through `client.get` / `client.post` looked up at call time, so the tests
// that stub `client.defaults.adapter` or replace `client.get` still drive it.
const axios = require('axios');
const metrics = require('./metrics');

const { version } = require('../../package.json');
const USER_AGENT = `Bindarr/${version} (self-hosted TCG collection manager; https://github.com/thenotoriousJeremy/bindarr)`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A Retry-After value in milliseconds: delta-seconds or an HTTP-date. Null when
// absent or unreadable, so the caller's default applies.
function retryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// A response header, from axios's AxiosHeaders or a plain object (test stubs).
function headerOf(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.replace(/(^|-)([a-z])/g, (m, d, c) => d + c.toUpperCase())];
}

// A URL's path, for matching endpoint gaps. Relative ('/cards/search?q=') and
// absolute (a provider's own next-page link) both arrive here.
function pathOf(url) {
  let p = String(url || '');
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { /* the raw string is the best there is */ }
  }
  return p.split('?')[0];
}

const isRateLimited = (error, statuses) => !!(error && error.response && statuses.includes(error.response.status));

function createProviderClient({
  name,
  label = name,
  client = null,
  baseURL,
  timeout = 15000,
  headers = {},
  userAgent = USER_AGENT,
  instrument = true,
  serial = true,
  minGapMs = 0,
  gapAfterMs = 0,
  endpointGaps = [],
  cooldownStatuses = [429],
  defaultCooldownMs = 30000,
  minCooldownMs = 0,
  maxCooldownMs = 5 * 60 * 1000,
  attempts = 1,
  hooks = {},
  log = console,
} = {}) {
  if (!name) throw new TypeError('createProviderClient needs a name');
  const http = client || axios.create({
    baseURL,
    timeout,
    headers: { ...(userAgent ? { 'User-Agent': userAgent } : {}), Accept: 'application/json', ...headers },
  });
  if (instrument) metrics.instrumentAxiosClient(http, name);

  let queue = Promise.resolve();
  let lastAt = 0;
  let lastEnd = 0;
  let cooldownUntil = 0;
  const lastByEndpoint = new Map();

  const endpointOf = (url) => {
    const p = pathOf(url);
    for (const [pattern, gap] of endpointGaps) if (pattern.test(p)) return { key: pattern.source, gap };
    return { key: 'default', gap: 0 };
  };
  const coolingDown = () => cooldownUntil > Date.now();
  const cooldownRemainingMs = () => Math.max(0, cooldownUntil - Date.now());

  // How long this request still has to wait: the pause, its endpoint's gap, the
  // floor between requests, and the rest after the previous response.
  function waitMs(url) {
    const now = Date.now();
    const { key, gap } = endpointOf(url);
    return Math.max(
      cooldownUntil - now,
      gap - (now - (lastByEndpoint.get(key) || 0)),
      minGapMs - (now - lastAt),
      gapAfterMs - (now - lastEnd),
      0
    );
  }

  function cooldownError() {
    return Object.assign(new Error(`${label} rate limit: requests paused for ${Math.ceil(cooldownRemainingMs() / 1000)}s`), {
      code: 'PROVIDER_COOLDOWN', provider: name, response: { status: 429, headers: {}, data: {} },
    });
  }

  // Arm (or extend) the pause from a rate-limited response. True when it was one.
  function noteRateLimit(error) {
    if (!isRateLimited(error, cooldownStatuses)) return false;
    if (error.code === 'PROVIDER_COOLDOWN') return true;   // our own refusal, not the provider's
    const asked = retryAfterMs(headerOf(error.response.headers, 'retry-after'));
    const wait = Math.min(Math.max(asked ?? defaultCooldownMs, minCooldownMs), maxCooldownMs);
    const until = Date.now() + wait;
    if (until > cooldownUntil) {
      cooldownUntil = until;
      log.warn(`${label} rate-limited us — pausing all ${label} traffic for ${Math.round(wait / 1000)}s.`);
    }
    return true;
  }

  async function send(method, url, data, config, interactive) {
    for (let w = waitMs(url); w > 0; w = waitMs(url)) {
      // Re-checked after every wait: a 429 may have armed the pause meanwhile.
      if (interactive && coolingDown()) throw cooldownError();
      await sleep(w);
    }
    if (hooks.before) await hooks.before({ method, url });
    const { key } = endpointOf(url);
    lastAt = Date.now();
    lastByEndpoint.set(key, lastAt);
    try {
      return await (method === 'post' ? http.post(url, data, config) : http.get(url, config));
    } catch (error) {
      noteRateLimit(error);
      if (hooks.error) await hooks.error(error, { method, url });
      throw error;
    } finally {
      lastEnd = Date.now();
    }
  }

  function request(method, url, data, config, { interactive = false } = {}) {
    if (interactive && coolingDown()) return Promise.reject(cooldownError());
    if (!serial) return send(method, url, data, config, interactive);
    const run = queue.then(() => send(method, url, data, config, interactive));
    // Keep the chain alive whatever this request's outcome.
    queue = run.then(() => {}, () => {});
    return run;
  }

  // Up to `tries` attempts of a request that hit a rate limit, each queued behind
  // the pause it armed. An interactive one stops at the first pause still running:
  // only a 429 whose wait is already over (Retry-After: 0) is asked again.
  async function retried(method, url, data, config, { interactive = false, tries = attempts } = {}) {
    let lastError;
    for (let i = 0; i < tries; i++) {
      try {
        return await request(method, url, data, config, { interactive });
      } catch (error) {
        lastError = error;
        if (interactive && coolingDown()) throw error;
        if (isRateLimited(error, cooldownStatuses) && i < tries - 1) continue;
        throw error;
      }
    }
    throw lastError;
  }

  return {
    name,
    client: http,
    get: (url, config, opts) => request('get', url, undefined, config, opts),
    post: (url, data, config, opts) => request('post', url, data, config, opts),
    getRetried: (url, config, opts) => retried('get', url, undefined, config, opts),
    postRetried: (url, data, config, opts) => retried('post', url, data, config, opts),
    noteRateLimit,
    coolingDown,
    cooldownRemainingMs,
  };
}

module.exports = { createProviderClient, retryAfterMs, USER_AGENT };
