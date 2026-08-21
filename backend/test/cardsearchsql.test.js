// The card_cache query builders that pokemontcg.io, Scryfall and TCGdex all share.
//
// They were three separate copies that had already drifted apart, so what is
// pinned here is mostly the resolution of that drift — plus one latent bug the
// merge exposed.
// No framework — plain node + assert. Run: `node test/cardsearchsql.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-searchsql-${process.pid}.db`);
const { collectionQuery, localCacheQuery, numberClause, nameClause } = require('../src/utils/cardSearchSql');

const squash = (s) => s.replace(/\s+/g, ' ').trim();

function testNumberMatching() {
  // Written either way round: "004" must find a stored "4" and vice versa. Only
  // pokemontcg.io did this before; it is a pure OR, so it can only find more.
  const padded = numberClause('number', '004');
  assert.ok(padded.clause.includes('number = ?'), 'exact form is matched');
  // as typed, zero-stripped, then the numeric CAST comparison
  assert.deepStrictEqual(padded.params, ['004', '4', '004']);

  // A number with no leading zeros needs no stripped variant.
  const plain = numberClause('number', '4');
  assert.strictEqual(plain.params.filter(p => p === '4').length, 2, 'exact + CAST, no redundant stripped term');

  // THE LATENT BUG. SQLite casts any non-numeric string to 0, so
  // CAST('TG12') = CAST('SV49') = 0 — the CAST branch matched every card whose
  // number starts with a letter. It is now only emitted for numeric input.
  const promo = numberClause('number', 'TG12');
  assert.ok(!promo.clause.includes('CAST'), 'no CAST for a non-numeric collector number');
  assert.deepStrictEqual(promo.params, ['TG12'], 'exact match only');

  const numeric = numberClause('number', '25');
  assert.ok(numeric.clause.includes('CAST'), 'CAST still applies where it means something');

  // Fractions (e.g. 5/64) and hash prefixes (#5) extract the clean collector number
  const frac = numberClause('number', '5/64');
  assert.ok(frac.clause.includes('CAST'), 'CAST applies for extracted numeric part of fraction');
  assert.deepStrictEqual(frac.params, ['5/64', '5', '5']);

  const hashNum = numberClause('number', '#5');
  assert.deepStrictEqual(hashNum.params, ['#5', '5', '5']);

  // Column name is honoured, so the aliased collection query and the bare local
  // one cannot diverge.
  assert.ok(numberClause('cc.number', '7').clause.includes('cc.number'));

  for (const empty of ['', null, undefined, '   ']) {
    assert.strictEqual(numberClause('number', empty), null, `no clause for ${JSON.stringify(empty)}`);
  }
}

function testNameMatching() {
  // Both columns: `name` is the searchable one, `printed_name` the localized one.
  // pokemontcg.io's local query checked only `name` before.
  const n = nameClause('', 'Celebi');
  assert.ok(n.clause.includes('name LIKE ?') && n.clause.includes('printed_name LIKE ?'));
  assert.deepStrictEqual(n.params, ['%Celebi%', '%Celebi%']);
  assert.ok(nameClause('cc.', 'x').clause.includes('cc.printed_name'), 'prefix is applied to both columns');
  for (const empty of ['', null, undefined, '  ']) {
    assert.strictEqual(nameClause('', empty), null, `no clause for ${JSON.stringify(empty)}`);
  }
}

function testCollectionScopeIgnoresLanguage() {
  // The resolved disagreement: collection scope answers "what do I own", and you
  // own the card whatever language you own it in. TCGdex used to filter here, so
  // the same search returned different rows depending on the UI language.
  const { sql, params } = collectionQuery('pokemon', {
    userId: 7, name: 'Celebi', number: '004', setList: [], limit: 60, offset: 0,
  });
  assert.ok(!/language/i.test(sql), 'collection scope must NOT filter by language');
  assert.ok(squash(sql).includes('JOIN card_cache cc ON c.card_id = cc.id'));
  assert.ok(squash(sql).includes("c.list_type = 'collection'"));
  assert.ok(squash(sql).includes('GROUP BY cc.id LIMIT ? OFFSET ?'), 'grouped, so one row per card');

  // game is BOUND, never interpolated.
  assert.ok(!sql.includes("'pokemon'"), 'game is a bound parameter, not inlined');
  assert.strictEqual(params[0], 7, 'userId first');
  assert.strictEqual(params[1], 'pokemon', 'then game');
  assert.strictEqual(params[params.length - 2], 60, 'limit');
  assert.strictEqual(params[params.length - 1], 0, 'offset');

  // Same shape for MTG — the only difference is the bound game.
  const mtg = collectionQuery('mtg', { userId: 7, limit: 10, offset: 0 });
  assert.strictEqual(mtg.params[1], 'mtg');
  assert.strictEqual(squash(mtg.sql), squash(collectionQuery('pokemon', { userId: 7, limit: 10, offset: 0 }).sql),
    'both games build identical SQL; only the bound game differs');
}

function testLocalCacheKeepsLanguage() {
  // The opposite call, and deliberately so: in the cache, language is part of a
  // printing's identity, so a Japanese search must not be answered with the
  // English row sitting next to it.
  const { sql, params } = localCacheQuery('pokemon', {
    language: 'Japanese', name: '', number: '', setList: [], limit: 60, offset: 0,
  });
  assert.ok(/language = \?/.test(sql), 'local cache MUST filter by language');
  assert.ok(!sql.includes('JOIN'), 'no collection join — this is the plain cache');
  assert.deepStrictEqual(params, ['pokemon', 'Japanese', 60, 0]);
}

function testParamOrderMatchesClauseOrder() {
  // The failure this catches is silent and total: parameters binding to the wrong
  // placeholders returns confident nonsense rather than an error.
  const { sql, params } = localCacheQuery('mtg', {
    language: 'English', name: 'Bolt', number: '007', limit: 5, offset: 10,
  });
  const placeholders = (sql.match(/\?/g) || []).length;
  assert.strictEqual(placeholders, params.length, `${placeholders} placeholders vs ${params.length} params`);
  assert.deepStrictEqual(params, ['mtg', 'English', '%Bolt%', '%Bolt%', '007', '7', '007', 5, 10]);
}

function testNormalizeSearchParams() {
  const { normalizeSearchParams } = require('../src/routes/collection');
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Kangaskhan 5/64' }), { name: 'Kangaskhan', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Kangaskhan', number: '5/64' }), { name: 'Kangaskhan', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: '5/64' }), { name: '', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: '#5' }), { name: '', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Kangaskhan #5' }), { name: 'Kangaskhan', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Kangaskhan 5' }), { name: 'Kangaskhan', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Kangaskhan' }), { name: 'Kangaskhan', number: '', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ q: 'Kangaskhan 5/64' }), { name: 'Kangaskhan', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ q: '5/64' }), { name: '', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Charizard VMAX SV107/SV122' }), { name: 'Charizard VMAX', number: 'SV107', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ set: 'base2', number: '5/64' }), { name: '', number: '5', set: 'base2' });
}

function main() {
  testNumberMatching();
  testNameMatching();
  testCollectionScopeIgnoresLanguage();
  testLocalCacheKeepsLanguage();
  testParamOrderMatchesClauseOrder();
  testNormalizeSearchParams();
  console.log('cardsearchsql.test.js: all assertions passed');
}

try { main(); process.exit(0); }
catch (err) { console.error(err); process.exit(1); }
