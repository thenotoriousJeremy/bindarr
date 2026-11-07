// Display-currency conversion (review item 9).
//
// Prices are stored in the currency their marketplace quoted (a row's
// price_currency), and priceText keeps showing exactly that. This converts them
// into the owner's display currency (Settings -> Currency) with the ECB daily
// reference rates from GET /api/fx: { base: 'EUR', date, rates }, rates[X] being
// how many X one euro buys. Cross rates go through the euro.
//
// When a rate is missing (never fetched, or a currency the ECB does not quote),
// the price stays in its own currency, correctly labelled. A converted figure
// with a guessed rate, or the target symbol on an unconverted number, is the bug
// this replaces: picking JPY used to turn $4.50 into "¥4.50".
//
// backend/src/utils/fx.js carries the same math for the dashboard totals.
import { priceText } from './formatPrice.js';

// ISO 4217 minor units, for the ECB currencies that have none.
export const MINOR_UNITS = { JPY: 0, KRW: 0, ISK: 0 };

export const roundMoney = (amount, currency) => {
  const digits = MINOR_UNITS[currency] ?? 2;
  const f = 10 ** digits;
  return Math.round((amount + Number.EPSILON) * f) / f;
};

export const rateFor = (fx, code) => {
  if (!fx || !fx.rates || !code) return null;
  if (code === (fx.base || 'EUR')) return 1;
  const r = fx.rates[code];
  return r > 0 ? r : null;
};

// Unrounded, or null when it cannot be converted. A row with no currency is USD,
// as everywhere else in the app.
export const convertPrice = (amount, from, to, fx) => {
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return null;
  const src = from || 'USD';
  if (!to || src === to) return n;
  const rFrom = rateFor(fx, src);
  const rTo = rateFor(fx, to);
  if (!rFrom || !rTo) return null;
  return (n / rFrom) * rTo;
};

// What to show for one price: converted into `to` when possible, otherwise as
// quoted. `converted` is true only when the number actually changed currency,
// which is when the UI should say so and give the rate date.
export const displayPrice = (amount, from, to, fx) => {
  const src = from || 'USD';
  const value = convertPrice(amount, src, to, fx);
  if (value == null || src === (to || src)) {
    return { amount: parseFloat(amount) || 0, currency: src, converted: false, date: null, text: priceText(amount, src) };
  }
  const rounded = roundMoney(value, to);
  return { amount: rounded, currency: to, converted: true, date: fx.date || null, text: priceText(rounded, to) };
};

// A total over prices in several currencies: per-currency subtotals as quoted,
// plus a grand total in `to` when every currency present converts. With a
// currency that does not, `total` is null rather than a sum of unlike units.
export const totalPrices = (entries, to, fx) => {
  const byCurrency = {};
  for (const { amount, currency } of entries) {
    const n = parseFloat(amount);
    if (!(n > 0)) continue;
    const c = currency || 'USD';
    byCurrency[c] = (byCurrency[c] || 0) + n;
  }
  const codes = Object.keys(byCurrency).sort();
  let total = 0;
  let complete = true;
  for (const c of codes) {
    const v = convertPrice(byCurrency[c], c, to, fx);
    if (v == null) { complete = false; break; }
    total += v;
  }
  const subtotals = codes.map(c => ({ currency: c, amount: roundMoney(byCurrency[c], c) }));
  if (!complete) {
    // One currency and no rate: that currency's total is still a real total.
    if (codes.length === 1) return { total: subtotals[0].amount, currency: codes[0], converted: false, date: null, subtotals };
    return { total: null, currency: null, converted: false, date: null, subtotals };
  }
  const converted = codes.some(c => c !== to);
  return { total: roundMoney(total, to), currency: to, converted, date: converted ? fx.date || null : null, subtotals };
};
