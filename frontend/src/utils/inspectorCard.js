// The copies of a card the card popup (CardInspectorModal) works on. Pure, so
// node:test can hold the line that a preview never changes the caller's card:
// the popup used to assign a language switch onto it, so the switch stayed on
// the collection, storage or scanner screen even after Cancel.

// The printing in another language, previewed on a copy of the entry.
export function localizedPreview(card, localized, language) {
  return { ...(card || {}), ...localized, card_id: localized.id, language };
}

// What a SAVED language switch carries onto the caller's card (the server moved
// the entry to that printing): the printing's own fields, never the ids the
// popup finds the entry by. `id` in a preview is the printing's card id.
export function savedPrintingFields(preview) {
  const fields = { ...preview };
  delete fields.id;
  delete fields.entry_id;
  return fields;
}
