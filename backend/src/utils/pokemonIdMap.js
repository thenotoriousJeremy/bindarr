// Which TCGdex or pokemontcgapi.com card a pokemontcg.io card id names.
//
// pokemontcg.io stops serving on 1 March 2027 (pokemonProvider.POKEMONTCG_SUNSET),
// and every row an install collected while it was the provider is keyed by its
// ids: `sv1-1`, `swsh12pt5gg-GG01`, `pgo-28`. Its successors number the same cards
// differently — TCGdex writes `sv01-001`, files Pokémon GO under swsh10.5 and 151
// under sv03.5 — so no rewrite rule turns one id into the other. What carries
// across is what is printed on the card: the set it belongs to and its collector
// number. This module maps on those, pure and synchronous, so the whole decision
// table can be tested from fixtures; fetching and re-keying live in
// pokemonMigration.js.
//
// The rule that shapes everything here: never guess. A wrong mapping is worse than
// none, because it silently files a user's card as a different card and the price,
// art and set completion that follow are confidently wrong. So every way two
// candidates can tie, or a number can land on a differently named card, comes back
// `ambiguous` and stays on its old id for a person to look at.
const { matcher, normId, fold } = require('./setCatalogueMatch');

// Every other provider prefixes the ids it mints (see cardApi.js); pokemontcg.io's
// are a bare `<set>-<number>`. Its set codes are lower-case letters and digits and
// its numbers carry no dash, which keeps `mtg-<uuid>` and `tcgdex-en-sv01-001` out
// before the prefix check; pokemonMigration also requires a Pokémon card_cache row.
const LEGACY_ID = /^([a-z0-9]+)-([^\s-]+)$/;
const FOREIGN = new Set(['mtg', 'tcgdex', 'pokemontcgapi', 'lorcana']);

function parseLegacyId(id) {
  const m = LEGACY_ID.exec(String(id || ''));
  if (!m || FOREIGN.has(m[1])) return null;
  return { set_id: m[1], number: m[2] };
}
const isLegacyId = (id) => parseLegacyId(id) !== null;

// A collector number as both providers can agree on it.
//
// pokemontcg.io writes `1`, `TG01`, `SV1`; TCGdex writes `001`, `TG01`, `SV001`;
// TCGplayer writes `004/165`. So: drop a `/total`, separators and case, and the
// zeros padding a digit run, whether it starts the number or follows a letter.
// Letters are kept, never stripped: `28a` is not card 28, and `TG12` and `SV12`
// are different cards of one set.
function numKey(raw) {
  let s = fold(String(raw == null ? '' : raw)).trim().toUpperCase();
  s = s.split('/')[0].trim().replace(/^#/, '');
  s = s.replace(/[\s_.-]+/g, '');
  return s.replace(/^0+(?=\d)/, '').replace(/([A-Z])0+(?=\d)/g, '$1');
}

// Names as a cross-check, never as the key. The providers spell the same card
// differently often enough ("M Charizard-EX" / "Mega Charizard EX", a trainer's
// name in brackets, curly apostrophes) that equality would refuse half the good
// matches; what this has to catch is a number landing on a different card
// altogether, which shares next to nothing with the one asked for.
const nameKey = (s) => fold(s).toLowerCase()
  .replace(/\([^)]*\)/g, ' ')
  .replace(/δ/g, ' ')
  .replace(/[^a-z0-9♀♂]/g, '');

function dice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g);
    if (n) { hits++; grams.set(g, n - 1); }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

// Missing on either side is not evidence against a match: a deck can reference an
// id this install never cached, and then the set and number are all there is.
function namesCompatible(a, b) {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return dice(x, y) >= 0.6;
}

// pokemontcg.io gives a set's subset its own set — the Trainer Gallery of
// Brilliant Stars is `swsh9tg`, Crown Zenith's Galarian Gallery `swsh12pt5gg`,
// Shining Fates' Shiny Vault `swsh45sv` — where a successor may keep those cards
// inside the parent set under the same TG/GG/SV numbers. When the subset has no
// set of its own on the other side, its parent is the next place to look.
//
// The name has to say it is a subset; an id that merely ends in `c` or `sv` is not
// evidence of anything. The id is only trimmed when it carries the matching
// suffix, otherwise the parent is found by name alone (Hidden Fates' vault is
// `sma`, which trims to nothing useful).
const SUBSETS = [
  { id: /tg$/, name: /[\s:–-]*trainer gallery$/i },
  { id: /gg$/, name: /[\s:–-]*galarian gallery$/i },
  { id: /sv$/, name: /[\s:–-]*shiny vault$/i },
  { id: /c$/, name: /[\s:–-]*classic collection$/i },
];

function subsetParent(setId, setName) {
  const name = String(setName || '');
  for (const rule of SUBSETS) {
    if (!rule.name.test(name)) continue;
    const id = rule.id.test(String(setId || '')) ? String(setId).replace(rule.id, '') : '';
    return { id, name: name.replace(rule.name, '').trim() };
  }
  return null;
}

// pokemontcg.io writes a half set as `pt5` (sv3pt5, swsh12pt5) where the others
// write `.5` (sv03.5, swsh12.5). Trying that spelling lets an id find its set
// without leaning on the name.
const halfSet = (id) => String(id || '').replace(/pt5/g, '.5');

// Id evidence first, either spelling, then the name. setCatalogueMatch already
// refuses keys two sets claim, so a name shared by two target sets finds nothing.
function findSet(match, id, name) {
  if (id) {
    const hit = match(id) || (halfSet(id) !== id ? match(halfSet(id)) : null);
    if (hit) return hit;
  }
  return name ? match('', name) : null;
}

// The target sets a source set's cards can be in: its own counterpart, then the
// parent a subset may have been folded into.
function setCandidates(match, setId, setName) {
  const out = [];
  const add = (s) => { if (s && !out.includes(s)) out.push(s); };
  add(findSet(match, setId, setName));
  const parent = subsetParent(setId, setName);
  if (parent) add(findSet(match, parent.id, parent.name));
  return out;
}

function indexByNumber(cards) {
  const byNumber = new Map();
  for (const card of cards || []) {
    const key = numKey(card.number);
    if (!key) continue;
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key).push(card);
  }
  return byNumber;
}

const lower = (s) => String(s || '').toLowerCase();
const uniqueById = (cards) => [...new Map(cards.filter(Boolean).map(c => [c.id, c])).values()];
const brief = (c) => ({ id: c.id, set_id: c.set_id || '', set_name: c.set_name || '', number: c.number || '', name: c.name || '' });
const setNumberKey = (setId, number) => `${lower(setId)}|${numKey(number)}`;

// The TCGplayer product a source card was priced as: the id stored on its row,
// else the product map's entry for its set and number. Null when neither knows.
function sourceProductOf(src, bySetNumber = new Map()) {
  return Number(src.product_id || bySetNumber.get(setNumberKey(src.set_id, src.number)) || 0) || null;
}

// Which target sets need listing before anything can be classified: every source
// set's candidates, plus the sets the TCGplayer product map places a source's
// product in (the product-only path below reads those listings too).
function setsToList({ sources, targetSets, products = {} }) {
  const match = matcher(targetSets || []);
  const catalog = products.catalog || new Map();
  const out = new Set();
  const seen = new Set();
  for (const src of sources || []) {
    const key = `${lower(src.set_id)}|${src.set_name || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      for (const s of setCandidates(match, src.set_id, src.set_name)) out.add(s.id);
    }
    const entry = catalog.get(sourceProductOf(src, products.bySetNumber));
    if (entry) for (const s of setCandidates(match, entry.set_id, entry.set_name)) out.add(s.id);
  }
  return [...out];
}

// Classify every source id. Input:
//
//   sources     [{ id, set_id, set_name, number, name, product_id }]
//   targetSets  [{ id, name }]                 the target provider's English sets
//   listings    Map<targetSetId, card[]>       card: { id, set_id, set_name, number, name, product_id? }
//   failedSets  Set<targetSetId>               listings that could not be fetched
//   products    { ofTarget: Map<targetId, productId>,   from card_cache / tcgplayer_product
//                 known: Map<targetId, card>,           target rows behind ofTarget
//                 catalog: Map<productId, { set_id, set_name, number }>,   the TCGCSV product map
//                 bySetNumber: Map<'set|numKey', productId|null> }       the same map, keyed back
//
// Returns one entry per source:
//
//   { old_id, class, method, confirmed, reason, new_id, target, candidates, target_sets }
//
//   class      mapped     one card at that set and number, its name agrees, and no
//                         product id says otherwise
//              product    no set-and-number match, but the source's TCGplayer
//                         product names exactly one target card
//              ambiguous  candidates exist and none can be chosen without guessing
//              unmapped   nothing to choose from
//   confirmed  both sides carry the same TCGplayer product id
function buildPlan({ sources, targetSets, listings = new Map(), failedSets = new Set(), products = {} }) {
  const match = matcher(targetSets || []);
  const indexes = new Map();
  const cardById = new Map();
  for (const [setId, cards] of listings) {
    indexes.set(setId, indexByNumber(cards));
    for (const c of cards) cardById.set(c.id, c);
  }
  const ofTarget = products.ofTarget || new Map();
  const known = products.known || new Map();
  const catalog = products.catalog || new Map();
  const bySetNumber = products.bySetNumber || new Map();
  const byProduct = new Map();
  const claim = (pid, id) => {
    if (!pid || !id) return;
    const key = Number(pid);
    if (!byProduct.has(key)) byProduct.set(key, new Set());
    byProduct.get(key).add(id);
  };
  for (const [id, pid] of ofTarget) claim(pid, id);
  for (const c of cardById.values()) claim(c.product_id, c.id);

  const productOf = (card) => Number(card.product_id || ofTarget.get(card.id)
    || bySetNumber.get(setNumberKey(card.set_id, card.number)) || 0) || null;
  const inSets = (sets, number) => {
    const key = numKey(number);
    if (!key) return [];
    return uniqueById(sets.flatMap(s => (indexes.get(s.id) && indexes.get(s.id).get(key)) || []));
  };

  // The product-only path: the TCGplayer product the source was priced as, and the
  // target card(s) that same product names — directly, where a target row carries
  // the id, or through the product map's own set and number for it. A target id
  // with no row behind it has nothing to check a name against, so it is dropped.
  const productCandidates = (pid) => {
    if (!pid) return [];
    const out = [...(byProduct.get(pid) || [])].map(id => cardById.get(id) || known.get(id));
    const entry = catalog.get(pid);
    if (entry) out.push(...inSets(setCandidates(match, entry.set_id, entry.set_name), entry.number));
    return uniqueById(out);
  };

  const entries = (sources || []).map((src) => {
    const direct = findSet(match, src.set_id, src.set_name);
    const base = {
      old_id: src.id, source: src, new_id: null, target: null, candidates: [], confirmed: false, method: null, reason: null,
      direct_set: direct ? direct.id : null,
    };
    if (!src.set_id && !src.number) return { ...base, class: 'unmapped', reason: 'no_card_data', target_sets: [] };
    const sets = setCandidates(match, src.set_id, src.set_name);
    const target_sets = sets.map(s => s.id);
    const listed = sets.filter(s => indexes.has(s.id));
    const pid = sourceProductOf(src, bySetNumber);
    const mapped = (card, cls, method, confirmed) => ({
      ...base, target_sets, class: cls, method, confirmed: !!confirmed,
      new_id: card.id, target: card, candidates: [brief(card)],
    });
    const ambiguous = (reason, cards) => ({ ...base, target_sets, class: 'ambiguous', reason, candidates: uniqueById(cards).map(brief) });

    const byNumber = inSets(listed, src.number);
    const named = byNumber.filter(c => namesCompatible(src.name, c.name));
    if (named.length === 1) {
      const other = productOf(named[0]);
      if (pid && other && pid !== other) return ambiguous('product_mismatch', [named[0], ...productCandidates(pid)]);
      return mapped(named[0], 'mapped', 'set-number', pid && other === pid);
    }
    if (named.length > 1) {
      // Two cards at one number (a stamped variant, a reprint the target keeps in
      // the same set): only a product id both sides agree on may choose.
      const agreed = pid ? named.filter(c => productOf(c) === pid) : [];
      if (agreed.length === 1) return mapped(agreed[0], 'mapped', 'set-number', true);
      return ambiguous('several_cards', named);
    }

    const byProductId = productCandidates(pid);
    const productNamed = byProductId.filter(c => namesCompatible(src.name, c.name));
    if (productNamed.length === 1) return mapped(productNamed[0], 'product', 'product-id', true);
    if (productNamed.length > 1) return ambiguous('several_products', productNamed);
    if (byNumber.length || byProductId.length) return ambiguous('name_mismatch', [...byNumber, ...byProductId]);

    let reason = 'number_not_found';
    if (!sets.length) reason = 'set_not_found';
    else if (!listed.length || sets.some(s => failedSets.has(s.id))) reason = 'listing_failed';
    return { ...base, target_sets, class: 'unmapped', reason };
  });

  // Two old ids landing on one new id means one of them is wrong (or the target
  // merged two printings), and nothing here can say which: both stay put.
  const byNew = new Map();
  for (const e of entries) {
    if (!e.new_id) continue;
    if (!byNew.has(e.new_id)) byNew.set(e.new_id, []);
    byNew.get(e.new_id).push(e);
  }
  for (const group of byNew.values()) {
    if (group.length < 2) continue;
    for (const e of group) {
      Object.assign(e, { class: 'ambiguous', reason: 'same_target', new_id: null, target: null, confirmed: false, method: null });
    }
  }
  return entries;
}

// Which source sets can move as a whole, for storage settings that name a set
// (binder fixed slots, set rules). A set moves when every referenced card of it
// mapped, all into one target set that is its own counterpart, and no other
// source set maps there; otherwise a rule rewritten to the new set would stop
// matching the cards left behind, or start matching cards it never meant — a
// Galarian Gallery rule rewritten to the whole of Crown Zenith, say. Sets nothing
// references fall back to the set-level match alone: no cards contradict it.
function setMoves(entries, { targetSets = [], storageSets = [] } = {}) {
  const bySource = new Map();
  const sourcesOf = new Map();
  for (const e of entries || []) {
    const s = lower(e.source && e.source.set_id);
    if (!s) continue;
    const slot = bySource.get(s) || { targets: new Map(), unresolved: 0, indirect: null, name: e.source.set_name || '' };
    if (e.new_id) {
      slot.targets.set(e.target.set_id, e.target.set_name || '');
      // Landed somewhere other than the set's own counterpart: a parent the subset
      // was folded into, or (product-only) a set no id or name pointed at.
      if (e.target.set_id !== e.direct_set) slot.indirect = e.method === 'product-id' ? 'no_counterpart' : 'merged';
      if (!sourcesOf.has(e.target.set_id)) sourcesOf.set(e.target.set_id, new Set());
      sourcesOf.get(e.target.set_id).add(s);
    } else {
      slot.unresolved++;
    }
    bySource.set(s, slot);
  }
  const moves = new Map();
  const blocked = new Map();
  for (const [s, slot] of bySource) {
    if (slot.unresolved) { blocked.set(s, 'cards_left'); continue; }
    if (slot.targets.size !== 1) { blocked.set(s, 'split'); continue; }
    if (slot.indirect) { blocked.set(s, slot.indirect); continue; }
    const [[target, name]] = slot.targets;
    if (sourcesOf.get(target).size !== 1) { blocked.set(s, 'merged'); continue; }
    moves.set(s, { set_id: target, set_name: name, from_name: slot.name });
  }
  const match = matcher(targetSets);
  const targetIds = new Set(targetSets.map(t => lower(t.id)));
  for (const { id, name } of storageSets) {
    const s = lower(id);
    if (!s || moves.has(s) || blocked.has(s) || targetIds.has(s)) continue;
    const hit = findSet(match, s, name);
    if (hit && !sourcesOf.has(hit.id)) moves.set(s, { set_id: hit.id, set_name: hit.name || '', from_name: name || '' });
  }
  return { moves, blocked };
}

const parseJson = (v) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return undefined; }
};

// Rewrite the set ids a fixed-slots list names. Returns the new JSON, or null when
// nothing changed. Compared the way compartmentSort.fixedSetKey compares them.
function remapFixedSlots(stored, moves) {
  const list = parseJson(stored);
  if (!Array.isArray(list)) return null;
  let changed = false;
  const out = list.map((e) => {
    const move = e && moves.get(lower(e.set_id));
    if (!move) return e;
    changed = true;
    return { ...e, set_id: move.set_id };
  });
  return changed ? JSON.stringify(out) : null;
}

// Rewrite `set_id equals …` and `set_name equals …` rules (compartmentSort's
// compound rules, stored either as a bare list or under `rules`). Returns the new
// JSON, or null when nothing changed.
function remapRules(stored, moves) {
  const cfg = parseJson(stored);
  const rules = Array.isArray(cfg) ? cfg : (cfg && Array.isArray(cfg.rules) ? cfg.rules : null);
  if (!rules) return null;
  const byName = new Map([...moves.values()].filter(m => m.from_name && m.set_name).map(m => [lower(m.from_name), m]));
  let changed = false;
  const next = rules.map((r) => {
    if (!r || r.operator !== 'equals') return r;
    if (r.field === 'set_id' && moves.has(lower(r.value))) {
      changed = true;
      return { ...r, value: moves.get(lower(r.value)).set_id };
    }
    const named = r.field === 'set_name' && byName.get(lower(r.value));
    if (named && named.set_name !== r.value) {
      changed = true;
      return { ...r, value: named.set_name };
    }
    return r;
  });
  if (!changed) return null;
  return JSON.stringify(Array.isArray(cfg) ? next : { ...cfg, rules: next });
}

// Set ids a stored storage setting names, for setMoves' set-level fallback.
function storageSetIds(fixedSlots, ruleConfigs) {
  const out = [];
  const list = parseJson(fixedSlots);
  if (Array.isArray(list)) for (const e of list) if (e && e.set_id) out.push(String(e.set_id));
  for (const stored of ruleConfigs || []) {
    const cfg = parseJson(stored);
    const rules = Array.isArray(cfg) ? cfg : (cfg && Array.isArray(cfg.rules) ? cfg.rules : []);
    for (const r of rules) if (r && r.field === 'set_id' && r.operator === 'equals' && r.value) out.push(String(r.value));
  }
  return out;
}

module.exports = {
  parseLegacyId, isLegacyId, numKey, namesCompatible, subsetParent, halfSet, findSet, setCandidates,
  indexByNumber, sourceProductOf, setsToList, buildPlan, setMoves, remapFixedSlots, remapRules, storageSetIds,
  setNumberKey, normId,
};
