import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPrice, displayPrice, roundMoney, rateFor, totalPrices } from './convertPrice.js';

// The ECB reference rates of 2026-11-06, as GET /api/fx returns them (the same
// numbers as backend/test/fixtures/ecb/eurofxref-daily.xml).
const FX = {
  base: 'EUR',
  date: '2026-11-06',
  rates: { EUR: 1, USD: 1.1165, JPY: 176.77, GBP: 0.83415, CAD: 1.5705, AUD: 1.625 },
};

test('convertPrice: EUR base, inverse and cross rates', () => {
  assert.equal(rateFor(FX, 'EUR'), 1);
  assert.equal(roundMoney(convertPrice(10, 'EUR', 'USD', FX), 'USD'), 11.17);
  assert.equal(roundMoney(convertPrice(11.165, 'USD', 'EUR', FX), 'EUR'), 10);
  // USD -> JPY goes through the euro: 4.50 / 1.1165 * 176.77.
  assert.equal(roundMoney(convertPrice(4.5, 'USD', 'JPY', FX), 'JPY'), 712);
  assert.equal(roundMoney(convertPrice(4.5, 'USD', 'GBP', FX), 'GBP'), 3.36);
  assert.equal(roundMoney(convertPrice(4.5, 'EUR', 'CAD', FX), 'CAD'), 7.07);
  // A base that is not EUR still works: rates are relative to fx.base.
  assert.equal(convertPrice(2, 'USD', 'EUR', { base: 'USD', rates: { EUR: 0.5 } }), 1);
});

test('roundMoney: per-currency minor units and half-up cents', () => {
  assert.equal(roundMoney(1.005, 'USD'), 1.01);
  assert.equal(roundMoney(2.675, 'EUR'), 2.68);
  assert.equal(roundMoney(712.46, 'JPY'), 712);
  assert.equal(roundMoney(712.5, 'JPY'), 713);
});

test('displayPrice: converts and says so, with the rate date', () => {
  const d = displayPrice(4.5, 'USD', 'JPY', FX);
  assert.equal(d.converted, true);
  assert.equal(d.currency, 'JPY');
  assert.equal(d.amount, 712);
  assert.equal(d.date, '2026-11-06');
  assert.equal(d.text, '¥712.00');
  // Already in the display currency: untouched, not "converted".
  const same = displayPrice(4.5, 'EUR', 'EUR', FX);
  assert.deepEqual([same.converted, same.text], [false, '€4.50']);
});

test('displayPrice: no rates keeps the quoted currency instead of mislabeling', () => {
  // The bug this replaces: JPY selected, $4.50 shown as ¥4.50.
  for (const fx of [null, { base: 'EUR', date: null, rates: null }, { base: 'EUR', date: 'x', rates: { GBP: 0.8 } }]) {
    const d = displayPrice(4.5, 'USD', 'JPY', fx);
    assert.equal(d.converted, false);
    assert.equal(d.currency, 'USD');
    assert.equal(d.text, '$4.50');
  }
  // A row with no currency is USD.
  assert.equal(displayPrice(3, null, 'EUR', null).text, '$3.00');
  assert.equal(displayPrice(3, undefined, 'EUR', FX).text, '€2.69');
});

test('totalPrices: mixed currencies are converted, never summed as they stand', () => {
  const rows = [
    { amount: 20, currency: 'USD' },
    { amount: 10, currency: 'EUR' },
    { amount: 0, currency: 'GBP' },     // nothing to add, and no subtotal for it
    { amount: 5 },                      // no currency: USD
  ];
  const usd = totalPrices(rows, 'USD', FX);
  assert.equal(usd.total, 36.17);       // 25 + 10 * 1.1165
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.converted, true);
  assert.equal(usd.date, '2026-11-06');
  assert.deepEqual(usd.subtotals, [{ currency: 'EUR', amount: 10 }, { currency: 'USD', amount: 25 }]);

  // Without rates: subtotals only, no grand total.
  const none = totalPrices(rows, 'USD', null);
  assert.equal(none.total, null);
  assert.equal(none.converted, false);
  assert.deepEqual(none.subtotals.map(s => s.currency), ['EUR', 'USD']);

  // Without rates but one currency: that total is real, in its own currency.
  const eurOnly = totalPrices([{ amount: 3, currency: 'EUR' }, { amount: 4, currency: 'EUR' }], 'JPY', null);
  assert.deepEqual([eurOnly.total, eurOnly.currency, eurOnly.converted], [7, 'EUR', false]);

  // All already in the display currency: a plain sum, not labelled converted.
  const plain = totalPrices([{ amount: 1.1, currency: 'USD' }, { amount: 2.2, currency: 'USD' }], 'USD', FX);
  assert.deepEqual([plain.total, plain.converted, plain.date], [3.3, false, null]);

  // Empty: zero in the display currency.
  assert.deepEqual([totalPrices([], 'GBP', null).total, totalPrices([], 'GBP', null).currency], [0, 'GBP']);
});
