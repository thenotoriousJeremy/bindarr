// The pure half of the Trades area (components/transfers): who is who on a
// transfer, the items the pickers offer, and how costs and dates read.
import { currencySymbol, formatPrice } from './formatPrice.js';
import { parseSqliteUtc } from './undo.js';

// ----------------------------------------------------------------- parties

// The same member? A deleted member's ids arrive as null (their name still
// arrives, from a snapshot), so a null id is nobody: never "me", and never the
// same as another null. Compare against the viewer's own id, never against the
// other party's id alone.
export const sameUser = (a, b) => a != null && b != null && String(a) === String(b);

// The viewer's side of a transfer: 'incoming' (they were sent it), 'outgoing'
// (they sent it) or null.
export function transferRole(transfer, me) {
  if (sameUser(transfer?.recipient_id, me)) return 'incoming';
  if (sameUser(transfer?.proposer_id, me)) return 'outgoing';
  return null;
}

// The other party's id and name, from the viewer's side. Transfers name their
// parties proposer/recipient, recorded past trades creator/recipient. The name
// is the live username, else the snapshot the server keeps (proposer_name,
// recipient_name), which is all that is left of a deleted member.
export function otherParty(record, me, first = 'proposer', second = 'recipient') {
  const them = sameUser(record?.[`${first}_id`], me) ? second : first;
  return {
    id: record?.[`${them}_id`] ?? null,
    name: record?.[`${them}_username`] || record?.[`${them}_name`] || null,
  };
}

// Proposals still waiting, split by the viewer's side.
export function pendingTransfers(transfers, me) {
  const incoming = [];
  const outgoing = [];
  for (const transfer of transfers) {
    if (transfer.status !== 'pending') continue;
    const role = transferRole(transfer, me);
    if (role === 'incoming') incoming.push(transfer);
    else if (role === 'outgoing') outgoing.push(transfer);
  }
  return { incoming, outgoing };
}

// A trade that asks for nothing back: the recipient has to counter with
// something before it can be accepted.
export function isOneSidedTrade(transfer, me) {
  if (transfer?.transfer_type !== 'trade') return false;
  const items = transfer.items || [];
  const role = transferRole(transfer, me);
  if (role === 'incoming') return !items.some(item => sameUser(item.from_user_id, me));
  if (role === 'outgoing') return items.every(item => sameUser(item.from_user_id, me));
  return false;
}

// ------------------------------------------------------------- picker items

export const itemKey = (item) => `${item.type}:${item.id}`;
export const itemLabel = (item) => (item.type === 'card'
  ? item.name || item.printed_name || item.card_id
  : item.product_name);
export const locationFilterKey = (item) => (item.location_id == null ? 'unsorted' : String(item.location_id));
export const itemCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// A slab's grade ('PSA 10'), or null for a raw card. As in the collection grid,
// it stands in for the condition: both answer how good the copy is.
export function gradeText(item) {
  if (!item?.grader || item.grader === 'Raw') return null;
  return item.grade != null && item.grade !== '' ? `${item.grader} ${item.grade}` : item.grader;
}

// Where a copy of yours is stored, as the pickers and offers name it.
export function cardLocationLabel(item, t) {
  if (item.location_id == null) return t('transfer.unsortedLocation');
  return item.location_name || t('transfer.unknownLocation');
}

// The pickers' filters before anything is chosen.
export const DEFAULT_PICKER_FILTERS = Object.freeze({ query: '', game: '', type: 'all', location: '', sort: 'name-asc' });

// The location filter's choices: each place one of your cards is kept.
export function locationOptions(cards, t) {
  const options = new Map();
  for (const card of cards) {
    const key = locationFilterKey(card);
    if (!options.has(key)) options.set(key, { key, label: cardLocationLabel(card, t) });
  }
  return [...options.values()].sort((a, b) => itemCollator.compare(a.label, b.label));
}

// The collection grid's slim rows (fields=grid) carry a copy's location_id but
// not its name; the names come from GET /api/locations.
export function withLocationNames(rows, namesById) {
  return rows.map(row => (row.location_name != null || row.location_id == null
    ? row
    : { ...row, location_name: namesById.get(row.location_id) ?? null }));
}

// Your own copies as picker items: a card by its collection entry, a sealed
// product by its unit.
export function ownOfferItems(cards, sealed) {
  return [
    ...cards.map(card => ({ ...card, type: 'card', id: card.entry_id })),
    ...sealed.map(unit => ({ ...unit, type: 'sealed', id: unit.id })),
  ];
}

// What the other member offered on a transfer being countered, as picker items:
// asking for those back is allowed even when they are not marked for trade.
export function counterOfferedItems(transfer, me) {
  if (!transfer) return [];
  const byKey = new Map();
  for (const item of transfer.items || []) {
    if (sameUser(item.from_user_id, me)) continue;
    const type = item.item_type;
    const id = type === 'card' ? item.source_collection_id : item.source_sealed_unit_id;
    if (!id) continue;
    const key = itemKey({ type, id });
    const copies = type === 'card' ? Number(item.quantity) || 1 : 1;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += copies;
      continue;
    }
    const snapshot = item.item_snapshot || {};
    byKey.set(key, {
      type,
      id,
      quantity: copies,
      name: snapshot.name || snapshot.product_name,
      printed_name: snapshot.printed_name,
      product_name: snapshot.product_name,
      set_name: snapshot.set_name,
      number: snapshot.number,
      rarity: snapshot.rarity,
      image_url: snapshot.image_url,
      game: snapshot.game,
      printing: snapshot.printing,
      condition: snapshot.condition,
      language: snapshot.language,
      grader: snapshot.grader,
      grade: snapshot.grade,
      sealed_type: snapshot.sealed_type,
      origin_product_name: snapshot.origin_product_name,
      explicit: true,
    });
  }
  return [...byKey.values()];
}

// What can be asked of a member: their trade-marked items (GET
// /api/transfers/marked/:id) and, in a counter, what they offered themselves.
export function requestOptions(marked, counterItems = []) {
  const all = [
    ...(marked?.cards || []).map(item => ({ ...item, type: 'card', id: item.entry_id })),
    ...(marked?.sealed || []).map(item => ({ ...item, type: 'sealed', id: item.unit_id })),
    ...counterItems,
  ];
  const seen = new Set();
  return all.filter((item) => {
    const key = itemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function matchesItemFilters(item, filters) {
  if (filters.type !== 'all' && item.type !== filters.type) return false;
  if (filters.game && String(item.game || '').toLowerCase() !== filters.game) return false;
  if (filters.location && (item.type !== 'card' || locationFilterKey(item) !== filters.location)) return false;
  const query = String(filters.query || '').trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    item.name,
    item.printed_name,
    item.product_name,
    item.set_name,
    item.number,
    item.sealed_type,
    item.origin_product_name,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

// ----------------------------------------------------------------- composer

// The composer's recipient select holds 'user:<id>' (a member) or
// 'contact:<id>' (someone outside Bindarr).
export function parseRecipient(value) {
  const match = /^(user|contact):(.+)$/.exec(String(value || ''));
  return match ? { kind: match[1], id: match[2] } : { kind: null, id: null };
}

// Whether the composer holds enough to send. A deal recorded with a contact
// needs both sides for a trade, or the gift's one side; an offer to a member
// needs something offered, and a counter something asked for too.
export function composerReady({ recipient, type, giftDirection, offered = 0, requested = 0, received = 0, countering = false }) {
  const { kind } = parseRecipient(recipient);
  if (kind === 'contact') {
    if (type === 'trade') return offered > 0 && received > 0;
    return giftDirection === 'received' ? received > 0 : offered > 0;
  }
  if (kind !== 'user' || offered === 0) return false;
  return !countering || requested > 0;
}

// --------------------------------------------------------------- formatting

// A recorded cost in the reader's notation and currency, or null when it is
// not known (the cost of a gift's or trade's incoming side can be).
export const costText = (cost, locale) => (cost == null || cost === '' || Number.isNaN(Number(cost))
  ? null
  : `${currencySymbol()}${formatPrice(cost, locale)}`);

// A server timestamp (SQLite's UTC 'YYYY-MM-DD HH:MM:SS') in the reader's notation.
export function timestampText(ts, locale) {
  const date = parseSqliteUtc(ts);
  return date ? date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

// A calendar day ('YYYY-MM-DD', a recorded trade's date) in the reader's
// notation. Read as a date, not an instant: no time zone can move it a day.
export function calendarDateText(day, locale) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return day || '';
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(locale, { timeZone: 'UTC', dateStyle: 'medium' });
}

// How a card copy, sealed purchase or sealed unit that came from someone else
// arrived, or null for one that did not. A member's gift or trade reads
// acquired_transfer_type ('gift' | 'trade') and acquired_transfer_partner (the
// server stopped writing "Transfer from X" into store and notes); a deal
// recorded with someone outside Bindarr reads acquired_external_transaction_type
// and acquired_external_contact.
const RECEIVED_KEYS = {
  gift: { member: 'transfer.receivedGift', outside: 'transfer.receivedGiftOutside' },
  trade: { member: 'transfer.receivedTrade', outside: 'transfer.receivedTradeOutside' },
};

export function receivedFromText(t, row, { outside = false } = {}) {
  const type = outside ? row?.acquired_external_transaction_type : row?.acquired_transfer_type;
  const keys = type === 'gift' || type === 'trade' ? RECEIVED_KEYS[type] : null;
  if (!keys) return null;
  const user = (outside ? row.acquired_external_contact : row.acquired_transfer_partner) || t('transfer.unknownUser');
  return t(outside ? keys.outside : keys.member, { user });
}

// Whichever of the two a sealed purchase or unit carries: GET
// /api/sealed/purchases and /units send both sets of fields, null when unused.
export const provenanceText = (t, row) => receivedFromText(t, row) || receivedFromText(t, row, { outside: true });
