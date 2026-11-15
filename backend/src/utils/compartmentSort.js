const db = require('../db');
const { resolveCardPrice } = require('./priceHelpers');

// Card ordering lives in shared/cardSort.mjs, the one comparator the frontend draws
// cards with too, so where a card is filed and where it is shown cannot drift. The
// category orderings it reads are shared/cardOrder.json and the named schemes
// shared/sortSchemes.json. require() of an ES module needs Node 22.12 or later,
// which is the documented floor (AGENTS.md).
const cardOrder = require('../../../shared/cardOrder.json');
const sortSchemes = require('../../../shared/sortSchemes.json');
const cardSort = require('../../../shared/cardSort.mjs');
const sorter = cardSort.cardSorter(cardOrder, sortSchemes);

// Sets in release order, for the 'set' sort and its divider labels. The rank is a
// Map lookup, not a findIndex over every set: that scan ran twice per comparison,
// and was most of what re-sorting a big binder cost.
let setsCache = [];
let setRank = cardSort.setRanker(setsCache);
async function loadSetsCache(database) {
  const dbClient = database || db;
  try {
    setsCache = await dbClient.all('SELECT * FROM sets ORDER BY release_date ASC, id ASC');
    setRank = cardSort.setRanker(setsCache);
    console.log(`Loaded ${setsCache.length} sets into compartmentSort cache`);
  } catch (e) {
    console.error('Failed to load sets cache', e);
  }
}

function safeJsonParse(val, fallback = []) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch (e) {
    return fallback;
  }
}

function evaluateCompoundRules(rules, cardMetadata) {
  for (const rule of (rules || [])) {
    let matches = false;
    let cValue = cardMetadata[rule.field];
    if (typeof cValue === 'string' && (cValue.startsWith('[') || cValue.startsWith('{'))) {
      try { cValue = JSON.parse(cValue); } catch(e){}
    }

    if (rule.field === 'types') {
      let sub = cardMetadata.subtypes;
      if (typeof sub === 'string') { try { sub = JSON.parse(sub); } catch { sub = []; } }
      if (Array.isArray(sub) && sub.length) {
        const base = Array.isArray(cValue) ? cValue : (cValue == null || cValue === '' ? [] : [cValue]);
        cValue = [...base, ...sub];
      }
    }

    if (rule.operator === 'equals') {
      if (Array.isArray(cValue)) matches = cValue.some(v => String(v).toLowerCase() === String(rule.value).toLowerCase());
      else matches = String(cValue).toLowerCase() === String(rule.value).toLowerCase();
    } else if (rule.operator === 'contains') {
      if (Array.isArray(cValue)) matches = cValue.some(v => String(v).toLowerCase().includes(String(rule.value).toLowerCase()));
      else matches = String(cValue || '').toLowerCase().includes(String(rule.value).toLowerCase());
    } else if (rule.operator === '>') {
      matches = parseFloat(cValue) > parseFloat(rule.value);
    } else if (rule.operator === '<') {
      matches = parseFloat(cValue) < parseFloat(rule.value);
    } else if (rule.operator === '>=') {
      matches = parseFloat(cValue) >= parseFloat(rule.value);
    } else if (rule.operator === '<=') {
      matches = parseFloat(cValue) <= parseFloat(rule.value);
    } else if (rule.operator === 'exists') {
      matches = cValue != null && cValue !== '';
    }

    if (rule.action === 'exclude' && matches) return false;
    if (rule.action === 'include' && !matches) return false;
  }
  return true;
}

function compartmentAcceptsCard(compartment, cardMetadata) {
  const cfg = compartment && compartment.ruleConfig;
  const rules = Array.isArray(cfg) ? cfg : ((cfg && cfg.rules) || []);
  if (rules.length === 0) return true;
  return evaluateCompoundRules(rules, cardMetadata);
}

function locationAcceptsCard(location, cardMetadata) {
  if (location.game && location.game !== 'any') {
    // A row with no game predates multi-game support (utils/games LEGACY_GAME).
    const cardGame = cardMetadata.game || require('./games').LEGACY_GAME;
    if (cardGame !== location.game) return false;
  }

  if (!location.rule_type || location.rule_type === 'any') return true;

  try {
    const config = location.rule_config ? (typeof location.rule_config === 'string' ? JSON.parse(location.rule_config) : location.rule_config) : {};
    if (location.rule_type === 'compound') {
      const rules = Array.isArray(config) ? config : (config.rules || []);
      return evaluateCompoundRules(rules, cardMetadata);
    }
  } catch (e) {
    console.error('Failed to parse location rule_config', e);
  }
  return true;
}

const { isMtgCard, typeCategory } = cardSort;
const { mtgTypeCategory, cardTypeCategory } = sorter;
const getColorCategory = cardSort.colorCategory;

// What getSortCategory returned for a card before issue #88, when it differs
// from today's answer: an MTG card under a 'type' scheme used to file by
// colour. compartment_assignments written back then still name colours
// ("Red", "Multicolor"), so filing accepts either rather than silently
// dropping those pages out of rotation.
function legacySortCategory(card, sortOrder) {
  if (!isMtgCard(card) || sortPrimaryField(sortOrder) !== 'type') return null;
  return typeCategory(card.types);
}

function assignedTo(compartment, cardCat, legacyCat) {
  const filters = (compartment && compartment.assignedFilters) || [];
  return (!!cardCat && filters.includes(cardCat)) || (!!legacyCat && filters.includes(legacyCat));
}

// A container's order as one comparator (shared/cardSort.mjs), with sets ranked
// by release date.
function comparatorFor(sortOrder, foilSorting) {
  return sorter.comparator(sorter.sortCriteria(sortOrder), { foilSorting, setRank });
}

function sortCards(cards, sortOrder, foilSorting) {
  const criteria = sorter.sortCriteria(sortOrder);
  if (criteria.length === 0) return [...cards];
  return [...cards].sort(sorter.comparator(criteria, { foilSorting, setRank }));
}

function isBinderType(type) {
  return type === 'Binder';
}

function compartmentLabel(comp, locationType) {
  if (!comp) return 'Unassigned';
  if (comp.label) return comp.label;
  const noun = isBinderType(locationType) ? 'Page' : 'Row';
  return `${noun} ${comp.idx}`;
}

// Which copies share one slot in a container with allow_stacking on: the same
// printing of the same card in the same language. Condition is deliberately not
// part of it, matching the collection view's "stack duplicates", which only
// splits by condition when the owner asks it to. The SQL and JS forms have to
// agree — one counts occupancy, the other decides where a copy is filed — so
// both default a legacy NULL the same way.
const STACK_KEY_SQL = `card_id || '|' || COALESCE(printing, 'Normal') || '|' || COALESCE(language, 'English')`;
function stackKey(row) {
  const id = row.card_id !== undefined ? row.card_id : row.id;
  return `${id}|${row.printing || 'Normal'}|${row.language || 'English'}`;
}

// How full a compartment is, as SQL over its collection rows: the copies in it,
// or on a stacking container the pockets they use (one per stack). Every
// capacity check reads this one expression — it used to be written five ways,
// some counting rows and some copies — so none can disagree about when a page is
// full. `stacking` is a boolean, or a SQL expression when the query spans
// containers.
function occupancySql(stacking) {
  const stacks = `COUNT(DISTINCT ${STACK_KEY_SQL})`;
  const copies = 'COALESCE(SUM(quantity), 0)';
  if (typeof stacking === 'string') return `CASE WHEN ${stacking} THEN ${stacks} ELSE ${copies} END`;
  return stacking ? stacks : copies;
}

// Fixed slots (locations.fixed_slots): a binder can pin a set's cards to the
// pocket their collector number names, so #23 sits in slot 23 even while 1-22
// are still missing. Stored as JSON [{ set_id, start_slot, max_number }]; NULL
// means off. Slots are counted across the whole binder in page order, 1-based.
const FIXED_SLOT_LIMIT = 100000;

// Validates what a client sent and returns the JSON to store (null = off).
// Throws with a client-safe message on bad input.
function normalizeFixedSlots(input) {
  if (input === null || input === undefined || input === '') return null;
  let list = input;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { throw new Error('fixed_slots must be valid JSON'); }
  }
  if (!Array.isArray(list)) throw new Error('fixed_slots must be a list');
  if (list.length === 0) return null;
  if (list.length > 50) throw new Error('fixed_slots allows at most 50 sets');
  const intIn = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > FIXED_SLOT_LIMIT) throw new Error(`${name} must be a whole number from 1 to ${FIXED_SLOT_LIMIT}`);
    return n;
  };
  const seen = new Set();
  const out = list.map(e => {
    const setId = typeof e?.set_id === 'string' ? e.set_id.trim() : '';
    if (!setId || setId.length > 64) throw new Error('Each fixed slot entry needs a set_id');
    if (seen.has(fixedSetKey(setId))) throw new Error(`Set ${setId} is listed twice`);
    seen.add(fixedSetKey(setId));
    return {
      set_id: setId,
      start_slot: e.start_slot == null || e.start_slot === '' ? 1 : intIn(e.start_slot, 'start_slot'),
      max_number: e.max_number == null || e.max_number === '' ? null : intIn(e.max_number, 'max_number')
    };
  });
  return JSON.stringify(out);
}

// The sets table keys Scryfall sets as "mtg-<code>" while MTG cards carry the
// bare code, so compare on the bare form.
function fixedSetKey(setId) {
  return String(setId || '').toLowerCase().replace(/^mtg-/, '');
}

// Stored config -> ranges with an inclusive `end` slot, or null when off. A set
// with no max_number runs up to the next set's start slot (open-ended if last),
// so one set's high numbers never land in another set's pockets.
function fixedSlotRanges(stored) {
  const list = safeJsonParse(stored, null);
  if (!Array.isArray(list) || list.length === 0) return null;
  const sorted = list.map(e => ({ ...e, start_slot: e.start_slot || 1, key: fixedSetKey(e.set_id) }))
    .sort((a, b) => a.start_slot - b.start_slot);
  return sorted.map((e, i) => ({
    ...e,
    end: e.max_number
      ? e.start_slot + e.max_number - 1
      : (sorted[i + 1] ? sorted[i + 1].start_slot - 1 : Infinity)
  }));
}

// The binder-wide slot a card is pinned to, or null when it has none: set not
// configured, collector number not a plain integer ("123a", "TG01", "★"), or past
// the set's cap.
function fixedSlotFor(card, ranges) {
  if (!ranges || !card) return null;
  const key = fixedSetKey(card.set_id);
  const range = key && ranges.find(r => r.key === key);
  if (!range) return null;
  const num = String(card.number || '').trim();
  if (!/^\d+$/.test(num)) return null;
  const n = parseInt(num, 10);
  if (n < 1) return null;
  const slot = range.start_slot + n - 1;
  return slot <= range.end ? slot : null;
}

// Last slot any configured set reserves. Cards with no fixed slot are filed only
// on pages that start after it; Infinity means there is no such area.
function lastReservedSlot(ranges) {
  return Math.max(...ranges.map(r => r.end));
}

// First binder-wide slot of each compartment (pages in idx order, locked ones
// included: a locked page still takes up its pockets in the physical binder).
function compartmentStartSlots(compartments) {
  const starts = new Map();
  let next = 1;
  [...compartments].sort((a, b) => a.idx - b.idx).forEach(c => { starts.set(c.id, next); next += c.capacity; });
  return starts;
}

// Positions for the cards on one page of a fixed-slot binder. Pinned cards take
// their own pocket (first come keeps it; on a stacking binder a twin shares it).
// Anything else on the page — a manual placement, a second copy of a pinned card
// — keeps its pocket if that is free, otherwise takes the first free pocket no
// set reserves, then any free pocket, and only past capacity if the page is full.
function fixedPagePositions(cards, { ranges, startSlot, capacity, allowStacking }) {
  const taken = new Map(); // local slot -> stack key
  const positions = new Map();
  const claim = (local, card) => {
    const key = stackKey(card);
    if (taken.has(local) && !(allowStacking && taken.get(local) === key)) return false;
    taken.set(local, key);
    positions.set(card.id, local * 1000);
    return true;
  };
  const leftovers = [];
  for (const card of cards) {
    const slot = fixedSlotFor(card, ranges);
    const local = slot ? slot - startSlot + 1 : 0;
    if (!(local >= 1 && local <= capacity && claim(local, card))) leftovers.push(card);
  }
  const reserved = (local) => ranges.some(r => startSlot + local - 1 >= r.start_slot && startSlot + local - 1 <= r.end);
  let past = capacity;
  for (const card of leftovers) {
    const current = Math.floor((card.position || 0) / 1000);
    if (current >= 1 && current <= capacity && claim(current, card)) continue;
    let placed = false;
    for (const wantReserved of [false, true]) {
      for (let local = 1; local <= capacity && !placed; local++) {
        if (reserved(local) === wantReserved) placed = claim(local, card);
      }
    }
    if (!placed) positions.set(card.id, ++past * 1000);
  }
  return positions;
}

// Positions for a sorted page: one pocket per card, or on a stacking container one
// per stack, so the copies that share a pocket keep sharing it. Giving every row
// its own pocket there split each stack across the page the next time anything
// was filed.
function sortedPagePositions(sorted, { allowStacking }) {
  const positions = new Map();
  const stackPocket = new Map();
  let next = 0;
  for (const card of sorted) {
    if (!allowStacking) { positions.set(card.id, ++next * 1000); continue; }
    const key = stackKey(card);
    if (!stackPocket.has(key)) stackPocket.set(key, ++next * 1000);
    positions.set(card.id, stackPocket.get(key));
  }
  return positions;
}

async function loadCompartments(database, locationId, userId) {
  const dbClient = database || db;
  // The location's stacking flag rides along rather than being passed in by every
  // caller: occupancy is the one thing all of them read off these rows, and it
  // means a different thing on a stacking container (slots used, not cards held).
  const compartments = await dbClient.all(
    `SELECT c.*, l.allow_stacking FROM compartments c JOIN locations l ON c.location_id = l.id
     WHERE c.location_id = ? ORDER BY c.idx ASC`,
    [locationId]
  );
  if (compartments.length === 0) return [];
  const ids = compartments.map(c => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const filterRows = await dbClient.all(
    `SELECT compartment_id, filter_value AS category FROM compartment_assignments WHERE compartment_id IN (${placeholders})`,
    ids
  );
  const filtersByCompartment = new Map();
  filterRows.forEach(r => {
    if (!filtersByCompartment.has(r.compartment_id)) filtersByCompartment.set(r.compartment_id, []);
    filtersByCompartment.get(r.compartment_id).push(r.category);
  });

  const stacking = compartments.some(c => c.allow_stacking);
  const countRows = await dbClient.all(
    `SELECT compartment_id, ${occupancySql(stacking)} as cnt
     FROM collection WHERE user_id = ? AND compartment_id IN (${placeholders}) GROUP BY compartment_id`,
    [userId, ...ids]
  );
  const countByCompartment = new Map(countRows.map(r => [r.compartment_id, r.cnt]));

  const parseCfg = (rc) => {
    if (!rc) return null;
    try { return typeof rc === 'string' ? JSON.parse(rc) : rc; } catch (e) { return null; }
  };

  return compartments.map(c => ({
    ...c,
    assignedFilters: filtersByCompartment.get(c.id) || [],
    ruleConfig: parseCfg(c.rule_config),
    count: countByCompartment.get(c.id) || 0,
    free: c.capacity - (countByCompartment.get(c.id) || 0)
  }));
}

const SORT_SCHEME_LABELS = {
  'name-asc': 'A-Z alphabetical',
  'set-number': 'set & number',
  'set-number-printing': 'set, printing & number',
  'price-desc': 'value (high to low)',
  'type-name': 'energy type',
  'language': 'language'
};

// --- Filing -----------------------------------------------------------------
//
// Where a copy goes is decided against a Container: one storage location's
// compartments and the copies already in them, held in memory. recommendSlot
// loads one per call. A FilingPlan keeps them across a batch — filing a selection,
// adding several copies, re-sorting a whole container — so each copy is filed
// against the ones placed before it, from memory. Re-sorting used to reload and
// re-sort every card in the container for every card it filed, inside one
// transaction on the only connection: 33 seconds for 1,000 cards, with every
// other request (the Docker healthcheck included) waiting behind it.

// The copies a container holds, as filing reads them, in the order these rows have
// always come back in (the query runs on idx_collection_loc_pos): ties in a sort
// keep this order, so it is spelled out rather than left to the planner.
const LOCATION_CARDS_SQL = `
  SELECT c.id as entry_id, c.card_id, c.compartment_id, c.position, c.quantity, c.condition, c.printing, c.language, c.purchase_price, c.added_at, c.is_trade, c.favorite, c.list_type,
         cc.name, cc.printed_name, cc.supertype, cc.game, cc.types, cc.subtypes, cc.rarity, cc.set_id, cc.set_name, cc.number, cc.image_url, cc.orientation,
         cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
  FROM collection c
  JOIN card_cache cc ON c.card_id = cc.id
  WHERE c.user_id = ? AND c.location_id = ?
  ORDER BY c.position ASC, c.id ASC`;

// Types as a list and the price the copy is worth in its printing: how a stored
// copy has always been compared against the one being filed.
function readyStoredCard(card) {
  if (typeof card.types === 'string') {
    try { card.types = JSON.parse(card.types || '[]'); } catch { card.types = []; }
  } else if (!Array.isArray(card.types)) {
    card.types = [];
  }
  card.price_trend = resolveCardPrice(card);
  return card;
}

const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// The copy being filed, as the sort compares it: the defaults a stored row always
// has, and for a copy not in the collection yet the newest added_at and entry_id,
// so a newest-first container puts it first.
function filingView(card) {
  return {
    ...card,
    favorite: card.favorite ? 1 : 0,
    printing: card.printing || 'Normal',
    language: card.language || 'English',
    name: card.name || '',
    supertype: card.supertype || '',
    game: card.game || null,
    types: card.types || [],
    subtypes: card.subtypes || [],
    rarity: card.rarity || '',
    set_name: card.set_name || '',
    number: card.number || '0',
    cmc: card.cmc !== undefined ? card.cmc : null,
    color_identity: card.color_identity || null,
    entry_id: card.entry_id || Number.MAX_SAFE_INTEGER,
    added_at: card.added_at || sqliteNow(),
  };
}

// First index in `list` (sorted by cmp) whose card sorts after `card`: where a
// stable sort puts a card that arrives after every copy it ties with.
function upperBound(list, card, cmp) {
  if (list.length === 0 || cmp(list[list.length - 1], card) <= 0) return list.length;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(list[mid], card) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// "No room here: try the user's other containers." Returned by Container.decide.
const OVERFLOW = Symbol('every compartment is full');

class Container {
  // `compartments` as loadCompartments returns them (idx order, count = slots
  // used). `cards` are the location's own copies (LOCATION_CARDS_SQL rows), plus any
  // a caller has already placed in memory. With `resort`, none of them are in a
  // compartment: the container is being refilled from empty, in sorted order.
  constructor(location, compartments, cards, { resort = false } = {}) {
    this.location = location;
    this.comps = compartments.map(c => ({
      ...c,
      assignedFilters: c.assignedFilters || [],
      units: c.count || 0,
      list: [],
      rows: 0,
      pockets: new Map(),
      keys: new Map(),
    }));
    this.byId = new Map(this.comps.map(c => [c.id, c]));
    this.stacking = this.comps.some(c => c.allow_stacking) || !!location.allow_stacking;
    this.cmp = comparatorFor(location.sort_order, location.foil_sorting);
    this.resort = resort;
    this.ranges = fixedSlotRanges(location.fixed_slots);
    this.starts = this.ranges ? compartmentStartSlots(this.comps) : null;
    // stack key -> the copy a duplicate stacks onto: the first, in row order, that
    // has a pocket in an unlocked compartment.
    this.twins = new Map();
    this.seq = 0;
    // Every copy in a compartment here, in row order, and those with an entry id by
    // it, so a copy that moves can leave its old slot.
    this.members = [];
    this.byEntry = new Map();

    const byComp = new Map();
    for (const card of cards) {
      readyStoredCard(card);
      card._seq = this.seq++;
      const comp = card.compartment_id ? this.byId.get(card.compartment_id) : null;
      if (!comp) continue;
      this.track(comp, card);
      this.members.push(card);
      if (card.entry_id != null) this.byEntry.set(card.entry_id, card);
      if (!byComp.has(comp.id)) byComp.set(comp.id, []);
      byComp.get(comp.id).push(card);
    }
    for (const [compId, list] of byComp) {
      const comp = this.byId.get(compId);
      const sorted = list.slice().sort(this.cmp);
      if (!this.stacking) { comp.list = sorted; continue; }
      // One entry per stack: filing counts the pockets a page uses, not its rows.
      const seen = new Set();
      comp.list = sorted.filter(card => {
        const key = stackKey(card);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }

  // Occupancy bookkeeping for one copy in `comp`.
  track(comp, card) {
    comp.rows++;
    const pocket = Math.floor((card.position || 0) / 1000);
    comp.pockets.set(pocket, (comp.pockets.get(pocket) || 0) + 1);
    if (!this.stacking) return false;
    const key = stackKey(card);
    const had = comp.keys.get(key) || 0;
    comp.keys.set(key, had + 1);
    if (card.position > 0 && !comp.locked && !this.twins.has(key)) this.twins.set(key, card);
    return had > 0;
  }

  free(comp) {
    return comp.units < comp.capacity;
  }

  // Where `card` goes in this container: a recommendation, OVERFLOW when every
  // compartment it could use is full, or null when it cannot be filed here.
  decide(card) {
    const location = this.location;
    // A locked container accepts no auto-filed cards at all.
    if (location.locked) return null;
    // Drop locked compartments so filing never targets them; their existing cards
    // stay put and manual moves still work.
    let compartments = this.comps.filter(c => !c.locked);
    if (compartments.length === 0) return null;

    if (!locationAcceptsCard(location, card)) return null;

    // Stacking container: a duplicate rides in the pocket its twin already holds,
    // so it claims no new slot and a full container still accepts it. Checked
    // before the "everything is full" bail-out below for exactly that reason.
    if (this.stacking) {
      const twin = this.twins.get(stackKey(card));
      if (twin) {
        const twinComp = this.byId.get(twin.compartment_id);
        const seq = Math.max(1, Math.round(twin.position / 1000));
        return {
          location_id: location.id,
          compartment_id: twin.compartment_id,
          position: twin.position,
          label: `${compartmentLabel(twinComp, location.type)}, Pos ${seq} (in ${location.name})`,
          reason: `Stacked with the copy already in ${compartmentLabel(twinComp, location.type)}`,
          // Batch callers tick a compartment's occupancy down per placement; a
          // stacked copy takes no slot, so it must not count against capacity.
          stacked: true
        };
      }
    }

    // Fixed-slot binder: a pinned card goes to its own pocket when that pocket is
    // free, on an unlocked page whose rules accept it. Everything else — unpinned
    // cards, and pinned ones whose pocket is taken — is filed by the normal scheme
    // on the pages after the last reserved slot, or overflows to another container
    // (via the "full" path below) when the reserved ranges leave no such pages.
    const ranges = this.ranges;
    if (ranges) {
      const starts = this.starts;
      const slot = fixedSlotFor(card, ranges);
      const page = slot && this.comps.find(c => slot >= starts.get(c.id) && slot < starts.get(c.id) + c.capacity);
      if (page && !page.locked && compartmentAcceptsCard(page, card)) {
        const local = slot - starts.get(page.id) + 1;
        if (!page.pockets.get(local)) {
          return {
            location_id: location.id,
            compartment_id: page.id,
            position: local * 1000,
            label: `${compartmentLabel(page, location.type)}, Pos ${local} (in ${location.name})`,
            reason: `Fixed slot ${slot} for ${card.set_name || card.set_id} #${card.number}`
          };
        }
      }
      const last = lastReservedSlot(ranges);
      compartments = compartments.filter(c => starts.get(c.id) > last);
    }

    if (compartments.every(c => !this.free(c))) return OVERFLOW;

    card.price_trend = resolveCardPrice(card);
    const cardCat = getSortCategory(card, location.sort_order);
    const legacyCat = legacySortCategory(card, location.sort_order);
    const view = filingView(card);

    // The compartments this card may go in: its rules accept it, and a compartment
    // assigned to categories is one of this card's. Those assigned to it come
    // first; the open ones only when they are full.
    const eligible = compartments.filter(c => compartmentAcceptsCard(c, card) &&
      (c.assignedFilters.length === 0 || assignedTo(c, cardCat, legacyCat)));
    let pool = eligible.filter(c => c.assignedFilters.length > 0);
    if (!pool.some(c => this.free(c))) pool = eligible;
    if (!pool.some(c => this.free(c))) return null;
    pool = [...pool].sort((a, b) => a.idx - b.idx);

    if (location.sort_order === 'custom') {
      const best = pool.find(c => this.free(c));
      return {
        location_id: location.id,
        compartment_id: best.id,
        position: this.customPosition(best),
        label: `${compartmentLabel(best, location.type)} (in ${location.name})`,
        reason: 'Manual order — next open slot'
      };
    }

    // Where the card falls in the pool's sorted order, then the compartment whose
    // share of that order holds it — spilling to the next one with room. On a
    // re-sort every card is filed in order, so it lands after everything already
    // placed.
    const at = (comp) => (this.resort ? comp.list.length : upperBound(comp.list, view, this.cmp));
    let targetIndex = 0;
    for (const c of pool) targetIndex += at(c);

    let cursor = 0;
    for (let i = 0; i < pool.length; i++) {
      const compartment = pool[i];
      if (targetIndex < cursor + compartment.capacity) {
        let target = compartment;
        if (!this.free(target)) {
          target = pool.slice(i + 1).find(c => this.free(c));
          if (!target) return null;
        }
        const seq = at(target);
        // Neighbours in the TARGET compartment's own order (handles spill), so the
        // "file it after X" hint names the physical card the new one sits behind.
        const afterCard = seq > 0 ? target.list[seq - 1] : this.neighbour(pool, at, -1);
        const beforeCard = seq < target.list.length ? target.list[seq] : this.neighbour(pool, at, 1);

        let reason = `Sorted by ${schemeLabel(location.sort_order, card)}`;
        if (afterCard) reason += `, right after ${afterCard.name}`;
        else if (beforeCard) reason += `, right before ${beforeCard.name}`;
        else reason += ` — first card here`;
        if (assignedTo(target, cardCat, legacyCat)) {
          const matched = target.assignedFilters.includes(cardCat) ? cardCat : legacyCat;
          reason += ` (${compartmentLabel(target, location.type)} is assigned "${matched}")`;
        }
        return {
          location_id: location.id,
          compartment_id: target.id,
          position: (seq + 1) * 1000,
          label: `${compartmentLabel(target, location.type)}, Pos ${seq + 1} (in ${location.name})`,
          reason,
          after: afterCard ? { name: afterCard.name, image_url: afterCard.image_url || null } : null,
          before: beforeCard ? { name: beforeCard.name, image_url: beforeCard.image_url || null } : null
        };
      }
      cursor += compartment.capacity;
    }

    return null;
  }

  // The card just before (dir -1) or after (dir 1) the new one across the whole
  // pool, in sorted order with ties in row order.
  neighbour(pool, at, dir) {
    let best = null;
    for (const comp of pool) {
      const i = at(comp) + (dir < 0 ? -1 : 0);
      const card = comp.list[i];
      if (!card) continue;
      if (!best) { best = card; continue; }
      const c = this.cmp(card, best) || (card._seq - best._seq);
      if (dir < 0 ? c > 0 : c < 0) best = card;
    }
    return best;
  }

  // Custom order: a box row is an order, so the copy goes at its end; a binder page
  // is a grid of pockets the owner arranged, so it takes the first empty one
  // rather than a number past the cards already there, which could be a pocket in
  // use (a page holding pockets 2, 3 and 4 gave a fourth card pocket 4).
  customPosition(comp) {
    if (isBinderType(this.location.type)) {
      for (let pocket = 1; pocket <= comp.capacity; pocket++) {
        if (!comp.pockets.get(pocket)) return pocket * 1000;
      }
    }
    return (comp.rows + 1) * 1000;
  }

  // Record a placement this container's decide() returned, so the next copy is
  // filed against it.
  commit(card, rec) {
    const comp = this.byId.get(rec.compartment_id);
    if (!comp) return;
    const placed = readyStoredCard({ ...filingView(card), compartment_id: rec.compartment_id, position: rec.position, _seq: this.seq++ });
    this.members.push(placed);
    if (card.entry_id != null) this.byEntry.set(card.entry_id, placed);
    const stackedHere = this.track(comp, placed);
    if (this.stacking && stackedHere) return;
    comp.units += 1;
    if (this.resort) comp.list.push(placed);
    else comp.list.splice(upperBound(comp.list, placed, this.cmp), 0, placed);
  }

  // A copy leaving its slot here (it is being filed somewhere else, or somewhere
  // else in this container): the next copy is filed as if it had already gone.
  remove(entryId) {
    const card = this.byEntry.get(entryId);
    if (!card) return;
    this.byEntry.delete(entryId);
    this.members.splice(this.members.indexOf(card), 1);
    const comp = this.byId.get(card.compartment_id);
    comp.rows--;
    const pocket = Math.floor((card.position || 0) / 1000);
    if ((comp.pockets.get(pocket) || 0) > 1) comp.pockets.set(pocket, comp.pockets.get(pocket) - 1);
    else comp.pockets.delete(pocket);
    const at = comp.list.indexOf(card);
    if (at >= 0) comp.list.splice(at, 1);
    if (!this.stacking) {
      comp.units -= 1;
      return;
    }
    const key = stackKey(card);
    const sameStack = this.members.filter(c => c.compartment_id === comp.id && stackKey(c) === key);
    if (sameStack.length === 0) {
      comp.keys.delete(key);
      comp.units -= 1;
    } else {
      comp.keys.set(key, sameStack.length);
      // It stood for its stack in the order: the stack's next copy does now.
      if (at >= 0) {
        const next = sameStack.slice().sort((a, b) => this.cmp(a, b) || a._seq - b._seq)[0];
        comp.list.splice(upperBound(comp.list, next, this.cmp), 0, next);
      }
    }
    if (this.twins.get(key) === card) {
      this.twins.delete(key);
      const twin = this.members.find(c => stackKey(c) === key && c.position > 0 && !this.byId.get(c.compartment_id).locked);
      if (twin) this.twins.set(key, twin);
    }
  }
}

// 'type-name' files a Magic card by card type, not energy type.
function schemeLabel(sortOrder, card) {
  let scheme = sortOrder === 'type-name' && isMtgCard(card)
    ? 'card type'
    : (SORT_SCHEME_LABELS[sortOrder] || sortOrder);
  if (typeof scheme === 'string' && scheme.startsWith('[')) {
    try {
      const parsed = JSON.parse(scheme);
      if (Array.isArray(parsed)) {
        const prettyLabels = {
          'color_identity': 'Color Identity',
          'color': 'Color',
          'type': 'Type',
          'name': 'Name',
          'set': 'Set',
          'price': 'Price',
          'rarity': 'Rarity',
          'number': 'Number',
          'language': 'Language'
        };
        scheme = parsed.map(p => prettyLabels[p.by] || p.by).join(', ');
      }
    } catch (e) {}
  }
  return scheme;
}

const OTHER_LOCATION_COLUMNS = 'id, name, type, sort_order, foil_sorting, rule_type, rule_config, game, allow_stacking, fixed_slots, user_id';

// Several placements in a row, each against the ones before it, across every
// container a copy can overflow into. Nothing is written: callers write what
// recommend() returned, then rebalance touched() with each container's own scheme.
class FilingPlan {
  constructor(dbClient) {
    this.db = dbClient;
    this.containers = new Map();
    this.others = new Map();
    this.touchedComps = new Set();
  }

  // The plan for filing into `location`. Options are recommendSlot's old batch
  // inputs: compartments whose counts the caller has kept, and copies it has
  // placed without writing them.
  static async open(database, location, { compartments = null, extraCards = [], resort = false } = {}) {
    const plan = new FilingPlan(database || db);
    plan.primary = await plan.load(location, { compartments, extraCards, resort });
    return plan;
  }

  async load(location, { compartments = null, extraCards = [], resort = false } = {}) {
    let comps = compartments || await loadCompartments(this.db, location.id, location.user_id);
    let cards;
    if (resort) {
      // Refilled from empty. Its own copies leave their slots; anything filed in its
      // compartments under another location_id stays, and still takes room.
      cards = [];
      const ids = comps.map(c => c.id);
      const stacking = comps.some(c => c.allow_stacking);
      const rows = ids.length ? await this.db.all(
        `SELECT compartment_id, ${occupancySql(stacking)} AS cnt
           FROM collection WHERE user_id = ? AND compartment_id IN (${ids.map(() => '?').join(',')}) AND location_id IS NOT ?
          GROUP BY compartment_id`,
        [location.user_id, ...ids, location.id]
      ) : [];
      const drift = new Map(rows.map(r => [r.compartment_id, r.cnt]));
      comps = comps.map(c => ({ ...c, count: drift.get(c.id) || 0 }));
    } else {
      cards = await this.db.all(LOCATION_CARDS_SQL, [location.user_id, location.id]);
      cards.push(...extraCards.map(c => ({ ...c })));
    }
    const container = new Container(location, comps, cards, { resort });
    this.containers.set(location.id, container);
    return container;
  }

  async container(location) {
    return this.containers.get(location.id) || this.load(location);
  }

  async otherLocations(location) {
    const key = `${location.user_id}:${location.id}`;
    if (!this.others.has(key)) {
      this.others.set(key, await this.db.all(
        `SELECT ${OTHER_LOCATION_COLUMNS} FROM locations WHERE user_id = ? AND id != ? AND locked = 0 ORDER BY id ASC`,
        [location.user_id, location.id]
      ));
    }
    return this.others.get(key);
  }

  // Where `card` goes: a recommendation (location_id, compartment_id, position,
  // label, reason, and the neighbours to file it next to), or null when nowhere has
  // room. When its own container is full, the user's other unlocked containers are
  // tried in id order — each visited once, so two full containers can no longer
  // send a card back and forth until the stack overflows.
  async recommend(card) {
    return this.recommendIn(this.primary, card, new Set([this.primary.location.id]));
  }

  async recommendIn(container, card, visited) {
    const rec = container.decide(card);
    if (rec !== OVERFLOW) return rec;
    for (const otherLoc of await this.otherLocations(container.location)) {
      if (visited.has(otherLoc.id)) continue;
      const other = await this.container(otherLoc);
      if (!other.comps.some(c => c.capacity - c.units > 0)) continue;
      const otherRec = await this.recommendIn(other, card, new Set([...visited, otherLoc.id]));
      if (otherRec) {
        return {
          ...otherRec,
          reason: `"${container.location.name}" is full — overflowed to "${otherLoc.name}". ${otherRec.reason || ''}`.trim()
        };
      }
    }
    return null;
  }

  // Keep a placement recommend() returned, so later copies are filed around it. A
  // copy already in the collection leaves the slot it had, as it will once written.
  commit(card, rec) {
    if (!rec) return;
    if (card.entry_id != null) for (const loaded of this.containers.values()) loaded.remove(card.entry_id);
    const container = this.containers.get(rec.location_id);
    if (container) container.commit(card, rec);
    this.touchedComps.add(rec.compartment_id);
  }

  // Compartments a placement went into, to rebalance once the batch is written.
  touched() {
    return [...this.touchedComps];
  }
}

async function recommendSlot(database, location, cardMetadata, overrideCompartments = null, mockCards = []) {
  const plan = await FilingPlan.open(database || db, location, { compartments: overrideCompartments, extraCards: mockCards });
  return plan.recommend(cardMetadata);
}

// Re-sorting a container: every copy in it filed again from empty, in the order
// its scheme gives them, in one pass. Nothing is written. Returns `placed`, one
// { entry, recommended } per copy in that order (recommended null where there was
// no room, plus rejected: true where the container's rules refuse the card), and
// the plan, whose touched() names the compartments filled.
async function planResort(database, location) {
  const dbClient = database || db;
  const cards = await dbClient.all(`
    SELECT c.id as entry_id, c.card_id, c.printing, c.language, c.quantity, c.favorite, c.is_trade, c.list_type, c.added_at,
           cc.name, cc.printed_name, cc.set_id, cc.set_name, cc.number, cc.types, cc.subtypes, cc.rarity, cc.supertype, cc.image_url, cc.orientation, cc.game,
           cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
    FROM collection c
    JOIN card_cache cc ON c.card_id = cc.id
    WHERE c.location_id = ? AND c.user_id = ?
    ORDER BY c.position ASC, c.id ASC
  `, [location.id, location.user_id]);
  cards.forEach(c => { try { c.types = JSON.parse(c.types || '[]'); } catch { c.types = []; } });

  const plan = await FilingPlan.open(dbClient, location, { resort: true });
  const placed = [];
  for (const entry of sortCards(cards, location.sort_order, location.foil_sorting)) {
    const recommended = await plan.recommend(entry);
    if (recommended) {
      plan.commit(entry, recommended);
      placed.push({ entry, recommended });
    } else {
      placed.push({ entry, recommended: null, ...(!location.locked && !locationAcceptsCard(location, entry) ? { rejected: true } : {}) });
    }
  }
  return { placed, plan };
}

// Write placements in chunks: { id, location_id, compartment_id, position } per
// copy, all the user's. One statement per hundred copies rather than per copy.
async function writePlacements(database, placements, userId) {
  const dbClient = database || db;
  const CHUNK = 100;
  for (let i = 0; i < placements.length; i += CHUNK) {
    const chunk = placements.slice(i, i + CHUNK);
    const caseOf = () => `CASE id ${chunk.map(() => 'WHEN ? THEN ?').join(' ')} END`;
    const params = [];
    for (const field of ['location_id', 'compartment_id', 'position']) {
      for (const p of chunk) params.push(p.id, p[field]);
    }
    await dbClient.run(
      `UPDATE collection SET location_id = ${caseOf()}, compartment_id = ${caseOf()}, position = ${caseOf()}
        WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(',')})`,
      [...params, userId, ...chunk.map(p => p.id)]
    );
  }
}

// The new order is computed from one read and written back in chunks, so it is
// one transaction: a write landing in between would be overwritten from stale
// positions, and a chunk failing part way would leave two cards on one slot.
function rebalanceCompartmentByScheme(database, compartmentId, sortOrder, foilSorting) {
  return db.withTransaction(() => rebalanceCompartment(database, compartmentId, sortOrder, foilSorting));
}

// Rebalance each compartment with its own container's scheme. A batch can file
// into several containers (a card overflows into the next one), and every one of
// them is renumbered by the order it keeps, not the order of the container the
// batch started in.
async function rebalanceCompartments(database, compartmentIds) {
  const dbClient = database || db;
  for (const compartmentId of new Set(compartmentIds)) {
    if (!compartmentId) continue;
    const loc = await dbClient.get(
      `SELECT l.sort_order, l.foil_sorting FROM compartments cp JOIN locations l ON l.id = cp.location_id WHERE cp.id = ?`,
      [compartmentId]
    );
    if (loc) await rebalanceCompartmentByScheme(dbClient, compartmentId, loc.sort_order, loc.foil_sorting);
  }
}

async function rebalanceCompartment(database, compartmentId, sortOrder, foilSorting) {
  const dbClient = database || db;
  const cards = await dbClient.all(
    `SELECT c.*, c.id as entry_id, cc.name, cc.printed_name, cc.set_id, cc.set_id as set_code, cc.set_name, cc.number, cc.types, cc.subtypes, cc.supertype, cc.game, cc.rarity, cc.price_trend
     FROM collection c
     LEFT JOIN card_cache cc ON c.card_id = cc.id
     WHERE c.compartment_id = ?
     ORDER BY c.position ASC, c.id ASC`,
    [compartmentId]
  );

  if (!cards || cards.length === 0) return;

  // On a fixed-slot binder the reserved pages keep their gaps: renumbering them
  // 1..n would slide #23 into slot 1. Pages past the reserved range sort as usual.
  let positions = null;
  const loc = await dbClient.get(
    `SELECT l.id, l.type, l.fixed_slots, l.allow_stacking FROM compartments cp JOIN locations l ON l.id = cp.location_id WHERE cp.id = ?`,
    [compartmentId]
  );
  const ranges = loc && fixedSlotRanges(loc.fixed_slots);
  if (ranges) {
    const comps = await dbClient.all(`SELECT id, idx, capacity FROM compartments WHERE location_id = ?`, [loc.id]);
    const startSlot = compartmentStartSlots(comps).get(Number(compartmentId));
    const capacity = comps.find(c => c.id === Number(compartmentId)).capacity;
    if (startSlot <= lastReservedSlot(ranges)) {
      positions = fixedPagePositions(cards, { ranges, startSlot, capacity, allowStacking: !!loc.allow_stacking });
    }
  }
  if (!positions) {
    // A Custom binder page is a grid the owner arranged pocket by pocket: gaps are
    // part of it. Renumbering it 1..n turned pockets 1, 5 and 9 into 1, 2 and 3
    // after any add. A Custom box row is an order, and is still renumbered.
    if (sortOrder === 'custom' && loc && isBinderType(loc.type)) return;
    positions = sortedPagePositions(sortCards(cards, sortOrder, foilSorting), { allowStacking: !!(loc && loc.allow_stacking) });
  }

  const entries = [...positions];
  const CHUNK_SIZE = 100;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    let posCaseStr = 'CASE id ';
    const params = [];
    const ids = [];

    chunk.forEach(([id, newPos]) => {
      posCaseStr += `WHEN ? THEN ? `;
      params.push(id, newPos);
      ids.push(id);
    });
    posCaseStr += 'END';

    const placeholders = ids.map(() => '?').join(',');
    const sql = `UPDATE collection SET position = (${posCaseStr}) WHERE id IN (${placeholders})`;
    await dbClient.run(sql, [...params, ...ids]);
  }
}

// The field a container files by (its first divider, else its first criterion),
// or null when it has none.
function sortPrimaryField(sortOrder) {
  if (!sortOrder || sortOrder === 'custom') return null;
  let criteria = [];
  if (typeof sortOrder === 'string') {
    if (sortOrder.startsWith('[')) {
      try { criteria = JSON.parse(sortOrder); } catch(e){}
    } else {
      criteria = [{by: sortOrder.split('-')[0], divider: true}];
    }
  } else if (Array.isArray(sortOrder)) {
    criteria = sortOrder;
  }
  if (!criteria || criteria.length === 0) return null;

  const dividers = criteria.filter(c => c.divider === true);
  if (dividers.length === 0 && criteria.some(c => c.divider === false)) {
    return null;
  }

  return dividers.length > 0 ? dividers[0].by : criteria[0].by;
}

function getSortCategory(card, sortOrder) {
  if (!card) return null;
  const primary = sortPrimaryField(sortOrder);
  if (!primary) return null;

  if (primary === 'name') return card.name ? card.name.charAt(0).toUpperCase() : '?';
  if (primary === 'set') {
    if (!card.set_name) return 'Unknown Set';
    if (!setsCache || setsCache.length === 0) return card.set_name;
    const idx = setRank(card.set_name);
    return idx < 999999 ? `${idx + 1}. ${card.set_name}` : card.set_name;
  }
  if (primary === 'color_identity' || primary === 'color') {
    return getColorCategory(card);
  }
  if (primary === 'type') return cardTypeCategory(card);
  if (primary === 'price') {
    const p = card.price_trend || 0;
    if (p >= 100) return '$100+';
    if (p >= 50) return '$50+';
    if (p >= 20) return '$20+';
    if (p >= 10) return '$10+';
    if (p >= 5) return '$5+';
    if (p >= 1) return '$1+';
    return '< $1';
  }
  if (primary === 'language') return card.language || 'English';
  if (primary === 'cmc') return `CMC ${card.cmc != null ? card.cmc : '?'}`;
  if (primary === 'rarity') return card.rarity || 'Common';

  return null;
}

module.exports = {
  sortCards,
  compartmentLabel,
  isBinderType,
  loadCompartments,
  recommendSlot,
  FilingPlan,
  planResort,
  writePlacements,
  rebalanceCompartmentByScheme,
  rebalanceCompartments,
  locationAcceptsCard,
  compartmentAcceptsCard,
  loadSetsCache,
  getSortCategory,
  cardTypeCategory,
  mtgTypeCategory,
  safeJsonParse,
  stackKey,
  STACK_KEY_SQL,
  occupancySql,
  normalizeFixedSlots,
  fixedSlotRanges,
  fixedSlotFor,
  fixedPagePositions
};
