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

// Canonical category orderings shared with the frontend. See shared/cardOrder.json.
const cardOrder = require('../../../shared/cardOrder.json');
const sortSchemes = require('../../../shared/sortSchemes.json');
const POKEMON_TYPE_ORDER = cardOrder.pokemonType;
const PRINTING_ORDER_NORMALS_FIRST = cardOrder.printingNormalsFirst;
const PRINTING_ORDER_FOILS_FIRST = cardOrder.printingFoilsFirst;
const LANGUAGE_ORDER = cardOrder.language;
const WUBRG_ORDER = cardOrder.wubrg;

function typeCategory(types) {
  const t = Array.isArray(types) ? types : safeJsonParse(types, []);
  if (t.length > 1) return 'Multicolor';
  return t[0] || 'Colorless';
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
  const noun = isBinderType(locationType) ? 'Page' : 'Row';
  return `${noun} ${comp.idx}`;
}

async function loadCompartments(database, locationId, userId) {
  const dbClient = database || db;
  const compartments = await dbClient.all(
    `SELECT * FROM compartments WHERE location_id = ? ORDER BY idx ASC`,
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

  const countRows = await dbClient.all(
    `SELECT compartment_id, SUM(quantity) as cnt FROM collection WHERE user_id = ? AND compartment_id IN (${placeholders}) GROUP BY compartment_id`,
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
  const compartments = (overrideCompartments || await loadCompartments(dbClient, location.id, location.user_id)).filter(c => !c.locked);
  if (compartments.length === 0) return null;

  if (!locationAcceptsCard(location, cardMetadata)) {
    return null;
  }

  const allLocationCards = await dbClient.all(`
    SELECT c.id as entry_id, c.compartment_id, c.printing, c.language, c.favorite, cc.name, cc.supertype, cc.types, cc.rarity, cc.set_name, cc.number,
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

  const countOf = (c) => overrideCompartments
    ? (overrideCompartments.find(oc => oc.id === c.id)?.count || 0)
    : (c.count !== undefined ? c.count : (cardsByCompId.get(c.id) || []).reduce((sum, card) => sum + (card.quantity || 1), 0));

  const allCompartmentsFull = compartments.every(c => countOf(c) >= c.capacity);

  if (allCompartmentsFull) {
    const otherLocations = await dbClient.all(
      `SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, game, user_id FROM locations WHERE user_id = ? AND id != ? AND locked = 0 ORDER BY id ASC`,
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

  const dynamicCatsByCompId = new Map();
  compartments.forEach(c => {
    const compCards = cardsByCompId.get(c.id) || [];
    const cardCats = compCards.map(card => getSortCategory(card, location.sort_order)).filter(Boolean);
    dynamicCatsByCompId.set(c.id, Array.from(new Set(cardCats)));
  });

  const validComps = compartments.filter(c => {
    if (!compartmentAcceptsCard(c, cardMetadata)) return false;

    if (c.assignedFilters && c.assignedFilters.length > 0) {
      return cardCat && c.assignedFilters.includes(cardCat);
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
      (cardCat && c.assignedFilters.includes(cardCat)))
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

async function rebalanceCompartmentByScheme(database, compartmentId, sortOrder, foilSorting) {
  const dbClient = database || db;
  const cards = await dbClient.all(
    `SELECT c.*, cc.name, cc.set_id as set_code, cc.set_name, cc.number, cc.types, cc.rarity, cc.price_trend
     FROM collection c
     LEFT JOIN card_cache cc ON c.card_id = cc.id
     WHERE c.compartment_id = ?
     ORDER BY c.position ASC, c.id ASC`,
    [compartmentId]
  );

  if (!cards || cards.length === 0) return;
  const sorted = sortCards(cards, sortOrder, foilSorting);

  const CHUNK_SIZE = 100;
  for (let i = 0; i < sorted.length; i += CHUNK_SIZE) {
    const chunk = sorted.slice(i, i + CHUNK_SIZE);
    let posCaseStr = 'CASE id ';
    const params = [];
    const ids = [];

    chunk.forEach((card, idx) => {
      const newPos = (i + idx + 1) * 1000;
      posCaseStr += `WHEN ? THEN ? `;
      params.push(card.id, newPos);
      ids.push(card.id);
    });
    posCaseStr += 'END';

    const placeholders = ids.map(() => '?').join(',');
    const sql = `UPDATE collection SET position = (${posCaseStr}) WHERE id IN (${placeholders})`;
    await dbClient.run(sql, [...params, ...ids]);
  }
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
    return null;
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
    return getColorCategory(card);
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
  prepareCardMetadata,
  safeJsonParse
};
