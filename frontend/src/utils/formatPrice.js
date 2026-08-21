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

export const formatPrice = (p) => (parseFloat(p) || 0).toFixed(2);

// Formats a price using the app's single active currency setting.
// Enforces one uniform currency across the entire application.
export const priceText = (p) => `${activeCurrencySymbol()}${formatPrice(p)}`;
