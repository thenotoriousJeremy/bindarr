// Split a total price paid across cards into per-card purchase prices.
// prices: array of each card's market value (0 if unknown).
// method 'weighted' allocates proportional to market value; 'equal' splits
// evenly. Weighted falls back to equal when every price is 0. All arithmetic is
// in integer cents; any rounding remainder lands on the last card so the parts
// sum back to exactly `total`.
function splitPrice(prices, total, method = 'weighted') {
  const n = prices.length;
  if (n === 0) return [];
  const cents = Math.round(total * 100);
  const sum = prices.reduce((s, p) => s + (p || 0), 0);
  const weighted = method === 'weighted' && sum > 0;
  let allocated = 0;
  return prices.map((p, i) => {
    if (i === n - 1) return (cents - allocated) / 100;
    const share = weighted ? Math.round(cents * (p || 0) / sum) : Math.round(cents / n);
    allocated += share;
    return share / 100;
  });
}

module.exports = { splitPrice };

if (require.main === module) {
  const assert = require('assert');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const sums = (arr, t) => near(arr.reduce((s, x) => s + x, 0), t);

  // Equal split, clean division.
  assert.deepStrictEqual(splitPrice([1, 1, 1], 30, 'equal'), [10, 10, 10]);
  // Equal split with a remainder — drift lands on the last card, parts sum to total.
  const eq = splitPrice([0, 0, 0], 10, 'equal');
  assert.ok(sums(eq, 10), 'equal parts sum to total');
  assert.deepStrictEqual(eq, [3.33, 3.33, 3.34]);
  // Weighted: a $50 pack, one $45 chase card, rest bulk.
  const w = splitPrice([45, 4, 1], 50, 'weighted');
  assert.ok(sums(w, 50), 'weighted parts sum to total');
  assert.ok(w[0] > w[1] && w[1] > w[2], 'weighted follows value order');
  // Weighted with no market data falls back to equal.
  assert.ok(sums(splitPrice([0, 0], 9, 'weighted'), 9), 'weighted fallback sums to total');
  // Single card gets the whole total.
  assert.deepStrictEqual(splitPrice([5], 12.5, 'weighted'), [12.5]);

  console.log('splitPrice self-check passed');
}
