// The card-name dictionaries — every Pokémon in nine languages, Lorcana's
// characters and versions — are a quarter of a megabyte of JS, and most
// collections never need them: a non-English card normally carries the name it is
// printed with, and a Japanese search is the exception. Bundled, they rode along
// with every view that shows a card name, the Dashboard included. Now they are
// fetched the first time something asks (langHelper.js does the asking); this
// module only holds them, so the app shell can listen for their arrival without
// pulling in the translation code.

let dictionaries = null;
let pending = null;
const listeners = new Set();

// { pokemon, lorcana } once loaded, else null.
export const nameDictionaries = () => dictionaries;

export function loadNameDictionaries() {
  if (!pending) {
    pending = Promise.all([
      import('../../../shared/pokemonTranslations.js'),
      import('../../../shared/lorcanaTranslations.js'),
    ]).then(([pokemon, lorcana]) => {
      dictionaries = { pokemon: pokemon.default, lorcana: lorcana.default };
      for (const fn of listeners) fn(dictionaries);
      return dictionaries;
    });
    // Not retried: names staying English beats a failing fetch on every render.
    // (A chunk missing after an upgrade reloads the page; see chunkReload.js.)
    pending.catch(err => console.warn('Card name dictionaries failed to load:', err));
  }
  return pending;
}

// Called once, with the dictionaries, when they arrive. Returns the unsubscribe.
export const onNameDictionaries = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
