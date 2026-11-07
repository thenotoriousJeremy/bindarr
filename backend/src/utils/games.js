// The card games Bindarr knows, and what each one supports.
//
// The table is shared/games.json, which the frontend reads too (through its ESM
// twin shared/games.js — Vite bundles either, but bare Node cannot import JSON
// without an import attribute, and ESLint 8 cannot parse one). test/games.test.js
// fails if the two ever disagree.
//
// It exists because the list of games used to be written out wherever something
// needed it — ['pokemon','mtg','lorcana'] in decks, three hand-written ORs in the
// collection routes, ['any','pokemon','mtg'] in storage (so a container could not
// be restricted to Lorcana at all), a per-language `games` list in
// shared/languages.json — and each copy was one more place a new game had to be
// remembered. Genuinely game-specific behaviour (Magic's mana costs, Pokémon's
// provider policy) stays where it is; this answers "which games are there, and
// which of them can do X".
const GAMES = require('../../../shared/games.json');

const byValue = new Map(GAMES.map(g => [g.value, g]));
const VALUES = GAMES.map(g => g.value);

// The game every row written before multi-game support belongs to. db.js gives
// collection/card_cache/decks.game this as their column default, and an id with
// no provider prefix is this game's (pokemontcg.io's) — see gameOfId.
const LEGACY_GAME = (GAMES.find(g => g.legacy) || GAMES[0]).value;

const get = (game) => byValue.get(String(game || '')) || null;
const isGame = (game) => byValue.has(String(game || ''));

// Values of the games that have `feature` switched on, in table order.
const withFeature = (feature) => GAMES.filter(g => g.features && g.features[feature]).map(g => g.value);
const hasFeature = (game, feature) => !!(get(game)?.features?.[feature]);

// A request's `game`: absent means `fallback` (usually the legacy game, which is
// what every caller defaulted to before), anything else must be a known game or
// it is null — and the caller answers 400 rather than guessing.
function parseGame(value, fallback = LEGACY_GAME) {
  if (value == null || value === '') return fallback;
  return isGame(value) ? String(value) : null;
}

// Longest prefix first, so a prefix that happens to extend another one cannot be
// shadowed by it.
const PREFIXES = GAMES
  .flatMap(g => (g.idPrefixes || []).map(prefix => ({ prefix, game: g.value })))
  .sort((a, b) => b.prefix.length - a.prefix.length);

const legacyEntry = get(LEGACY_GAME);
const LEGACY_ID = legacyEntry && legacyEntry.legacyIdPattern ? new RegExp(legacyEntry.legacyIdPattern) : null;

// The game a card ID belongs to, or null when nothing can say.
//
// Every provider since pokemontcg.io mints a prefixed id ('mtg-', 'tcgdex-',
// 'lorcana-', ...), so a known prefix answers outright. An id WITHOUT one is a
// pokemontcg.io id ('sv1-1', 'base1-4', 'swshp-SWSH001') only if it has that
// shape: one hyphen between a lowercase set id and a collector number. Anything
// else is unknown. It used to be "Pokémon, ask pokemontcg.io" — so a typo, a
// Lorcast id handed over raw, or an id from a game this install has never heard
// of went off to an API that could only answer 404, and the route then reported
// the card missing from the wrong provider.
//
// The shape cannot tell 'yugioh-1' from 'basep-1'; nothing can. Which is why a
// new game must register a prefix in shared/games.json rather than mint bare ids.
function gameOfId(id) {
  const s = String(id || '');
  if (!s) return null;
  for (const { prefix, game } of PREFIXES) if (s.startsWith(prefix)) return game;
  if (LEGACY_ID && LEGACY_ID.test(s)) return LEGACY_GAME;
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The `sets` table prefixes a game's set ids ('mtg-fdn', 'lorcana-tfc') while
// some card_cache rows carry the bare code; this strips whichever prefix a set id
// has, for the comparisons that have to meet in the middle.
const SET_PREFIXES = GAMES.map(g => g.setIdPrefix).filter(Boolean);
const SET_PREFIX_RE = SET_PREFIXES.length
  ? new RegExp(`^(?:${SET_PREFIXES.map(escapeRe).join('|')})`, 'i')
  : null;
const bareSetId = (id) => (SET_PREFIX_RE ? String(id || '').replace(SET_PREFIX_RE, '') : String(id || ''));

// Language codes a game is printed in, or null for an unknown game.
const languagesFor = (game) => (get(game) ? get(game).languages || [] : null);

// Which game a PSA label names, read off its brand/category text. Null when none
// does: PSA grades sports cards and tickets too.
function gameOfPsaBrand(brandText) {
  const brand = String(brandText || '').toUpperCase();
  const hit = GAMES.find(g => g.psaBrand && new RegExp(g.psaBrand).test(brand));
  return hit ? hit.value : null;
}

module.exports = {
  GAMES, VALUES, LEGACY_GAME,
  get, isGame, withFeature, hasFeature, parseGame,
  gameOfId, bareSetId, languagesFor, gameOfPsaBrand,
};
