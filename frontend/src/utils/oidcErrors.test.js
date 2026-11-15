import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { oidcErrorKey, OIDC_ERRORS } from './oidcErrors.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));

test('a known SSO error code names its message', () => {
  assert.equal(oidcErrorKey('no_account'), 'login.oidcNoAccount');
  assert.equal(oidcErrorKey('setup_code_required'), 'login.oidcSetupCodeRequired');
});

test('anything else, text from a link included, gets the generic message', () => {
  assert.equal(oidcErrorKey('Your account was deleted, call 555-0100'), 'login.errOidcFailed');
  assert.equal(oidcErrorKey(undefined), 'login.errOidcFailed');
  assert.equal(oidcErrorKey('__proto__'), 'login.errOidcFailed');
  assert.equal(oidcErrorKey('toString'), 'login.errOidcFailed');
});

test('every message the map names is in en.json', () => {
  for (const key of [...Object.values(OIDC_ERRORS), 'login.errOidcFailed']) {
    assert.ok(typeof en[key] === 'string', `${key} is missing from en.json`);
  }
});
