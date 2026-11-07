// Self-check for UI translation lookup: per-key fallback, {placeholder} filling,
// and locale-driven plural selection.
// Run: `node src/utils/translate.test.js`
import assert from 'node:assert';
import { pickLocale, translate, fillParts, getActiveLocale, setActiveLocale } from './translate.js';

const en = {
  'nav.collection': 'Collection',
  'toast.welcomeBack': 'Welcome back, {name}!',
  'collection.cardUnit.one': 'card',
  'collection.cardUnit.other': 'cards',
};

// A translation only has to cover what it covers; every other key stays English.
const de = { 'nav.collection': 'Sammlung' };
assert.strictEqual(translate(de, en, 'de', 'nav.collection'), 'Sammlung');
assert.strictEqual(translate(de, en, 'de', 'toast.welcomeBack', { name: 'Ash' }), 'Welcome back, Ash!');

// An unknown key renders as itself rather than blank, so a typo is visible in the
// UI instead of silently erasing a label.
assert.strictEqual(translate(de, en, 'de', 'nav.nope'), 'nav.nope');

// A placeholder with nothing to fill it stays literal — better a visible {name}
// than the word vanishing mid-sentence.
assert.strictEqual(translate(en, en, 'en', 'toast.welcomeBack', {}), 'Welcome back, {name}!');

// English picks between its two forms.
assert.strictEqual(translate(en, en, 'en', 'collection.cardUnit', { count: 1 }), 'card');
assert.strictEqual(translate(en, en, 'en', 'collection.cardUnit', { count: 24 }), 'cards');

// Russian needs three integer forms, and 2 is "few" — the whole reason plural
// category comes from Intl and not from a count === 1 branch.
const ru = {
  'collection.cardUnit.one': 'карта',
  'collection.cardUnit.few': 'карты',
  'collection.cardUnit.many': 'карт',
  'collection.cardUnit.other': 'карты',
};
assert.strictEqual(translate(ru, en, 'ru', 'collection.cardUnit', { count: 1 }), 'карта');
assert.strictEqual(translate(ru, en, 'ru', 'collection.cardUnit', { count: 2 }), 'карты');
assert.strictEqual(translate(ru, en, 'ru', 'collection.cardUnit', { count: 7 }), 'карт');

// Japanese has a single form: 'other' answers every count.
assert.strictEqual(translate({ 'collection.cardUnit.other': '枚' }, en, 'ja', 'collection.cardUnit', { count: 1 }), '枚');

// A half-translated plural falls back to English for the missing category only.
assert.strictEqual(translate({ 'collection.cardUnit.one': 'Karte' }, en, 'de', 'collection.cardUnit', { count: 1 }), 'Karte');
assert.strictEqual(translate({ 'collection.cardUnit.one': 'Karte' }, en, 'de', 'collection.cardUnit', { count: 5 }), 'cards');

// Numbers are locale-formatted so a count reads naturally; strings pass through
// untouched, which is what set codes and card numbers need.
assert.strictEqual(translate({ n: '{count} cards' }, en, 'en', 'n', { count: 12345 }), '12,345 cards');
assert.strictEqual(translate({ n: '{count} cards' }, en, 'de', 'n', { count: 12345 }), '12.345 cards');
assert.strictEqual(translate({ n: 'card {num}' }, en, 'de', 'n', { num: '1234' }), 'card 1234');

// Browser preference matching: exact tag wins, then the bare language, then en.
assert.strictEqual(pickLocale(['en', 'pt', 'pt-BR'], ['pt-BR', 'en']), 'pt-BR');
assert.strictEqual(pickLocale(['en', 'pt'], ['pt-BR', 'en']), 'pt');
assert.strictEqual(pickLocale(['en', 'de'], ['fr-CA', 'de-AT']), 'de');
assert.strictEqual(pickLocale(['en', 'de'], ['fr']), 'en');
assert.strictEqual(pickLocale(['en', 'DE'], ['de']), 'DE');

// Rich sentences: the translator places the {placeholders}, the component supplies
// what goes there. The text around them survives in every language, which cutting
// the translation on English words (the old catalog hint) did not.
const bold = (s) => ({ bold: s });
assert.deepStrictEqual(
  fillParts('{magic} stores ids. {pokemon} stores product ids.', { magic: bold('Magic'), pokemon: bold('Pokémon') }),
  [bold('Magic'), ' stores ids. ', bold('Pokémon'), ' stores product ids.']
);
assert.deepStrictEqual(
  fillParts('{magic} 存储 Scryfall ID。{pokemon} 存储产品 ID。', { magic: 1, pokemon: 2 }),
  [1, ' 存储 Scryfall ID。', 2, ' 存储产品 ID。']
);
assert.deepStrictEqual(fillParts('no parts here', {}), ['no parts here']);
assert.deepStrictEqual(fillParts('keep {unknown} literal', {}), ['keep ', '{unknown}', ' literal']);

// The interface locale mirrored for code outside React (formatPrice).
assert.strictEqual(getActiveLocale(), 'en');
setActiveLocale('de');
assert.strictEqual(getActiveLocale(), 'de');
setActiveLocale(null);
assert.strictEqual(getActiveLocale(), 'en', 'nothing set means English');

console.log('translate.test.js OK');
