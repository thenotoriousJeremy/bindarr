const db = require('../db');
const { resolveCardPrice } = require('./priceHelpers');

let setsCache = [];
async function loadSetsCache(database) {
  const dbClient = database || db;
  try {
    setsCache = await dbClient.all('SELECT * FROM sets ORDER BY release_date ASC, id ASC');
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

function prepareCardMetadata(card) {
  if (!card) return card;
  return {
    ...card,
    parsed_types: Array.isArray(card.types) ? card.types : safeJsonParse(card.types, []),
    parsed_subtypes: Array.isArray(card.subtypes) ? card.subtypes : safeJsonParse(card.subtypes, []),
    parsed_color_identity: Array.isArray(card.color_identity) ? card.color_identity : safeJsonParse(card.color_identity, [])
  };
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

// Canonical category orderings shared with the frontend. See shared/cardOrder.json.
const cardOrder = require('../../../shared/cardOrder.json');
const sortSchemes = require('../../../shared/sortSchemes.json');
const POKEMON_TYPE_ORDER = cardOrder.pokemonType;
const PRINTING_ORDER_NORMALS_FIRST = cardOrder.printingNormalsFirst;
const PRINTING_ORDER_FOILS_FIRST = cardOrder.printingFoilsFirst;
const LANGUAGE_ORDER = cardOrder.language;
const WUBRG_ORDER = cardOrder.wubrg;

const MTG_CARD_TYPE_ORDER = cardOrder.mtgCardType;

function typeCategory(types) {
  const t = Array.isArray(types) ? types : safeJsonParse(types, []);
  if (t.length > 1) return 'Multicolor';
  return t[0] || 'Colorless';
}

// `types` holds colours for an MTG card (the deck colour charts read it that
// way), so the card's type line — split into words in `subtypes` — is what a
// "type" sort has to read instead. `supertype` is the fallback for rows that
// were selected without the game column.
function isMtgCard(card) {
  return !!card && (card.game === 'mtg' || card.supertype === 'MTG');
}

// One card-type category per MTG card; see shared/cardOrder.json for why the
// pick order is what it is. Mirrors mtgTypeCategory in frontend/src/utils/cardSort.js.
function mtgTypeCategory(subtypes) {
  const list = Array.isArray(subtypes) ? subtypes : safeJsonParse(subtypes, []);
  const words = new Set((Array.isArray(list) ? list : []).map(w => String(w).toLowerCase()));
  return cardOrder.mtgCardTypePick.find(type => words.has(type.toLowerCase())) || 'Other';
}

// The category a card sorts, groups and is filed under for the 'type' field:
// card type for Magic, the type/ink list as before for Pokémon and Lorcana.
function cardTypeCategory(card) {
  if (isMtgCard(card)) return mtgTypeCategory(card.subtypes);
  return typeCategory(card && card.types);
}

function typeRank(card) {
  const order = isMtgCard(card) ? MTG_CARD_TYPE_ORDER : POKEMON_TYPE_ORDER;
  return order[cardTypeCategory(card)] || 50;
}

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

function getColorCategory(card) {
  if (!card) return 'Colorless';
  let ci = [];
  if (typeof card.color_identity === 'string') {
    try { ci = JSON.parse(card.color_identity); } catch(e){ if (card.color_identity) ci = [card.color_identity]; }
  } else if (Array.isArray(card.color_identity)) {
    ci = card.color_identity;
  }
  if (!ci || ci.length === 0) return 'Colorless';
  if (ci.length > 1) return 'Multicolor';
  const names = { 'W': 'White', 'U': 'Blue', 'B': 'Black', 'R': 'Red', 'G': 'Green' };
  return names[ci[0]] || ci[0] || 'Colorless';
}

const RARITY_RANK = [
  ['classic collection', 16], ['hyper', 15], ['special illustration', 14],
  ['illustration', 13], ['secret', 12], ['ultra', 11], ['radiant', 10],
  ['amazing', 9], ['shiny', 8], ['double rare', 7], ['mythic', 6],
  ['rare holo', 5], ['holo rare', 5], ['promo', 4], ['rare', 3],
  ['uncommon', 2], ['common', 1],
];
function rarityRank(rarity) {
  const r = (rarity || '').toLowerCase();
  for (const [kw, rank] of RARITY_RANK) if (r.includes(kw)) return rank;
  return 0;
}

function sortCards(cards, sortOrder, foilSorting) {
  let criteria = [];
  if (typeof sortOrder === 'string') {
    if (sortOrder.startsWith('[')) {
      try { criteria = JSON.parse(sortOrder); } catch(e){}
    } else {
      criteria = sortSchemes[sortOrder] || [];
    }
  } else if (Array.isArray(sortOrder)) {
    criteria = sortOrder;
  }

  const printingOrder = foilSorting === 'foils_first' ? PRINTING_ORDER_FOILS_FIRST : PRINTING_ORDER_NORMALS_FIRST;

  if (!criteria || criteria.length === 0) return [...cards];

  const sorted = [...cards];
  sorted.sort((a, b) => {
    for (const c of criteria) {
      const dirMult = c.dir === 'desc' ? -1 : 1;
      let cmp = 0;
      switch (c.by) {
        case 'favorite':
          cmp = (a.favorite ? 1 : 0) - (b.favorite ? 1 : 0);
          break;
        case 'name':
          cmp = (a.name || '').localeCompare(b.name || '');
          break;
        case 'price':
          cmp = (a.price_trend || 0) - (b.price_trend || 0);
          break;
        case 'set': {
          const setAIndex = setsCache.findIndex(s => s.name === a.set_name);
          const setBIndex = setsCache.findIndex(s => s.name === b.set_name);
          const cmpSetChrono = (setAIndex >= 0 ? setAIndex : 999999) - (setBIndex >= 0 ? setBIndex : 999999);
          if (cmpSetChrono !== 0) { cmp = cmpSetChrono; break; }
          cmp = (a.set_name || '').localeCompare(b.set_name || '');
          break;
        }
        case 'number': {
          const nA = parseInt(a.number || '0', 10);
          const nB = parseInt(b.number || '0', 10);
          if (!isNaN(nA) && !isNaN(nB) && nA !== nB) { cmp = nA - nB; break; }
          cmp = (a.number || '').localeCompare(b.number || '');
          break;
        }
        case 'printing':
          cmp = (printingOrder[a.printing] || 10) - (printingOrder[b.printing] || 10);
          break;
        case 'type':
          cmp = typeRank(a) - typeRank(b);
          break;
        case 'language': {
          const la = LANGUAGE_ORDER[a.language] || 99;
          const lb = LANGUAGE_ORDER[b.language] || 99;
          cmp = la - lb;
          break;
        }
        case 'cmc':
          cmp = (a.cmc || 0) - (b.cmc || 0);
          break;
        case 'color_identity':
        case 'color': {
          const catA = getColorCategory(a);
          const catB = getColorCategory(b);
          const orderA = WUBRG_ORDER[catA] || 99;
          const orderB = WUBRG_ORDER[catB] || 99;
          cmp = orderA - orderB;
          if (cmp === 0) cmp = catA.localeCompare(catB);
          break;
        }
        case 'rarity':
          cmp = rarityRank(a.rarity) - rarityRank(b.rarity);
          break;
      }
      if (cmp !== 0) return cmp * dirMult;
    }
    return 0;
  });
  return sorted;
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
    `SELECT compartment_id, ${stacking ? `COUNT(DISTINCT ${STACK_KEY_SQL})` : 'SUM(quantity)'} as cnt
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

async function recommendSlot(database, location, cardMetadata, overrideCompartments = null, mockCards = []) {
  const dbClient = database || db;
  // A locked container accepts no auto-filed cards at all.
  if (location.locked) return null;
  // Drop locked compartments so filing never targets them; their existing cards
  // stay put and manual moves still work.
  const allCompartments = overrideCompartments || await loadCompartments(dbClient, location.id, location.user_id);
  let compartments = allCompartments.filter(c => !c.locked);
  if (compartments.length === 0) return null;

  if (!locationAcceptsCard(location, cardMetadata)) {
    return null;
  }

  const allLocationCards = await dbClient.all(`
    SELECT c.id as entry_id, c.card_id, c.compartment_id, c.position, c.quantity, c.condition, c.printing, c.language, c.purchase_price, c.added_at, c.is_trade, c.favorite, c.list_type,
           cc.name, cc.printed_name, cc.supertype, cc.game, cc.types, cc.subtypes, cc.rarity, cc.set_id, cc.set_name, cc.number, cc.image_url,
           cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
    FROM collection c
    JOIN card_cache cc ON c.card_id = cc.id
    WHERE c.user_id = ? AND c.location_id = ?
  `, [location.user_id, location.id]);

  allLocationCards.push(...mockCards);

  allLocationCards.forEach(c => {
    if (typeof c.types === 'string') {
      try { c.types = JSON.parse(c.types || '[]'); } catch { c.types = []; }
    } else if (!Array.isArray(c.types)) {
      c.types = [];
    }
    c.price_trend = resolveCardPrice(c);
  });

  const cardsByCompId = new Map();
  allLocationCards.forEach(c => {
    if (!c.compartment_id) return;
    if (!cardsByCompId.has(c.compartment_id)) cardsByCompId.set(c.compartment_id, []);
    cardsByCompId.get(c.compartment_id).push(c);
  });

  // Stacking container: a duplicate rides in the pocket its twin already holds,
  // so it claims no new slot and a full container still accepts it. Checked
  // before the "everything is full" bail-out below for exactly that reason.
  if (location.allow_stacking) {
    const key = stackKey(cardMetadata);
    const twin = allLocationCards.find(c =>
      c.position > 0 && compartments.some(comp => comp.id === c.compartment_id) && stackKey(c) === key
    );
    if (twin) {
      const twinComp = compartments.find(comp => comp.id === twin.compartment_id);
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

  const countOf = (c) => overrideCompartments
    ? (overrideCompartments.find(oc => oc.id === c.id)?.count || 0)
    : (c.count !== undefined ? c.count : (cardsByCompId.get(c.id) || []).reduce((sum, card) => sum + (card.quantity || 1), 0));

  // Fixed-slot binder: a pinned card goes to its own pocket when that pocket is
  // free, on an unlocked page whose rules accept it. Everything else — unpinned
  // cards, and pinned ones whose pocket is taken — is filed by the normal scheme
  // on the pages after the last reserved slot, or overflows to another container
  // (via the "full" path below) when the reserved ranges leave no such pages.
  const ranges = fixedSlotRanges(location.fixed_slots);
  if (ranges) {
    const starts = compartmentStartSlots(allCompartments);
    const slot = fixedSlotFor(cardMetadata, ranges);
    const page = slot && allCompartments.find(c => slot >= starts.get(c.id) && slot < starts.get(c.id) + c.capacity);
    if (page && !page.locked && compartmentAcceptsCard(page, cardMetadata)) {
      const local = slot - starts.get(page.id) + 1;
      const occupied = allLocationCards.some(c => c.compartment_id === page.id && Math.floor((c.position || 0) / 1000) === local);
      if (!occupied) {
        return {
          location_id: location.id,
          compartment_id: page.id,
          position: local * 1000,
          label: `${compartmentLabel(page, location.type)}, Pos ${local} (in ${location.name})`,
          reason: `Fixed slot ${slot} for ${cardMetadata.set_name || cardMetadata.set_id} #${cardMetadata.number}`
        };
      }
    }
    const last = lastReservedSlot(ranges);
    compartments = compartments.filter(c => starts.get(c.id) > last);
  }

  const allCompartmentsFull = compartments.every(c => countOf(c) >= c.capacity);

  if (allCompartmentsFull) {
    const otherLocations = await dbClient.all(
      `SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, game, allow_stacking, fixed_slots, user_id FROM locations WHERE user_id = ? AND id != ? AND locked = 0 ORDER BY id ASC`,
      [location.user_id, location.id]
    );
    for (const otherLoc of otherLocations) {
      const otherComps = await loadCompartments(dbClient, otherLoc.id, location.user_id);
      const hasSpace = otherComps.some(c => c.free > 0);
      if (hasSpace) {
        const rec = await recommendSlot(dbClient, otherLoc, cardMetadata, otherComps);
        if (rec) {
          return {
            ...rec,
            location_id: otherLoc.id,
            reason: `"${location.name}" is full — overflowed to "${otherLoc.name}". ${rec.reason || ''}`.trim()
          };
        }
      }
    }
    return null;
  }

  cardMetadata.price_trend = resolveCardPrice(cardMetadata);
  const cardCat = getSortCategory(cardMetadata, location.sort_order);
  const legacyCat = legacySortCategory(cardMetadata, location.sort_order);

  const dynamicCatsByCompId = new Map();
  compartments.forEach(c => {
    const compCards = cardsByCompId.get(c.id) || [];
    const cardCats = compCards.map(card => getSortCategory(card, location.sort_order)).filter(Boolean);
    dynamicCatsByCompId.set(c.id, Array.from(new Set(cardCats)));
  });

  const validComps = compartments.filter(c => {
    if (!compartmentAcceptsCard(c, cardMetadata)) return false;

    if (c.assignedFilters && c.assignedFilters.length > 0) {
      return assignedTo(c, cardCat, legacyCat);
    }
    
    if (location.type !== 'binder') {
      return true;
    }

    const dCats = dynamicCatsByCompId.get(c.id) || [];
    if (dCats.length > 0) {
      return cardCat && dCats.includes(cardCat);
    }
    
    return true;
  });

  const assignedComps = validComps.filter(c => {
    if (c.assignedFilters && c.assignedFilters.length > 0) return true;
    if (location.type !== 'binder') return false;
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    return dCats.length > 0;
  });
  
  const unassignedComps = validComps.filter(c => {
    if (c.assignedFilters && c.assignedFilters.length > 0) return false;
    if (location.type !== 'binder') return true;
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    return dCats.length === 0;
  });

  let pool = [...assignedComps];
  
  const poolHasFreeSpace = pool.some(c => countOf(c) < c.capacity);

  if (pool.length === 0 || !poolHasFreeSpace) {
    pool = [...pool, ...unassignedComps];
  }

  const hasFreeSpace = (c) => countOf(c) < c.capacity;

  if (pool.length === 0 || !pool.some(hasFreeSpace)) {
    pool = compartments.filter(c =>
      compartmentAcceptsCard(c, cardMetadata) &&
      (!(c.assignedFilters && c.assignedFilters.length > 0) ||
      assignedTo(c, cardCat, legacyCat))
    );
  }

  if (pool.length === 0 || !pool.some(hasFreeSpace)) {
    return null;
  }

  pool.sort((a, b) => a.idx - b.idx);

  if (location.sort_order === 'custom') {
    const usableCandidates = pool.filter(c => countOf(c) < c.capacity);
    const best = usableCandidates.find(c => {
      const cats = dynamicCatsByCompId.get(c.id) || [];
      return cardCat && cats.includes(cardCat);
    }) || usableCandidates.find(c => {
      const cats = dynamicCatsByCompId.get(c.id) || [];
      return cats.length === 0;
    }) || usableCandidates[0];

    if (!best) return null;
    const bestCards = cardsByCompId.get(best.id) || [];
    let reason = 'Manual order — next open slot';
    if (cardCat && (best.assignedFilters || []).includes(cardCat)) {
      reason = `${compartmentLabel(best, location.type)} is assigned to "${cardCat}"`;
    } else if (cardCat && (dynamicCatsByCompId.get(best.id) || []).includes(cardCat)) {
      reason = `${compartmentLabel(best, location.type)} already holds "${cardCat}" cards`;
    }
    return {
      location_id: location.id,
      compartment_id: best.id,
      position: (bestCards.length + 1) * 1000,
      label: `${compartmentLabel(best, location.type)} (in ${location.name})`,
      reason
    };
  }

  const poolIds = pool.map(c => c.id);
  const existingCardsInPool = allLocationCards.filter(c => poolIds.includes(c.compartment_id));

  const newCard = {
    entry_id: -1,
    favorite: cardMetadata.favorite ? 1 : 0,
    printing: cardMetadata.printing || 'Normal',
    language: cardMetadata.language || 'English',
    name: cardMetadata.name || '',
    supertype: cardMetadata.supertype || '',
    game: cardMetadata.game || null,
    types: cardMetadata.types || [],
    // An MTG card's type sort reads its type line, which lives here.
    subtypes: cardMetadata.subtypes || [],
    rarity: cardMetadata.rarity || '',
    set_name: cardMetadata.set_name || '',
    number: cardMetadata.number || '0',
    price_trend: resolveCardPrice(cardMetadata),
    cmc: cardMetadata.cmc !== undefined ? cardMetadata.cmc : null,
    color_identity: cardMetadata.color_identity || null
  };

  const sorted = sortCards([...existingCardsInPool, newCard], location.sort_order, location.foil_sorting);
  const targetIndex = sorted.findIndex(c => c.entry_id === -1);
  if (targetIndex === -1) return null;

  // 'type-name' files a Magic card by card type, not energy type.
  let scheme = location.sort_order === 'type-name' && isMtgCard(cardMetadata)
    ? 'card type'
    : (SORT_SCHEME_LABELS[location.sort_order] || location.sort_order);
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
  const prevCard = targetIndex > 0 ? sorted[targetIndex - 1] : null;
  const nextCard = targetIndex < sorted.length - 1 ? sorted[targetIndex + 1] : null;



  const localSeq = (comp) => {
    const cc = cardsByCompId.get(comp.id) || [];
    const ls = sortCards([...cc, newCard], location.sort_order, location.foil_sorting);
    const idx = ls.findIndex(c => c.entry_id === -1);
    return idx === -1 ? cc.length : idx;
  };

  let cursor = 0;
  for (let i = 0; i < pool.length; i++) {
    const compartment = pool[i];
    if (targetIndex < cursor + compartment.capacity) {
      let target = compartment;
      let seq = localSeq(target);
      if (countOf(target) >= target.capacity) {
        const spill = pool.slice(i + 1).find(c => countOf(c) < c.capacity);
        if (!spill) return null;
        target = spill;
        seq = localSeq(spill);
      }
      // Neighbours in the TARGET compartment's own order (handles spill), so the
      // "file it after X" hint names the physical card the new one sits behind.
      const targetLocal = sortCards([...(cardsByCompId.get(target.id) || []), newCard], location.sort_order, location.foil_sorting);
      const li = targetLocal.findIndex(c => c.entry_id === -1);
      const afterCard = li > 0 ? targetLocal[li - 1] : (prevCard || null);
      const beforeCard = (li !== -1 && li < targetLocal.length - 1) ? targetLocal[li + 1] : (nextCard || null);

      let reason = `Sorted by ${scheme}`;
      if (afterCard) reason += `, right after ${afterCard.name}`;
      else if (beforeCard) reason += `, right before ${beforeCard.name}`;
      else reason += ` — first card here`;
      if (assignedTo(target, cardCat, legacyCat)) {
        const matched = (target.assignedFilters || []).includes(cardCat) ? cardCat : legacyCat;
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

// The new order is computed from one read and written back in chunks, so it is
// one transaction: a write landing in between would be overwritten from stale
// positions, and a chunk failing part way would leave two cards on one slot.
function rebalanceCompartmentByScheme(database, compartmentId, sortOrder, foilSorting) {
  return db.withTransaction(() => rebalanceCompartment(database, compartmentId, sortOrder, foilSorting));
}

async function rebalanceCompartment(database, compartmentId, sortOrder, foilSorting) {
  const dbClient = database || db;
  const cards = await dbClient.all(
    `SELECT c.*, cc.name, cc.printed_name, cc.set_id, cc.set_id as set_code, cc.set_name, cc.number, cc.types, cc.subtypes, cc.supertype, cc.game, cc.rarity, cc.price_trend
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
    `SELECT l.id, l.fixed_slots, l.allow_stacking FROM compartments cp JOIN locations l ON l.id = cp.location_id WHERE cp.id = ?`,
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
    positions = new Map(sortCards(cards, sortOrder, foilSorting).map((card, idx) => [card.id, (idx + 1) * 1000]));
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
    const idx = setsCache.findIndex(s => s.name === card.set_name);
    return idx >= 0 ? `${idx + 1}. ${card.set_name}` : card.set_name;
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
  rebalanceCompartmentByScheme,
  locationAcceptsCard,
  compartmentAcceptsCard,
  loadSetsCache,
  getSortCategory,
  cardTypeCategory,
  mtgTypeCategory,
  prepareCardMetadata,
  safeJsonParse,
  stackKey,
  STACK_KEY_SQL,
  normalizeFixedSlots,
  fixedSlotRanges,
  fixedSlotFor,
  fixedPagePositions
};
