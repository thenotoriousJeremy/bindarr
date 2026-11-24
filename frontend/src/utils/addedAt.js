import { parseSqliteUtc } from './undo.js';

// The "date added" of a copy, between how the server holds it (UTC without a
// zone, '2024-03-09 18:30:00') and a <input type="datetime-local">, which reads
// and writes the reader's own wall clock ('2024-03-09T19:30').

const pad = (n) => String(n).padStart(2, '0');

// A Date as a datetime-local value, to the minute, in the reader's zone.
export function localInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// A stored added_at as a datetime-local value; '' when there is none.
export function addedAtInputValue(stored) {
  return localInputValue(parseSqliteUtc(stored));
}

// A datetime-local value as the instant the server takes (ISO 8601, UTC), or
// null when the field is empty or half filled in.
export function addedAtFromInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || ''));
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part || 0));
  // From its parts: a zone-less string is read as local time by current engines,
  // but older ones took it for UTC.
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
