// Stacked tiles: several collection rows (one per physical copy) drawn as one
// card with one number on it. Each tile carries `member_ids`, the entry ids of
// every row it stands for, because the card popup edits that number: it sends
// the ids along with the new quantity, and the server adds or removes copies
// among exactly those rows. Without them the server could only guess at the
// tile, and guessed a different group — a x5 tile of 3 Near Mint + 2 Lightly
// Played set to 4 came out at six.
//
// The first row of a group is the one the tile shows (and the popup edits);
// the rest only add to its quantity.

// The collection view: by card, optionally split by condition and/or printing.
function collectionStackKey(item, { byCondition = false, byPrinting = false } = {}) {
  let key = item.card_id;
  if (byCondition) key += `-${item.condition}`;
  if (byPrinting) key += `-${item.printing}`;
  return key;
}

// "Duplicates only" (#164): a predicate for rows of a card owned more than once,
// counted across all of `rows` (pass the whole collection, not a filtered view,
// so a second copy elsewhere still counts) and grouped like the stacked tiles,
// so splitting by condition or printing narrows what counts as the same card.
export function duplicateRowFilter(rows, options = {}) {
  const copies = new Map();
  for (const item of rows) {
    const key = collectionStackKey(item, options);
    copies.set(key, (copies.get(key) || 0) + (Number(item.quantity) || 1));
  }
  return (item) => (copies.get(collectionStackKey(item, options)) || 0) > 1;
}

export function stackCollectionRows(rows, { byCondition = false, byPrinting = false } = {}) {
  const tiles = new Map();
  for (const item of rows) {
    const key = collectionStackKey(item, { byCondition, byPrinting });
    const tile = tiles.get(key);
    if (!tile) {
      tiles.set(key, { ...item, member_ids: [item.entry_id] });
    } else {
      tile.quantity += item.quantity;
      tile.member_ids.push(item.entry_id);
    }
  }
  return Array.from(tiles.values());
}

// A binder page on a stacking container: copies of the same card share a
// pocket, keyed the way the server counts occupancy there (card, printing and
// language; not condition). The first copy holds the slot and the rest ride
// along in its quantity, so the page lays out from stacks rather than from rows.
export function stackPocketCards(cards) {
  const stacks = new Map();
  for (const card of cards) {
    const key = `${card.card_id}|${card.printing || 'Normal'}|${card.language || 'English'}`;
    const held = stacks.get(key);
    if (!held) {
      stacks.set(key, { ...card, quantity: card.quantity || 1, member_ids: [card.entry_id] });
      continue;
    }
    held.quantity += card.quantity || 1;
    held.member_ids.push(card.entry_id);
    // Whichever copy is actually filed decides where the stack sits; an unplaced
    // one joining it must not drag the pocket back to "no position".
    if (!(held.position > 0) && card.position > 0) held.position = card.position;
  }
  return Array.from(stacks.values());
}
