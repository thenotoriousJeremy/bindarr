import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_STEPS, resumeStep, pokemonTcgKeyApplies, keysToSave } from './setupWizard.js';

test('an unfinished wizard reopens at the step it was closed on', () => {
  assert.equal(resumeStep({ setup_complete: false, setup_step: 'keys' }), SETUP_STEPS.indexOf('keys'));
  assert.equal(resumeStep({ setup_complete: false, setup_step: 'tour' }), SETUP_STEPS.length - 1);
});

test('a new install, or a step this build does not have, starts at the beginning', () => {
  assert.equal(resumeStep({ setup_complete: false, setup_step: '' }), 0);
  assert.equal(resumeStep({ setup_complete: false }), 0, 'a server from before the column');
  assert.equal(resumeStep({ setup_complete: false, setup_step: 'retired' }), 0);
});

test('a finished or skipped wizard does not open at all', () => {
  assert.equal(resumeStep({ setup_complete: true, setup_step: 'keys' }), null);
  assert.equal(resumeStep(null), null, 'nothing to go on: say nothing');
});

test('the pokemontcg.io key only applies to an install pinned to pokemontcg.io', () => {
  assert.equal(pokemonTcgKeyApplies('pokemontcg'), true);
  for (const provider of ['tcgdex', 'pokemontcgapi', undefined, null, '']) {
    assert.equal(pokemonTcgKeyApplies(provider), false, String(provider));
  }
});

test('only the boxes with something typed in are saved', () => {
  assert.deepEqual(keysToSave({ tcg: '', psa: 'psa-1', graded: '   ' }, { pokemonTcg: true }), { psa_api_token: 'psa-1' });
  assert.deepEqual(keysToSave({}), {}, 'nothing typed, nothing to save');
  assert.deepEqual(
    keysToSave({ tcg: 'tcg-1', psa: 'psa-1', graded: 'ppt-1' }, { pokemonTcg: true }),
    { tcg_api_key: 'tcg-1', psa_api_token: 'psa-1', graded_price_api_key: 'ppt-1' },
  );
});

test('a pokemontcg.io key is not saved where the box is not shown', () => {
  assert.deepEqual(keysToSave({ tcg: 'tcg-1', graded: 'ppt-1' }, { pokemonTcg: false }), { graded_price_api_key: 'ppt-1' });
});
