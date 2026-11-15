import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenTradeHistory, offersTradeShortcuts, tradeAccess, tradesEnabledFor, transferPages } from './tradeAccess.js';

test('the opt-in flag, as the server sends it (0/1) or as a boolean', () => {
  assert.equal(tradesEnabledFor({ trades_enabled: 1 }), true);
  assert.equal(tradesEnabledFor({ trades_enabled: true }), true);
  assert.equal(tradesEnabledFor({ trades_enabled: 0 }), false);
  assert.equal(tradesEnabledFor({}), false, 'a profile stored before the flag existed is opted out');
  assert.equal(tradesEnabledFor(null), false);
});

test('on a phone (device mode) only deals with people outside Bindarr are offered', () => {
  for (const tradesEnabled of [true, false]) {
    const access = tradeAccess({ deviceMode: true, tradesEnabled });
    assert.deepEqual(access, { members: false, canTrade: false, needsOptIn: false }, 'no members, nothing to opt into');
    assert.deepEqual(transferPages(access), ['new', 'history'], 'no Offers page');
  }
  assert.equal(offersTradeShortcuts({ deviceMode: true }), false, 'no "Propose trade" on cards or sealed units');
  assert.equal(canOpenTradeHistory('external', { deviceMode: true }), true);
  assert.equal(canOpenTradeHistory('internal', { deviceMode: true }), false);
  assert.equal(canOpenTradeHistory('historical', { deviceMode: true }), false);
});

test('on a server with trading off, member lists stay readable and the opt-in is offered', () => {
  const access = tradeAccess({ deviceMode: false, tradesEnabled: false });
  assert.deepEqual(access, { members: true, canTrade: false, needsOptIn: true });
  assert.deepEqual(transferPages(access), ['new', 'offers', 'history']);
  assert.equal(offersTradeShortcuts({ deviceMode: false }), true, 'the shortcut leads to the opt-in');
});

test('on a server with trading on, everything is offered', () => {
  const access = tradeAccess({ tradesEnabled: true });
  assert.deepEqual(access, { members: true, canTrade: true, needsOptIn: false });
  assert.deepEqual(transferPages(access), ['new', 'offers', 'history']);
  for (const type of ['internal', 'historical', 'external']) assert.equal(canOpenTradeHistory(type), true);
});
