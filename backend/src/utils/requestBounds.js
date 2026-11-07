// Copy counts from requests and imported files. A copy is a row, so this number
// decides how many INSERTs one request runs. It used to be read with parseInt and
// floored at 1 with no ceiling: 1e9 asked for a billion rows, and "abc", -3 and
// 2.5 quietly became one or two copies.
//
// The frontend's quantity fields (components/CardEntryFields.jsx) stop at the same
// number.
const MAX_QUANTITY = 9999;

const QUANTITY_ERROR = `quantity must be a whole number from 1 to ${MAX_QUANTITY}`;

// A quantity a client sent: a whole number of copies from 1 to MAX_QUANTITY, as a
// number or as a string of digits (a form field). Anything else is the client's
// mistake and is refused rather than guessed at — null included, since "no
// quantity" is spelled by leaving the field out, which gives `fallback`.
// Returns { value } or { error }.
function readQuantity(raw, { fallback } = {}) {
  if (raw === undefined) return { value: fallback };
  const n = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) return { error: QUANTITY_ERROR };
  return { value: n };
}

// The copies one imported row stands for. Clamped rather than refused: one odd
// cell should not sink a four-thousand-row file. Below 1 becomes 1 and above
// MAX_QUANTITY becomes MAX_QUANTITY, and `clamped` marks the row so the import
// summary can say how many it changed. A row with no usable number at all is one
// copy, as it always was.
function clampImportQuantity(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { copies: 1, clamped: false };
  let n = Number(raw);
  if (!Number.isFinite(n)) n = parseInt(raw, 10);   // "3x", "2 copies"
  if (!Number.isFinite(n)) return { copies: 1, clamped: false };
  n = Math.trunc(n);
  if (n < 1) return { copies: 1, clamped: true };
  if (n > MAX_QUANTITY) return { copies: MAX_QUANTITY, clamped: true };
  return { copies: n, clamped: false };
}

module.exports = { MAX_QUANTITY, readQuantity, clampImportQuantity };
