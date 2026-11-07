// Client-side helpers for card lists (components/Lists.jsx). Owned and missing
// counts come from the server (backend/src/utils/listOwnership.js); these only
// filter, total and format what it sent.
import { setCode } from './languages.js';

// 'all' | 'missing' | 'owned'. "Owned" means the want is fully covered.
export function filterItems(items, filter) {
  if (filter === 'missing') return items.filter(i => i.missing > 0);
  if (filter === 'owned') return items.filter(i => i.missing === 0);
  return items;
}

// One line per item: `qty name [SET] number`, the shape ManaBox, Moxfield and
// TCGplayer's mass entry all read. `qty` is the copies still missing when
// `useMissing` is set (a shopping list), else the copies wanted. Items with
// nothing left to buy are skipped in missing mode.
export function listAsText(items, { useMissing = false } = {}) {
  return items
    .map(i => ({ i, qty: useMissing ? i.missing : i.quantity_wanted }))
    .filter(({ qty }) => qty > 0)
    .map(({ i, qty }) => {
      const card = i.card || {};
      const code = setCode(card);
      return [String(qty), card.name || i.card_id, code ? `[${code.toUpperCase()}]` : '', card.number || '']
        .filter(Boolean).join(' ');
    })
    .join('\n');
}

// The per-currency missing-value map as display rows, largest first. Never
// summed across currencies: there is no exchange rate in the app.
export const currencyTotals = (missingValue) => Object.entries(missingValue || {})
  .filter(([, amount]) => amount > 0)
  .map(([currency, amount]) => ({ currency, amount }))
  .sort((a, b) => b.amount - a.amount);

// How far along a list is, 0-100, by copies: owned (capped per item) over wanted.
export const progressPercent = (summary) => (summary && summary.wanted > 0
  ? Math.round((summary.owned / summary.wanted) * 100)
  : 0);
