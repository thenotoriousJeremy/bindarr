import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionExpired, SESSION_EXPIRED } from './sessionExpiry.js';

const reply = (status, body) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json' } }
);

test('the auth gate saying the session is gone signs out', async () => {
  assert.equal(await isSessionExpired(reply(401, { error: 'Invalid or expired session token.', code: SESSION_EXPIRED })), true);
  assert.equal(await isSessionExpired(reply(401, { error: 'Access denied. No token provided.', code: SESSION_EXPIRED })), true);
});

test('a 401 that is about something else does not', async () => {
  // Any route but the gate: whatever it says, it says it without the marker.
  assert.equal(await isSessionExpired(reply(401, { error: 'Current password is incorrect' })), false);
  assert.equal(await isSessionExpired(reply(401, { error: 'Invalid username or password' })), false);
  // A code that is present but different is a different answer.
  assert.equal(await isSessionExpired(reply(401, { error: 'Invalid or expired session token.', code: 'other' })), false);
  // A proxy's own auth page, or nothing at all.
  assert.equal(await isSessionExpired(reply(401, '<html>401 Authorization Required</html>')), false);
  assert.equal(await isSessionExpired(new Response(null, { status: 401 })), false);
});

test('only a 401 can sign out', async () => {
  assert.equal(await isSessionExpired(reply(400, { error: 'Current password is incorrect' })), false);
  assert.equal(await isSessionExpired(reply(403, { error: 'x', code: SESSION_EXPIRED })), false);
  assert.equal(await isSessionExpired(reply(200, { ok: true })), false);
  assert.equal(await isSessionExpired(undefined), false);
});

test('an older server, which sent no code, is still understood', async () => {
  assert.equal(await isSessionExpired(reply(401, { error: 'Invalid or expired session token.' })), true);
  assert.equal(await isSessionExpired(reply(401, { error: 'Access denied. No token provided.' })), true);
});

test('the caller can still read the body afterwards', async () => {
  const res = reply(401, { error: 'Current password is incorrect' });
  await isSessionExpired(res);
  assert.deepEqual(await res.json(), { error: 'Current password is incorrect' });
});
