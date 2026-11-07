// Characterization of scanCandidates: how each kind of scan-catalog match is named.
//
// This was the body of POST /scan-match until it moved to its own module. These
// checks pin what it did there, branch by branch, so the move (and anything after
// it) cannot quietly change which card a scan files. scanlang.test.js covers the
// non-English Pokémon fallback through the route; this covers the rest.
//
// Every provider is stubbed on its module object, the way scanlang does it; the
// card_cache and tcgplayer_product rows are real, in a throwaway database.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-scancandidates-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

(async () => {
  const db = require('../src/db');
  await db.initDb();
  const scryfallApi = require('../src/scryfallApi');
  const lorcastApi = require('../src/lorcastApi');
  const tcgplayerCatalog = require('../src/tcgplayerCatalog');
  const pokemonProvider = require('../src/utils/pokemonProvider');
  const sc = require('../src/scanCandidates');

  let passed = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log(`PASS: ${name}`); };
  const en = { langName: 'English', tcgApiKey: '' };

  const cache = (id, game, extra = {}) => db.run(
    `INSERT INTO card_cache (id, name, set_id, set_name, number, image_url, game, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, extra.name || `Card ${id}`, extra.set_id || 'set1', 'Set One', extra.number || '7', extra.image_url ?? 'https://img/x.png', game, extra.language || 'English']
  );

  await check('toEmbedding accepts exactly 128 finite numbers', () => {
    assert.ok(sc.toEmbedding(new Array(128).fill(0.5)) instanceof Float32Array);
    assert.strictEqual(sc.toEmbedding(new Array(127).fill(0)), null);
    assert.strictEqual(sc.toEmbedding([...new Array(127).fill(0), NaN]), null);
    assert.strictEqual(sc.toEmbedding('nope'), null);
  });

  await check('sameNumber ignores zero padding and case, never matches blanks', () => {
    assert.ok(sc.sameNumber('013', '13'));
    assert.ok(sc.sameNumber('tg12', 'TG12'));
    assert.ok(!sc.sameNumber('13', '130'));
    assert.ok(!sc.sameNumber('', ''));
    assert.ok(!sc.sameNumber(null, undefined));
  });

  await check('MTG card id: fetched by id, re-expressed in the scanned language', async () => {
    const asked = [];
    scryfallApi.getCardById = async (id) => ({ id, name: 'Bolt', set_id: 'lea', number: '161', language: 'English' });
    scryfallApi.getPrintingInLang = async (set, number, lang) => {
      asked.push([set, number, lang]);
      return lang === 'Japanese' ? { id: 'ja-bolt', name: 'Bolt', set_id: 'lea', number: '161', language: 'Japanese' } : null;
    };
    const ja = await sc.resolveCandidate({ cardId: 'en-bolt', score: 0.9 }, 0, { game: 'mtg', langName: 'Japanese' });
    assert.strictEqual(ja.card.id, 'ja-bolt');
    assert.strictEqual(ja.set, 'lea');
    assert.strictEqual(ja.number, '161');
    assert.strictEqual(ja.score, 0.9, 'the match score rides through');
    assert.deepStrictEqual(asked, [['lea', '161', 'Japanese']]);
    const eng = await sc.resolveCandidate({ cardId: 'en-bolt' }, 0, { game: 'mtg', ...en });
    assert.strictEqual(eng.card.id, 'en-bolt', 'no localized printing keeps the matched one');
    scryfallApi.getCardById = async () => { throw new Error('down'); };
    assert.deepStrictEqual(await sc.resolveCandidate({ cardId: 'x' }, 0, { game: 'mtg', ...en }), { cardId: 'x' },
      'a fetch failure returns the bare candidate');
  });

  await check('Pokémon card id: the cached row, never a fetch', async () => {
    await cache('sv1-7', 'pokemon');
    await cache('sv1-8', 'pokemon', { image_url: '' });
    const hit = await sc.resolveCandidate({ cardId: 'sv1-7' }, 3, { game: 'pokemon', ...en });
    assert.strictEqual(hit.card.id, 'sv1-7');
    assert.strictEqual(hit.name, 'Card sv1-7');
    assert.deepStrictEqual(await sc.resolveCandidate({ cardId: 'sv1-8' }, 0, { game: 'pokemon', ...en }), { cardId: 'sv1-8' },
      'a row without art does not count as a match');
    assert.deepStrictEqual(await sc.resolveCandidate({ cardId: 'nowhere' }, 0, { game: 'pokemon', ...en }), { cardId: 'nowhere' });
  });

  await check('Lorcana card id: cached row, else Lorcast by id', async () => {
    await cache('lor-1', 'lorcana');
    assert.strictEqual((await sc.resolveCandidate({ cardId: 'lor-1' }, 0, { game: 'lorcana', ...en })).card.id, 'lor-1');
    lorcastApi.getCardById = async (id) => (id === 'lor-2' ? { id, name: 'Stitch', set_id: '1', number: '22' } : null);
    const fetched = await sc.resolveCandidate({ cardId: 'lor-2' }, 0, { game: 'lorcana', ...en });
    assert.strictEqual(fetched.card.name, 'Stitch');
    assert.strictEqual(fetched.number, '22');
    assert.deepStrictEqual(await sc.resolveCandidate({ cardId: 'lor-3' }, 0, { game: 'lorcana', ...en }), { cardId: 'lor-3' });
  });

  await check('Lorcana product id: tcgplayer_product join, then the denormalised column', async () => {
    await cache('lor-10', 'lorcana');
    await db.run(`INSERT INTO tcgplayer_product (card_id, product_id, category_id) VALUES ('lor-10', 1010, 71)`);
    assert.strictEqual((await sc.resolveCandidate({ productId: 1010 }, 0, { game: 'lorcana', ...en })).card.id, 'lor-10');
    await cache('lor-11', 'lorcana');
    await db.run(`UPDATE card_cache SET tcgplayer_product_id = 1011 WHERE id = 'lor-11'`);
    assert.strictEqual((await sc.resolveCandidate({ productId: 1011 }, 0, { game: 'lorcana', ...en })).card.id, 'lor-11');
  });

  await check('Lorcana product id unknown locally: catalogue hint, then a name search that is remembered', async () => {
    tcgplayerCatalog.lookup = async (pid) => (pid === 1012 ? { name: 'Mickey', set_id: '2', number: '5' } : null);
    lorcastApi.searchCards = async () => ({ cards: [{ id: 'lor-12', name: 'Mickey', set_id: '2', number: '005' }] });
    await cache('lor-12', 'lorcana');
    const named = await sc.resolveCandidate({ productId: 1012 }, 0, { game: 'lorcana', ...en });
    assert.strictEqual(named.card.id, 'lor-12');
    const row = await db.get(`SELECT product_id, category_id FROM tcgplayer_product WHERE card_id = 'lor-12'`);
    assert.deepStrictEqual({ ...row }, { product_id: 1012, category_id: 71 });
    assert.deepStrictEqual(await sc.resolveCandidate({ productId: 9999 }, 0, { game: 'lorcana', ...en }), { productId: 9999 });
  });

  await check('Pokémon product id: join first; else only the top English candidate is searched', async () => {
    await cache('sv2-20', 'pokemon');
    await db.run(`INSERT INTO tcgplayer_product (card_id, product_id, category_id) VALUES ('sv2-20', 2020, 3)`);
    assert.strictEqual((await sc.resolveCandidate({ productId: 2020 }, 5, { game: 'pokemon', ...en })).card.id, 'sv2-20');

    tcgplayerCatalog.lookup = async (pid) => ({
      2021: { name: 'Pikachu', set_id: 'sv2', number: '021' },
      2022: { name: 'Promo', group_name: 'Promos', number: '1' },
    })[pid] || null;
    const searched = [];
    await cache('sv2-21', 'pokemon');
    pokemonProvider.apiFor = async (lang) => ({
      searchCards: async (q) => {
        searched.push({ provider: lang, ...q });
        return { cards: [{ id: 'sv2-21', name: 'Pikachu', number: '21', set_id: 'sv2', language: 'English' }] };
      },
    });

    const second = await sc.resolveCandidate({ productId: 2021 }, 1, { game: 'pokemon', ...en });
    assert.strictEqual(second.card, undefined, 'rank 1 on an English scan is left to the client');
    assert.deepStrictEqual([second.name, second.set, second.number], ['Pikachu', 'sv2', '021']);
    assert.strictEqual(searched.length, 0);

    const top = await sc.resolveCandidate({ productId: 2021 }, 0, { game: 'pokemon', langName: 'English', tcgApiKey: 'k' });
    assert.strictEqual(top.card.id, 'sv2-21', "'021' and '21' are the same collector number");
    assert.deepStrictEqual(searched, [{ provider: 'English', number: '021', set: 'sv2', lang: 'en', apiKey: 'k', limit: 5 }],
      'asks the configured provider by set + number');
    const mapped = await db.get(`SELECT product_id, category_id FROM tcgplayer_product WHERE card_id = 'sv2-21'`);
    assert.deepStrictEqual({ ...mapped }, { product_id: 2021, category_id: 3 }, 'the mapping is remembered');

    const noSet = await sc.resolveCandidate({ productId: 2022 }, 0, { game: 'pokemon', ...en });
    assert.deepStrictEqual([noSet.name, noSet.set, noSet.card], ['Promo', 'Promos', undefined], 'no set id: group name as the hint');
    assert.deepStrictEqual(await sc.resolveCandidate({ productId: 2099 }, 0, { game: 'pokemon', ...en }), { productId: 2099 });
  });

  await check('resolveCandidates keeps order and passes each rank', async () => {
    tcgplayerCatalog.lookup = async (pid) => ({ name: `P${pid}`, set_id: 'sv2', number: String(pid) });
    pokemonProvider.apiFor = async () => ({ searchCards: async () => ({ cards: [] }) });
    const out = await sc.resolveCandidates([{ productId: 1 }, { productId: 2 }], { game: 'pokemon', ...en });
    assert.deepStrictEqual(out.map(c => c.name), ['P1', 'P2']);
  });

  await check('isUnresolvedPublished: Pokémon, non-empty, and nothing at all could be said', () => {
    const bare = [{ productId: 1 }, { productId: 2 }];
    assert.strictEqual(sc.isUnresolvedPublished('pokemon', bare), true);
    assert.strictEqual(sc.isUnresolvedPublished('mtg', bare), false);
    assert.strictEqual(sc.isUnresolvedPublished('pokemon', []), false);
    assert.strictEqual(sc.isUnresolvedPublished('pokemon', [{ productId: 1, set: 'sv2' }]), false, 'a set is a working hint');
    assert.strictEqual(sc.isUnresolvedPublished('pokemon', [{ productId: 1, card: {} }]), false);
    assert.strictEqual(sc.isUnresolvedPublished('pokemon', [{ cardId: 'x' }]), false, 'card-id catalogs are not the published one');
  });

  console.log(`scancandidates.test.js: ${passed} checks passed`);
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
