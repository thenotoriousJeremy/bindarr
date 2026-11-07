// How wide a binder page is drawn, in pockets.
//
// Pocket pages are sold in a handful of fixed layouts, and they are landscape
// more often than not: a 12-pocket page is 4 wide and 3 tall, an 8-pocket page
// 4 by 2. Rounding the square root of the capacity got the square ones right and
// the rest wrong — round(sqrt(12)) is 3, which drew a 12-pocket page as 3 by 4
// and had owners setting 13 per page just to get four columns (issue #90). So
// the known layouts are looked up, and only an odd capacity falls back to the
// nearest square.
const STANDARD_COLUMNS = {
  4: 2, // 2×2 toploader page
  6: 3, // 3×2
  8: 4, // 4×2
  9: 3, // 3×3, the classic binder page
  12: 4, // 4×3
  16: 4, // 4×4
  18: 6, // 6×3
  20: 5, // 5×4
  24: 6, // 6×4
  25: 5, // 5×5
  36: 6, // 6×6
};

// The widest a binder can be set to. Mirrors MAX_PAGE_COLUMNS in
// backend/src/routes/storage.js, which rejects anything past it.
export const MAX_PAGE_COLUMNS = 12;

// Choices for the "Columns per page" picker; the empty value is Auto.
export const PAGE_COLUMN_CHOICES = Array.from({ length: MAX_PAGE_COLUMNS }, (_, i) => i + 1);

export function defaultPageColumns(capacity) {
  const cap = Math.max(1, parseInt(capacity, 10) || 1);
  return STANDARD_COLUMNS[cap] || Math.max(1, Math.round(Math.sqrt(cap)));
}

// The binder's own setting wins when it is a usable number; null, undefined or
// anything out of range means automatic.
export function pageColumns(capacity, override) {
  const n = Number(override);
  if (override != null && override !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_PAGE_COLUMNS) return n;
  return defaultPageColumns(capacity);
}

// Columns and rows together, for labels like "4 × 3". Rows round up: a page whose
// capacity doesn't divide evenly still needs a row for the remainder.
export function pageGrid(capacity, override) {
  const cap = Math.max(1, parseInt(capacity, 10) || 1);
  const columns = pageColumns(cap, override);
  return { columns, rows: Math.ceil(cap / columns) };
}

// Collapse copies of the same card into one pocket, keyed the way the server
// counts occupancy on a stacking container (card, printing and language; not
// condition). The first copy holds the slot and the rest ride along in its
// quantity, so the page lays out from stacks rather than from rows.
export function stackPocketCards(cards) {
  const stacks = new Map();
  for (const card of cards) {
    const key = `${card.card_id}|${card.printing || 'Normal'}|${card.language || 'English'}`;
    const held = stacks.get(key);
    if (!held) {
      stacks.set(key, { ...card, quantity: card.quantity || 1 });
      continue;
    }
    held.quantity += card.quantity || 1;
    // Whichever copy is actually filed decides where the stack sits; an unplaced
    // one joining it must not drag the pocket back to "no position".
    if (!(held.position > 0) && card.position > 0) held.position = card.position;
  }
  return Array.from(stacks.values());
}

// One page's cards in pocket order, null for an empty pocket. A card sits in the
// pocket its position names (position = slot * 1000); one without a usable
// position, or whose pocket is already taken, goes in the first free pocket. A
// page holding more than its capacity grows past it rather than hiding cards.
export function layoutPockets(cards, capacity, allowStacking = false) {
  const pocketCards = allowStacking ? stackPocketCards(cards) : cards;
  let maxSlotFromCards = capacity || 1;
  pocketCards.forEach(c => {
    if (c && c.position > 0) {
      const s = Math.floor(c.position / 1000);
      if (s > maxSlotFromCards) maxSlotFromCards = s;
    }
  });
  const slotCount = Math.max(capacity || 1, maxSlotFromCards);
  const pockets = new Array(slotCount).fill(null);
  const unplaced = [];

  pocketCards.forEach(c => {
    const slot = (c && c.position > 0) ? Math.floor(c.position / 1000) : null;
    if (slot && slot >= 1 && slot <= slotCount && !pockets[slot - 1]) {
      pockets[slot - 1] = c;
    } else {
      unplaced.push(c);
    }
  });

  unplaced.forEach(c => {
    const freeIdx = pockets.findIndex(p => p === null);
    if (freeIdx !== -1) pockets[freeIdx] = c;
    else pockets.push(c);
  });
  return pockets;
}
