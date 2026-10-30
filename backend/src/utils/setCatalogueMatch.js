// Join one provider's set list to another's.
//
// The scan-index panel lists the sets it can BUILD (setIndex.listAllSets) and
// decorates each with display metadata — name, release date, card count, logo —
// from the local `sets` table. For Pokémon that table is populated from
// pokemontcg.io (tcgApi.fetchAndCacheSets), but the buildable list comes from
// TCGdex whenever that provider is selected, and the two do not agree on ids:
//
//   TCGdex      pokemontcg.io
//   sv01        sv1              Scarlet & Violet
//   sv03.5      sv3pt5           151
//   swsh9.5tg   swsh9tg          Brilliant Stars Trainer Gallery
//   cel25cc     cel25c           Celebrations Classic Collection
//
// A bare normalized-id join therefore missed 91 of TCGdex's 218 English sets —
// every Scarlet & Violet release among them — and those rows rendered as a raw
// set code with no year and no card count, which reads as a broken catalogue
// rather than as two providers numbering their sets differently.
//
// Three keys, tried in order of how much they can be trusted:
//
//   1. normalized id   — punctuation and case removed. Exact, always right.
//   2. unpadded id     — leading zeros dropped from a digit run that follows a
//                        letter, so sv01 reaches sv1. Deliberately NOT a general
//                        zero strip: "2011bw" (McDonald's Collection 2011) would
//                        become "211bw" and could then collide with something
//                        unrelated.
//   3. normalized name — the last resort, and the one that recovers the ".5"
//                        sets whose ids diverge past repair (sv3pt5 vs sv035).
//
// Keys that more than one catalogue row claims are dropped rather than guessed
// at: a wrong join here silently shows one set's release date and card count
// under another set's name, which is worse than the blank it replaces.
// Diacritics are folded BEFORE the a-z filter, not stripped by it. Dropping the
// accent as an illegal character turns "Pokémon GO" into "pokmongo" while a
// provider spelling it "Pokemon GO" gives "pokemongo" — two keys for one set, and
// the join silently misses. Decomposing first makes both "pokemongo".
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

// Provider prefixes are not part of the set code.
const normId = (s) => fold(s).toLowerCase().replace(/^(mtg|lorcana|pokemontcgapi)-/, '').replace(/[^a-z0-9]/g, '');

// Only zeros sitting between a letter and a digit — see the note above.
const unpadId = (s) => normId(s).replace(/([a-z])0+(\d)/g, '$1$2');

const normName = (s) => fold(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Index `rows` (anything with .id and .name) under all three keys at once.
function index(rows, { idOf = (r) => r.id, nameOf = (r) => r.name } = {}) {
  const byId = new Map(), byUnpad = new Map(), byName = new Map();
  const clash = (map, key, row) => {
    if (!key) return;
    // A key already claimed by a DIFFERENT row is poisoned: null it so neither
    // row can win it, instead of letting insertion order decide.
    if (map.has(key) && map.get(key) !== row) map.set(key, null);
    else map.set(key, row);
  };
  for (const row of rows || []) {
    clash(byId, normId(idOf(row)), row);
    clash(byUnpad, unpadId(idOf(row)), row);
    clash(byName, normName(nameOf(row)), row);
  }
  return { byId, byUnpad, byName };
}

// Build a lookup over `rows`. The returned function takes the set code being
// listed plus, optionally, a name to fall back on, and returns the matching row
// or null.
function matcher(rows, opts) {
  const { byId, byUnpad, byName } = index(rows, opts);
  return function match(set, name) {
    return byId.get(normId(set))
      || byUnpad.get(unpadId(set))
      || (name ? byName.get(normName(name)) : null)
      || null;
  };
}

module.exports = { matcher, index, normId, unpadId, normName, fold };
