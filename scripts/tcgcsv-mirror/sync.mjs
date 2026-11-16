#!/usr/bin/env node
// One polite copy of the TCGCSV data Bindarr reads, for every Bindarr install.
//
// Why this exists: each self-hosted instance used to sync from TCGCSV itself,
// under the same User-Agent, so the traffic TCGCSV saw from "Bindarr" grew with
// the install count and went past its per-application allowance (<10,000
// requests a day). This script is run by ONE scheduled workflow, once a day, and
// writes a static tree with TCGCSV's own path layout. Instances point
// TCGCSV_BASE_URL at the published copy and never contact tcgcsv.com.
//
// What it serves, byte for byte as TCGCSV sent it (the client parses the same
// { totalItems, success, errors, results } envelope, so nothing re-serialises),
// except in the sealed-only categories (Magic 1, Lorcana 71): there Bindarr reads
// only sealed product, and Magic alone is ~100k cards, so products and prices are
// filtered to sealed product with the backend's own rule (utils/tcgcsvSlim.js)
// and re-serialised in the same envelope:
//
//   /last-updated.txt
//   /tcgplayer/{categoryId}/groups
//   /tcgplayer/{categoryId}/{groupId}/products
//   /tcgplayer/{categoryId}/{groupId}/prices
//
// TCGCSV's rules, all enforced here rather than trusted to the caller:
//   - a User-Agent naming the mirror and linking the project;
//   - /last-updated.txt first, and a full sync only when it moved;
//   - strictly serial, at least 100 ms between requests;
//   - a hard request cap far below the daily allowance, retries included;
//   - 403 or 429 ends the run at once, with no retry;
//   - a 5xx is retried a bounded number of times, with backoff, then ends the run;
//   - a group whose products or prices are gone (404) is skipped and left out of
//     the tree, exactly as TCGCSV serves it, rather than ending the run: one bad
//     group used to stop every install's daily prices, and the backend already
//     records a missing group as empty (tcgcsvApi.syncResults);
//   - no price archives, ever (only the four paths above can be requested).
//
// Exit codes: 0 synced (publish), 78 unchanged (skip publish), 1 error, 2 bad
// arguments. 78 is the old GitHub Actions "neutral" code; any distinct value
// would do, it only has to be one the workflow can tell apart from failure.
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Same source of truth as the backend's own User-Agent, so the two never disagree
// about which release is talking.
const VERSION = JSON.parse(readFileSync(path.join(HERE, '../../backend/package.json'), 'utf8')).version;
export const USER_AGENT = `BindarrMirror/${VERSION} (+https://github.com/thenotoriousJeremy/bindarr)`;

// The backend's rule for what counts as sealed product, so the mirror and the
// cache can never disagree about which Magic/Lorcana rows Bindarr needs.
const {
  isSealedProduct, SEALED_ONLY_CATEGORIES, slimResults, SLIM_VERSION, BUNDLE_KINDS, bundlePath, INDEX_PATH,
} = createRequire(import.meta.url)('../../backend/src/utils/tcgcsvSlim.js');

export const EXIT = { SYNCED: 0, ERROR: 1, USAGE: 2, UNCHANGED: 78 };

const MIN_INTERVAL_MS = 100;        // TCGCSV's floor; not configurable below it
const DEFAULT_INTERVAL_MS = 200;    // double the floor: the run has all night
// 682 Pokémon groups (3, 85) took 1,367 requests on 2026-11-10; Riftbound (89),
// Lorcana (71) and Magic (1) add 2 per group. 4,500 leaves room for new sets;
// 5,000 is half of TCGCSV's daily allowance and the most anyone may ask for, so a
// typo in --max-requests cannot turn this into the problem it fixes. The run
// stops after the group lists if the whole sync would not fit.
const DEFAULT_MAX_REQUESTS = 4500;
const MAX_REQUESTS_CEILING = 5000;
const REQUEST_TIMEOUT_MS = 30000;
// A server error is TCGCSV having a bad moment, not saying stop: asked again up to
// this many times, waiting ten request intervals and then twice that.
const MAX_5XX_RETRIES = 2;
const RETRY_BACKOFF_INTERVALS = 10;

// The only paths the mirror ever asks for. Anything else (archives above all) is
// refused before a socket opens. Digits-only ids also make every path safe to
// join onto --out.
const ALLOWED_PATHS = [
  /^\/last-updated\.txt$/,
  // Read once a run, and only when optional categories are configured, to check
  // each one is the game it was added for (CATEGORY_NAMES).
  /^\/tcgplayer\/categories$/,
  /^\/tcgplayer\/\d+\/groups$/,
  /^\/tcgplayer\/\d+\/\d+\/(products|prices)$/,
];

class UsageError extends Error {}

// 403 and 429 are TCGCSV saying stop. Retrying either is how an app gets blocked.
export class BlockedError extends Error {}

// 404: TCGCSV has no such path. For one group's products or prices that is a
// group gone or not published yet, which the run steps over.
export class NotFoundError extends Error {}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class PoliteClient {
  constructor({ base, maxRequests, intervalMs }) {
    this.base = base.replace(/\/+$/, '');
    this.maxRequests = maxRequests;
    this.intervalMs = intervalMs;
    this.count = 0;
    this.lastEnd = 0;
  }

  // One request at a time: every caller awaits, and nothing here runs in parallel.
  // A 5xx is asked again, MAX_5XX_RETRIES times at most, each retry a request the
  // cap counts like any other; 403 and 429 never are.
  async get(urlPath) {
    if (!ALLOWED_PATHS.some(re => re.test(urlPath))) {
      throw new Error(`refusing to fetch ${urlPath}: not a path the mirror serves`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(urlPath, attempt ? this.intervalMs * RETRY_BACKOFF_INTERVALS * 2 ** (attempt - 1) : 0);
      } catch (e) {
        if (!(e.status >= 500) || attempt >= MAX_5XX_RETRIES) throw e;
      }
    }
  }

  async once(urlPath, extraWaitMs) {
    if (this.count >= this.maxRequests) {
      throw new Error(`request cap of ${this.maxRequests} reached before ${urlPath}`);
    }
    // Spacing is measured from the end of the previous response, so a slow reply
    // never shortens the gap. Looped because a timer may wake a millisecond early.
    if (this.count > 0) {
      const due = this.lastEnd + Math.max(this.intervalMs, extraWaitMs);
      while (performance.now() < due) await sleep(Math.max(1, due - performance.now()));
    }
    this.count++;
    try {
      const res = await fetch(this.base + urlPath, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain' },
        // A followed redirect is an extra request the cap would not see.
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 403 || res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        throw new BlockedError(
          `HTTP ${res.status} for ${urlPath}${retryAfter ? ` (retry-after ${retryAfter})` : ''}; stopping without retry`
        );
      }
      if (res.status === 404) throw new NotFoundError(`HTTP 404 for ${urlPath}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${urlPath}`), { status: res.status });
      return Buffer.from(await res.arrayBuffer());
    } finally {
      this.lastEnd = performance.now();
    }
  }
}

function parseEnvelope(urlPath, body) {
  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error(`${urlPath} is not JSON`);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
    throw new Error(`${urlPath} has no results array`);
  }
  return data;
}

// --previous-last-updated takes either the timestamp or a file holding it (the
// workflow passes the file it read from the published branch). Missing or empty
// means nothing has been published yet.
async function readPrevious(value) {
  if (!value) return '';
  try {
    if ((await stat(value)).isFile()) return (await readFile(value, 'utf8')).trim();
  } catch { /* not a file: treat it as the timestamp itself */ }
  return String(value).trim();
}

function isNewer(current, previous, log) {
  if (!previous) return true;
  const prev = Date.parse(previous);
  if (!Number.isFinite(prev)) {
    // A corrupt published marker must not freeze the mirror forever.
    log.warn(`previous last-updated "${previous}" is unreadable; doing a full sync`);
    return true;
  }
  return Date.parse(current) > prev;
}

async function writeMirrored(outDir, urlPath, body) {
  const file = path.join(outDir, ...urlPath.split('/').filter(Boolean));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return body.length;
}

// --- what to fetch -------------------------------------------------------------
//
// Prices move every day; a set's product list mostly does not. So a group's
// products are re-fetched only when they may have changed, and otherwise the copy
// already in the published tree is kept (the workflow checks the previous tree out
// into --out first):
//   · no copy yet, or a group TCGCSV did not list last time
//   · the group's modifiedOn moved
//   · a set published in the last RECENT_DAYS, which fills in for weeks
//   · and every group once a week regardless (groupId % 7), in case a change
//     slips past modifiedOn
// That roughly halves the daily requests, which is the room the optional
// categories below fit into.
const RECENT_DAYS = 60;
const ROTATION_DAYS = 7;
const DAY_MS = 86400000;

// What each category's TCGplayer name must look like before anything of it is
// mirrored. Only checked for the optional categories (one extra request): a
// category id typed wrong would otherwise fill a game with another game's cards
// for every install that reads the mirror.
export const CATEGORY_NAMES = {
  2: /yu-?gi-?oh/i,
  62: /flesh/i,
  63: /digimon/i,
  68: /one ?piece/i,
  79: /star ?wars/i,
};

const exists = async (file) => { try { await stat(file); return true; } catch { return false; } };
const fileOf = (outDir, urlPath) => path.join(outDir, ...urlPath.split('/').filter(Boolean));

async function readEnvelopeFile(outDir, urlPath) {
  try {
    return JSON.parse(await readFile(fileOf(outDir, urlPath), 'utf8'));
  } catch {
    return null;
  }
}

// groupId -> modifiedOn, from the groups list the previous run published.
async function previousStamps(outDir, categoryId) {
  const env = await readEnvelopeFile(outDir, `/tcgplayer/${categoryId}/groups`);
  return new Map((env && Array.isArray(env.results) ? env.results : []).map(g => [g.groupId, g.modifiedOn ?? null]));
}

export function productsDue(group, { previous, haveFile, refreshAll, now }) {
  if (refreshAll || !haveFile || !previous.has(group.groupId)) return true;
  if ((previous.get(group.groupId) ?? null) !== (group.modifiedOn ?? null)) return true;
  const published = Date.parse(group.publishedOn || '');
  if (Number.isFinite(published) && now - published < RECENT_DAYS * DAY_MS) return true;
  return group.groupId % ROTATION_DAYS === Math.floor(now / DAY_MS) % ROTATION_DAYS;
}

// --- bundles -------------------------------------------------------------------
//
// One file per category and kind, already slim (backend/src/utils/tcgcsvSlim.js,
// the same rules an instance applies to the per-group files), plus an index of
// the bundles' hashes. An instance then syncs a category in at most three
// requests and skips the ones whose hash it already holds (tcgcsvApi.
// syncFromBundles). The per-group files stay, byte for byte, for every release
// that predates the bundles and for anyone pointing an install at TCGCSV itself.
async function writeBundles(outDir, categoryId, version) {
  const groupsPath = `/tcgplayer/${categoryId}/groups`;
  const groupsEnv = await readEnvelopeFile(outDir, groupsPath);
  if (!groupsEnv || !Array.isArray(groupsEnv.results)) return 0;
  const groups = slimResults(groupsPath, groupsEnv.results);
  const products = {}, prices = {};
  for (const g of groups) {
    const productsPath = `/tcgplayer/${categoryId}/${g.groupId}/products`;
    const pricesPath = `/tcgplayer/${categoryId}/${g.groupId}/prices`;
    const prodEnv = await readEnvelopeFile(outDir, productsPath);
    products[g.groupId] = prodEnv && Array.isArray(prodEnv.results) ? slimResults(productsPath, prodEnv.results) : [];
    const keep = SEALED_ONLY_CATEGORIES.has(categoryId) ? new Set(products[g.groupId].map(p => p.productId)) : null;
    const priceEnv = await readEnvelopeFile(outDir, pricesPath);
    prices[g.groupId] = priceEnv && Array.isArray(priceEnv.results)
      ? slimResults(pricesPath, priceEnv.results, { keepProductIds: keep }) : [];
  }
  // No version or timestamp in the body: a bundle whose rows did not change must be
  // byte-identical to yesterday's, so its hash in the index is too and an instance
  // carries it forward without downloading it (most days, every products bundle).
  // The index names the version; an instance checks each bundle against the
  // index's hash, which also catches a CDN serving an older copy.
  void version;
  let bytes = 0;
  for (const [kind, results] of [['groups', groups], ['products', products], ['prices', prices]]) {
    const body = JSON.stringify({ success: true, errors: [], slim: SLIM_VERSION, categoryId, kind, results });
    bytes += await writeMirrored(outDir, bundlePath(categoryId, kind), Buffer.from(body));
  }
  return bytes;
}

async function writeIndex(outDir, version, categories) {
  const files = {};
  for (const categoryId of categories) {
    for (const kind of BUNDLE_KINDS) {
      const urlPath = bundlePath(categoryId, kind);
      try {
        files[urlPath] = createHash('sha256').update(await readFile(fileOf(outDir, urlPath))).digest('hex').slice(0, 20);
      } catch { /* a category with no bundle is simply not listed */ }
    }
  }
  const body = JSON.stringify({ version, slim: SLIM_VERSION, generatedAt: new Date().toISOString(), files });
  return writeMirrored(outDir, INDEX_PATH, Buffer.from(body));
}

// A group TCGCSV no longer lists leaves its directory behind in a tree that is
// carried from run to run; remove it, so the tree is exactly the groups listed.
async function pruneGroups(outDir, categoryId, groupIds) {
  const dir = fileOf(outDir, `/tcgplayer/${categoryId}`);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  const keep = new Set(groupIds.map(String));
  let removed = 0;
  for (const e of entries) {
    if (e.isDirectory() && /^\d+$/.test(e.name) && !keep.has(e.name)) {
      await rm(path.join(dir, e.name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

export async function sync(options, log = console) {
  const {
    out, categories, optionalCategories = [], base, maxRequests, intervalMs, previousLastUpdated,
    refreshAllProducts = false, now = Date.now(),
  } = options;
  const client = new PoliteClient({ base, maxRequests, intervalMs });
  const previous = await readPrevious(previousLastUpdated);

  const lastUpdatedBody = await client.get('/last-updated.txt');
  const current = lastUpdatedBody.toString('utf8').trim();
  if (!Number.isFinite(Date.parse(current))) {
    throw new Error(`last-updated.txt is not a timestamp: ${current.slice(0, 80) || '(empty)'}`);
  }
  if (!isNewer(current, previous, log)) {
    log.log(`TCGCSV last updated ${current}; published copy is ${previous}. Nothing to sync.`);
    return { status: 'unchanged', lastUpdated: current, requests: client.count };
  }

  // Optional categories are vetted by name first, and dropped (not fatal) when
  // they do not look like the game they are meant to be.
  let optional = optionalCategories.filter(c => !categories.includes(c));
  if (optional.length) {
    const urlPath = '/tcgplayer/categories';
    const envelope = parseEnvelope(urlPath, await client.get(urlPath));
    const names = new Map(envelope.results.map(c => [c && c.categoryId, `${c && c.name} ${c && c.displayName}`]));
    optional = optional.filter(c => {
      const ok = names.has(c) && (!CATEGORY_NAMES[c] || CATEGORY_NAMES[c].test(names.get(c)));
      if (!ok) log.warn(`category ${c} is "${names.get(c) || 'not listed'}", not the game it was added for; skipping it`);
      return ok;
    });
  }

  let bytes = 0;
  // Every group list first (one request each), so the budget is known before the
  // bulk of the run: the core categories must fit, each optional one is added
  // only while the run still fits under the cap.
  const plan = [];
  const fetchGroups = async (categoryId) => {
    const urlPath = `/tcgplayer/${categoryId}/groups`;
    const body = await client.get(urlPath);
    const envelope = parseEnvelope(urlPath, body);
    if (envelope.success === false) {
      // Without the group list there is nothing to mirror for this category.
      throw new Error(`${urlPath} failed upstream: ${(envelope.errors || []).join('; ') || 'unknown error'}`);
    }
    const groups = envelope.results;
    const bad = groups.map(g => g && g.groupId).find(id => !Number.isInteger(id) || id <= 0);
    if (bad !== undefined) throw new Error(`${urlPath} has a non-numeric groupId: ${JSON.stringify(bad)}`);
    const prev = await previousStamps(out, categoryId);
    const due = new Set();
    for (const g of groups) {
      const haveFile = await exists(fileOf(out, `/tcgplayer/${categoryId}/${g.groupId}/products`));
      if (productsDue(g, { previous: prev, haveFile, refreshAll: refreshAllProducts, now })) due.add(g.groupId);
    }
    return { categoryId, groups, due, body, cost: groups.length + due.size };
  };

  for (const categoryId of categories) plan.push(await fetchGroups(categoryId));
  const coreNeeded = client.count + plan.reduce((n, p) => n + p.cost, 0);
  if (coreNeeded > maxRequests) {
    // Fail before the bulk of the run rather than part-way through it: a sync the
    // cap would cut short is a wasted few hundred requests against TCGCSV.
    throw new Error(
      `a full sync needs ${coreNeeded} requests (${plan.reduce((n, p) => n + p.groups.length, 0)} groups), ` +
      `over the cap of ${maxRequests}; stopped after the group lists`
    );
  }
  const skipped = [];
  for (const categoryId of optional) {
    if (client.count + 1 > maxRequests) { skipped.push(categoryId); continue; }
    const entry = await fetchGroups(categoryId);
    const needed = client.count + plan.reduce((n, p) => n + p.cost, 0) + entry.cost;
    if (needed > maxRequests) {
      skipped.push(categoryId);
      log.warn(`category ${categoryId} needs ${entry.cost} more requests than today's cap leaves; keeping yesterday's copy`);
      continue;
    }
    plan.push(entry);
  }

  let groupCount = 0, productFetches = 0;
  let missing = 0;   // group files TCGCSV answered 404 for
  for (const { categoryId, groups, due, body } of plan) {
    groupCount += groups.length;
    bytes += await writeMirrored(out, `/tcgplayer/${categoryId}/groups`, body);
    await pruneGroups(out, categoryId, groups.map(g => g.groupId));
    const sealedOnly = SEALED_ONLY_CATEGORIES.has(categoryId);
    for (const { groupId } of groups) {
      let sealedIds = null;   // products before prices, so the prices can follow them
      for (const kind of ['products', 'prices']) {
        const urlPath = `/tcgplayer/${categoryId}/${groupId}/${kind}`;
        if (kind === 'products' && !due.has(groupId)) {
          // Kept from the previous run; a sealed-only category's prices still
          // need to know which products it kept.
          if (sealedOnly) {
            const kept = await readEnvelopeFile(out, urlPath);
            sealedIds = new Set((kept && kept.results || []).map(p => p && p.productId));
          }
          continue;
        }
        if (kind === 'products') productFetches++;
        let fetched;
        try {
          fetched = await client.get(urlPath);
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e;
          // Left out of the tree, so an install reading the mirror sees the same
          // 404 and records the group as empty — yesterday's copy included, which
          // the previous tree may still hold. A group with no products has no
          // prices worth a request either.
          log.warn(`${urlPath} is not on TCGCSV (404); skipping ${kind === 'products' ? 'this group' : 'its prices'}`);
          missing++;
          for (const k of kind === 'products' ? ['products', 'prices'] : ['prices']) {
            await rm(fileOf(out, `/tcgplayer/${categoryId}/${groupId}/${k}`), { force: true });
          }
          break;
        }
        const envelope = parseEnvelope(urlPath, fetched);
        // Mirrored anyway: an instance reading the mirror should see what it
        // would have seen from TCGCSV, not a different answer.
        if (envelope.success === false) log.warn(`${urlPath} reported success: false upstream`);
        if (!sealedOnly) {
          bytes += await writeMirrored(out, urlPath, fetched);
          continue;
        }
        let results;
        if (kind === 'products') {
          results = envelope.results.filter(p => p && typeof p === 'object' && isSealedProduct(p));
          sealedIds = new Set(results.map(p => p.productId));
        } else {
          results = envelope.results.filter(r => r && sealedIds.has(r.productId));
        }
        const filtered = JSON.stringify({ ...envelope, totalItems: results.length, results });
        bytes += await writeMirrored(out, urlPath, Buffer.from(filtered));
      }
    }
  }

  // Bundles for every category the tree holds — a skipped optional category's
  // too, rebuilt from yesterday's files under today's version, so an instance never
  // sees an index and a bundle that disagree.
  const bundled = [...categories, ...optionalCategories.filter(c => !categories.includes(c))];
  for (const categoryId of bundled) bytes += await writeBundles(out, categoryId, current);
  bytes += await writeIndex(out, current, bundled);

  // Written last, so a tree from a failed run never carries a marker claiming it
  // is complete.
  bytes += await writeMirrored(out, '/last-updated.txt', lastUpdatedBody);
  log.log(
    `Mirrored TCGCSV ${current}: ${groupCount} groups in categories ${plan.map(p => p.categoryId).join(',')}` +
    `${skipped.length ? ` (skipped ${skipped.join(',')})` : ''}, ${productFetches} product lists re-fetched, ` +
    `${client.count} requests, ${(bytes / 1048576).toFixed(1)} MiB written` +
    `${missing ? `, ${missing} path(s) skipped as missing upstream` : ''}.`
  );
  return {
    status: 'synced', lastUpdated: current, requests: client.count, groups: groupCount, bytes,
    categories: plan.map(p => p.categoryId), skipped, productFetches, missing,
  };
}

function positiveInt(name, value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

export function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        out: { type: 'string' },
        categories: { type: 'string', default: '3,85' },
        // Mirrored only when they fit under the cap after --categories, and only
        // once TCGCSV's own name for each matches the game (CATEGORY_NAMES).
        'optional-categories': { type: 'string', default: '' },
        // Re-fetch every group's products, not just the ones that may have changed.
        'refresh-products': { type: 'boolean', default: false },
        base: { type: 'string', default: 'https://tcgcsv.com' },
        'max-requests': { type: 'string' },
        'previous-last-updated': { type: 'string' },
        'interval-ms': { type: 'string' },
      },
      strict: true,
    }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (!values.out) throw new UsageError('--out <dir> is required');
  const categories = values.categories.split(',').map(s => s.trim()).filter(Boolean);
  if (!categories.length || categories.some(c => !/^\d+$/.test(c))) {
    throw new UsageError('--categories must be comma-separated numeric TCGplayer category ids');
  }
  if (!/^https?:\/\//.test(values.base)) throw new UsageError('--base must be an http(s) URL');
  const maxRequests = positiveInt('max-requests', values['max-requests'], DEFAULT_MAX_REQUESTS);
  if (maxRequests > MAX_REQUESTS_CEILING) {
    throw new UsageError(`--max-requests may not exceed ${MAX_REQUESTS_CEILING}`);
  }
  const intervalMs = positiveInt('interval-ms', values['interval-ms'], DEFAULT_INTERVAL_MS);
  if (intervalMs < MIN_INTERVAL_MS) throw new UsageError(`--interval-ms may not be below ${MIN_INTERVAL_MS}`);
  const optional = String(values['optional-categories'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (optional.some(c => !/^\d+$/.test(c))) {
    throw new UsageError('--optional-categories must be comma-separated numeric TCGplayer category ids');
  }
  return {
    out: path.resolve(values.out),
    categories: categories.map(Number),
    optionalCategories: optional.map(Number),
    refreshAllProducts: !!values['refresh-products'],
    base: values.base,
    maxRequests,
    intervalMs,
    previousLastUpdated: values['previous-last-updated'] || '',
  };
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (e) {
    console.error(`usage error: ${e.message}`);
    return EXIT.USAGE;
  }
  try {
    const result = await sync(options);
    return result.status === 'unchanged' ? EXIT.UNCHANGED : EXIT.SYNCED;
  } catch (e) {
    console.error(`${e instanceof BlockedError ? 'blocked' : 'error'}: ${e.message}`);
    return EXIT.ERROR;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
