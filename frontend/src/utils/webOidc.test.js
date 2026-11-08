import test from 'node:test';
import assert from 'node:assert/strict';
import { readOidcCode } from './webOidc.js';

test('an SSO return yields its code and the address without it', () => {
  assert.deepEqual(readOidcCode('https://cards.example.com/?oidc_code=abc123'), { code: 'abc123', cleanUrl: '/' });
  // Anything else on the address survives the clean-up.
  assert.deepEqual(
    readOidcCode('https://cards.example.com/?theme=light&oidc_code=abc123#top'),
    { code: 'abc123', cleanUrl: '/?theme=light#top' }
  );
});

test('a session token in the URL is not a way in any more', () => {
  // The old sign-in read these. Nothing reads them now.
  assert.equal(readOidcCode('https://cards.example.com/?token=deadbeef'), null);
  assert.equal(readOidcCode('https://cards.example.com/?oidc_token=deadbeef'), null);
});

test('no code, an empty code, or no URL at all is not a return', () => {
  assert.equal(readOidcCode('https://cards.example.com/'), null);
  assert.equal(readOidcCode('https://cards.example.com/?oidc_code='), null);
  assert.equal(readOidcCode('https://cards.example.com/?oidc_error=Access%20denied'), null);
  assert.equal(readOidcCode('not a url'), null);
  assert.equal(readOidcCode(undefined), null);
});
