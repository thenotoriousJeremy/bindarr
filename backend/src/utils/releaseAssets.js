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
const base = () => String(process.env.CATALOG_RELEASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
const disabled = () => String(process.env.CATALOG_RELEASE_URL || '').trim().toLowerCase() === 'off';
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
async function fetchAsset(name, { timeoutMs = 120000 } = {}) {
  if (disabled()) throw new AssetMissingError(name);
  const res = await fetch(urlFor(name), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream, application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) throw new AssetMissingError(name);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${name}`);
  return new Uint8Array(await res.arrayBuffer());
}

// A published JSON file, or null when it is not published.
async function fetchJson(name, opts) {
  try {
    return JSON.parse(new TextDecoder().decode(await fetchAsset(name, opts)));
  } catch (err) {
    if (err.code === 'ASSET_MISSING') return null;
    throw err;
  }
}

module.exports = { fetchAsset, fetchJson, urlFor, base, disabled, AssetMissingError, DEFAULT_BASE };
