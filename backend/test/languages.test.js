// Runnable checks for multi-language card support (issue #25).
//
// The bug this exists to prevent regressing: Scryfall has NO `lang` query
// parameter, so the old `&lang=ja` was silently ignored and every "Japanese"
// search came back in English. Language has to be a `lang:` search KEYWORD plus
// include_multilingual=true. Verified against the live API:
//   q=!"Lightning Bolt" unique:prints&lang=ja        -> 64 results, all English
//   q=!"Lightning Bolt" lang:ja unique:prints
//     &include_multilingual=true                     -> 18 results, all Japanese
// No framework — plain node + assert. Run: `node test/languages.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-languages-${process.pid}.db`);
const languages = require('../src/utils/languages');
const scryfallApi = require('../src/scryfallApi');
const tcgdexApi = require('../src/tcgdexApi');

// --- 1. Language registry resolves every form callers use ---------------------
assert.strictEqual(languages.toCode('Japanese'), 'ja', 'display name -> code');
assert.strictEqual(languages.toCode('JA'), 'ja', 'code is case-insensitive');
assert.strictEqual(languages.toCode('zht'), 'zh-tw', "Scryfall's own spelling resolves");
assert.strictEqual(languages.toName('ja'), 'Japanese', 'code -> display name');
assert.strictEqual(languages.toName('de'), 'German');
// collection.language has held these exact strings since v1.0 — changing them
// would orphan every existing row.
for (const name of ['English', 'Japanese', 'German', 'French', 'Spanish', 'Italian']) {
  assert.strictEqual(languages.toName(name), name, `${name} must survive a round trip`);
}
assert.strictEqual(languages.toCode('klingon'), 'en', 'unknown input degrades to English');
assert.ok(languages.isEnglish(''), 'no language means English');
assert.ok(languages.isEnglish('English') && languages.isEnglish('en'));
assert.ok(!languages.isEnglish('ja'));

// --- 2. Scryfall query construction -----------------------------------------
// Capture the URLs fetchWindow actually requests.
let urls = [];
scryfallApi.client.defaults.adapter = async (config) => {
  urls.push(config.url);
  return {
    status: 200, statusText: 'OK', headers: {}, config,
    data: { data: [{ id: 'x', lang: 'ja', printed_name: '稲妻', name: 'Lightning Bolt', image_uris: { normal: 'i' } }], has_more: false, total_cards: 1 },
  };
};

async function scryfallChecks() {
  urls = [];
  await scryfallApi.fetchWindow('!"Lightning Bolt" unique:prints', 'ja', 0, 10);
  const jaUrl = urls[0];
  assert.ok(jaUrl.includes(encodeURIComponent('lang:ja')), `language must be a search keyword: ${jaUrl}`);
  assert.ok(jaUrl.includes('include_multilingual=true'), 'non-English needs include_multilingual');
  assert.ok(!/[?&]lang=/.test(jaUrl), 'a bare lang= parameter is ignored by Scryfall — must not be sent');

  // Chinese has to go out as Scryfall's spelling, not ours.
  urls = [];
  await scryfallApi.fetchWindow('set:tst', 'zh-tw', 0, 10);
  assert.ok(urls[0].includes(encodeURIComponent('lang:zht')), `zh-tw must map to zht: ${urls[0]}`);

  // English must stay byte-identical to the pre-language behaviour.
  urls = [];
  await scryfallApi.fetchWindow('set:tst', null, 0, 10);
  assert.ok(!urls[0].includes('lang'), `English adds nothing: ${urls[0]}`);
  assert.ok(!urls[0].includes('include_multilingual'), 'English must not request multilingual');

  urls = [];
  await scryfallApi.fetchWindow('set:tst', 'en', 0, 10);
  assert.ok(!urls[0].includes('include_multilingual'), "'en' behaves like no language");
}

// --- 3. normalizeCard records the printing, not the request -------------------
function normalizeChecks() {
  const ja = scryfallApi.normalizeCard(
    { id: 'u1', name: 'Lightning Bolt', printed_name: '稲妻', lang: 'ja', set: 'msc', collector_number: '806', image_uris: { normal: 'i' }, rarity: 'common' },
    'ja'
  );
  assert.strictEqual(ja.language, 'Japanese');
  assert.strictEqual(ja.printed_name, '稲妻', 'localized name is kept for display');
  assert.strictEqual(ja.name, 'Lightning Bolt', 'name stays English for search/deck lists/links');

  // Scryfall answers in English when a card was never printed in the language
  // asked for. Trusting the REQUEST would mislabel that row as Japanese.
  const fallback = scryfallApi.normalizeCard(
    { id: 'u2', name: 'Sol Ring', lang: 'en', set: 'c21', collector_number: '1', image_uris: { normal: 'i' } },
    'ja'
  );
  assert.strictEqual(fallback.language, 'English', "the response's own lang wins");
  assert.strictEqual(fallback.printed_name, null, 'English printings have no printed name');

  // Prices: USD is TCGplayer's number, EUR is Cardmarket's, and a non-English
  // printing usually has only the second. Reading usd alone left whole languages at
  // 0.00 — 241 of 1,205 Spanish rows priced, 53 of 194 Italian.
  const priced = (prices) => scryfallApi.normalizeCard(
    { id: 'u3', name: 'Lightning Bolt', lang: 'ja', set: 'msc', collector_number: '806', image_uris: { normal: 'i' }, prices },
    'ja'
  );

  const eur = priced({ usd: null, usd_foil: null, eur: '4.50', eur_foil: '9.00' });
  assert.strictEqual(eur.price_currency, 'EUR', 'a EUR-only printing is recorded as EUR');
  assert.strictEqual(eur.price_normal, 4.5);
  assert.strictEqual(eur.price_holofoil, 9);
  assert.strictEqual(eur.price_trend, 4.5);

  // USD wins when present, and the row must never mix the two: a USD normal price
  // beside a EUR foil price is a pair of numbers that cannot be compared.
  const both = priced({ usd: '3.00', usd_foil: null, eur: '4.50', eur_foil: '9.00' });
  assert.strictEqual(both.price_currency, 'USD');
  assert.strictEqual(both.price_normal, 3);
  assert.strictEqual(both.price_holofoil, null, 'no EUR foil price on a USD row');

  // A foil-only USD listing still counts as USD, EUR notwithstanding.
  const foilOnly = priced({ usd: null, usd_foil: '7.00', eur: '4.50' });
  assert.strictEqual(foilOnly.price_currency, 'USD');
  assert.strictEqual(foilOnly.price_trend, 7, 'trend falls back to the foil price');

  // Nothing anywhere: unpriced, and still labelled USD, which is what every
  // consumer defaults to.
  const none = priced({});
  assert.strictEqual(none.price_currency, 'USD');
  assert.strictEqual(none.price_trend, 0);
}

// --- 4. TCGdex ids round-trip ------------------------------------------------
function tcgdexChecks() {
  // The trap: TCGdex set ids contain dashes and can themselves be two lowercase
  // letters ("lc-3"), so a [a-z]{2} pattern reads "tcgdex-en-lc-3" as language
  // "en-lc" and card "3", and the card then 404s on every lookup.
  const cases = [
    ['tcgdex-ja-SV2a-004', 'ja', 'SV2a-004'],
    ['tcgdex-en-lc-3', 'en', 'lc-3'],
    ['tcgdex-zh-tw-SV2a-001', 'zh-tw', 'SV2a-001'],
    ['mtg-abc', null, 'mtg-abc'],
  ];
  for (const [id, lang, provider] of cases) {
    assert.strictEqual(tcgdexApi.idLanguage(id), lang, `language of ${id}`);
    assert.strictEqual(tcgdexApi.providerId(id), provider, `provider id of ${id}`);
  }

  // A full TCGdex card maps onto the card_cache shape, with Cardmarket's rolling
  // averages landing in the same columns the price charts already read.
  const card = tcgdexApi.normalizeCard({
    id: 'SV2a-004', localId: '004', name: 'ヒトカゲ', category: 'Pokemon', stage: 'Basic',
    rarity: 'Common', types: ['Fire'], image: 'https://assets.tcgdex.net/ja/SV/SV2a/004',
    set: { id: 'SV2a', name: 'ポケモンカード151' },
    pricing: { cardmarket: { avg: 0.07, trend: 0.04, avg1: 0.04, avg7: 0.05, avg30: 0.07 }, tcgplayer: null },
  }, 'ja');
  assert.strictEqual(card.id, 'tcgdex-ja-SV2a-004', 'id carries the language');
  assert.strictEqual(card.game, 'pokemon');
  assert.strictEqual(card.language, 'Japanese');
  assert.strictEqual(card.number, '004');
  assert.strictEqual(card.set_name, 'ポケモンカード151');
  // A Japan-exclusive card has no English name anywhere, so the localized name is
  // both `name` and `printed_name`.
  assert.strictEqual(card.name, 'ヒトカゲ');
  assert.strictEqual(card.printed_name, 'ヒトカゲ');
  assert.strictEqual(card.supertype, 'Pokémon', "must match pokemontcg.io's accented spelling so filters don't split");
  assert.strictEqual(card.price_normal, 0.07);
  assert.strictEqual(card.price_avg7, 0.05);
  assert.strictEqual(card.image_url, 'https://assets.tcgdex.net/ja/SV/SV2a/004/low.png');

  // TCGplayer's market price wins over Cardmarket when both exist (same
  // precedence tcgApi has always used for English cards).
  const withTp = tcgdexApi.normalizeCard({
    id: 'sv03-125', localId: '125', name: 'Charizard ex', category: 'Pokemon',
    set: { id: 'sv03', name: 'Obsidian Flames' },
    pricing: { cardmarket: { 'avg-holo': 7.36 }, tcgplayer: { holofoil: { marketPrice: 4.97 } } },
  }, 'en');
  assert.strictEqual(withTp.price_holofoil, 4.97);
}

async function main() {
  await scryfallChecks();
  normalizeChecks();
  tcgdexChecks();
  console.log('languages.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
