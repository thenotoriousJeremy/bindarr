import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMassEntry, massEntryLine, productLine, massEntryPage, MAX_URL_LENGTH, MASS_ENTRY_URL } from './tcgMassEntryUrl.js';

test('product lines are the names TCGplayer matches on', () => {
  assert.equal(productLine('mtg'), 'Magic');
  assert.equal(productLine('pokemon', 'English'), 'Pokemon');
  // Japanese Pokémon is a separate TCGplayer catalogue.
  assert.equal(productLine('pokemon', 'ja'), 'Pokemon Japan');
  assert.equal(productLine('pokemon', 'Japanese'), 'Pokemon Japan');
  assert.equal(productLine('lorcana'), 'Lorcana TCG');
  assert.equal(massEntryPage('lorcana'), `${MASS_ENTRY_URL}?productline=Lorcana%20TCG`);
  assert.equal(productLine('riftbound'), 'Riftbound League of Legends Trading Card Game');
});

test('a Riftbound buylist goes by product id, which every listed card has', () => {
  const { url, count } = buildMassEntry(
    [{ quantity: 2, name: 'Vi - Peacekeeper', productId: 685595 }, { quantity: 1, name: 'Star Spring', productId: 685601 }],
    { game: 'riftbound' }
  );
  assert.equal(count, 2);
  assert.ok(url.startsWith(`${MASS_ENTRY_URL}?productline=Riftbound%20League%20of%20Legends%20Trading%20Card%20Game`), url);
  assert.ok(url.includes('2-685595') && url.includes('1-685601'), url);
});

test('a line is qty name, with [SET] number only when the set code is known', () => {
  assert.equal(massEntryLine({ quantity: 2, name: 'Lightning Bolt' }), '2 Lightning Bolt');
  assert.equal(massEntryLine({ quantity: 1, name: 'Sire of Seven Deaths', setCode: 'FDN', number: '1' }), '1 Sire of Seven Deaths [FDN] 1');
  assert.equal(massEntryLine({ name: 'Pikachu', number: '25' }), '1 Pikachu', 'a number alone cannot be placed without a set');
  assert.equal(massEntryLine({ quantity: 0, name: 'Plains' }), '1 Plains');
  // A delimiter inside a name would split the entry in two.
  assert.equal(massEntryLine({ name: 'Odd || Name' }), '1 Odd | Name');
  assert.equal(massEntryLine({ name: '' }), '');
});

test('name entries are encoded one by one and joined with a raw ||', () => {
  const { url, text, count } = buildMassEntry(
    [{ quantity: 1, name: 'Glover, the Fist' }, { quantity: 2, name: "Laur-Élie's Gift", setCode: 'FDN', number: '12' }],
    { game: 'mtg' }
  );
  assert.equal(count, 2);
  assert.equal(text, "1 Glover, the Fist\n2 Laur-Élie's Gift [FDN] 12");
  assert.equal(url,
    'https://www.tcgplayer.com/massentry?productline=Magic&c=1%20Glover%2C%20the%20Fist||2%20Laur-%C3%89lie\'s%20Gift%20%5BFDN%5D%2012');
});

test('product ids are used only when every entry has one', () => {
  const all = buildMassEntry([
    { quantity: 1, name: 'A Whole New World', productId: 506088 },
    { quantity: 3, name: 'Mickey Mouse - Brave Little Tailor', productId: '506100' },
  ], { game: 'lorcana' });
  assert.equal(all.url, `${MASS_ENTRY_URL}?productline=Lorcana%20TCG&c=1-506088||3-506100`);
  assert.equal(all.text, '1 A Whole New World\n3 Mickey Mouse - Brave Little Tailor', 'the paste fallback stays readable');

  const mixed = buildMassEntry([
    { quantity: 1, name: 'Pineco', productId: 490001 },
    { quantity: 1, name: 'Heracross' },
  ], { game: 'pokemon' });
  assert.equal(mixed.url, `${MASS_ENTRY_URL}?productline=Pokemon&c=1%20Pineco||1%20Heracross`);
});

test('the same card twice is one entry bought twice', () => {
  const { url, count } = buildMassEntry([
    { quantity: 1, name: 'Pineco', productId: 490001 },
    { quantity: 1, name: 'Pineco', productId: 490001 },
  ], { game: 'pokemon', language: 'English' });
  assert.equal(count, 1);
  assert.ok(url.endsWith('&c=2-490001'));
});

test('nothing to buy gives no link, and a list too long for a URL gives text only', () => {
  assert.deepEqual(buildMassEntry([], { game: 'mtg' }), { url: null, text: '', count: 0 });
  assert.deepEqual(buildMassEntry([{ name: '' }, null], { game: 'mtg' }), { url: null, text: '', count: 0 });

  const many = Array.from({ length: 600 }, (_, i) => ({ quantity: 1, name: `Card Number ${i}`, setCode: 'FDN', number: String(i) }));
  const long = buildMassEntry(many, { game: 'mtg' });
  assert.equal(long.url, null, `a link over ${MAX_URL_LENGTH} characters is refused by TCGplayer`);
  assert.equal(long.text.split('\n').length, 600);

  const fits = buildMassEntry(many.slice(0, 50), { game: 'mtg' });
  assert.ok(fits.url && fits.url.length <= MAX_URL_LENGTH);
});
