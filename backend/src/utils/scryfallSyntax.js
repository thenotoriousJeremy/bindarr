// The backend's door to shared/scryfallQuery.mjs, the Scryfall-syntax parser the
// frontend uses too.
//
// That file is ESM so the browser can load it untranslated, and CommonJS cannot
// require() ESM on the Node versions this server supports (18+). import() works
// everywhere, so the module is loaded once, lazily, and everything that needs it
// here is async — which every caller (a route handler) already is.
const db = require('../db');
const LANGUAGES = require('../../../shared/languages.json');
const { parseCardRow, resolveCardPrice } = require('./priceHelpers');

let shared = null;
const load = () => shared || (shared = import('../../../shared/scryfallQuery.mjs'));

// Passed as the search language when the query names its own (lang:ja): see
// scryfallApi.langSearch. A Symbol, so no request parameter can ever equal it.
const QUERY_LANGUAGE = Symbol('the query names its own language');

// Is this MTG search box Scryfall syntax? Returns the parsed query, or null for a
// plain card name (which keeps its old search path exactly). Throws a
// QuerySyntaxError for syntax that cannot be read — an unbalanced quote is the
// user's to fix, not a query to send.
//
// The scanner's own lookups (prints=1, or an attached image) never count: they
// pass a recognized card name, which must be looked up as a name even when it
// contains a quote or a parenthesis.
async function forSearch(text, { prints, image } = {}) {
  if (prints === '1' || prints === true || image) return null;
  const { looksLikeSyntax, parseQuery, someTerm } = await load();
  if (!looksLikeSyntax(text)) return null;
  const query = String(text).trim();
  const ast = parseQuery(query);
  const has = (keyword, values) => someTerm(ast, n => n.type === 'term' && n.keyword === keyword
    && (!values || values.includes(String(n.value).toLowerCase())));
  return {
    query,
    ast,
    // What the user already chose, so the search does not add its own default.
    ownLanguage: has('lang'),
    ownUnique: has('unique'),
    ownDigital: has('is', ['digital']) || has('not', ['digital']) || has('game'),
  };
}

// A value as Scryfall reads it: quoted when it would otherwise split in two.
const scryValue = (v) => (/[\s()"]/.test(v) ? `"${String(v).replace(/"/g, '')}"` : v);

// The q Scryfall receives for a syntax search from Search & Add: the user's query
// in parentheses, ANDed with the form's set(s) and collector number, then the same
// defaults a name search uses — every printing (the user is picking the one to
// add) and no digital-only cards. A default the query already states is left out,
// so `unique:cards` or `game:arena` mean what they say.
function catalogQuery(syntax, { setList = [], number = '' } = {}) {
  const parts = [`(${syntax.query})`];
  if (setList.length === 1) parts.push(`set:${scryValue(setList[0])}`);
  else if (setList.length > 1) parts.push(`(${setList.map(s => `set:${scryValue(s)}`).join(' or ')})`);
  if (number) parts.push(`cn:${scryValue(number)}`);
  if (!syntax.ownUnique) parts.push('unique:prints');
  if (!syntax.ownDigital) parts.push('-is:digital');
  return parts.join(' ');
}

// Deck builder search ("from my collection") in Scryfall syntax: the user's MTG
// cards whose copies match, one row per card with owned_qty, the shape the plain
// collection-scope search returns.
//
// Evaluated here, over the rows, by the same compileFilter the collection screen
// runs in the browser, rather than compiled to SQL: one evaluator means the two
// cannot disagree about what a query means, and no part of the query is ever SQL —
// the statement below is fixed and binds only the user id. A card is in when ANY
// copy matches, because finish (is:foil), language and price belong to the copy;
// owned_qty still counts every copy, as the plain search does.
async function collectionMatches({ userId, syntax, limit = 60, offset = 0 }) {
  const { compileFilter } = await load();
  const matches = compileFilter(syntax.ast, { languages: LANGUAGES });
  const rows = await db.all(
    `SELECT cc.*, c.quantity AS copy_quantity, c.printing AS copy_printing,
            c.language AS copy_language, c.market_value AS copy_market_value
       FROM collection c
       JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ? AND c.list_type = 'collection' AND cc.game = 'mtg'`,
    [userId]
  );
  const byCard = new Map();
  for (const row of rows) {
    const { copy_quantity: quantity, copy_printing: printing, copy_language: language, copy_market_value: marketValue, ...cardRow } = row;
    let hit = byCard.get(cardRow.id);
    if (!hit) {
      hit = { card: parseCardRow(cardRow), owned: 0, matched: false };
      byCard.set(cardRow.id, hit);
    }
    hit.owned += quantity || 0;
    if (!hit.matched) {
      // The copy as the collection screen sees it: its finish, its language and
      // the price for that finish (GET /collection resolves it the same way).
      const copy = { ...hit.card, printing, language, market_value: marketValue };
      copy.price_trend = resolveCardPrice(copy);
      hit.matched = matches(copy);
    }
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name))
    || String(a.set_id).localeCompare(String(b.set_id))
    || String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
  return [...byCard.values()]
    .filter(h => h.matched)
    .map(h => ({ ...h.card, owned_qty: h.owned }))
    .sort(byName)
    .slice(offset, offset + limit);
}

// Scryfall answered 400: it read the query and refused it. Its own explanation
// is the useful part ("All of your terms were ignored..."), so it is passed on.
async function upstreamRejected(body) {
  const { QuerySyntaxError } = await load();
  const said = body && (body.details || (Array.isArray(body.warnings) && body.warnings.join(' ')));
  return new QuerySyntaxError('upstreamRejected', { detail: String(said || 'the query was not accepted.').slice(0, 300) });
}

// The 400 body for a syntax problem, or null when `err` is anything else. The
// code and params let the frontend show it in the user's language.
function errorBody(err) {
  if (!err || err.name !== 'QuerySyntaxError') return null;
  return { error: err.message, code: err.code, params: err.params || {} };
}

module.exports = { forSearch, catalogQuery, collectionMatches, upstreamRejected, errorBody, QUERY_LANGUAGE };
