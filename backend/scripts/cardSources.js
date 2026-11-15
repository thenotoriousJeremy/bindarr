// Shared card-image sources for the global index builds. Returns a flat list of
// { name, set, number, img } where img is a reasonably high-res image URL
// (better than the tiny thumbnails — the milo embedder takes a 448px crop and
// benefits from a sharp downsample rather than an upscaled thumbnail).
const axios = require('axios');
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');

const { version } = require('../package.json');
// Scryfall asks callers to identify themselves and rate-limits generic agents
// harder, so send something traceable rather than a bare product name.
const USER_AGENT = `Bindarr/${version} (+https://github.com/thenotoriousJeremy/bindarr)`;

function makeHttp() {
  return axios.create({
    timeout: 30000,
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Scryfall bulk-data ---------------------------------------------------

// Scryfall has renamed these fields before. In issue #29 `download_uri` and
// `size` disappeared in favour of `jsonl_download_uri` and `compressed_size`,
// and because nothing validated the shape it surfaced as `NaN MB` followed by
// `TypeError: Invalid URL` thrown ten frames deep inside axios — which tells a
// user nothing. So accept either spelling, and when neither is present say what
// we looked for and what the entry actually carried.
const URL_FIELDS = ['jsonl_download_uri', 'download_uri'];
const SIZE_FIELDS = ['compressed_size', 'size'];

function resolveBulkEntry(list, type) {
  const entries = Array.isArray(list) ? list : [];
  const entry = entries.find(d => d && d.type === type);
  if (!entry) {
    const saw = entries.map(e => e && e.type).filter(Boolean).join(', ') || 'nothing';
    throw new Error(`Scryfall bulk-data has no '${type}' entry (saw: ${saw})`);
  }
  const urlField = URL_FIELDS.find(f => typeof entry[f] === 'string' && entry[f]);
  if (!urlField) {
    throw new Error(
      `Scryfall bulk-data entry '${type}' has no usable download URL. Looked for ` +
      `${URL_FIELDS.join(' or ')}; the entry only has [${Object.keys(entry).join(', ')}]. ` +
      `Scryfall's bulk-data schema has probably changed again (see issue #29).`
    );
  }
  const sizeField = SIZE_FIELDS.find(f => Number.isFinite(entry[f]));
  return { url: entry[urlField], bytes: sizeField ? entry[sizeField] : 0, urlField };
}

// Re-emit `stream` with gunzip spliced in when its first bytes are the gzip
// magic number. Sniffed rather than inferred from the URL because Scryfall
// serves the bulk file as `Content-Type: application/gzip` with NO
// `Content-Encoding`, so no HTTP layer unzips it for us — and because a future
// switch back to plain JSONL should keep working without a code change.
async function maybeGunzip(stream) {
  const it = stream[Symbol.asyncIterator]();
  const first = await it.next();
  const head = first.done ? Buffer.alloc(0) : first.value;
  // objectMode: false so this stays a byte stream — gunzip and readline both
  // want chunks, not discrete objects.
  const rebuilt = Readable.from((async function* () {
    if (head.length) yield head;
    if (!first.done) { let n; while (!(n = await it.next()).done) yield n.value; }
  })(), { objectMode: false });
  const isGzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  return isGzip ? rebuilt.pipe(zlib.createGunzip()) : rebuilt;
}

// Yield one parsed card object per line. Handles both the current JSONL format
// and the older single-JSON-array file, which Scryfall also wrote one object per
// line — stripping the brackets and trailing commas covers both, so the
// `download_uri` fallback above stays usable.
async function* streamCardObjects(http, url) {
  const resp = await http.get(url, { responseType: 'stream', timeout: 120000, decompress: false });
  const rl = readline.createInterface({ input: await maybeGunzip(resp.data), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim().replace(/,$/, '');
    if (!s || s === '[' || s === ']') continue;
    try { yield JSON.parse(s); }
    catch { /* a truncated final line is not worth failing 74k cards over */ }
  }
}

// One image per scannable face: single-image layouts give one; double-faced
// cards (transform, modal DFC, art series, reversible) give one per face so
// scanning either side matches.
function faceImgs(c) {
  const top = c.image_uris?.normal || c.image_uris?.small;
  if (top) return [top];
  return (c.card_faces || []).map(f => f.image_uris?.normal || f.image_uris?.small).filter(Boolean);
}

// MTG: Scryfall unique_artwork bulk — one gzipped JSONL file, no key. Streamed
// and reduced to the four fields we keep as it parses, so peak memory stays in
// the tens of MB instead of inflating the whole 37 MB archive into ~500 MB of
// JSON text plus a parsed array of full card objects.
async function gatherMtg(http, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  console.log('Fetching Scryfall bulk-data index...');
  const bulkIndex = await http.get('https://api.scryfall.com/bulk-data');
  const { url, bytes, urlField } = resolveBulkEntry(bulkIndex.data?.data, 'unique_artwork');
  const mb = bytes ? `${(bytes / 1e6).toFixed(0)} MB` : 'unknown size';
  console.log(`Streaming unique_artwork (${mb}, via ${urlField})...`);

  // Dedupe by image URL: unique_artwork already yields one card per
  // illustration, but a DFC can surface once per face.
  const seen = new Set();
  const out = [];
  for await (const c of streamCardObjects(http, url)) {
    for (const img of faceImgs(c)) {
      if (seen.has(img)) continue;
      seen.add(img);
      out.push({ name: c.name || '', set: c.set || '', number: c.collector_number || '', img });
    }
    if (out.length % 5000 === 0) onProgress(out.length);
  }
  if (out.length === 0) throw new Error(`Scryfall unique_artwork stream yielded no cards (${url})`);
  console.log(`Bulk contains ${out.length} scannable faces.`);
  return out;
}

// --- Pokémon -------------------------------------------------------------

// How long to wait after a 429, preferring the server's own Retry-After.
function retryAfterMs(err, attempt) {
  const raw = err?.response?.headers?.['retry-after'];
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60000);
  return 2000 * Math.pow(2, attempt);
}

// Pokémon: page pokemontcg.io /cards (no bulk file). Uses POKEMON_TCG_API_KEY
// if set. Retries each page with backoff (the API is slow/flaky under load).
async function gatherPokemon(http, delay, limit) {
  const key = process.env.POKEMON_TCG_API_KEY || '';
  const headers = key ? { 'X-Api-Key': key } : {};
  if (!key) console.warn('No POKEMON_TCG_API_KEY set — paging may throttle.');
  console.log(`Paging pokemontcg.io /cards${key ? ' (with API key)' : ' (no key)'}...`);
  const out = [];
  let page = 1;
  let total = Infinity;
  while ((page - 1) * 250 < total) {
    let data = null;
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && data === null; attempt++) {
      try {
        const r = await http.get('https://api.pokemontcg.io/v2/cards', {
          params: { page, pageSize: 250, select: 'id,name,number,set,images' },
          headers,
          timeout: 30000,
        });
        total = r.data.totalCount || 0;
        data = r.data.data || [];
      } catch (e) {
        if (attempt === MAX_ATTEMPTS - 1) throw e;
        const wait = retryAfterMs(e, attempt);
        console.warn(`  page ${page} attempt ${attempt + 1} failed (${e.message}); retrying in ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
      }
    }
    if (data.length === 0) break;
    for (const c of data) {
      const img = c.images?.large || c.images?.small;
      if (img) out.push({ name: c.name || '', set: c.set?.id || '', number: c.number || '', img });
    }
    console.log(`  page ${page} (${out.length}/${total})`);
    if (limit && out.length >= limit) break;
    page++;
    await sleep(delay);
  }
  return out;
}

module.exports = {
  makeHttp, gatherMtg, gatherPokemon, sleep, USER_AGENT,
  // exported for backend/test/cardsources.test.js
  resolveBulkEntry, maybeGunzip, streamCardObjects,
};
