// Scryfall's bulk card file, streamed: the whole-game MTG catalog build reads
// every card from ONE download instead of paging /cards/search set by set.
//
// Measured 2026-11-15 against the live API: a whole English build paged ~946
// search requests across 464 set families (175 cards a page, each a full card
// object), where `default_cards` is a single 77 MiB gzipped JSONL file served
// from data.scryfall.io — Scryfall's own guidance for anything that walks the
// whole catalogue, and outside the API's rate limit. Two requests: the bulk-data
// index, then the file.
//
// Server-only (catalog builds never run on a phone). zlib is aliased to a stub
// in device mode (embedded/aliases.js), which is why it is required lazily and
// nothing here needs `stream` or `readline`.
'use strict';

const BULK_INDEX = 'https://api.scryfall.com/bulk-data';
// The index goes through Scryfall's shared queue (scryGetRetried); the file comes
// from its CDN, outside the API's rate limit, with the same User-Agent.
const USER_AGENT = require('./utils/providerClient').USER_AGENT;

// Find a bulk file's download URL. `type`: 'default_cards' (every print, in
// English or its only printed language) or 'all_cards' (every language).
async function bulkUrl(type) {
  const { scryGetRetried } = require('./scryfallApi');
  const r = await scryGetRetried(BULK_INDEX);
  const entry = (r.data && r.data.data || []).find(b => b.type === type);
  const url = entry && (entry.jsonl_download_uri || entry.download_uri);
  if (!url) throw new Error(`Scryfall lists no ${type} bulk file`);
  if (!/\.jsonl(\.gz)?$/i.test(new URL(url).pathname)) {
    // The older one-big-JSON-array format would have to be parsed whole (~500 MB).
    throw new Error(`Scryfall's ${type} file is not JSONL (${url})`);
  }
  return { url, updatedAt: entry.updated_at || null, size: entry.compressed_size || null };
}

// Stream every card in a bulk file to `onCard(card)`, one parsed object at a
// time, without holding the file in memory. `onCard` may be async (it is awaited,
// which back-pressures the download) and may return false to stop early.
// Resolves to { cards, url }.
async function streamCards(type, onCard, { signal } = {}) {
  const { url } = await bulkUrl(type);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/gzip, application/json' },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`);

  const gzipped = /\.gz$/i.test(new URL(url).pathname);
  const zlib = gzipped ? require('zlib') : null;
  const gunzip = gzipped ? zlib.createGunzip() : null;
  const decoder = new TextDecoder();
  let pending = '';
  let cards = 0;
  let stopped = false;

  // Raw bytes -> gunzip, honouring its back-pressure so a slow consumer (the
  // SQLite writes behind onCard) never lets the download balloon in memory.
  const feed = gzipped ? (async () => {
    try {
      for await (const chunk of res.body) {
        if (stopped) break;
        // 'close' too: a consumer that stops early destroys gunzip, and a drain that
        // never comes would leave this loop (and the caller's finally) hanging.
        if (!gunzip.write(chunk)) {
          await new Promise(resolve => {
            const done = () => { gunzip.off('drain', done); gunzip.off('close', done); resolve(); };
            gunzip.on('drain', done);
            gunzip.on('close', done);
          });
        }
      }
      gunzip.end();
    } catch (err) {
      gunzip.destroy(err);
    }
  })() : null;

  const consume = async (text) => {
    pending += text;
    let start = 0;
    let nl;
    while (!stopped && (nl = pending.indexOf('\n', start)) >= 0) {
      const line = pending.slice(start, nl).trim();
      start = nl + 1;
      if (!line) continue;
      cards++;
      if ((await onCard(JSON.parse(line))) === false) stopped = true;
    }
    pending = pending.slice(start);
  };

  try {
    const source = gzipped ? gunzip : res.body;
    for await (const chunk of source) {
      await consume(decoder.decode(chunk, { stream: true }));
      if (stopped) break;
    }
    if (!stopped) await consume(decoder.decode() + '\n');
  } finally {
    stopped = true;
    if (gunzip) gunzip.destroy();
    if (feed) await feed.catch(() => {});
  }
  return { cards, url };
}

module.exports = { streamCards, bulkUrl };
