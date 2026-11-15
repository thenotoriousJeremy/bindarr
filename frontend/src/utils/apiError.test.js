import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apiErrorText, apiErrorKey } from './apiError.js';
import { translate } from './translate.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const de = JSON.parse(readFileSync(new URL('../locales/de.json', import.meta.url), 'utf8'));
const tEn = (key, vars) => translate(en, en, 'en', key, vars);
const tDe = (key, vars) => translate(de, en, 'de', key, vars);

test('a known code shows in the interface language', () => {
  const body = { error: 'Invalid username or password', code: 'invalid_credentials' };
  assert.equal(apiErrorText(tDe, body, 'login.errFailed'), 'Ungültiger Benutzername oder ungültiges Passwort.');
  assert.equal(apiErrorText(tEn, body, 'login.errFailed'), 'Invalid username or password.');
});

test('params fill the sentence, and a cert number stays verbatim', () => {
  const body = { error: 'PSA cert 82613901 is already in your collection as Charizard.', code: 'cert_in_use', params: { grader: 'PSA', cert: 82613901, name: 'Charizard' } };
  assert.equal(apiErrorText(tEn, body, 'search.errAddDb'), 'PSA cert 82613901 is already in your collection as Charizard.');
  assert.equal(apiErrorText(tEn, { code: 'cert_in_use', params: { grader: 'BGS', cert: '1' } }, 'x'), 'BGS cert 1 is already in your collection.');
  assert.equal(apiErrorText(tEn, { code: 'import_too_many_rows', params: { count: 6000, max: 5000 } }, 'x'), 'Too many rows (6,000). Import at most 5,000 at a time.');
});

test('no known code: the server\'s words, then the caller\'s message', () => {
  assert.equal(apiErrorText(tEn, { error: 'Something specific', code: 'not_a_code' }, 'loc.errMove'), 'Something specific');
  assert.equal(apiErrorText(tEn, { error: 'Something specific' }, 'loc.errMove'), 'Something specific');
  assert.equal(apiErrorText(tEn, {}, 'loc.errMove'), en['loc.errMove']);
  assert.equal(apiErrorText(tEn, null, 'loc.errMove'), en['loc.errMove']);
  assert.equal(apiErrorText(tEn, undefined, 'settings.importFailed', { error: 'x' }), 'Import failed: x');
});

test('every code maps to a key that exists in en.json', () => {
  const codes = ['card_not_found', 'cert_in_use', 'add_failed', 'entry_not_found', 'printing_other_game', 'invalid_market_value',
    'update_failed', 'delete_failed', 'compartment_full', 'rate_limited', 'provider_unavailable', 'page_locked', 'binder_locked',
    'location_name_taken', 'last_compartment', 'import_too_many_rows', 'import_empty', 'import_invalid', 'import_no_match',
    'import_failed', 'csv_no_headers', 'manabox_empty', 'manabox_no_match', 'share_not_found', 'share_no_locations',
    'container_not_found', 'deck_name_required', 'deck_not_enough_cards', 'invalid_credentials', 'registration_disabled',
    'username_taken', 'wrong_password', 'offline',
    'not_found', 'invalid', 'trades_disabled', 'api_key_refused', 'too_many_pending', 'asset_changed', 'deck_allocated', 'unit_claimed'];
  for (const code of codes) {
    const key = apiErrorKey({ code, params: { name: 'x' } });
    assert.ok(key && key in en, `${code} -> ${key}`);
  }
  assert.ok(apiErrorKey({ code: 'cert_in_use' }) in en);
  const named = apiErrorKey({ code: 'deck_allocated', decks: ['Mew'] });
  assert.ok(`${named}.one` in en && `${named}.other` in en, `${named} is a plural`);
});

test('trade refusals are translated, and the server\'s own words are only a fallback', () => {
  const said = (code, extra) => apiErrorText(tEn, { error: 'English from the server', code, ...extra }, 'transfer.errAction');
  for (const code of ['not_found', 'invalid', 'trades_disabled', 'api_key_refused', 'too_many_pending', 'asset_changed', 'unit_claimed']) {
    assert.notEqual(said(code), 'English from the server', code);
    assert.equal(said(code), en[apiErrorKey({ code })], code);
  }
  assert.notEqual(apiErrorText(tDe, { error: 'x', code: 'trades_disabled' }, 'transfer.errAction'), 'x', 'German, or English until translated; never the raw text');
  assert.equal(said('no_such_code'), 'English from the server');
  assert.equal(apiErrorText(tEn, { code: 'no_such_code' }, 'transfer.errAction'), en['transfer.errAction']);
  assert.equal(apiErrorText(tEn, { code: 'constructor' }, 'transfer.errAction'), en['transfer.errAction'], 'only the table\'s own codes');
});

test('deck_allocated names the decks holding the copies, from the body', () => {
  const one = apiErrorText(tEn, { error: 'x', code: 'deck_allocated', decks: ['Mew box'] }, 'transfer.errAction');
  assert.equal(one, 'A copy in this offer is held by the checked-out deck Mew box. Return the deck to storage first.');
  const two = apiErrorText(tEn, { error: 'x', code: 'deck_allocated', decks: ['Mew box', 'Dragons', 42] }, 'transfer.errAction');
  assert.equal(two, 'Copies in this offer are held by the checked-out decks Mew box and Dragons. Return them to storage first.');
  const none = apiErrorText(tEn, { error: 'x', code: 'deck_allocated', decks: [] }, 'transfer.errAction');
  assert.equal(none, en['apiError.deckAllocated']);
  assert.doesNotMatch(none, /\{decks\}/);
});
