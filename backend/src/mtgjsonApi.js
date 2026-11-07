// Preconstructed Magic decks and Secret Lair drops, from MTGJSON (https://mtgjson.com).
//
// Two endpoints, both static files behind Cloudflare and both checked against the
// live site on 2026-11-07 (format 5.3.0):
//
//   /api/v5/DeckList.json         the index: ~3,100 decks, each
//                                 { code, fileName, name, releaseDate, type }.
//                                 Secret Lair drops are type "Secret Lair Drop"
//                                 (sets SLD, SLC, SLU); the Secret Lair Commander
//                                 decks are type "Commander Deck" in set SLD.
//   /api/v5/decks/<fileName>.json one deck: commander, mainBoard and sideBoard
//                                 arrays of full card objects, each with `count`,
//                                 `isFoil`, `setCode`, `number` and
//                                 `identifiers.scryfallId`.
//
// A deck file carries every card's rulings and foreign names (a Commander deck is
// ~600 KB), so only the fields an import reads are kept, and both the index and
// the decks are cached for a day — the files are regenerated daily at most.
// Requests go out one at a time with a gap between them, and a 429 pauses all of
// them for as long as MTGJSON asks.
const axios = require('axios');

const USER_AGENT = `Bindarr/${require('../package.json').version} (self-hosted TCG collection manager; https://github.com/thenotoriousJeremy/bindarr)`;

const client = axios.create({
  baseURL: 'https://mtgjson.com/api/v5',
  timeout: 30000,
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_GAP_MS = 250;
const MAX_CACHED_DECKS = 30;
// The boards a deck import takes. Tokens, planes and schemes ride along in a box
// but are not cards anyone files, and MTGJSON keeps them in arrays of their own.
const BOARDS = ['commander', 'mainBoard', 'sideBoard'];

let queue = Promise.resolve();
let lastAt = 0;
let pausedUntil = 0;

function paced(path) {
  const run = queue.then(async () => {
    const wait = Math.max(pausedUntil - Date.now(), MIN_GAP_MS - (Date.now() - lastAt), 0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
    try {
      return await client.get(path);
    } catch (error) {
      if (error.response && error.response.status === 429) {
        const seconds = parseInt(error.response.headers && error.response.headers['retry-after'], 10);
        pausedUntil = Date.now() + (Number.isFinite(seconds) ? seconds * 1000 : 60000);
      }
      throw error;
    }
  });
  queue = run.then(() => {}, () => {});
  return run;
}

let index = null;        // { at, meta, decks }
let indexPending = null;

// The deck index, cached for a day. A failed refresh keeps serving the old one.
async function listDecks() {
  if (index && Date.now() - index.at < DAY_MS) return index;
  if (indexPending) return indexPending;
  indexPending = (async () => {
    try {
      const { data } = await paced('/DeckList.json');
      if (!data || !Array.isArray(data.data)) throw new Error('MTGJSON deck list has no data array');
      const decks = data.data
        .filter(d => d && typeof d.fileName === 'string' && d.fileName && d.name)
        .map(d => ({
          fileName: d.fileName,
          name: String(d.name),
          code: String(d.code || '').toUpperCase(),
          type: String(d.type || ''),
          releaseDate: d.releaseDate || null,
        }));
      index = { at: Date.now(), meta: data.meta || null, decks };
      return index;
    } catch (error) {
      if (index) {
        console.warn(`MTGJSON deck list refresh failed (${error.message}); using the cached list.`);
        return index;
      }
      throw error;
    } finally {
      indexPending = null;
    }
  })();
  return indexPending;
}

const decks = new Map();   // fileName -> { at, deck }
const deckPending = new Map();

const trimCard = (c) => ({
  name: String(c.name || ''),
  count: c.count,
  isFoil: !!c.isFoil,
  isEtched: !!c.isEtched,
  setCode: String(c.setCode || ''),
  number: c.number != null ? String(c.number) : '',
  scryfallId: (c.identifiers && c.identifiers.scryfallId) || null,
  language: c.language || 'English',
});

// One deck, trimmed to what an import reads, or null when the index does not list
// it. The index is the allowlist: only a fileName MTGJSON published is ever put
// into a request path.
async function getDeck(fileName) {
  const { decks: listed } = await listDecks();
  const entry = listed.find(d => d.fileName === fileName);
  if (!entry) return null;
  const hit = decks.get(fileName);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.deck;
  if (deckPending.has(fileName)) return deckPending.get(fileName);
  const work = (async () => {
    const { data } = await paced(`/decks/${encodeURIComponent(fileName)}.json`);
    const d = data && data.data;
    if (!d) throw new Error(`MTGJSON deck ${fileName} has no data`);
    const deck = {
      fileName,
      name: String(d.name || entry.name),
      code: String(d.code || entry.code).toUpperCase(),
      type: String(d.type || entry.type),
      releaseDate: d.releaseDate || entry.releaseDate,
      boards: Object.fromEntries(BOARDS.map(b => [b, (Array.isArray(d[b]) ? d[b] : []).map(trimCard)])),
    };
    decks.set(fileName, { at: Date.now(), deck });
    // Bounded: a deck is a few kilobytes once trimmed, but nothing should grow forever.
    while (decks.size > MAX_CACHED_DECKS) decks.delete(decks.keys().next().value);
    return deck;
  })();
  deckPending.set(fileName, work);
  try { return await work; } finally { deckPending.delete(fileName); }
}

// Drop the caches. For tests, which swap the HTTP adapter between cases.
function resetCache() {
  index = null;
  decks.clear();
}

module.exports = { listDecks, getDeck, resetCache, client, BOARDS, USER_AGENT };
