// Scryfall syntax through the real search route, against a temp SQLite.
//
//   · Search & Add (GET /api/search, game=mtg): syntax reaches Scryfall intact, in
//     parentheses, ANDed with the form's set / number / language. Checked on the
//     outgoing `q` itself, with the axios client stubbed — no request leaves the
//     process. Plain names must still send exactly what they always sent.
//   · A query that cannot be read is a 400 that names the problem, and nothing is
//     sent to Scryfall.
//   · The deck builder's collection-scope search answers syntax from the owner's
//     own cards, and no part of the query ever reaches SQL.
// The rules-text columns all of this reads are covered by mtgrulestext.test.js.
// No framework — plain node + assert. Run: `node test/scryfallsyntaxsearch.test.js`
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

process.env.SCRYFALL_GAP_SCALE = '0';
const tmpDb = path.join(os.tmpdir(), `bindarr-scryfallsyntax-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const scryfall = require('../src/scryfallApi');
const lorcastApi = require('../src/lorcastApi');
const pokemonProvider = require('../src/utils/pokemonProvider');

let server;
async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

// Every Scryfall GET is recorded and answered by `respond`, which a test swaps.
let calls = [];
const list = (data, total = data.length) => ({ data: { object: 'list', data, has_more: false, total_cards: total } });
// Retry-After: 0, or a stubbed 429 arms the shared queue's real 60-second pause.
const httpError = (status, data = {}) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data, headers: { 'retry-after': '0' } } });
let respond = () => list([]);
scryfall.client.get = async (url) => { calls.push(url); return respond(url); };
const sentQ = () => calls.map(u => new URL(u, 'https://api.scryfall.com').searchParams);

// Scryfall's own card shape, as /cards/search and /cards/collection return it.
let seq = 0;
const raw = (name, fields = {}) => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  lang: 'en', name, set: 'tst', set_name: 'Test Set', collector_number: String(seq), rarity: 'common',
  cmc: 0, colors: [], color_identity: [], keywords: [], image_uris: { normal: `https://img.test/${seq}.jpg` },
  prices: { usd: '1.00' }, ...fields,
});

const ELVES = raw('Llanowar Elves', { type_line: 'Creature — Elf Druid', oracle_text: '{T}: Add {G}.', mana_cost: '{G}', cmc: 1, power: '1', toughness: '1', colors: ['G'], color_identity: ['G'] });
const BOLT = raw('Lightning Bolt', { type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.', mana_cost: '{R}', cmc: 1, colors: ['R'], color_identity: ['R'] });
const BEARS = raw('Grizzly Bears', { type_line: 'Creature — Bear', oracle_text: '', mana_cost: '{1}{G}', cmc: 2, power: '2', toughness: '2', colors: ['G'], color_identity: ['G'] });
const ANGEL = raw('Serra Angel', { type_line: 'Creature — Angel', oracle_text: 'Flying, vigilance', mana_cost: '{3}{W}{W}', cmc: 5, power: '4', toughness: '4', colors: ['W'], color_identity: ['W'], keywords: ['Flying', 'Vigilance'], rarity: 'uncommon', prices: { usd: '0.40', usd_foil: '2.00' } });
const SIGNET = raw('Azorius Signet', { type_line: 'Artifact', oracle_text: '{1}, {T}: Add {W}{U}.', mana_cost: '{2}', cmc: 2, color_identity: ['W', 'U'], rarity: 'uncommon' });
const GOYF = raw('Tarmogoyf', { type_line: 'Creature — Lhurgoyf', oracle_text: "Tarmogoyf's power is...", mana_cost: '{1}{G}', cmc: 2, power: '*', toughness: '1+*', colors: ['G'], color_identity: ['G'], rarity: 'rare' });
// Double-faced: the text and costs live on the faces, not the top level.
const DELVER = raw('Delver of Secrets // Insectile Aberration', {
  type_line: 'Creature — Human Wizard // Creature — Human Insect', cmc: 1, color_identity: ['U'], keywords: ['Flying', 'Transform'],
  image_uris: undefined,
  card_faces: [
    { name: 'Delver of Secrets', mana_cost: '{U}', type_line: 'Creature — Human Wizard', oracle_text: 'At the beginning of your upkeep, look at the top card of your library.', power: '1', toughness: '1', colors: ['U'], image_uris: { normal: 'https://img.test/delver.jpg' } },
    { name: 'Insectile Aberration', mana_cost: '', type_line: 'Creature — Human Insect', oracle_text: 'Flying', power: '3', toughness: '2', colors: ['U'], image_uris: { normal: 'https://img.test/aberration.jpg' } },
  ],
});
const idOf = (r) => `mtg-${r.id}`;

async function main() {
  await db.initDb();
  // The cards the collection-scope searches below own, cached as any search would.
  await scryfall.cacheCards([ELVES, BOLT, BEARS, ANGEL, SIGNET, GOYF, DELVER].map(c => scryfall.normalizeCard(c)));

  const mkUser = async (name) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [name, db.hashPassword('x'), `share-${name}-${process.pid}`]
  )).lastID;
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.get('x-test-user')) || alice, role: 'member' }; next(); });
  app.use('/api', require('../src/routes/collection'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const search = async (params, user = alice) => {
    calls = [];
    const res = await fetch(`${base}/api/search?${new URLSearchParams(params)}`, { headers: { 'x-test-user': String(user) } });
    return { status: res.status, body: await res.json(), total: res.headers.get('x-total-count'), qs: sentQ() };
  };

  // ---- 1. Search & Add: syntax goes to Scryfall intact.
  respond = () => list([ELVES], 1);
  let r = await search({ game: 'mtg', scope: 'internet', lang: 'en', name: 't:creature c:g cmc<=3' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.qs.length, 1, 'one request: no specific-number probe, no fallback');
  assert.strictEqual(r.qs[0].get('q'), '(t:creature c:g cmc<=3) unique:prints -is:digital');
  assert.strictEqual(r.qs[0].get('include_multilingual'), null, 'English adds nothing');
  assert.strictEqual(r.qs[0].get('order'), null, 'Scryfall\'s order, not a set browse');
  assert.strictEqual(r.total, '1', 'Scryfall\'s total is passed on');
  assert.deepStrictEqual(r.body.map(c => c.id), [idOf(ELVES)]);
  assert.strictEqual(r.body[0].oracle_text, '{T}: Add {G}.', 'results carry their rules text');

  // The form's own fields AND with the WHOLE query: an `or` inside it stays inside.
  r = await search({ game: 'mtg', scope: 'internet', lang: 'ja', name: 't:goblin or t:elf', set: 'mh3, mh2', number: '0145' });
  assert.strictEqual(r.qs[0].get('q'), '(t:goblin or t:elf) (set:mh3 or set:mh2) cn:145 unique:prints -is:digital lang:ja');
  assert.strictEqual(r.qs[0].get('include_multilingual'), 'true');
  r = await search({ game: 'mtg', scope: 'internet', lang: 'en', name: 's:mh3 145' });
  assert.strictEqual(r.qs[0].get('q'), '(s:mh3 145) unique:prints -is:digital', 'no name/number splitting of syntax');

  // A default the query already states is left out.
  r = await search({ game: 'mtg', scope: 'internet', lang: 'ja', name: 't:elf lang:de' });
  assert.strictEqual(r.qs[0].get('q'), '(t:elf lang:de) unique:prints -is:digital', 'the query\'s language wins over the picker');
  assert.strictEqual(r.qs[0].get('include_multilingual'), 'true', 'and non-English printings may come back');
  r = await search({ game: 'mtg', scope: 'internet', name: 't:elf unique:cards game:arena' });
  assert.strictEqual(r.qs[0].get('q'), '(t:elf unique:cards game:arena)');
  r = await search({ game: 'mtg', scope: 'internet', name: 't:elf not:digital' });
  assert.strictEqual(r.qs[0].get('q'), '(t:elf not:digital) unique:prints');
  // Keywords the collection cannot answer are Scryfall's to answer here.
  r = await search({ game: 'mtg', scope: 'internet', name: 'otag:ramp f:edh' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.qs[0].get('q'), '(otag:ramp f:edh) unique:prints -is:digital');
  // The default (database) scope searches syntax the same way: a LIKE over the
  // cache cannot read it, so Scryfall is asked straight away.
  r = await search({ game: 'mtg', name: 'o:"draw a card"' });
  assert.strictEqual(r.qs[0].get('q'), '(o:"draw a card") unique:prints -is:digital');
  console.log('PASS: syntax reaches Scryfall intact and parenthesised');

  // ---- 2. Plain names send exactly what they always sent.
  respond = () => list([]);
  for (const [name, q] of [
    ['Lightning Bolt', 'Lightning Bolt unique:prints -is:digital'],
    ['Circle of Protection: Red', 'Circle of Protection: Red unique:prints -is:digital'],
    ['Fire // Ice', 'Fire // Ice unique:prints -is:digital'],
    ['Fight or Flight', 'Fight or Flight unique:prints -is:digital'],
  ]) {
    r = await search({ game: 'mtg', scope: 'internet', name });
    assert.strictEqual(r.qs[0].get('q'), q, `${name} is still a name search`);
  }
  r = await search({ game: 'mtg', scope: 'internet', name: 'Sol Ring', number: '263' });
  assert.strictEqual(r.qs[0].get('q'), 'Sol Ring cn:263', 'the name + number probe is unchanged');
  // The scanner's identify lookups pass a recognised name, which stays a name
  // even when it holds a quote.
  r = await search({ game: 'mtg', scope: 'internet', prints: '1', name: 'Kongming, "Sleeping Dragon"' });
  assert.strictEqual(r.qs[0].get('q'), '!"Kongming, "Sleeping Dragon"" unique:prints');
  console.log('PASS: plain names and scanner lookups are unchanged');

  // ---- 3. Unreadable syntax is a 400 that names the problem; nothing is sent.
  for (const [name, code, params] of [
    ['o:"draw a card', 'unterminatedQuote', {}],
    ['(t:elf', 'unbalancedParens', {}],
    ['otaq:ramp', 'unknownKeyword', { keyword: 'otaq:' }],
    ['t:elf or', 'danglingOperator', { word: 'or' }],
  ]) {
    r = await search({ game: 'mtg', scope: 'internet', name });
    assert.strictEqual(r.status, 400, `${name} is refused`);
    assert.strictEqual(r.body.code, code);
    assert.deepStrictEqual(r.body.params, params);
    assert.ok(r.body.error && r.body.error.length > 10, 'with a readable message');
    assert.strictEqual(r.qs.length, 0, `${name} never reaches Scryfall`);
  }
  // Scryfall refusing a query it was sent is also the user's to fix.
  respond = () => { throw httpError(400, { object: 'error', code: 'bad_request', details: 'All of your terms were ignored.' }); };
  r = await search({ game: 'mtg', scope: 'internet', name: 'c:yore' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'upstreamRejected');
  assert.deepStrictEqual(r.body.params, { detail: 'All of your terms were ignored.' });
  // Nothing matched: an empty page, and no first-word fallback broadening it.
  respond = () => { throw httpError(404, { object: 'error', code: 'not_found' }); };
  r = await search({ game: 'mtg', scope: 'internet', name: 't:goblin c:u' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, []);
  assert.strictEqual(r.qs.length, 1, 'no fallback query');
  respond = () => { throw httpError(500); };
  r = await search({ game: 'mtg', scope: 'internet', name: 't:goblin' });
  assert.strictEqual(r.status, 503, 'an upstream failure is still "unavailable"');
  respond = () => { throw httpError(429); };
  r = await search({ game: 'mtg', scope: 'internet', name: 't:goblin' });
  assert.strictEqual(r.status, 429);
  respond = () => list([]);
  console.log('PASS: syntax errors are named, upstream refusals passed on');

  // ---- 4. Other games are untouched: no syntax, the name as it always was.
  let captured = null;
  const fakeApi = { searchCards: async (opts) => { captured = opts; return { cards: [], total: 0 }; } };
  const realApiFor = pokemonProvider.apiFor;
  const realLorcana = lorcastApi.searchCards;
  pokemonProvider.apiFor = async () => fakeApi;
  lorcastApi.searchCards = fakeApi.searchCards;
  try {
    for (const game of ['pokemon', 'lorcana']) {
      captured = null;
      r = await search({ game, scope: 'internet', name: 't:creature (c:g)' });
      assert.strictEqual(r.status, 200, `${game} search runs`);
      assert.strictEqual(captured.syntax, undefined, `${game} gets no syntax`);
      assert.strictEqual(captured.name, 't:creature (c:g)', `${game} gets the name as typed`);
      r = await search({ game, scope: 'internet', name: 'o:"unbalanced' });
      assert.strictEqual(r.status, 200, `${game} never fails on a quote`);
    }
  } finally {
    pokemonProvider.apiFor = realApiFor;
    lorcastApi.searchCards = realLorcana;
  }
  console.log('PASS: Pokémon and Lorcana searches are unaffected');

  // ---- 5. Deck builder: syntax over the owner's collection.
  const own = async (userId, rawCard, quantity, extra = {}) => db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing, language, list_type, game) VALUES (?, ?, ?, ?, ?, ?, 'mtg')`,
    [idOf(rawCard), userId, quantity, extra.printing || 'Normal', extra.language || 'English', extra.list || 'collection']
  );
  await own(alice, ELVES, 2);
  await own(alice, ELVES, 1, { printing: 'Holofoil' });
  await own(alice, BOLT, 1, { language: 'Japanese' });
  await own(alice, BEARS, 3);
  await own(alice, ANGEL, 1, { printing: 'Holofoil' });
  await own(alice, SIGNET, 1);
  await own(alice, DELVER, 1);
  await own(alice, GOYF, 1, { list: 'wishlist' }); // wanted, not owned
  await own(bob, BOLT, 4);
  await own(bob, GOYF, 2);
  const deck = async (name, params = {}, user = alice) => search({ game: 'mtg', scope: 'collection', name, ...params }, user);
  const names = (res) => res.body.map(c => c.name);

  r = await deck('t:creature c:g');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(names(r), ['Grizzly Bears', 'Llanowar Elves'], 'sorted by name');
  assert.deepStrictEqual(r.body.map(c => c.owned_qty), [3, 3], 'every copy counts');
  assert.strictEqual(r.qs.length, 0, 'the collection is never asked of Scryfall');
  assert.deepStrictEqual(names(await deck('is:foil')), ['Llanowar Elves', 'Serra Angel'], 'a card is in when one copy matches');
  assert.strictEqual((await deck('is:foil')).body[0].owned_qty, 3, 'owned still counts the non-foil copies');
  assert.deepStrictEqual(names(await deck('lang:ja')), ['Lightning Bolt'], 'the copy\'s language');
  assert.deepStrictEqual(names(await deck('kw:flying')), ['Delver of Secrets', 'Serra Angel']);
  assert.deepStrictEqual(names(await deck('is:vanilla')), ['Grizzly Bears']);
  assert.deepStrictEqual(names(await deck('o:"top card"')), ['Delver of Secrets']);
  assert.deepStrictEqual(names(await deck('id<=wu -t:creature')), ['Azorius Signet']);
  assert.deepStrictEqual(names(await deck('usd>1 t:creature')), ['Serra Angel'], 'the foil copy\'s price');
  assert.deepStrictEqual(names(await deck('t:creature')), ['Delver of Secrets', 'Grizzly Bears', 'Llanowar Elves', 'Serra Angel']);
  assert.deepStrictEqual(names(await deck('t:creature', { limit: '1', page: '2' })), ['Grizzly Bears'], 'paged after sorting');
  assert.deepStrictEqual(names(await deck('t:lhurgoyf')), [], 'a wishlist card is not owned');
  const bolts = await deck('"lightning bolt"');
  assert.deepStrictEqual(bolts.body.map(c => [c.name, c.owned_qty]), [['Lightning Bolt', 1]], 'another user\'s copies never count');
  assert.deepStrictEqual(names(await deck('t:lhurgoyf', {}, bob)), ['Tarmogoyf'], 'bob sees his own');
  for (const [name, code] of [['otag:ramp', 'unsupportedKeyword'], ['name:/bolt/', 'regexUnsupported'], ['c:yore', 'invalidColor']]) {
    r = await deck(name);
    assert.strictEqual(r.status, 400, `${name} cannot filter a collection`);
    assert.strictEqual(r.body.code, code);
  }
  r = await deck('Elves');
  assert.deepStrictEqual(names(r), ['Llanowar Elves'], 'a plain name keeps the SQL name search');
  console.log('PASS: deck search answers syntax from the owner\'s cards');

  // ---- 6. No part of a query is SQL. Quote-and-comment payloads are just text
  // to look for, and LIKE wildcards mean nothing to the evaluator.
  const before = (await db.get(`SELECT COUNT(*) AS n FROM collection`)).n;
  for (const name of [
    `name:"x' OR '1'='1"`, `o:"'); DROP TABLE collection; --"`, `s:"lea' --"`, `"%"`, `"_"`,
    `t:"creature' UNION SELECT * FROM users --"`, `-name:"' OR 1=1 --" t:nothing`,
  ]) {
    r = await deck(name);
    assert.strictEqual(r.status, 200, `${name} is a query, not an error`);
    assert.deepStrictEqual(r.body, [], `${name} matches nothing`);
  }
  r = await deck(`Bolt' OR 'a'='a`);
  assert.deepStrictEqual(r.body, [], 'the plain path (no syntax in it) binds its LIKE as well');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection`)).n, before, 'nothing was changed');
  assert.ok(await db.get(`SELECT id FROM users WHERE id = ?`, [bob]), 'and nothing was dropped');
  console.log('PASS: injection-shaped queries are inert');
}

main()
  .then(async () => { await cleanup(); console.log('scryfallsyntaxsearch.test.js: all assertions passed'); process.exit(0); })
  .catch(async (err) => { console.error(err); await cleanup(); process.exit(1); });
