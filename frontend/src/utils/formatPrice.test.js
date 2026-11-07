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
import { setActiveLocale } from './translate.js';

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

test('formatPrice: the reader\'s notation for the locale given', () => {
  assert.equal(formatPrice(1234.5, 'en'), '1,234.50');
  assert.equal(formatPrice(1234.5, 'de'), '1.234,50');
  assert.equal(formatPrice(1234.5, 'fr'), '1 234,50');
  assert.equal(formatPrice(1234.5, 'ru'), '1 234,50');
  assert.equal(formatPrice(1234.5, 'pt-BR'), '1.234,50');
  assert.equal(formatPrice(1234.5, 'ja'), '1,234.50');
  assert.equal(formatPrice('4.5', 'de'), '4,50');
  assert.equal(formatPrice('12.50 USD', 'de'), '12,50');
  assert.equal(formatPrice(null, 'de'), '0,00');
  assert.equal(formatPrice(0.125, 'de'), '0,13');
  // Not a language tag at all: still a number, in English notation.
  assert.equal(formatPrice(12.5, 'not a locale!'), '12.50');
});

test('priceText: active interface locale for the number, row currency for the symbol', () => {
  localStorage.clear();
  try {
    setActiveLocale('de');
    assert.equal(priceText(1234.5), '$1.234,50');
    assert.equal(priceText(4.5, 'EUR'), '€4,50');
    assert.equal(formatPrice(4.5), '4,50', 'no locale passed: the interface language');
    setActiveLocale('fr');
    assert.equal(priceText(1234.5, 'GBP'), '£1 234,50');
  } finally {
    setActiveLocale('en');
  }
  assert.equal(priceText(1234.5), '$1,234.50');
});

test('currency configuration and defaults', () => {
  localStorage.clear();
  assert.equal(DEFAULT_CURRENCY, 'USD');
  assert.equal(getCurrency(), 'USD');
  assert.equal(currencySymbol(), '$');
  assert.equal(activeCurrencySymbol(), '$');
  assert.equal(priceText(5), '$5.00');
  // A row's own currency wins over the active one; stored prices are never converted
  assert.equal(priceText(5, 'EUR'), '€5.00');
  assert.equal(priceText(5, 'USD'), '$5.00');
});

test('currency selection and priceText formatting', () => {
  localStorage.clear();

  // Test EUR
  setCurrency('EUR');
  assert.equal(getCurrency(), 'EUR');
  assert.equal(currencySymbol(), '€');
  assert.equal(activeCurrencySymbol(), '€');
  assert.equal(priceText(19.99), '€19.99');
  assert.equal(priceText(19.99, 'USD'), '$19.99'); // Row currency, not the active one
  assert.equal(priceText(19.99, 'EUR'), '€19.99');

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

test('priceText falls back to the active currency when the row has none or an unknown one', () => {
  localStorage.clear();
  setCurrency('GBP');
  assert.equal(priceText(3), '£3.00');
  assert.equal(priceText(3, null), '£3.00');
  assert.equal(priceText(3, undefined), '£3.00');
  assert.equal(priceText(3, ''), '£3.00');
  assert.equal(priceText(3, 'XYZ'), '£3.00');
  assert.equal(priceText(3, 'JPY'), '¥3.00');
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
