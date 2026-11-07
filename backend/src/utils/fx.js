// Currency conversion against a set of ECB reference rates.
//
// `fx` is what fxRates.latestRates() returns: { base: 'EUR', date, rates }, where
// rates[X] is how many X one euro buys. Every conversion goes through the euro,
// so USD -> JPY is a cross rate (amount / USD * JPY), the same way the ECB itself
// publishes them. Pure functions: no database, no network.
//
// frontend/src/utils/convertPrice.js carries the same math for display. The two
// are kept separate because one is CommonJS and the other ESM; their tests pin
// the same numbers.

// ISO 4217 minor units, for the ECB currencies that have none. Everything else
// has two.
const MINOR_UNITS = { JPY: 0, KRW: 0, ISK: 0 };

function roundMoney(amount, currency) {
  const digits = MINOR_UNITS[currency] ?? 2;
  const f = 10 ** digits;
  return Math.round((amount + Number.EPSILON) * f) / f;
}

function rateFor(fx, code) {
  if (!fx || !fx.rates || !code) return null;
  if (code === (fx.base || 'EUR')) return 1;
  const r = fx.rates[code];
  return r > 0 ? r : null;
}

// Null when either side has no rate — never a guess. Same-currency is the
// identity whether or not any rates are known.
function convert(amount, from, to, fx) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const src = from || 'USD';
  if (!to || src === to) return n;
  const rFrom = rateFor(fx, src);
  const rTo = rateFor(fx, to);
  if (!rFrom || !rTo) return null;
  return (n / rFrom) * rTo;
}

// Which single currency a set of amounts can be reported in. The requested
// target when every currency present converts to it; otherwise, the one
// currency they already share; otherwise null — a mixed set with no way to
// convert has no honest single total.
function pickUnit(currencies, target, fx) {
  const list = [...currencies];
  if (target && list.every(c => convert(1, c, target, fx) != null)) return target;
  if (list.length === 1) return list[0];
  if (list.length === 0) return target || 'USD';
  return null;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
function parseCurrencyParam(value) {
  const code = String(value || '').trim().toUpperCase();
  return CURRENCY_RE.test(code) ? code : null;
}

module.exports = { MINOR_UNITS, roundMoney, rateFor, convert, pickUnit, parseCurrencyParam };
