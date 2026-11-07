// Runnable checks for the game registry (shared/games.json) and for the card-ID
// dispatch that reads it.
//
// The registry replaced lists of games written out wherever something needed one,
// and the failure it exists to prevent is quiet: a game missing from one copy of
// the list did not error, it just fell through to Pokémon (a search, an import
// row, a deck) or was refused somewhere nobody looked (storage could not restrict
// a container to Lorcana at all). So this pins the table's own invariants, the
// two copies of it staying identical, and the one behaviour change that matters:
// an id nobody minted is unknown, not Pokémon.
//
// No framework — plain node + assert. Offline. Run: `node test/games.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-games-${process.pid}.db`);

// Every outgoing provider request is recorded and refused. The unknown-id cases
// below must not produce one: "ask pokemontcg.io about it" is the old behaviour.
const axios = require('axios');
const requests = [];
axios.Axios.prototype.request = async function (config) {
  requests.push(`${(config && config.baseURL) || this.defaults.baseURL || ''}${(config && config.url) || ''}`);
  throw new Error('network disabled in games.test.js');
};

const games = require('../src/utils/games');
const languages = require('../src/utils/languages');
const GAMES_JSON = require('../../shared/games.json');
const LANGUAGES_JSON = require('../../shared/languages.json');

(async () => {
  // --- 1. One table, two files, no drift ------------------------------------
  // The frontend reads the ESM twins (bare Node cannot import JSON without an
  // import attribute, and ESLint 8 cannot parse one). Two hand-edited copies of
  // one list are exactly the problem the registry exists to remove, so they are
  // held identical here.
  const { pathToFileURL } = require('url');
  const esm = async (file) => (await import(pathToFileURL(path.join(__dirname, '../../shared', file)).href)).default;
  assert.deepStrictEqual(await esm('games.js'), GAMES_JSON, 'shared/games.js must mirror shared/games.json exactly');
  assert.deepStrictEqual(await esm('languages.js'), LANGUAGES_JSON, 'shared/languages.js must mirror shared/languages.json exactly');

  // --- 2. The table's own invariants -----------------------------------------
  const values = GAMES_JSON.map(g => g.value);
  assert.strictEqual(new Set(values).size, values.length, 'game values are unique');
  assert.deepStrictEqual(games.VALUES, values, 'VALUES keeps table order (it is the UI order)');
  assert.strictEqual(GAMES_JSON.filter(g => g.legacy).length, 1, 'exactly one game owns the legacy rows');
  assert.strictEqual(games.LEGACY_GAME, 'pokemon', 'pre-multi-game rows are Pokémon (db.js column defaults)');
  const prefixes = GAMES_JSON.flatMap(g => g.idPrefixes || []);
  assert.strictEqual(new Set(prefixes).size, prefixes.length, 'no two games claim one id prefix');
  const codes = new Set(LANGUAGES_JSON.map(l => l.code));
  for (const g of GAMES_JSON) {
    assert.ok(g.label && g.short, `${g.value} has labels`);
    assert.ok(Array.isArray(g.languages) && g.languages.length, `${g.value} lists its languages`);
    for (const c of g.languages) assert.ok(codes.has(c), `${g.value} language ${c} is in shared/languages.json`);
    assert.ok(g.deck && g.deck.defaultFormat && g.deck.defaultSize > 0, `${g.value} has a default deck format`);
    assert.ok(['pokemon', 'foil'].includes(g.printings), `${g.value} names a printing scheme`);
    assert.ok(g.value === games.LEGACY_GAME || (g.idPrefixes && g.idPrefixes.length),
      `${g.value} registers an id prefix — only the legacy game may mint bare ids`);
  }
  // The per-language `games` lists are gone: a game lists its languages instead.
  assert.ok(LANGUAGES_JSON.every(l => !('games' in l)), 'shared/languages.json no longer carries per-language game lists');

  // --- 3. Languages per game come from the registry ---------------------------
  assert.strictEqual(languages.getLanguagesForGame('lorcana').length, 6);
  assert.ok(languages.isLanguageSupported('lorcana', 'French'));
  assert.ok(!languages.isLanguageSupported('lorcana', 'Spanish'));
  assert.strictEqual(languages.getLanguagesForGame('mtg').length, LANGUAGES_JSON.length);
  assert.strictEqual(languages.getLanguagesForGame('').length, LANGUAGES_JSON.length, 'no game means every language');
  assert.deepStrictEqual(languages.getLanguagesForGame('yugioh'), [], 'an unknown game is printed in nothing');

  // --- 4. Validation and feature lookups ---------------------------------------
  assert.strictEqual(games.parseGame(undefined), 'pokemon', 'absent still means the legacy default');
  assert.strictEqual(games.parseGame(''), 'pokemon');
  assert.strictEqual(games.parseGame('mtg'), 'mtg');
  assert.strictEqual(games.parseGame('yugioh'), null, 'unknown is null, for the caller to refuse');
  assert.strictEqual(games.parseGame('MTG'), null, 'values are exact; the API has always spoken lowercase');
  assert.ok(games.withFeature('scan').includes('lorcana'));
  assert.ok(games.hasFeature('pokemon', 'gradedPrices') && !games.hasFeature('mtg', 'gradedPrices'),
    'only Pokémon has an automatic graded-price source');
  assert.strictEqual(games.hasFeature('yugioh', 'scan'), false);

  // --- 5. Set ids lose whichever game prefix they carry -------------------------
  assert.strictEqual(games.bareSetId('mtg-fdn'), 'fdn');
  assert.strictEqual(games.bareSetId('lorcana-tfc'), 'tfc');
  assert.strictEqual(games.bareSetId('MTG-FDN'), 'FDN', 'case-insensitive, like the comparisons it serves');
  assert.strictEqual(games.bareSetId('sv03.5'), 'sv03.5', 'a Pokémon set id has no prefix to lose');

  // --- 6. PSA labels name a game, or none ---------------------------------------
  assert.strictEqual(games.gameOfPsaBrand('POKEMON GAME'), 'pokemon');
  assert.strictEqual(games.gameOfPsaBrand('Magic The Gathering'), 'mtg');
  assert.strictEqual(games.gameOfPsaBrand('Disney Lorcana'), 'lorcana');
  assert.strictEqual(games.gameOfPsaBrand('1986 FLEER BASKETBALL'), null, 'a sports card is not guessed at');

  // --- 7. gameOfId: prefixes, the legacy shape, and nothing else ----------------
  assert.strictEqual(games.gameOfId('mtg-0000579f-7b35-4ed3-b44c-db2a538066fe'), 'mtg');
  assert.strictEqual(games.gameOfId('tcgdex-en-sv01-001'), 'pokemon');
  assert.strictEqual(games.gameOfId('pokemontcgapi-sv1-1'), 'pokemon');
  assert.strictEqual(games.gameOfId('lorcana-crd_mickey_1'), 'lorcana');
  for (const legacy of ['sv1-1', 'base1-4', 'swsh12pt5-160', 'swshp-SWSH001', 'xy7-54a', 'cel25c-15_A', 'basep-50']) {
    assert.strictEqual(games.gameOfId(legacy), 'pokemon', `${legacy} has pokemontcg.io's shape`);
  }
  for (const unknown of ['', null, undefined, 'foo', 'Black Lotus', 'base1', '-4', 'base1-', 'a-b-c',
    '../etc/passwd', 'SV1-1', 'sv1 - 1', 'crd_mickey_1', '0000579f-7b35-4ed3-b44c-db2a538066fe']) {
    assert.strictEqual(games.gameOfId(unknown), null, `${JSON.stringify(unknown)} names no game`);
  }

  // --- 8. cardApi.gameOf: the id outranks the request ---------------------------
  const cardApi = require('../src/utils/cardApi');
  assert.strictEqual(cardApi.gameOf('tcgdex-en-sv01-001', 'mtg'), 'pokemon',
    'a TCGdex id is Pokémon whatever the request says (this used to answer mtg)');
  assert.strictEqual(cardApi.gameOf('mtg-abc', 'pokemon'), 'mtg');
  assert.strictEqual(cardApi.gameOf('base1-4'), 'pokemon');
  // A provider's raw id may still be tried when its game is asked for explicitly:
  // Scryfall resolves a bare uuid, Lorcast a bare crd_ id.
  assert.strictEqual(cardApi.gameOf('0000579f-7b35-4ed3-b44c-db2a538066fe', 'mtg'), 'mtg');
  assert.strictEqual(cardApi.gameOf('crd_mickey_1', 'lorcana'), 'lorcana');
  // ...but a request that merely defaulted to Pokémon rescues nothing.
  assert.strictEqual(cardApi.gameOf('Black Lotus', 'pokemon'), null);
  assert.strictEqual(cardApi.gameOf('garbage'), null);
  assert.strictEqual(cardApi.gameOf('garbage', 'yugioh'), null, 'an unknown requested game is no help either');
  assert.strictEqual(cardApi.gameOf('', 'mtg'), null, 'no id is no card');

  // --- 9. An unknown id is answered locally, never by pokemontcg.io ------------
  const db = require('../src/db');
  await db.initDb();
  requests.length = 0;
  assert.strictEqual(await cardApi.getCardById('Black Lotus'), null);
  assert.strictEqual(await cardApi.getCardById('garbage', { game: 'pokemon' }), null);
  assert.strictEqual(await cardApi.getCardById('yugioh_lob_001', { game: 'yugioh' }), null);
  assert.deepStrictEqual(requests, [], `an unknown id must not reach any provider (saw ${requests.join(', ')})`);
  // A recognised id still goes to its provider: here the network is refused, so
  // the provider's own failure handling answers null — after asking.
  await cardApi.getCardById('lorcana-crd_mickey_1').catch(() => null);
  assert.ok(requests.some(u => u.includes('lorcast')), 'a Lorcana id is asked of Lorcast');

  // --- 10. The search provider for each game ------------------------------------
  assert.strictEqual(await cardApi.apiForGame('mtg'), require('../src/scryfallApi'));
  assert.strictEqual(await cardApi.apiForGame('lorcana'), require('../src/lorcastApi'));
  assert.ok(await cardApi.apiForGame('pokemon', 'en'), 'Pokémon resolves through pokemonProvider');
  assert.strictEqual(await cardApi.apiForGame('yugioh'), null, 'an unknown game has no provider');

  console.log('games self-check passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
