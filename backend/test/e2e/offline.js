// Preloaded with `node -r` into the servers the isolation and malformed suites
// start: no request leaves the machine.
//
// Scryfall is answered from fixtures by scryfall-mock.js (which also blanks
// HTTPS_PORT). Every other outbound call — TCGdex, Lorcast, pokemontcg.io, the
// startup set sync — fails at once, the way an unreachable provider would. Those
// suites hand routes ids nobody has cached on purpose, and without this the result
// would depend on the network, on a provider's rate limit and on what it happened
// to return that day.
require('./scryfall-mock');

const axios = require('axios');

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
const refused = (url) => Object.assign(new Error(`offline test server: refused ${url}`), { code: 'ECONNREFUSED' });

// Instances made by axios.create() bind this at creation, which is why it has to
// be patched here, before server.js loads a single provider module.
const originalRequest = axios.Axios.prototype.request;
axios.Axios.prototype.request = function offlineRequest(configOrUrl, config) {
  const cfg = typeof configOrUrl === 'string' ? { ...(config || {}), url: configOrUrl } : (configOrUrl || {});
  const url = String(cfg.url || '');
  const full = /^[a-z]+:\/\//i.test(url) ? url : `${cfg.baseURL || this.defaults.baseURL || ''}${url}`;
  if (!LOCAL.test(full)) return Promise.reject(refused(full));
  return originalRequest.call(this, configOrUrl, config);
};

const originalFetch = global.fetch;
global.fetch = async function offlineFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && (input.href || input.url)) || '';
  if (!LOCAL.test(String(url))) {
    throw Object.assign(new TypeError('fetch failed'), { cause: refused(url) });
  }
  return originalFetch(input, init);
};
