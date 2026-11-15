import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calendarDateText, composerReady, costText, counterOfferedItems, gradeText, isOneSidedTrade, itemKey, matchesItemFilters, otherParty,
  ownOfferItems, parseRecipient, provenanceText, receivedFromText, requestOptions, sameUser, timestampText, transferRole, withLocationNames,
} from './transferView.js';
import { translate } from './translate.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const t = (key, vars) => translate(en, en, 'en', key, vars);

const ME = 7;

test('a null id is nobody: never me, never another deleted member', () => {
  assert.equal(sameUser(7, '7'), true);
  assert.equal(sameUser(null, null), false);
  assert.equal(sameUser(undefined, 7), false);
  assert.equal(sameUser(7, null), false);
});

test('the other party is found from my side, so a deleted member still has a name', () => {
  // The proposer's account was deleted: id null, name from the snapshot.
  const fromDeleted = { proposer_id: null, proposer_username: 'gone', recipient_id: ME, recipient_username: 'me' };
  assert.deepEqual(otherParty(fromDeleted, ME), { id: null, name: 'gone' });
  assert.equal(transferRole(fromDeleted, ME), 'incoming');
  const toDeleted = { proposer_id: ME, proposer_username: 'me', recipient_id: null, recipient_username: 'gone' };
  assert.deepEqual(otherParty(toDeleted, ME), { id: null, name: 'gone' });
  assert.equal(transferRole(toDeleted, ME), 'outgoing');
  const trade = { creator_id: 3, creator_username: 'ash', recipient_id: ME, recipient_username: 'me' };
  assert.deepEqual(otherParty(trade, ME, 'creator', 'recipient'), { id: 3, name: 'ash' });
  // The offer's own snapshot of the names, when the live username is gone.
  const snapshotOnly = { proposer_id: null, proposer_username: null, proposer_name: 'dawn', recipient_id: ME, recipient_name: 'me' };
  assert.deepEqual(otherParty(snapshotOnly, ME), { id: null, name: 'dawn' });
  assert.equal(otherParty({ proposer_id: 3, proposer_username: 'brock', proposer_name: 'old-brock', recipient_id: ME }, ME).name, 'brock', 'the live name first');
  assert.equal(transferRole({ proposer_id: 1, recipient_id: 2 }, ME), null);
  assert.equal(transferRole({ proposer_id: 1, recipient_id: 2 }, null), null, 'no id for me yet: no side');
});

test('a slab shows its grade in place of the condition', () => {
  assert.equal(gradeText({ grader: 'PSA', grade: 10 }), 'PSA 10');
  assert.equal(gradeText({ grader: 'BGS', grade: 9.5 }), 'BGS 9.5');
  assert.equal(gradeText({ grader: 'CGC', grade: null }), 'CGC');
  assert.equal(gradeText({ grader: 'Raw', grade: null }), null);
  assert.equal(gradeText({ condition: 'Near Mint' }), null);
});

test('a trade asking nothing back is one-sided from either side', () => {
  const offer = { transfer_type: 'trade', proposer_id: 3, recipient_id: ME, items: [{ from_user_id: 3 }] };
  assert.equal(isOneSidedTrade(offer, ME), true);
  assert.equal(isOneSidedTrade({ ...offer, items: [{ from_user_id: 3 }, { from_user_id: ME }] }, ME), false);
  assert.equal(isOneSidedTrade({ ...offer, proposer_id: ME, recipient_id: 3, items: [{ from_user_id: ME }] }, ME), true);
  assert.equal(isOneSidedTrade({ ...offer, transfer_type: 'gift' }, ME), false, 'a gift asks nothing back by design');
});

test('own copies become picker items, with the location names the slim rows lack', () => {
  const names = new Map([[4, 'Blue binder']]);
  const rows = withLocationNames([{ entry_id: 1, location_id: 4 }, { entry_id: 2, location_id: null }, { entry_id: 3, location_id: 9, location_name: 'Kept' }], names);
  assert.deepEqual(rows.map(r => r.location_name), ['Blue binder', undefined, 'Kept']);
  const items = ownOfferItems(rows, [{ id: 50, product_name: 'Booster' }]);
  assert.deepEqual(items.map(itemKey), ['card:1', 'card:2', 'card:3', 'sealed:50']);
});

test('a counter can ask back for what the other member offered, merged with their marked items', () => {
  const transfer = {
    proposer_id: 3,
    recipient_id: ME,
    items: [
      { from_user_id: 3, item_type: 'card', source_collection_id: 11, quantity: 1, item_snapshot: { name: 'Pikachu' } },
      { from_user_id: 3, item_type: 'card', source_collection_id: 11, quantity: 1, item_snapshot: { name: 'Pikachu' } },
      { from_user_id: 3, item_type: 'sealed', source_sealed_unit_id: 21, item_snapshot: { product_name: 'Booster' } },
      { from_user_id: ME, item_type: 'card', source_collection_id: 99, quantity: 1, item_snapshot: { name: 'Mine' } },
    ],
  };
  const offered = counterOfferedItems(transfer, ME);
  assert.deepEqual(offered.map(itemKey), ['card:11', 'sealed:21']);
  assert.equal(offered[0].quantity, 2);
  assert.equal(offered[1].product_name, 'Booster');
  const options = requestOptions({ cards: [{ entry_id: 11, name: 'Pikachu' }, { entry_id: 12 }], sealed: [{ unit_id: 30 }] }, offered);
  assert.deepEqual(options.map(itemKey), ['card:11', 'card:12', 'sealed:30', 'sealed:21'], 'each item once');
  assert.deepEqual(requestOptions(undefined), []);
});

test('picker filters: type, game, location and the text query', () => {
  const card = { type: 'card', id: 1, name: 'Charizard', set_name: 'Base', number: '4', game: 'pokemon', location_id: null };
  const sealed = { type: 'sealed', id: 2, product_name: 'Booster Box', game: 'mtg' };
  const all = { query: '', game: '', type: 'all', location: '' };
  assert.equal(matchesItemFilters(card, all), true);
  assert.equal(matchesItemFilters(card, { ...all, type: 'sealed' }), false);
  assert.equal(matchesItemFilters(sealed, { ...all, game: 'pokemon' }), false);
  assert.equal(matchesItemFilters(card, { ...all, location: 'unsorted' }), true);
  assert.equal(matchesItemFilters(sealed, { ...all, location: 'unsorted' }), false, 'sealed products have no location');
  assert.equal(matchesItemFilters(card, { ...all, query: ' base 4 ' }), true);
  assert.equal(matchesItemFilters(card, { ...all, query: 'charizard 4' }), false, 'one phrase, not separate words');
  assert.equal(matchesItemFilters(card, { ...all, query: 'CHARI' }), true);
});

test('the composer is ready when both sides it needs are there', () => {
  assert.deepEqual(parseRecipient('user:12'), { kind: 'user', id: '12' });
  assert.deepEqual(parseRecipient('contact:3'), { kind: 'contact', id: '3' });
  assert.deepEqual(parseRecipient(''), { kind: null, id: null });
  assert.equal(composerReady({ recipient: '', type: 'gift', offered: 1 }), false);
  assert.equal(composerReady({ recipient: 'user:2', type: 'gift', offered: 1 }), true);
  assert.equal(composerReady({ recipient: 'user:2', type: 'trade', offered: 1 }), true, 'a first trade offer may ask for nothing');
  assert.equal(composerReady({ recipient: 'user:2', type: 'trade', offered: 1, countering: true }), false, 'a counter must ask for something');
  assert.equal(composerReady({ recipient: 'user:2', type: 'trade', offered: 1, requested: 1, countering: true }), true);
  assert.equal(composerReady({ recipient: 'contact:4', type: 'trade', offered: 1 }), false);
  assert.equal(composerReady({ recipient: 'contact:4', type: 'trade', offered: 1, received: 1 }), true);
  assert.equal(composerReady({ recipient: 'contact:4', type: 'gift', giftDirection: 'given', offered: 1 }), true);
  assert.equal(composerReady({ recipient: 'contact:4', type: 'gift', giftDirection: 'received', offered: 1 }), false);
  assert.equal(composerReady({ recipient: 'contact:4', type: 'gift', giftDirection: 'received', received: 2 }), true);
});

test('costs and dates read in the interface language, not the browser\'s', () => {
  assert.equal(costText(1234.5, 'en'), '$1,234.50');
  assert.equal(costText(1234.5, 'de'), '$1.234,50');
  assert.equal(costText(0, 'en'), '$0.00', 'a gift costs nothing, which is known');
  assert.equal(costText(null, 'en'), null);
  assert.equal(calendarDateText('2026-03-01', 'en'), 'Mar 1, 2026');
  assert.equal(calendarDateText('2026-03-01', 'de'), '01.03.2026');
  assert.equal(calendarDateText('not a date', 'en'), 'not a date');
  assert.match(timestampText('2026-11-07 12:00:00', 'en'), /Nov 7, 2026/);
  assert.equal(timestampText(null, 'en'), '');
});

test('a sealed product or card from another member says how it came, from the transfer fields', () => {
  assert.equal(receivedFromText(t, { acquired_transfer_type: 'gift', acquired_transfer_partner: 'Misty' }), 'Received as a gift from Misty');
  assert.equal(receivedFromText(t, { acquired_transfer_type: 'trade', acquired_transfer_partner: 'Brock' }), 'Received in a trade with Brock');
  assert.equal(receivedFromText(t, { acquired_transfer_type: 'trade', acquired_transfer_partner: null }), `Received in a trade with ${en['transfer.unknownUser']}`);
  assert.equal(receivedFromText(t, { acquired_transfer_type: null, store: 'Transfer from X' }), null, 'store text is not read');
  assert.equal(receivedFromText(t, { acquired_external_transaction_type: 'gift', acquired_external_contact: 'Gary' }, { outside: true }), 'Received as a gift from Gary, outside Bindarr');
  // A sealed row carries both sets of fields, the unused one null.
  const sealedRow = (extra) => ({ acquired_transfer_type: null, acquired_transfer_partner: null, acquired_external_transaction_type: null, acquired_external_contact: null, ...extra });
  assert.equal(provenanceText(t, sealedRow({ acquired_transfer_type: 'gift', acquired_transfer_partner: 'Misty' })), 'Received as a gift from Misty');
  assert.equal(provenanceText(t, sealedRow({ acquired_external_transaction_type: 'trade', acquired_external_contact: 'Gary' })), 'Received in a trade with Gary, outside Bindarr');
  assert.equal(provenanceText(t, sealedRow({})), null);
});
