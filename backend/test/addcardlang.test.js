// A copy recorded in another language must reference that language's PRINTING.
//
// The card is picked in whatever language the search ran in, but the copy's language
// is chosen separately — Quick Add's dropdown, or a scan the English catalog
// answered. Both used to leave the collection row pointing at the English printing,
// so a card filed as Japanese still showed its English name, art and price: the
// localized name lives on the printing (card_cache.printed_name), not on the copy.
//
// cardApi.printingInLanguage is the swap, tcgdexApi.learnEnglishName keeps the copy
// searchable in English. Both providers are stubbed: this checks
// the dispatch and the degrade cases, not that Scryfall or TCGdex are up.
const assert = require('assert');

process.env.DB_PATH = require('path').join(
  require('os').tmpdir(), `bindarr-addcardlang-${process.pid}.db`
);

(async () => {
  const cardApi = require('../src/utils/cardApi');
  const scryfall = require('../src/scryfallApi');
  const tcgdex = require('../src/tcgdexApi');
  const languages = require('../src/utils/languages');
  const db = require('../src/db');
  await db.initDb();

  // Scryfall's language form of the card endpoint: /cards/:set/:number/:lang.
  scryfall.client.get = async (url) => {
    const m = url.match(/^\/cards\/([^/]+)\/([^/]+)\/([^/?]+)/);
    if (!m) throw Object.assign(new Error('unexpected url'), { response: { status: 404 } });
    const [, set, number, lang] = m;
    if (set === 'lea') throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id: `${set}-${number}-${lang}`, lang,
        name: 'Lightning Bolt', printed_name: '稲妻',
        set, set_name: 'Kamigawa', collector_number: number,
        image_uris: { normal: `https://cards.scryfall.io/${lang}.jpg` },
        rarity: 'common', prices: {},
      },
    };
  };

  // TCGdex serves a full card at /:lang/cards/:id, and a set's card list at
  // /:lang/sets/:id. Japan never had the Western Base Set, so that one 404s.
  const setRequests = [];
  tcgdex.client.get = async (url) => {
    const s = url.match(/^\/([^/]+)\/sets\/([^/]+)$/);
    if (s) {
      setRequests.push(`${s[1]}/${decodeURIComponent(s[2])}`);
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    }
    const m = url.match(/^\/([^/]+)\/cards\/(.+)$/);
    if (!m) throw new Error(`unexpected url ${url}`);
    const [, lang, id] = m;
    // A Western-only set has no edition in the Asian languages: TCGdex 404s.
    if (id.startsWith('swsh10.5')) throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id: decodeURIComponent(id), localId: '4', category: 'Pokemon',
        name: lang === 'ja' ? 'リザードン' : 'Charizard',
        rarity: 'Rare', set: { id: 'sv03', name: 'Obsidian Flames' },
        image: 'https://assets.tcgdex.net/x', pricing: {},
      },
    };
  };

  const english = { id: 'mtg-abc', game: 'mtg', set_id: 'neo', number: '1', language: 'English' };

  // The point of the fix: a Japanese copy of an English-searched Magic card lands on
  // the Japanese printing, which is the row that carries the Japanese name.
  const ja = await cardApi.printingInLanguage(english, 'Japanese');
  assert.ok(ja, 'a Japanese printing should resolve');
  assert.strictEqual(ja.language, 'Japanese');
  assert.strictEqual(ja.printed_name, '稲妻', 'the localized name comes with it');
  assert.notStrictEqual(ja.id, english.id, 'a different printing means a different row');

  // Same language as the printing: nothing to swap, and no request to pay for.
  assert.strictEqual(await cardApi.printingInLanguage(english, 'English'), null);
  assert.strictEqual(await cardApi.printingInLanguage({ ...english, language: 'Japanese' }, 'ja'), null,
    'a code and its display name are the same language');

  // Never printed in that language: keep the card the user picked.
  assert.strictEqual(
    await cardApi.printingInLanguage({ ...english, set_id: 'lea' }, 'Japanese'), null);

  // Set ids are stored prefixed in places; the printing lookup wants the bare code.
  const prefixed = await cardApi.printingInLanguage({ ...english, set_id: 'mtg-neo' }, 'Japanese');
  assert.strictEqual(prefixed && prefixed.set_id, 'neo', 'the mtg- prefix must not reach Scryfall');

  // TCGdex ids carry their language, so the swap is code for code.
  const jp = await cardApi.printingInLanguage(
    { id: 'tcgdex-en-sv03-004', game: 'pokemon', number: '4', language: 'English' }, 'Japanese');
  assert.ok(jp, 'a Japanese TCGdex printing should resolve');
  assert.strictEqual(jp.id, 'tcgdex-ja-sv03-004');
  assert.strictEqual(jp.printed_name, 'リザードン');

  // A set with no edition in that language 404s: degrade, do not throw.
  assert.strictEqual(await cardApi.printingInLanguage(
    { id: 'tcgdex-en-swsh10.5-004', game: 'pokemon', language: 'English' }, 'Korean'), null);

  // Every language in the table, not just Japanese: the swap resolves through
  // utils/languages, so the provider's own spelling (Scryfall's zht, TCGdex's zh-tw)
  // is looked up per row rather than assumed to be the canonical code. A language
  // whose codes were mistyped would silently stop localizing, which reads exactly
  // like "the name is still in English".
  for (const l of languages.LANGUAGES.filter(x => x.code !== 'en')) {
    const mtg = await cardApi.printingInLanguage(english, l.name);
    assert.ok(mtg, `${l.name}: a Magic printing should resolve`);
    assert.strictEqual(mtg.language, l.name, `${l.name}: row tagged with the language asked for`);
    assert.ok(mtg.id.endsWith(`-${l.scryfall}`), `${l.name}: asked Scryfall for ${l.scryfall}`);

    const pkmn = await cardApi.printingInLanguage(
      { id: 'tcgdex-en-sv03-004', game: 'pokemon', number: '4', language: 'en' }, l.code);
    assert.ok(pkmn, `${l.name}: a TCGdex printing should resolve`);
    assert.strictEqual(pkmn.id, `tcgdex-${l.code}-sv03-004`, `${l.name}: TCGdex id swapped by code`);
  }

  // pokemontcg.io is English-only and its ids carry no TCGdex id to swap, so the
  // swap falls back to asking TCGdex for the same set and number in the language.
  // Japan has no Base Set, so that answers nothing and the English row stays. The
  // fixture names the set: without one the set+number fallback never runs, and an
  // earlier version of this check passed without exercising it at all.
  assert.strictEqual(await cardApi.printingInLanguage(
    { id: 'base1-4', game: 'pokemon', set_id: 'base1', number: '4', language: 'English' }, 'Japanese'), null);
  assert.deepStrictEqual(setRequests, ['ja/base1'], 'the set+number fallback asked TCGdex for the Japanese set');

  // A localized TCGdex row carries the localized name in BOTH columns, so the
  // collection could only be searched in the card's own language. learnEnglishName
  // fills `name` in from the English printing — display reads printed_name and is
  // unchanged, but typing "Charizard" now finds リザードン.
  const jpRow = await db.get(`SELECT * FROM card_cache WHERE id = 'tcgdex-ja-sv03-004'`);
  assert.strictEqual(jpRow.name, jpRow.printed_name, 'TCGdex gave one name for both columns');
  const taught = await tcgdex.learnEnglishName(jpRow);
  assert.strictEqual(taught.name, 'Charizard', 'the English sibling supplies the searchable name');
  const stored = await db.get(`SELECT * FROM card_cache WHERE id = 'tcgdex-ja-sv03-004'`);
  assert.strictEqual(stored.name, 'Charizard', 'and it is written to the row');
  assert.strictEqual(stored.printed_name, 'リザードン', 'the printed name is untouched — display uses it');

  // Re-caching the same card (a price sweep, another Japanese search) must not undo
  // that. The incoming row's name IS its printed name, which is not new information.
  await tcgdex.cacheCards([tcgdex.normalizeCard({
    id: 'sv03-004', localId: '4', category: 'Pokemon', name: 'リザードン', rarity: 'Rare',
    set: { id: 'sv03', name: 'Obsidian Flames' }, image: 'https://assets.tcgdex.net/x', pricing: {},
  }, 'ja')]);
  const after = await db.get(`SELECT * FROM card_cache WHERE id = 'tcgdex-ja-sv03-004'`);
  assert.strictEqual(after.name, 'Charizard', 'a re-cache must not clobber the learned name');
  assert.strictEqual(after.printed_name, 'リザードン');

  // Nothing to learn: an English row, and a pokemontcg.io row, are left alone.
  const enRow = await db.get(`SELECT * FROM card_cache WHERE id = 'tcgdex-en-sv03-004'`);
  assert.strictEqual((await tcgdex.learnEnglishName(enRow)).name, 'Charizard');
  const foreign = { id: 'base1-4', name: 'Charizard', printed_name: 'Charizard' };
  assert.strictEqual(await tcgdex.learnEnglishName(foreign), foreign, 'pokemontcg.io rows are untouched');

  console.log('addcardlang.test.js: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
