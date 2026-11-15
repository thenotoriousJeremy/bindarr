// Preloaded with `node -r` into every server an e2e suite starts (harness.js):
// no request leaves the machine.
//
// Scryfall is answered from fixtures by scryfall-mock.js (which also blanks
// HTTPS_PORT). Every other outbound call — TCGdex, Lorcast, pokemontcg.io, the
// startup set sync — fails at once, the way an unreachable provider would. Suites
// hand routes ids nobody has cached on purpose, and without this the result
// would depend on the network, on a provider's rate limit and on what it happened
// to return that day. Each refusal is logged as `offline` for run.js to count.
// netguard.js refuses at the socket whatever reaches the network some other way.
require('./netguard');
require('./scryfall-mock');

const axios = require('axios');
const { record } = require('./netguard');

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
const withoutQuery = (url) => String(url).split('?')[0];
const refused = (method, url) => {
  record('offline', `${String(method || 'GET').toUpperCase()} ${withoutQuery(url)}`);
  return Object.assign(new Error(`offline test server: refused ${url}`), { code: 'ECONNREFUSED' });
};

// Instances made by axios.create() bind this at creation, which is why it has to
// be patched here, before server.js loads a single provider module.
const originalRequest = axios.Axios.prototype.request;
axios.Axios.prototype.request = function offlineRequest(configOrUrl, config) {
  const cfg = typeof configOrUrl === 'string' ? { ...(config || {}), url: configOrUrl } : (configOrUrl || {});
  const url = String(cfg.url || '');
  const full = /^[a-z]+:\/\//i.test(url) ? url : `${cfg.baseURL || this.defaults.baseURL || ''}${url}`;
  if (!LOCAL.test(full)) return Promise.reject(refused(cfg.method, full));
  return originalRequest.call(this, configOrUrl, config);
};

const originalFetch = global.fetch;
global.fetch = async function offlineFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && (input.href || input.url)) || '';
  if (!LOCAL.test(String(url))) {
    throw Object.assign(new TypeError('fetch failed'), { cause: refused((init && init.method) || (input && input.method), url) });
  }
  return originalFetch(input, init);
};

// harness.js starts each server with an IPC channel, which closes when the suite
// that started it exits. A suite killed by run.js's per-file timeout, or one that
// crashed before stop(), would otherwise leave its server running, holding the
// suite's temp directory open.
if (typeof process.send === 'function') {
  process.on('disconnect', () => process.exit(0));
}
