// Split a total price paid across cards into per-card purchase prices.
// prices: array of each card's market value (0 if unknown).
// method 'weighted' allocates proportional to market value; 'equal' splits
// evenly. Weighted falls back to equal when every price is 0.
//
// Largest-remainder apportionment in integer cents: every card gets its exact
// share rounded down to the cent, and the cents still left over go one each to the
// cards whose shares lost the most to that rounding (the later card on a tie). The
// parts add up to `total` exactly, and none is ever below zero. Rounding every
// share UP and letting the last card absorb the overshoot did neither: $5 over 200
// cards left the last one at -$0.97.
function splitPrice(prices, total, method = 'weighted') {
  const n = prices.length;
  if (n === 0) return [];
  const cents = Math.round(Number(total) * 100);
  const sign = cents < 0 ? -1 : 1;
  const pot = Math.abs(cents);
  const values = prices.map(p => (Number(p) > 0 ? Number(p) : 0));
  const sum = values.reduce((s, p) => s + p, 0);
  const weights = method === 'weighted' && sum > 0 ? values : values.map(() => 1);
  const weightSum = method === 'weighted' && sum > 0 ? sum : n;

  const exact = weights.map(w => pot * w / weightSum);
  const shares = exact.map(e => Math.floor(e));
  let left = pot - shares.reduce((s, c) => s + c, 0);
  const byRemainder = exact
    .map((e, i) => ({ i, rest: e - shares[i] }))
    .sort((a, b) => b.rest - a.rest || b.i - a.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) shares[byRemainder[k].i]++;
  return shares.map(c => (sign * c) / 100);
}

module.exports = { splitPrice };
