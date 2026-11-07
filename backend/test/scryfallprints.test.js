// "Change printing" and the scanner's set picker ask for every printing of one
// card (searchCards with allPrints). That read a single Scryfall page and kept the
// first 60, so a card with more printings than that (Sol Ring, every basic land)
// never offered its older ones. It now pages through has_more on the client's own
// queue and 429 retry, up to six 175-card pages. Scryfall is stubbed with an axios
// adapter serving list pages shaped like the real ones.
// Run: `node test/scryfallprints.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-scryfallprints-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.SCRYFALL_GAP_SCALE = '0';

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');

const PAGE = 175;
let printings = 0;          // how many printings the stubbed card has
let rateLimitPage = null;   // answer this page with one 429 first
let requests = [];

const printing = (i) => ({
  object: 'card', id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, lang: 'en',
  name: 'Sol Ring', set: `s${Math.floor(i / 10)}`, set_name: `Set ${Math.floor(i / 10)}`, collector_number: String(i),
  rarity: 'uncommon', type_line: 'Artifact', prices: { usd: '1.00', usd_foil: null },
  image_uris: { normal: `https://cards.scryfall.io/normal/front/${i}.jpg` },
});

scryfallApi.client.defaults.adapter = async (config) => {
  const url = new URL(config.url, 'https://api.scryfall.com');
  if (url.pathname !== '/cards/search') throw new Error(`Unexpected Scryfall request: ${config.url}`);
  const page = parseInt(url.searchParams.get('page'), 10) || 1;
  requests.push({ page, q: url.searchParams.get('q') });
  if (page === rateLimitPage) {
    rateLimitPage = null;
    const err = new Error('Request failed with status code 429');
    err.response = { status: 429, headers: { 'retry-after': '0' } };
    throw err;
  }
  const start = (page - 1) * PAGE;
  const end = Math.min(start + PAGE, printings);
  const has_more = end < printings;
  const data = [];
  for (let i = start; i < end; i++) data.push(printing(i + 1));
  return {
    status: 200, statusText: 'OK', headers: {}, config,
    data: {
      object: 'list', total_cards: printings, has_more, data,
      ...(has_more ? { next_page: `https://api.scryfall.com/cards/search?page=${page + 1}&q=${encodeURIComponent(url.searchParams.get('q'))}` } : {}),
    },
  };
};

const allPrints = () => scryfallApi.searchCards({ name: 'Sol Ring', allPrints: true, scope: 'internet' });

async function main() {
  await db.initDb();

  // Two pages: 230 printings, all of them returned and cached. A 429 on the
  // second page is waited out and retried, not taken for "no more printings".
  printings = 230;
  rateLimitPage = 2;
  let { cards, total } = await allPrints();
  assert.strictEqual(cards.length, 230, 'every printing, not the first 60');
  assert.strictEqual(total, 230);
  assert.deepStrictEqual(requests.map(r => r.page), [1, 2, 2], 'page 2 retried after its 429');
  assert.strictEqual(requests[0].q, '!"Sol Ring" unique:prints -is:digital');
  assert.strictEqual(cards[229].number, '230', "the second page's printings are there too");
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM card_cache WHERE name = 'Sol Ring'`)).n, 230, 'all cached');

  // A card with more printings than the cap stops at six pages, and says how many
  // there are in all.
  printings = 1200;
  requests = [];
  ({ cards, total } = await allPrints());
  assert.strictEqual(cards.length, 6 * PAGE);
  assert.deepStrictEqual(requests.map(r => r.page), [1, 2, 3, 4, 5, 6]);
  assert.strictEqual(total, 1200, 'the count beyond the cap is reported (X-Total-Count)');

  // One page is still one request.
  printings = 12;
  requests = [];
  ({ cards } = await allPrints());
  assert.strictEqual(cards.length, 12);
  assert.strictEqual(requests.length, 1);
}

main()
  .then(() => console.log('Scryfall all-printings paging self-check passed'))
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  });
