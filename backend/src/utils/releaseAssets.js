// Files the project publishes for installs to pull: the `scan-catalogs` release
// of this repository (built weekly by .github/workflows/scan-catalogs.yml).
//
// Release assets, not the GitHub API: an asset URL is a plain CDN download with no
// API rate limit, and it needs no token. CATALOG_RELEASE_URL points an install at
// another copy (a fork's release, or a local folder served for tests); `off` makes
// every file read as not published, without a request (an offline install, and
// the end-to-end tests, which fail on any outbound connection).
//
// fetch(), not axios: a phone running the app routes fetch through Capacitor's
// native HTTP layer, and nothing here needs more than GET.
'use strict';

const DEFAULT_BASE = 'https://github.com/thenotoriousJeremy/bindarr/releases/download/scan-catalogs';
const disabled = () => String(process.env.CATALOG_RELEASE_URL || '').trim().toLowerCase() === 'off';
// `off` switches downloads off; it is not an address, so the base stays the default.
const base = () => String((!disabled() && process.env.CATALOG_RELEASE_URL) || DEFAULT_BASE).replace(/\/+$/, '');
// Bindarr's own name (utils/providerClient), as every other outbound request has.
const USER_AGENT = require('./providerClient').USER_AGENT;

const urlFor = (name) => `${base()}/${encodeURIComponent(name)}`;

class AssetMissingError extends Error {
  constructor(name) {
    super(`${name} is not published`);
    this.code = 'ASSET_MISSING';
  }
}

// The bytes of one published file. A 404 is its own error: before the workflow
// has run, or for a catalog nobody publishes, "not there" is an answer, not a
// failure.
//
// `maxBytes` caps the body: the manifest says how big a segment is, and a
// response that runs past that is refused as it streams, not after it has filled
// memory. A JSON file is capped small by default.
const JSON_MAX_BYTES = 16 * 1024 * 1024;
async function fetchAsset(name, { timeoutMs = 120000, maxBytes = Infinity } = {}) {
  if (disabled()) throw new AssetMissingError(name);
  const res = await fetch(urlFor(name), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream, application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) throw new AssetMissingError(name);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${name}`);
  const tooBig = () => new Error(`${name} is larger than the ${maxBytes} bytes expected — refusing it`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw tooBig();
  }
  if (!res.body || !Number.isFinite(maxBytes)) return new Uint8Array(await res.arrayBuffer());
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// A published JSON file, or null when it is not published.
async function fetchJson(name, { maxBytes = JSON_MAX_BYTES, ...opts } = {}) {
  try {
    return JSON.parse(new TextDecoder().decode(await fetchAsset(name, { maxBytes, ...opts })));
  } catch (err) {
    if (err.code === 'ASSET_MISSING') return null;
    throw err;
  }
}

module.exports = { fetchAsset, fetchJson, urlFor, base, disabled, AssetMissingError, DEFAULT_BASE };
