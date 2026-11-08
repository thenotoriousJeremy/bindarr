import { getActiveLocale } from './translate.js';

export const CURRENCIES = [
  { code: 'USD', symbol: '$', label: 'USD ($)' },
  { code: 'EUR', symbol: '€', label: 'EUR (€)' },
  { code: 'GBP', symbol: '£', label: 'GBP (£)' },
  { code: 'CAD', symbol: 'C$', label: 'CAD (C$)' },
  { code: 'AUD', symbol: 'A$', label: 'AUD (A$)' },
  { code: 'JPY', symbol: '¥', label: 'JPY (¥)' },
];

export const DEFAULT_CURRENCY = 'USD';

export const SYMBOLS = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'C$',
  AUD: 'A$',
  JPY: '¥',
};

export const getCurrency = () => {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('bindarr_currency') : null;
    return (stored && SYMBOLS[stored]) ? stored : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
};

export const setCurrency = (code) => {
  const next = SYMBOLS[code] ? code : DEFAULT_CURRENCY;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('bindarr_currency', next);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('bindarr_currency_change', { detail: next }));
  }
};

export const currencySymbol = (currency) => {
  const code = (currency && SYMBOLS[currency]) ? currency : getCurrency();
  return SYMBOLS[code] || '$';
};

export const activeCurrencySymbol = () => SYMBOLS[getCurrency()] || '$';

// Two decimals in the reader's own notation — 1,234.50 in English, 1.234,50 in
// German, 1 234,50 in French — for the interface language unless a locale is
// given (the tests pin one). Only the number: the symbol is priceText's job.
// Formatters are cached because a collection view formats hundreds per render.
const formatters = new Map();
const priceFormat = (locale) => {
  let f = formatters.get(locale);
  if (!f) {
    const opts = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    try { f = new Intl.NumberFormat(locale, opts); } catch { f = new Intl.NumberFormat('en', opts); }
    formatters.set(locale, f);
  }
  return f;
};

export const formatPrice = (p, locale = getActiveLocale()) => priceFormat(locale).format(parseFloat(p) || 0);

// Prices are stored in the currency the marketplace quoted (card_cache.price_currency),
// and priceText shows a number in exactly the currency it is given: a Cardmarket
// price is €4.50 here whatever the active setting is. Converting into the display
// currency is convertPrice.js (and the <Price> component), which falls back to this.
// Callers showing what the owner typed or paid (purchase_price) pass nothing and
// get the active currency.
export const priceText = (p, currency) => `${currencySymbol(currency)}${formatPrice(p)}`;
