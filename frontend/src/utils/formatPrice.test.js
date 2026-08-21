import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  SYMBOLS,
  getCurrency,
  setCurrency,
  currencySymbol,
  activeCurrencySymbol,
  formatPrice,
  priceText,
} from './formatPrice.js';

// Polyfill minimal localStorage & window for node test environment
if (typeof globalThis.localStorage === 'undefined') {
  let store = {};
  globalThis.localStorage = {
    getItem: (key) => store[key] || null,
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
}

test('formatPrice: formats numbers and handles edge cases', () => {
  assert.equal(formatPrice(12.5), '12.50');
  assert.equal(formatPrice(0), '0.00');
  assert.equal(formatPrice('4.5'), '4.50');
  assert.equal(formatPrice('12.50 USD'), '12.50');
  assert.equal(formatPrice(null), '0.00');
  assert.equal(formatPrice(undefined), '0.00');
  assert.equal(formatPrice(''), '0.00');
  assert.equal(formatPrice('invalid'), '0.00');
});

test('currency configuration and defaults', () => {
  localStorage.clear();
  assert.equal(DEFAULT_CURRENCY, 'USD');
  assert.equal(getCurrency(), 'USD');
  assert.equal(currencySymbol(), '$');
  assert.equal(activeCurrencySymbol(), '$');
  assert.equal(priceText(5), '$5.00');
  // Even if an old row had EUR currency, priceText uses the active currency (USD)
  assert.equal(priceText(5, 'EUR'), '$5.00');
});

test('currency selection and priceText formatting', () => {
  localStorage.clear();

  // Test EUR
  setCurrency('EUR');
  assert.equal(getCurrency(), 'EUR');
  assert.equal(currencySymbol(), '€');
  assert.equal(activeCurrencySymbol(), '€');
  assert.equal(priceText(19.99), '€19.99');
  assert.equal(priceText(19.99, 'USD'), '€19.99'); // Enforces single active currency

  // Test GBP
  setCurrency('GBP');
  assert.equal(getCurrency(), 'GBP');
  assert.equal(currencySymbol(), '£');
  assert.equal(priceText(7.5), '£7.50');

  // Test JPY
  setCurrency('JPY');
  assert.equal(getCurrency(), 'JPY');
  assert.equal(currencySymbol(), '¥');
  assert.equal(priceText(500), '¥500.00');

  // Test CAD
  setCurrency('CAD');
  assert.equal(getCurrency(), 'CAD');
  assert.equal(currencySymbol(), 'C$');
  assert.equal(priceText(10), 'C$10.00');

  // Test AUD
  setCurrency('AUD');
  assert.equal(getCurrency(), 'AUD');
  assert.equal(currencySymbol(), 'A$');
  assert.equal(priceText(10), 'A$10.00');

  // Test invalid currency code fallback
  setCurrency('INVALID');
  assert.equal(getCurrency(), 'USD');
  assert.equal(currencySymbol(), '$');
  assert.equal(priceText(10), '$10.00');

  localStorage.clear();
});

test('CURRENCIES list has valid codes and labels', () => {
  assert.ok(CURRENCIES.length >= 6);
  for (const c of CURRENCIES) {
    assert.ok(c.code && typeof c.code === 'string');
    assert.ok(c.symbol && typeof c.symbol === 'string');
    assert.ok(c.label && typeof c.label === 'string');
    assert.equal(SYMBOLS[c.code], c.symbol);
  }
});
