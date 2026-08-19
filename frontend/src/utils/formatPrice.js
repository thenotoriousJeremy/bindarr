// Two decimals, and '0.00' for anything that does not parse as a number — null,
// undefined and '' all become NaN, which `|| 0` catches along with a genuine zero.
// parseFloat rather than Number, deliberately: it keeps the leniency the callers
// were written against, where a value like '12.50 USD' still reads as 12.50.
export const formatPrice = (p) => (parseFloat(p) || 0).toFixed(2);

// Prices are stored in the currency the marketplace quoted (card_cache.price_currency)
// and are NOT converted — an exchange rate is a live number this app has no source
// for. So the symbol has to follow the row: a Japanese Magic card priced from
// Cardmarket is €4.50, and printing it as $4.50 states a number the card was never
// quoted at. Callers that hold a card row pass its price_currency; the ones showing
// what the OWNER typed or paid (purchase_price, market_value) pass nothing and get
// the app's default.
const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
export const currencySymbol = (currency) => SYMBOLS[currency] || '$';

// Symbol + amount, e.g. '$4.50' or '€4.50'. Use this anywhere a price is shown; a
// literal '$' in the markup is how the symbol drifted from the number in the first
// place.
export const priceText = (p, currency) => `${currencySymbol(currency)}${formatPrice(p)}`;
