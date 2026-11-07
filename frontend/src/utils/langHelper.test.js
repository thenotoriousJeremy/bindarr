// Self-check for card display name localization and Japanese translation fallback.
// Run: `node src/utils/langHelper.test.js`
import assert from 'node:assert';
import { getCardDisplayName, translateJapaneseName, loadNameDictionaries, nameDictionariesReady, onNameDictionaries, hasJapaneseText, POKEMON_EN_TO_JP } from './langHelper.js';

// 0. The dictionaries are fetched on first use. Until then a name is the English
// one and a Japanese query maps to nothing — and asking is what starts the fetch.
assert.strictEqual(nameDictionariesReady(), false);
let arrived = 0;
onNameDictionaries(() => { arrived++; });
assert.strictEqual(getCardDisplayName('Charizard', 'English'), 'Charizard', 'English never needs them');
assert.strictEqual(nameDictionariesReady(), false, 'and does not fetch them');
assert.strictEqual(getCardDisplayName('Charizard', 'Japanese'), 'Charizard', 'not loaded yet: English');
assert.strictEqual(translateJapaneseName('リザードン'), '', 'not loaded yet: unmapped');
assert.strictEqual(loadNameDictionaries(), loadNameDictionaries(), 'one fetch, however many ask');
await loadNameDictionaries();
assert.strictEqual(nameDictionariesReady(), true);
assert.strictEqual(arrived, 1, 'listeners hear about it once');
assert.strictEqual(POKEMON_EN_TO_JP.Charizard, 'リザードン', 'the exported map is filled in place');
assert.ok(hasJapaneseText('リザードン ex') && hasJapaneseText('稲妻') && !hasJapaneseText('Charizard') && !hasJapaneseText(''));

// 1. When printed_name exists, it always wins regardless of language.
assert.strictEqual(getCardDisplayName('Ancestral Katana', 'Japanese', '祖先の刀'), '祖先の刀');
assert.strictEqual(getCardDisplayName('Lightning Bolt', 'French', 'Foudre'), 'Foudre');
assert.strictEqual(getCardDisplayName('Charizard', 'German', 'Glurak'), 'Glurak');

// 2. When printed_name is absent and language is Japanese, map known species.
assert.strictEqual(getCardDisplayName('Charizard', 'Japanese'), 'リザードン');
assert.strictEqual(getCardDisplayName('Pikachu', 'Japanese'), 'ピカチュウ');
assert.strictEqual(getCardDisplayName('Charizard', 'ja'), 'リザードン');
assert.strictEqual(getCardDisplayName('Charizard', 'JAPANESE'), 'リザードン');

// 3. Owner/variant prefixes map correctly with base species.
assert.strictEqual(getCardDisplayName('Dark Charizard', 'Japanese'), 'わるいリザードン');
assert.strictEqual(getCardDisplayName('Light Dragonite', 'Japanese'), 'やさしいカイリュー');
assert.strictEqual(getCardDisplayName('Shining Mew', 'Japanese'), 'ひかるミュウ');
assert.strictEqual(getCardDisplayName("Giovanni's Machamp", 'Japanese'), 'サカキのカイリキー');

// 4. Multilingual Pokémon species translation (FR, DE, IT, ES, JA, etc.)
assert.strictEqual(getCardDisplayName('Charizard', 'French'), 'Dracaufeu');
assert.strictEqual(getCardDisplayName('Charizard ex', 'French'), 'Dracaufeu ex');
assert.strictEqual(getCardDisplayName('Charizard', 'German'), 'Glurak');
assert.strictEqual(getCardDisplayName('Charizard VMAX', 'German'), 'Glurak VMAX');
assert.strictEqual(getCardDisplayName('Meowscarada ex', 'French'), 'Miascarade ex');
assert.strictEqual(getCardDisplayName('Charizard ex', 'Japanese'), 'リザードン ex');
assert.strictEqual(getCardDisplayName('Charizard', 'English'), 'Charizard');
assert.strictEqual(getCardDisplayName('Charizard', 'en'), 'Charizard');
assert.strictEqual(getCardDisplayName('Lightning Bolt', 'German'), 'Lightning Bolt');
assert.strictEqual(getCardDisplayName('Lightning Bolt', 'de'), 'Lightning Bolt');

// 5. Unmapped species name in Japanese returns English name.
assert.strictEqual(getCardDisplayName('SomeUnmappedPokemon', 'Japanese'), 'SomeUnmappedPokemon');

// 6. translateJapaneseName maps Japanese search queries back to English.
assert.strictEqual(translateJapaneseName('リザードン'), 'Charizard');
assert.strictEqual(translateJapaneseName('わるいリザードン'), 'Dark Charizard');
assert.strictEqual(translateJapaneseName('サカキのカイリキー'), "Giovanni's Machamp");

// 7. Game-scoped language filtering in frontend.
import { getLanguagesForGame, getLanguageNamesForGame, isLanguageSupported } from './languages.js';
assert.strictEqual(getLanguagesForGame('lorcana').length, 6);
assert.ok(isLanguageSupported('lorcana', 'French'));
assert.ok(isLanguageSupported('lorcana', 'fr'));
assert.ok(!isLanguageSupported('lorcana', 'es'));
assert.ok(!isLanguageSupported('lorcana', 'Spanish'));
assert.strictEqual(getLanguageNamesForGame('lorcana').length, 6);
assert.strictEqual(getLanguagesForGame('mtg').length, 11);
// 8. Disney Lorcana card translations
assert.strictEqual(getCardDisplayName('Tyler Nguyen-Baker - 4*Town Fan', 'French'), 'Tyler Nguyen-Baker - Fan des 4*Town');
assert.strictEqual(getCardDisplayName('Tyler Nguyen-Baker - 4*Town Fan', 'German'), 'Tyler Nguyen-Baker - 4*Town-Fan');
assert.strictEqual(getCardDisplayName('Tyler Nguyen-Baker - 4*Town Fan', 'Italian'), 'Tyler Nguyen-Baker - Fan dei 4*Town');
assert.strictEqual(getCardDisplayName('Elsa - Snow Queen', 'French'), 'Elsa - Reine des neiges');
assert.strictEqual(getCardDisplayName('Mickey Mouse - Brave Little Tailor', 'German'), 'Micky Maus - Tapferes Schneiderlein');
assert.strictEqual(getCardDisplayName('Beast - Tragic Hero', 'it'), 'La Bestia - Eroe tragico');

console.log('langHelper.test.js OK');
