// Magic's search boxes speak Scryfall syntax (t:creature c:g cmc<=3). What the
// syntax means lives in shared/scryfallQuery.mjs, which the backend loads too;
// this is the frontend's door to it, with the app's language table plugged in.
//
// Only for Magic. The callers check the game first: c:g or t:creature mean
// nothing for a Pokémon or Lorcana card, and those boxes keep their plain search.
import { looksLikeSyntax, parseQuery, compileFilter, QuerySyntaxError } from '../../../shared/scryfallQuery.mjs';
import { LANGUAGES } from './languages.js';

export { looksLikeSyntax };

const problemOf = (err) => ({ code: err.code, params: err.params, message: err.message });

// Search & Add: the problem with the box, or null when it holds a plain name or
// syntax that reads. Only the grammar is checked — Scryfall itself answers every
// keyword, so otag: or f:modern are fine here even though the collection cannot
// filter by them.
export function checkSearchSyntax(text) {
  if (!looksLikeSyntax(text)) return null;
  try {
    parseQuery(text);
    return null;
  } catch (err) {
    if (err instanceof QuerySyntaxError) return problemOf(err);
    throw err;
  }
}

// The collection filter: null for a plain search, which keeps the old name / set /
// number match. Otherwise { matches(row) } for syntax that the cached rows can
// answer, or { error, matches } where nothing matches and `error` says why — the
// screen shows that rather than an unexplained empty grid.
export function compileCollectionFilter(text) {
  if (!looksLikeSyntax(text)) return null;
  try {
    return { matches: compileFilter(text, { languages: LANGUAGES }), error: null };
  } catch (err) {
    if (err instanceof QuerySyntaxError) return { matches: () => false, error: problemOf(err) };
    throw err;
  }
}

// A syntax problem in the user's language: syntax.err.<code>, falling back to the
// English text the parser (or the server's 400) carried.
export function syntaxErrorText(t, problem) {
  if (!problem) return '';
  const key = `syntax.err.${problem.code}`;
  const text = problem.code ? t(key, problem.params || {}) : key;
  return text === key ? (problem.message || problem.error || '') : text;
}
