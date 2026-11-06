'use strict';
const assert = require('node:assert/strict');
const { allocateOpening, summarizeOpening } = require('../src/utils/openingAccounting');

let lot = { remainingQuantity: 3, remainingCostCents: 1000 };
let allocated = 0;
for (const expected of [333, 333, 334]) {
  const result = allocateOpening({ ...lot, quantity: 1 });
  assert.equal(result.costCents, expected);
  allocated += result.costCents;
  lot = result;
}
assert.equal(allocated, 1000);
assert.equal(lot.remainingQuantity, 0);
assert.equal(lot.remainingCostCents, 0);
assert.throws(() => allocateOpening({ remainingQuantity: 1, remainingCostCents: 500, quantity: 2 }), RangeError);
assert.throws(() => allocateOpening({ remainingQuantity: 2, remainingCostCents: 500, quantity: 0 }), TypeError);
assert.throws(() => allocateOpening({ remainingQuantity: 2, remainingCostCents: 1.5, quantity: 1 }), TypeError);
assert.equal(allocateOpening({ remainingQuantity: 2, remainingCostCents: 0, quantity: 1 }).costCents, 0);

const result = summarizeOpening({
  costCents: 5500,
  currency: 'USD',
  pulls: [
    { quantity: 2, unitValueCents: 1500, currency: 'USD' },
    { quantity: 1, unitValueCents: null },
    { quantity: 3, unitValueCents: 0, currency: 'USD' },
  ],
});
assert.equal(result.knownValueCents, 3000);
assert.equal(result.recordedQuantity, 6);
assert.equal(result.unpricedQuantity, 1);
assert.equal(result.valuationComplete, false);
assert.equal(result.valueDifferenceCents, -2500);
assert.ok(Math.abs(result.costRecoveryPercent - 54.54545454545454) < 1e-10);
assert.equal(summarizeOpening({ costCents: 0, currency: 'USD', pulls: [] }).costRecoveryPercent, null);
assert.throws(() => summarizeOpening({ costCents: 100, currency: 'USD', pulls: [{ quantity: 1, unitValueCents: 100, currency: 'EUR' }] }), RangeError);
assert.throws(() => summarizeOpening({ costCents: 100, currency: 'USD', pulls: [{ quantity: 2, unitValueCents: Number.MAX_SAFE_INTEGER, currency: 'USD' }] }), TypeError);
console.log('openingAccounting tests passed');
