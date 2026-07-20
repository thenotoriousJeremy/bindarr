import { useState, useEffect } from 'react';

// Deck picker that adds card(s) to the chosen deck. Owns the deck fetch so the
// places that offer "Add to Deck" (card popup, collection bulk toolbar) don't
// each re-implement the fetch + select. onAdd(deckId) performs the actual add.
// Renders nothing when the user has no decks.
export default function AddToDeckSelect({
  onAdd,
  disabled = false,
  placeholder = 'Add to Deck…',
  className = 'select-control',
  style,
}) {
  const [decks, setDecks] = useState([]);

  useEffect(() => {
    fetch('/api/decks').then(r => (r.ok ? r.json() : [])).then(setDecks).catch(() => {});
  }, []);

  if (decks.length === 0) return null;

  return (
    <select
      className={className}
      value=""
      disabled={disabled}
      onChange={(e) => { if (e.target.value) onAdd(e.target.value); e.target.value = ''; }}
      style={style}
    >
      <option value="">{placeholder}</option>
      {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );
}
