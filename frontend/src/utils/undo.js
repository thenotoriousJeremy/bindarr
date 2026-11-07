// Undo for the actions that have a cheap inverse on the server:
// - a delete, which moves copies to the trash: restore its batch;
// - a move to Unsorted: put each copy back where it was (the bulk endpoint
//   reports where that was);
// - removing a card from a deck: add it back at its old quantity.
// Anything else gets no Undo button rather than an inverse that guesses.

// Which undo a finished action offers, from what the server answered.
export function undoFor(action, value, data) {
  if (!data) return null;
  if (action === 'delete' && data.trash_batch) return { kind: 'trash', batch: data.trash_batch };
  if (action === 'move' && !value && Array.isArray(data.previous) && data.previous.length > 0) {
    return { kind: 'placement', placements: data.previous };
  }
  return null;
}

// The single-copy unfile in storage knows where the copy was itself.
export function placementUndo(card) {
  if (!card || (!card.compartment_id && !card.location_id)) return null;
  return {
    kind: 'placement',
    placements: [{ entry_id: card.entry_id, location_id: card.location_id, compartment_id: card.compartment_id, position: card.position }]
  };
}

export function deckCardUndo(deckId, card) {
  if (!deckId || !card || !(card.quantity > 0)) return null;
  return { kind: 'deckCard', deckId, cardId: card.id, quantity: card.quantity };
}

function request(undo) {
  const json = { 'Content-Type': 'application/json' };
  if (undo.kind === 'trash') {
    return [`/api/collection/trash/${encodeURIComponent(undo.batch)}/restore`, { method: 'POST' }];
  }
  if (undo.kind === 'placement') {
    return ['/api/collection/restore-placement', { method: 'POST', headers: json, body: JSON.stringify({ placements: undo.placements }) }];
  }
  if (undo.kind === 'deckCard') {
    return [`/api/decks/${undo.deckId}/cards`, { method: 'POST', headers: json, body: JSON.stringify({ card_id: undo.cardId, quantity: undo.quantity }) }];
  }
  throw new Error(`Unknown undo: ${undo.kind}`);
}

// Run an undo. Resolves { ok, data } and never throws, so a toast button can
// await it without its own try/catch.
export async function runUndo(undo, fetchImpl = fetch) {
  try {
    const [url, init] = request(undo);
    const res = await fetchImpl(url, init);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: {} };
  }
}

// The translation key and values for what an undo achieved.
export function undoResult(undo, { ok, data }) {
  if (!ok) return { key: 'undo.failed', values: {} };
  if (undo.kind === 'trash') {
    if (data.unsorted > 0) return { key: 'undo.restoredSomeUnsorted', values: { count: data.restored, unsorted: data.unsorted } };
    return { key: 'undo.restored', values: { count: data.restored } };
  }
  if (undo.kind === 'placement' && data.unplaced > 0) return { key: 'undo.placedSomeUnsorted', values: { count: data.unplaced } };
  return { key: 'undo.done', values: {} };
}

// Toast options for showToast(message, options): an Undo button that runs the
// undo, reports the result and lets the caller refresh. No undo, no button.
export function undoToast(undo, { showToast, t, onDone }) {
  if (!undo) return undefined;
  return {
    onAction: async () => {
      const result = await runUndo(undo);
      const { key, values } = undoResult(undo, result);
      showToast(t(key, values));
      if (result.ok && onDone) onDone();
    }
  };
}

// SQLite's CURRENT_TIMESTAMP is UTC without a zone ('2026-11-07 12:00:00').
export function parseSqliteUtc(ts) {
  if (!ts) return null;
  const d = new Date(`${String(ts).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Whole days until a trash batch is purged, never below 0.
export function daysLeft(expiresAt, now = Date.now()) {
  const d = parseSqliteUtc(expiresAt);
  if (!d) return 0;
  return Math.max(0, Math.ceil((d.getTime() - now) / 86400000));
}
