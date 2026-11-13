import assert from 'node:assert/strict';
import test from 'node:test';
import { counterSelections } from './transferSelection.js';

test('prefills counter selections in opposite directions and limits to owned inventory', () => {
  const transfer = {
    proposer_id: 1,
    recipient_id: 2,
    items: [
      { from_user_id: 2, item_type: 'card', source_collection_id: 101, quantity: 1 },
      { from_user_id: 2, item_type: 'card', source_collection_id: 101, quantity: 1 },
      { from_user_id: 2, item_type: 'sealed', source_sealed_unit_id: 202, quantity: 1 },
      { from_user_id: 1, item_type: 'card', source_collection_id: 303, quantity: 1 },
      { from_user_id: 1, item_type: 'card', source_collection_id: 303, quantity: 1 },
      { from_user_id: 1, item_type: 'sealed', source_sealed_unit_id: 404, quantity: 1 }
    ]
  };
  const ownItems = new Map([
    ['card:101', { quantity: 1 }]
  ]);

  const selections = counterSelections(transfer, ownItems);

  assert.deepStrictEqual(selections.offered, {
    'card:101': { type: 'card', id: 101, quantity: 1 }
  });
  assert.deepStrictEqual(selections.requested, {
    'card:303': { type: 'card', id: 303, quantity: 2 },
    'sealed:404': { type: 'sealed', id: 404, quantity: 1 }
  });
});
