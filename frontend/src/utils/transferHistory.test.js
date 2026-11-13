import assert from 'node:assert/strict';
import test from 'node:test';
import { groupTransferHistory } from './transferHistory.js';

test('groups negotiation versions by their root and orders newest first', () => {
  const transfers = [
    { id: 3, response_to_transfer_id: 2, status: 'accepted', created_at: '2026-03-03 10:00:00' },
    { id: 2, response_to_transfer_id: 1, status: 'countered', created_at: '2026-03-02 10:00:00' },
    { id: 4, response_to_transfer_id: 3, status: 'pending', created_at: '2026-03-04 10:00:00' },
    { id: 1, response_to_transfer_id: null, status: 'countered', created_at: '2026-03-01 10:00:00' },
    { id: 5, response_to_transfer_id: null, status: 'rejected', created_at: '2026-03-05 10:00:00' }
  ];

  const groups = groupTransferHistory(transfers);

  assert.deepStrictEqual(groups.map(group => group.root.id), [5, 1]);
  assert.strictEqual(groups.length, 2);
  assert.deepStrictEqual(groups[1].transfers.map(transfer => transfer.id), [4, 3, 2, 1]);
});

test('keeps a countered one-sided opening proposal grouped with its pending counter', () => {
  const transfers = [
    { id: 12, response_to_transfer_id: 11, status: 'pending', created_at: '2026-03-02 10:00:00' },
    { id: 11, response_to_transfer_id: null, status: 'countered', created_at: '2026-03-01 10:00:00' }
  ];

  const groups = groupTransferHistory(transfers);

  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].transfers.map(transfer => transfer.id), [12, 11]);
});

test('omits negotiations that have no history yet', () => {
  const groups = groupTransferHistory([
    { id: 21, response_to_transfer_id: null, status: 'pending', created_at: '2026-03-01 10:00:00' }
  ]);
  assert.deepStrictEqual(groups, []);
});
