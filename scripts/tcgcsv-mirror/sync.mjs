#!/usr/bin/env node
// One polite copy of TCGCSV's Pokémon data for every Bindarr install.
//
// Why this exists: each self-hosted instance used to sync from TCGCSV itself,
// under the same User-Agent, so the traffic TCGCSV saw from "Bindarr" grew with
// the install count and went past its per-application allowance (<10,000
// requests a day). This script is run by ONE scheduled workflow, once a day, and
// writes a static tree with TCGCSV's own path layout. Instances point
// TCGCSV_BASE_URL at the published copy and never contact tcgcsv.com.
//
// What it serves, byte for byte as TCGCSV sent it (the client parses the same
// { totalItems, success, errors, results } envelope, so nothing re-serialises):
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
//   - a hard request cap far below the daily allowance;
//   - 403 or 429 ends the run at once, with no retry;
//   - no price archives, ever (only the four paths above can be requested).
//
// Exit codes: 0 synced (publish), 78 unchanged (skip publish), 1 error, 2 bad
// arguments. 78 is the old GitHub Actions "neutral" code; any distinct value
// would do, it only has to be one the workflow can tell apart from failure.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Same source of truth as the backend's own User-Agent, so the two never disagree
// about which release is talking.
const VERSION = JSON.parse(readFileSync(path.join(HERE, '../../backend/package.json'), 'utf8')).version;
export const USER_AGENT = `BindarrMirror/${VERSION} (+https://github.com/thenotoriousJeremy/bindarr)`;

export const EXIT = { SYNCED: 0, ERROR: 1, USAGE: 2, UNCHANGED: 78 };

const MIN_INTERVAL_MS = 100;        // TCGCSV's floor; not configurable below it
const DEFAULT_INTERVAL_MS = 200;    // double the floor: the run has all night
// ~606 Pokémon groups today -> ~1,215 requests for a full sync. 2,500 leaves room
// for new sets; 5,000 is half of TCGCSV's daily allowance and the most anyone may
// ask for, so a typo in --max-requests cannot turn this into the problem it fixes.
const DEFAULT_MAX_REQUESTS = 2500;
const MAX_REQUESTS_CEILING = 5000;
const REQUEST_TIMEOUT_MS = 30000;

// The only paths the mirror ever asks for. Anything else (archives above all) is
// refused before a socket opens. Digits-only ids also make every path safe to
// join onto --out.
const ALLOWED_PATHS = [
  /^\/last-updated\.txt$/,
  /^\/tcgplayer\/\d+\/groups$/,
  /^\/tcgplayer\/\d+\/\d+\/(products|prices)$/,
];

class UsageError extends Error {}

// 403 and 429 are TCGCSV saying stop. Retrying either is how an app gets blocked.
export class BlockedError extends Error {}

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
  async get(urlPath) {
    if (!ALLOWED_PATHS.some(re => re.test(urlPath))) {
      throw new Error(`refusing to fetch ${urlPath}: not a path the mirror serves`);
    }
    if (this.count >= this.maxRequests) {
      throw new Error(`request cap of ${this.maxRequests} reached before ${urlPath}`);
    }
    // Spacing is measured from the end of the previous response, so a slow reply
    // never shortens the gap. Looped because a timer may wake a millisecond early.
    if (this.count > 0) {
      const due = this.lastEnd + this.intervalMs;
      while (performance.now() < due) await sleep(due - performance.now());
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
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${urlPath}`);
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

export async function sync(options, log = console) {
  const { out, categories, base, maxRequests, intervalMs, previousLastUpdated } = options;
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

  let bytes = 0;
  const groupsByCategory = [];
  for (const categoryId of categories) {
    const urlPath = `/tcgplayer/${categoryId}/groups`;
    const body = await client.get(urlPath);
    const envelope = parseEnvelope(urlPath, body);
    if (envelope.success === false) {
      // Without the group list there is nothing to mirror for this category.
      throw new Error(`${urlPath} failed upstream: ${(envelope.errors || []).join('; ') || 'unknown error'}`);
    }
    const groupIds = envelope.results.map(g => g && g.groupId);
    const bad = groupIds.find(id => !Number.isInteger(id) || id <= 0);
    if (bad !== undefined) throw new Error(`${urlPath} has a non-numeric groupId: ${JSON.stringify(bad)}`);
    groupsByCategory.push({ categoryId, groupIds });
    bytes += await writeMirrored(out, urlPath, body);
  }

  // Fail before the bulk of the run rather than part-way through it: a sync the
  // cap would cut short is a wasted few hundred requests against TCGCSV.
  const groupCount = groupsByCategory.reduce((n, c) => n + c.groupIds.length, 0);
  const needed = client.count + groupCount * 2;
  if (needed > maxRequests) {
    throw new Error(
      `a full sync needs ${needed} requests (${groupCount} groups), over the cap of ${maxRequests}; stopped after the group lists`
    );
  }

  for (const { categoryId, groupIds } of groupsByCategory) {
    for (const groupId of groupIds) {
      for (const kind of ['products', 'prices']) {
        const urlPath = `/tcgplayer/${categoryId}/${groupId}/${kind}`;
        const body = await client.get(urlPath);
        const envelope = parseEnvelope(urlPath, body);
        // Mirrored verbatim anyway: an instance reading the mirror should see what
        // it would have seen from TCGCSV, not a different answer.
        if (envelope.success === false) log.warn(`${urlPath} reported success: false upstream`);
        bytes += await writeMirrored(out, urlPath, body);
      }
    }
  }

  // Written last, so a tree from a failed run never carries a marker claiming it
  // is complete.
  bytes += await writeMirrored(out, '/last-updated.txt', lastUpdatedBody);
  log.log(
    `Mirrored TCGCSV ${current}: ${groupCount} groups in categories ${categories.join(',')}, ` +
    `${client.count} requests, ${(bytes / 1048576).toFixed(1)} MiB.`
  );
  return { status: 'synced', lastUpdated: current, requests: client.count, groups: groupCount, bytes };
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
  return {
    out: path.resolve(values.out),
    categories: categories.map(Number),
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
