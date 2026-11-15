// Splitting a total paid across cards (utils/splitPrice.js): the bulk "split
// purchase price" action and sealed cost allocation both write these shares as
// per-card purchase prices.
//
// It used to round every share up to the cent and let the last card absorb the
// overshoot, so the last card could come out negative ($5 over 200 cards gave it
// -$0.97). The shares are largest-remainder apportionment in cents now: they add
// up to the total exactly and none is below zero. Its self-check sat behind
// require.main, where no test runner ever ran it; it lives here now.
const assert = require('assert');
const { splitPrice } = require('../src/utils/splitPrice');

const cents = (shares) => shares.reduce((s, x) => s + Math.round(x * 100), 0);

// --- the old self-check ----------------------------------------------------------
assert.deepStrictEqual(splitPrice([1, 1, 1], 30, 'equal'), [10, 10, 10], 'equal split, clean division');
const eq = splitPrice([0, 0, 0], 10, 'equal');
assert.strictEqual(cents(eq), 1000, 'equal parts sum to the total');
assert.deepStrictEqual(eq, [3.33, 3.33, 3.34], 'the odd cent goes to the last card, as before');
const w = splitPrice([45, 4, 1], 50, 'weighted');
assert.strictEqual(cents(w), 5000, 'weighted parts sum to the total');
assert.ok(w[0] > w[1] && w[1] > w[2], 'weighted follows value order');
assert.strictEqual(cents(splitPrice([0, 0], 9, 'weighted')), 900, 'weighted with no market data falls back to equal');
assert.deepStrictEqual(splitPrice([5], 12.5, 'weighted'), [12.5], 'a single card gets the whole total');
assert.deepStrictEqual(splitPrice([], 10), [], 'no cards, no shares');
console.log('PASS: the original self-check');

// --- the reported cases: no negative last card -------------------------------------
for (const [count, total] of [[200, 5], [360, 100], [7, 0.05], [3, 0.01], [1000, 999.99]]) {
  for (const method of ['equal', 'weighted']) {
    const shares = splitPrice(Array.from({ length: count }, (_, i) => (method === 'weighted' ? (i % 5) + 0.37 : 0)), total, method);
    assert.strictEqual(shares.length, count);
    assert.strictEqual(cents(shares), Math.round(total * 100), `${method} $${total} over ${count}: parts sum to the total`);
    assert.ok(shares.every(s => s >= 0), `${method} $${total} over ${count}: no share is negative (min ${Math.min(...shares)})`);
    assert.ok(shares.every(s => Math.abs(s * 100 - Math.round(s * 100)) < 1e-6), 'every share is whole cents');
  }
}
const fivePerTwoHundred = splitPrice(Array(200).fill(0), 5, 'equal');
assert.deepStrictEqual([...new Set(fivePerTwoHundred)].sort(), [0.02, 0.03], '$5 over 200 cards is 2 or 3 cents each');
console.log('PASS: $5 over 200 and $100 over 360 split without a negative card');

// --- properties over random splits ------------------------------------------------
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let run = 0; run < 2000; run++) {
  const n = 1 + Math.floor(rnd() * 60);
  const prices = Array.from({ length: n }, () => (rnd() < 0.3 ? 0 : Math.round(rnd() * 50000) / 100));
  const total = Math.round(rnd() * 100000) / 100;
  const method = rnd() < 0.5 ? 'equal' : 'weighted';
  const shares = splitPrice(prices, total, method);
  assert.strictEqual(cents(shares), Math.round(total * 100), `run ${run}: sums to the total`);
  assert.ok(shares.every(s => s >= 0), `run ${run}: none negative`);
  if (method === 'weighted' && prices.some(p => p > 0)) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (prices[i] > prices[j]) assert.ok(shares[i] >= shares[j], `run ${run}: a dearer card never gets less`);
      }
    }
  } else {
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 0.0100001, `run ${run}: an equal split differs by at most a cent`);
  }
}
console.log('PASS: 2,000 random splits sum exactly, never go negative, and keep value order');
