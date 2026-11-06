'use strict';

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

// Allocate from the remaining lot cost, not a rounded per-unit price.
// The final opening receives the remainder, preserving the original cost exactly.
function allocateOpening({ remainingQuantity, remainingCostCents, quantity }) {
  integer(remainingQuantity, 'remainingQuantity', 1);
  integer(remainingCostCents, 'remainingCostCents');
  integer(quantity, 'quantity', 1);
  if (quantity > remainingQuantity) throw new RangeError('Insufficient sealed quantity');
  const costCents = Number(
    BigInt(remainingCostCents) * BigInt(quantity) / BigInt(remainingQuantity)
  );
  return {
    quantity,
    costCents,
    remainingQuantity: remainingQuantity - quantity,
    remainingCostCents: remainingCostCents - costCents,
  };
}

// Values must already be in the session currency. No implicit FX conversion.
// null means unpriced; zero is an explicitly known zero value.
function summarizeOpening({ costCents, currency, pulls }) {
  integer(costCents, 'costCents');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError('currency must be an uppercase three-letter code');
  }
  if (!Array.isArray(pulls)) throw new TypeError('pulls must be an array');
  let knownValueCents = 0;
  let recordedQuantity = 0;
  let unpricedQuantity = 0;
  for (const pull of pulls) {
    if (!pull || typeof pull !== 'object') throw new TypeError('Invalid pull');
    integer(pull.quantity, 'pull.quantity', 1);
    recordedQuantity = integer(recordedQuantity + pull.quantity, 'recordedQuantity');
    if (pull.unitValueCents == null) {
      unpricedQuantity = integer(unpricedQuantity + pull.quantity, 'unpricedQuantity');
      continue;
    }
    integer(pull.unitValueCents, 'pull.unitValueCents');
    if (pull.currency !== currency) throw new RangeError('Pull currency differs from session currency');
    const lineValue = integer(pull.unitValueCents * pull.quantity, 'lineValueCents');
    knownValueCents = integer(knownValueCents + lineValue, 'knownValueCents');
  }
  return {
    currency,
    costCents,
    recordedQuantity,
    unpricedQuantity,
    knownValueCents,
    valuationComplete: unpricedQuantity === 0,
    valueDifferenceCents: knownValueCents - costCents,
    costRecoveryPercent: costCents === 0 ? null : knownValueCents / costCents * 100,
  };
}

module.exports = { allocateOpening, summarizeOpening };
