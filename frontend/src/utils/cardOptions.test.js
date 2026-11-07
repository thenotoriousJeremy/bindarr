import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONDITIONS, PRINTINGS, getPrintings, conditionLabel, conditionShort, printingLabel } from './cardOptions.js';
import { getPrintingBadgeLabel } from './cardPrinting.js';
import { translate } from './translate.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const de = JSON.parse(readFileSync(new URL('../locales/de.json', import.meta.url), 'utf8'));
const tEn = (key, vars) => translate(en, en, 'en', key, vars);
const tDe = (key, vars) => translate(de, en, 'de', key, vars);
// Echoes the key, to see which one a label asked for.
const tKey = (key) => `<${key}>`;

test('every stored condition and printing has an English label', () => {
  for (const c of CONDITIONS) {
    assert.equal(conditionLabel(tEn, c), c, `${c} reads as itself in English`);
    assert.notEqual(conditionShort(tEn, c), `condition.short.${c}`, `${c} has a short form`);
  }
  for (const p of PRINTINGS) assert.equal(printingLabel(tEn, p), p, `${p} reads as itself in English`);
  assert.deepEqual(CONDITIONS.map(c => conditionShort(tEn, c)), ['NM', 'LP', 'MP', 'HP', 'DMG']);
});

test('labels translate; the stored value does not change', () => {
  assert.equal(conditionLabel(tDe, 'Lightly Played'), 'Leicht bespielt');
  assert.equal(printingLabel(tDe, '1st Edition'), '1. Auflage');
  // Untranslated in de.json: falls back to English key by key.
  assert.equal(conditionLabel(tDe, 'Near Mint'), 'Near Mint');
  assert.deepEqual(CONDITIONS, ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged']);
});

test('printing labels follow the game, as the picker does', () => {
  assert.equal(printingLabel(tKey, 'Holofoil', 'pokemon'), '<printing.holofoil>');
  assert.equal(printingLabel(tKey, 'Holofoil', 'mtg'), '<printing.foil>');
  assert.equal(printingLabel(tKey, 'Normal', 'lorcana'), '<printing.nonfoil>');
  assert.equal(printingLabel(tKey, 'Normal'), '<printing.normal>', 'no game: the stored finish');
  // A Pokémon-only finish on a Magic row (an old import) still gets its own name.
  assert.equal(printingLabel(tKey, 'Reverse Holofoil', 'mtg'), '<printing.reverseHolofoil>');
  for (const game of ['pokemon', 'mtg', 'lorcana']) {
    for (const { value, label } of getPrintings(game)) assert.equal(printingLabel(tEn, value, game), label);
  }
});

test('a value with no key shows as stored', () => {
  assert.equal(conditionLabel(tKey, 'Mint'), 'Mint');
  assert.equal(conditionShort(tKey, 'Mint'), 'Mint');
  assert.equal(printingLabel(tKey, 'Etched'), 'Etched');
  assert.equal(conditionLabel(tKey, null), '');
  assert.equal(printingLabel(tKey, undefined), '');
});

test('thumbnail badges', () => {
  assert.equal(getPrintingBadgeLabel('Holofoil', tEn), 'HOLO');
  assert.equal(getPrintingBadgeLabel('Reverse Holofoil', tEn), 'REV');
  assert.equal(getPrintingBadgeLabel('1st Edition', tEn), '1ST');
  assert.equal(getPrintingBadgeLabel('Promo', tEn), 'PRM');
  assert.equal(getPrintingBadgeLabel('Normal', tEn), '', 'Normal has no badge');
  assert.equal(getPrintingBadgeLabel(undefined, tEn), '');
});
