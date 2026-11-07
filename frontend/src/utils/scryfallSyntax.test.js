// Self-check for Magic's Scryfall-syntax boxes (scryfallSyntax.js over
// shared/scryfallQuery.mjs, the parser the backend runs too): which input counts
// as syntax, what the collection filter and the search box do with it, and that
// every error the parser can raise has its English text in en.json.
// Run: `node src/utils/scryfallSyntax.test.js`
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { checkSearchSyntax, compileCollectionFilter, syntaxErrorText, looksLikeSyntax } from './scryfallSyntax.js';
import { ERROR_CODES, QuerySyntaxError } from '../../../shared/scryfallQuery.mjs';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));

// Rows as GET /api/collection hands them to the collection screen.
const rows = [
  { name: 'Llanowar Elves', type_line: 'Creature — Elf Druid', types: ['Green'], color_identity: ['Green'], cmc: 1, mana_cost: '{G}', power: '1', toughness: '1', oracle_text: '{T}: Add {G}.', keywords: [], rarity: 'Common', set_id: 'm19', number: '314', language: 'English', printing: 'Normal', price_trend: 0.25, price_currency: 'USD' },
  { name: 'Serra Angel', type_line: 'Creature — Angel', types: ['White'], color_identity: ['White'], cmc: 5, mana_cost: '{3}{W}{W}', power: '4', toughness: '4', oracle_text: 'Flying, vigilance', keywords: ['Flying', 'Vigilance'], rarity: 'Uncommon', set_id: 'dom', number: '33', language: 'English', printing: 'Holofoil', price_trend: 2, price_currency: 'USD' },
  { name: 'Lightning Bolt', printed_name: '稲妻', type_line: 'Instant', types: ['Red'], color_identity: ['Red'], cmc: 1, mana_cost: '{R}', oracle_text: 'Lightning Bolt deals 3 damage to any target.', keywords: [], rarity: 'Common', set_id: 'sta', number: '42', language: 'Japanese', printing: 'Normal', price_trend: 1.2, price_currency: 'EUR' },
];
const names = (filter) => rows.filter(filter.matches).map(r => r.name);

// --- What counts as syntax -----------------------------------------------------
// A plain search keeps the collection's old name / set / number match: null.
for (const plain of ['', 'Lightning Bolt', 'Fire // Ice', 'Circle of Protection: Red', 'Fight or Flight', 'mh3', '314']) {
  assert.strictEqual(compileCollectionFilter(plain), null, `${JSON.stringify(plain)} stays a plain search`);
  assert.strictEqual(checkSearchSyntax(plain), null);
}
assert.ok(looksLikeSyntax('t:creature c:g'));

// --- The collection filter -----------------------------------------------------
assert.deepStrictEqual(names(compileCollectionFilter('t:creature c:g')), ['Llanowar Elves']);
assert.deepStrictEqual(names(compileCollectionFilter('t:creature -c:g')), ['Serra Angel']);
assert.deepStrictEqual(names(compileCollectionFilter('is:foil')), ['Serra Angel'], 'the copy you own is foil');
assert.deepStrictEqual(names(compileCollectionFilter('lang:ja')), ['Lightning Bolt'], 'languages come from the app table');
assert.deepStrictEqual(names(compileCollectionFilter('kw:flying or o:"3 damage"')), ['Serra Angel', 'Lightning Bolt']);
assert.deepStrictEqual(names(compileCollectionFilter('cmc<=3 usd<1')), ['Llanowar Elves'], 'a euro price is not a dollar price');
assert.deepStrictEqual(names(compileCollectionFilter('"稲妻"')), ['Lightning Bolt']);

// A filter that cannot run matches nothing and says why — never a silent empty grid.
const bad = compileCollectionFilter('otag:ramp');
assert.strictEqual(bad.error.code, 'unsupportedKeyword');
assert.deepStrictEqual(names(bad), []);
assert.strictEqual(compileCollectionFilter('o:"draw a').error.code, 'unterminatedQuote');
assert.strictEqual(compileCollectionFilter('c:yore').error.code, 'invalidColor');

// --- The search box: grammar only, because Scryfall answers every keyword ------
assert.strictEqual(checkSearchSyntax('otag:ramp f:edh'), null, 'card search takes what the collection cannot');
assert.strictEqual(checkSearchSyntax('t:elf (c:g').code, 'unbalancedParens');
assert.strictEqual(checkSearchSyntax('o:"draw a card').code, 'unterminatedQuote');
assert.deepStrictEqual(checkSearchSyntax('otaq:ramp').params, { keyword: 'otaq:' });

// --- Messages ----------------------------------------------------------------
const t = (key, vars) => (en[key] ?? key).replace(/\{(\w+)\}/g, (whole, k) => (vars && vars[k] != null ? vars[k] : whole));
assert.strictEqual(syntaxErrorText(t, checkSearchSyntax('otaq:ramp')), 'Unsupported: "otaq:" is not a Scryfall search keyword.');
// A code with no locale text falls back to the English the parser or server sent.
assert.strictEqual(syntaxErrorText(t, { code: 'notAKey', error: 'From the server.' }), 'From the server.');
assert.strictEqual(syntaxErrorText(t, null), '');

// Every error the parser can raise is in en.json, with the placeholders its
// English message fills — so a translator sees the same {value} the parser passes.
for (const code of ERROR_CODES) {
  const key = `syntax.err.${code}`;
  assert.ok(en[key], `${key} is in en.json`);
  const used = new Set();
  const params = new Proxy({}, { get: (_, name) => { used.add(name); return `<${String(name)}>`; } });
  const message = new QuerySyntaxError(code, params).message;
  const placeholders = new Set((en[key].match(/\{(\w+)\}/g) || []).map(p => p.slice(1, -1)));
  assert.deepStrictEqual(placeholders, used, `${key} uses the same placeholders as the parser's message`);
  // And it says the same thing, so English UI and English API agree.
  assert.strictEqual(t(key, Object.fromEntries([...used].map(n => [n, `<${n}>`]))), message, `${key} matches the parser's text`);
}

console.log('scryfallSyntax.test.js: all assertions passed');
