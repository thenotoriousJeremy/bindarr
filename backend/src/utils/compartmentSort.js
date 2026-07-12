// Single source of truth for "where should this card go" — replaces the old
// getSortedPositionForCard (server) and findNextRecommendedSlot (client, a
// 150-line duplicate that re-derived the same logic from sub_location
// strings). Every container type (binder page, box row, deck box slot) is
// just a compartment with a capacity, so one implementation covers all of
// them instead of branching on location.type everywhere.
const { resolveCardPrice, rebalanceCompartmentPositions } = require('./priceHelpers');

let setsCache = [];
async function loadSetsCache(db) {
  try {
    setsCache = await db.all('SELECT * FROM sets ORDER BY release_date ASC, id ASC');
    console.log(`Loaded ${setsCache.length} sets into compartmentSort cache`);
  } catch (e) {
    console.error('Failed to load sets cache', e);
  }
}



// Evaluates compound include/exclude rules against a card. Returns true if the
// card is allowed: every 'exclude' rule must miss and every 'include' rule hit.
// Shared by container-level (locationAcceptsCard) and per-compartment rules.
function evaluateCompoundRules(rules, cardMetadata) {
  for (const rule of (rules || [])) {
    let matches = false;
    let cValue = cardMetadata[rule.field];
    if (typeof cValue === 'string' && (cValue.startsWith('[') || cValue.startsWith('{'))) {
      try { cValue = JSON.parse(cValue); } catch(e){}
    }

    // MTG stores card-type words (Land, Creature, Instant...) in `subtypes` (the
    // whole type line is split into it) while `types` holds colors. The filter
    // UI lists card types under the "types" field, so a "types = Land" rule must
    // also see subtypes or it silently never matches a Mountain.
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

// A compartment with its own rule_config only accepts cards satisfying those
// rules. No rules → accepts anything (container + category logic still apply).
function compartmentAcceptsCard(compartment, cardMetadata) {
  const cfg = compartment && compartment.ruleConfig;
  const rules = Array.isArray(cfg) ? cfg : ((cfg && cfg.rules) || []);
  if (rules.length === 0) return true;
  return evaluateCompoundRules(rules, cardMetadata);
}

function locationAcceptsCard(location, cardMetadata) {
  // Game restriction is orthogonal to the alphabetical/set rules below and
  // applies first: an MTG-only container never accepts a Pokémon card, etc.
  if (location.game && location.game !== 'any') {
    const cardGame = cardMetadata.game || 'pokemon';
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

// Must stay aligned with POKEMON_TYPE_ORDER in frontend/src/utils/cardSort.js —
// the frontend renders compartments in this order and the backend places cards
// by it; a mismatch makes the REC SPOT ghost point at the wrong slot.
// Pokémon energy types first, then MTG colors in WUBRG order, then Multicolor.
// Both games share the one 'type-name' scheme so a mixed binder files each card
// deterministically. Must stay aligned with TYPE_ORDER in
// frontend/src/utils/cardSort.js so the REC SPOT ghost points at the right slot.
const POKEMON_TYPE_ORDER = {
  'Grass': 1, 'Fire': 2, 'Water': 3, 'Lightning': 4, 'Psychic': 5,
  'Fighting': 6, 'Darkness': 7, 'Metal': 8, 'Fairy': 9, 'Dragon': 10, 'Colorless': 11, 'Trainer': 12, 'Energy': 13,
  'White': 20, 'Blue': 21, 'Black': 22, 'Red': 23, 'Green': 24, 'Multicolor': 25
};

// Sort category for a card's types under the 'type-name' scheme: multi-color
// MTG cards bucket together (after mono-color), no types = Colorless.
function typeCategory(types) {
  const t = Array.isArray(types) ? types : [];
  if (t.length > 1) return 'Multicolor';
  return t[0] || 'Colorless';
}

const PRINTING_ORDER_NORMALS_FIRST = { 'Normal': 1, 'Reverse Holofoil': 2, 'Holofoil': 3, '1st Edition': 4, 'Promo': 5 };
const PRINTING_ORDER_FOILS_FIRST = { 'Reverse Holofoil': 1, 'Holofoil': 2, 'Normal': 3, '1st Edition': 4, 'Promo': 5 };

// Filing order for the 'language' scheme. Mirrors LANGUAGES in
// frontend/src/utils/cardOptions.js; anything unlisted files last. This is the
// home for non-Latin (e.g. Japanese) cards that an A-Z alphabetical range
// can't place by first letter.
const LANGUAGE_ORDER = { 'English': 1, 'Japanese': 2, 'German': 3, 'French': 4, 'Spanish': 5, 'Italian': 6 };

// Scarcity rank for the 'rarity' sort: higher = rarer. Checked rarest-keyword
// first ("Rare Secret" scores secret, not plain rare; "Uncommon" before
// "Common"). Must stay aligned with RARITY_RANK in
// frontend/src/utils/cardRarity.js so placement matches display order.
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
      if (sortOrder === 'name-asc') criteria = [{by:'name', dir:'asc'}];
      else if (sortOrder === 'price-desc') criteria = [{by:'price', dir:'desc'}];
      else if (sortOrder === 'set-number') criteria = [{by:'set', dir:'asc'}];
      else if (sortOrder === 'set-number-printing') criteria = [{by:'set', dir:'asc'}, {by:'printing', dir:'asc'}];
      else if (sortOrder === 'type-name') criteria = [{by:'type', dir:'asc'}, {by:'name', dir:'asc'}];
      else if (sortOrder === 'language') criteria = [{by:'language', dir:'asc'}, {by:'name', dir:'asc'}];
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
        case 'name':
          cmp = (a.name || '').localeCompare(b.name || '');
          break;
        case 'price':
          cmp = (a.price_trend || 0) - (b.price_trend || 0);
          break;
        case 'set': {
          // Set identity only; ties fall through to the next criterion (so
          // Set > Color > CMC isn't pre-empted by number). Use a separate
          // 'number' rule to order within a set.
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
        case 'type': {
          const orderA = POKEMON_TYPE_ORDER[typeCategory(a.types)] || 50;
          const orderB = POKEMON_TYPE_ORDER[typeCategory(b.types)] || 50;
          cmp = orderA - orderB;
          break;
        }
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
          let cA = 'Colorless';
          if (typeof a.color_identity === 'string') {
            try { const p = JSON.parse(a.color_identity); if (p.length > 0) cA = p[0]; } catch(e){}
          } else if (Array.isArray(a.color_identity) && a.color_identity.length > 0) {
            cA = a.color_identity[0];
          }
          let cB = 'Colorless';
          if (typeof b.color_identity === 'string') {
            try { const p = JSON.parse(b.color_identity); if (p.length > 0) cB = p[0]; } catch(e){}
          } else if (Array.isArray(b.color_identity) && b.color_identity.length > 0) {
            cB = b.color_identity[0];
          }
          const wubrg = { 'W': 1, 'White': 1, 'U': 2, 'Blue': 2, 'B': 3, 'Black': 3, 'R': 4, 'Red': 4, 'G': 5, 'Green': 5, 'Colorless': 6 };
          cmp = (wubrg[cA] || 99) - (wubrg[cB] || 99);
          if (cmp === 0) cmp = cA.localeCompare(cB);
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

function compartmentLabel(compartment, locationType) {
  if (compartment.label) return compartment.label;
  const isBinder = locationType === 'Binder' || locationType === 'Toploader Binder';
  return isBinder ? `Page ${compartment.idx}` : `Row ${compartment.idx}`;
}

function getSortCategory(card, sortOrder) {
  if (!card || !sortOrder || sortOrder === 'custom') return null;
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
    return null; // User explicitly disabled all dividers, don't categorize
  }

  const primary = dividers.length > 0 ? dividers[0].by : criteria[0].by;

  if (primary === 'name') return card.name ? card.name.charAt(0).toUpperCase() : '?';
  if (primary === 'set') {
    if (!card.set_name) return 'Unknown Set';
    if (!setsCache || setsCache.length === 0) return card.set_name;
    const idx = setsCache.findIndex(s => s.name === card.set_name);
    return idx >= 0 ? `${idx + 1}. ${card.set_name}` : card.set_name;
  }
  if (primary === 'color_identity' || primary === 'color') {
    let ci = 'Colorless';
    if (typeof card.color_identity === 'string') {
      try { const p = JSON.parse(card.color_identity); if (p.length > 0) ci = p[0]; } catch(e){}
    } else if (Array.isArray(card.color_identity) && card.color_identity.length > 0) {
      ci = card.color_identity[0];
    }
    const names = { 'W': 'White', 'U': 'Blue', 'B': 'Black', 'R': 'Red', 'G': 'Green' };
    return names[ci] || ci || 'Colorless';
  }
  if (primary === 'type') {
    let types = [];
    if (card.types) {
      try {
        types = typeof card.types === 'string' ? JSON.parse(card.types) : card.types;
      } catch (e) { types = Array.isArray(card.types) ? card.types : []; }
    }
    return typeCategory(types);
  }
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

// Loads every compartment for a location with its current card count and
// assigned sets, so callers get one consistent view instead of separate
// queries scattered around.
async function loadCompartments(db, locationId, userId) {
  const compartments = await db.all(
    `SELECT id, idx, label, capacity, rule_config FROM compartments WHERE location_id = ? ORDER BY idx ASC`,
    [locationId]
  );
  if (compartments.length === 0) return [];

  const ids = compartments.map(c => c.id);
  const placeholders = ids.map(() => '?').join(',');

  const assignmentRows = await db.all(
    `SELECT compartment_id, filter_value FROM compartment_assignments WHERE compartment_id IN (${placeholders})`,
    ids
  );
  const filtersByCompartment = new Map();
  assignmentRows.forEach(r => {
    if (!filtersByCompartment.has(r.compartment_id)) filtersByCompartment.set(r.compartment_id, []);
    filtersByCompartment.get(r.compartment_id).push(r.filter_value);
  });

  const countRows = await db.all(
    `SELECT compartment_id, COUNT(*) as cnt FROM collection WHERE user_id = ? AND compartment_id IN (${placeholders}) GROUP BY compartment_id`,
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

// Human-readable names for the sort schemes, used in recommendation reasons.
const SORT_SCHEME_LABELS = {
  'name-asc': 'A-Z alphabetical',
  'set-number': 'set & number',
  'set-number-printing': 'set, printing & number',
  'price-desc': 'value (high to low)',
  'type-name': 'energy type',
  'language': 'language'
};

// Recommends a {compartment_id, position, label, reason} for placing
// cardMetadata (name/set_name/number/types/rarity/price_trend/printing) into
// a location. `reason` is a short human-readable justification for the pick.
// overrideCompartments lets a caller (e.g. a bulk "apply all" action) pass a
// simulated in-memory snapshot instead of hitting the DB fresh each call, so
// a batch of cards never collide on the same slot.
async function recommendSlot(db, location, cardMetadata, overrideCompartments = null, mockCards = []) {
  const compartments = overrideCompartments || await loadCompartments(db, location.id, location.user_id);
  if (compartments.length === 0) return null;

  // Container-level rule first: a card this location doesn't accept must never
  // "overflow" out of it (the full-container branch below would otherwise fire
  // before any rule check and emit a misleading "overflowed from <this>" hop).
  if (!locationAcceptsCard(location, cardMetadata)) {
    return null;
  }

  const cardSet = cardMetadata.set_name;

  // 1. Get all cards in this location to check which sets are currently in which compartments
  const allLocationCards = await db.all(`
    SELECT c.id as entry_id, c.compartment_id, c.printing, c.language, cc.name, cc.supertype, cc.types, cc.rarity, cc.set_name, cc.number,
           cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
    FROM collection c
    JOIN card_cache cc ON c.card_id = cc.id
    WHERE c.user_id = ? AND c.location_id = ?
  `, [location.user_id, location.id]);

  allLocationCards.push(...mockCards);

  allLocationCards.forEach(c => {
    // mockCards persist across batch iterations, so types may already be a
    // parsed array — JSON.parse would then throw and wipe the type info.
    if (typeof c.types === 'string') {
      try { c.types = JSON.parse(c.types || '[]'); } catch { c.types = []; }
    } else if (!Array.isArray(c.types)) {
      c.types = [];
    }
    c.price_trend = resolveCardPrice(c);
  });

  // Group cards by compartment ID
  const cardsByCompId = new Map();
  allLocationCards.forEach(c => {
    if (!c.compartment_id) return;
    if (!cardsByCompId.has(c.compartment_id)) cardsByCompId.set(c.compartment_id, []);
    cardsByCompId.get(c.compartment_id).push(c);
  });

  // Check if this location is full
  const allCompartmentsFull = compartments.every(c => {
    const count = overrideCompartments
      ? (overrideCompartments.find(oc => oc.id === c.id)?.count || 0)
      : (cardsByCompId.get(c.id) || []).length;
    return count >= c.capacity;
  });

  if (allCompartmentsFull) {
    // Look for other locations of the same user
    const otherLocations = await db.all(
      `SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, game, user_id FROM locations WHERE user_id = ? AND id != ? ORDER BY id ASC`,
      [location.user_id, location.id]
    );
    for (const otherLoc of otherLocations) {
      const otherComps = await loadCompartments(db, otherLoc.id, location.user_id);
      const hasSpace = otherComps.some(c => c.free > 0);
      if (hasSpace) {
        const rec = await recommendSlot(db, otherLoc, cardMetadata, otherComps);
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

  // Resolve the printing-specific price before deriving the category so
  // price-bucket filters see the same number sortCards will sort by.
  cardMetadata.price_trend = resolveCardPrice(cardMetadata);
  const cardCat = getSortCategory(cardMetadata, location.sort_order);

  // 2. Compartment-level strict filters
  // A compartment can ONLY accept a card if:
  // - It has explicit assignedSets, AND the card matches one of them.
  // - It has NO explicit assignedSets, BUT it has dynamic cards matching the category.
  // - It has NO explicit assignedSets AND NO dynamic cards (it is completely empty/unassigned).
  
  const dynamicCatsByCompId = new Map();
  compartments.forEach(c => {
    const compCards = cardsByCompId.get(c.id) || [];
    const cardCats = compCards.map(card => getSortCategory(card, location.sort_order)).filter(Boolean);
    dynamicCatsByCompId.set(c.id, Array.from(new Set(cardCats)));
  });

  const validComps = compartments.filter(c => {
    // Per-compartment filing rules are a hard gate: a row/page with its own
    // rule_config never accepts a card those rules reject.
    if (!compartmentAcceptsCard(c, cardMetadata)) return false;

    // If it has explicit filters, it MUST match
    if (c.assignedFilters && c.assignedFilters.length > 0) {
      return cardCat && c.assignedFilters.includes(cardCat);
    }
    
    // Boxes don't restrict rows based on dynamic contents. They are continuous.
    if (location.type !== 'binder') {
      return true;
    }

    const dCats = dynamicCatsByCompId.get(c.id) || [];
    // If it has NO explicit filters, but has cards, it only accepts matching dynamic category
    if (dCats.length > 0) {
      return cardCat && dCats.includes(cardCat);
    }
    
    // If it has no explicit filters and no dynamic cards, it accepts anything
    return true;
  });

  // Separate into preferred (assigned/matching) vs unassigned
  const assignedComps = validComps.filter(c => {
    if (c.assignedFilters && c.assignedFilters.length > 0) return true;
    if (location.type !== 'binder') return false; // Boxes don't prefer rows dynamically
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
  
  // Check if assigned pool has space
  const poolHasFreeSpace = pool.some(c => {
    const count = overrideCompartments
      ? (overrideCompartments.find(oc => oc.id === c.id)?.count || 0)
      : (cardsByCompId.get(c.id) || []).length;
    return count < c.capacity;
  });

  // If no assigned compartments have space (or none exist), fallback to unassigned
  if (pool.length === 0 || !poolHasFreeSpace) {
    pool = [...pool, ...unassignedComps];
  }
  
  // Check if final pool has free space
  const hasFreeSpace = (c) => {
    const count = overrideCompartments
      ? (overrideCompartments.find(oc => oc.id === c.id)?.count || 0)
      : (cardsByCompId.get(c.id) || []).length;
    return count < c.capacity;
  };

  if (pool.length === 0 || !pool.some(hasFreeSpace)) {
    // Soft fallback: dynamic categories are inferred preferences, not user
    // rules. When every category-matching/empty compartment is taken, place
    // into any compartment WITHOUT an explicit filter mismatch rather than
    // reporting "full" while pockets sit empty. Explicit filters stay hard.
    pool = compartments.filter(c =>
      compartmentAcceptsCard(c, cardMetadata) &&
      (!(c.assignedFilters && c.assignedFilters.length > 0) ||
      (cardCat && c.assignedFilters.includes(cardCat)))
    );
  }

  if (pool.length === 0 || !pool.some(hasFreeSpace)) {
    return null;
  }

  pool.sort((a, b) => a.idx - b.idx);

  // Handle custom sort order recommendation
  if (location.sort_order === 'custom') {
    const usableCandidates = pool.filter(c => {
      const count = overrideCompartments
        ? (overrideCompartments.find(oc => oc.id === c.id)?.count || 0)
        : (cardsByCompId.get(c.id) || []).length;
      return count < c.capacity;
    });
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

  // Structured sort:
  const poolIds = pool.map(c => c.id);
  const existingCardsInPool = allLocationCards.filter(c => poolIds.includes(c.compartment_id));

  const newCard = {
    entry_id: -1,
    printing: cardMetadata.printing || 'Normal',
    language: cardMetadata.language || 'English',
    name: cardMetadata.name || '',
    supertype: cardMetadata.supertype || '',
    types: cardMetadata.types || [],
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

  let scheme = SORT_SCHEME_LABELS[location.sort_order] || location.sort_order;
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

  const countOf = (c) => overrideCompartments
    ? (overrideCompartments.find(oc => oc.id === c.id)?.count || 0)
    : (cardsByCompId.get(c.id) || []).length;

  let cursor = 0;
  for (let i = 0; i < pool.length; i++) {
    const compartment = pool[i];
    if (targetIndex < cursor + compartment.capacity) {
      let target = compartment;
      let seq = targetIndex - cursor;
      // The capacity-window walk assumes every earlier compartment is packed
      // to capacity, which isn't true when pages/rows have gaps. If the card
      // sorts into a compartment that's already full, spill it to the start of
      // the next pool compartment with room instead of overfilling this one —
      // the auto-placement path trusts this result without a capacity recheck.
      if (countOf(target) >= target.capacity) {
        const spill = pool.slice(i + 1).find(c => countOf(c) < c.capacity);
        if (!spill) return null;
        target = spill;
        seq = countOf(spill); // append after the cards already there
      }
      let reason = `Sorted by ${scheme}`;
      if (prevCard) reason += `, right after ${prevCard.name}`;
      else if (nextCard) reason += `, right before ${nextCard.name}`;
      else reason += ` — first card here`;
      if (cardCat && (target.assignedFilters || []).includes(cardCat)) {
        reason += ` (${compartmentLabel(target, location.type)} is assigned "${cardCat}")`;
      }
      return {
        location_id: location.id,
        compartment_id: target.id,
        position: (seq + 1) * 1000,
        label: `${compartmentLabel(target, location.type)}, Pos ${seq + 1} (in ${location.name})`,
        reason
      };
    }
    cursor += compartment.capacity;
  }

  return null;
}

// Renumbers a compartment's cards so stored `position` matches the container's
// sort scheme (1000, 2000, ...). Incremental inserts assign a colliding
// (seq+1)*1000 and the old position-only rebalance couldn't tell #10 from #50
// on a tie; re-deriving from the scheme here keeps display order, the "place
// here" label, and REC SPOT all in agreement. Custom order = manual, so it
// falls back to honoring the existing position order.
async function rebalanceCompartmentByScheme(db, compartmentId, userId, location) {
  if (!compartmentId) return;
  if (!location || location.sort_order === 'custom') {
    return rebalanceCompartmentPositions(db, compartmentId, userId);
  }
  const cards = await db.all(`
    SELECT c.id, c.printing, c.language, cc.name, cc.supertype, cc.types, cc.rarity, cc.set_name, cc.number,
           cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
    FROM collection c JOIN card_cache cc ON c.card_id = cc.id
    WHERE c.compartment_id = ? AND c.user_id = ?
  `, [compartmentId, userId]);
  cards.forEach(c => {
    try { c.types = JSON.parse(c.types || '[]'); } catch { c.types = []; }
    c.price_trend = resolveCardPrice(c);
  });
  const sorted = sortCards(cards, location.sort_order, location.foil_sorting);
  for (let i = 0; i < sorted.length; i++) {
    await db.run(`UPDATE collection SET position = ? WHERE id = ?`, [(i + 1) * 1000, sorted[i].id]);
  }
}

module.exports = { sortCards, compartmentLabel, loadCompartments, recommendSlot, rebalanceCompartmentByScheme, locationAcceptsCard, loadSetsCache, getSortCategory };
