import { cardTypeCategory, colorCategory } from './cardSort.js';

// The categories a container's dividers split its cards into, and where those
// categories change along a row or page. The coverflow's divider cards, a binder
// page's divider labels, the All cards overview and the box map all read these,
// so a divider in one view is a divider in every other.

// The label a card falls under for a given divider field.
export function categoryForField(card, field, setsList = []) {
  switch (field) {
    case 'name':
      return card.name ? card.name.charAt(0).toUpperCase() : '?';
    case 'set': {
      if (!card.set_name) return 'Unknown Set';
      if (!setsList || setsList.length === 0) return card.set_name;
      const idx = setsList.findIndex(s => s.name === card.set_name);
      return idx >= 0 ? `${idx + 1}. ${card.set_name}` : card.set_name;
    }
    case 'color_identity':
    case 'color':
      return colorCategory(card);
    case 'type':
      return cardTypeCategory(card);
    case 'cmc':
      return `CMC ${card.cmc != null && card.cmc !== '' ? card.cmc : '?'}`;
    case 'rarity':
      return card.rarity || 'Common';
    case 'printing':
      return card.printing || 'Normal';
    case 'language':
      return card.language || 'English';
    case 'price': {
      const p = card.price_trend || 0;
      if (p >= 100) return '$100+';
      if (p >= 50) return '$50+';
      if (p >= 20) return '$20+';
      if (p >= 10) return '$10+';
      if (p >= 5) return '$5+';
      if (p >= 1) return '$1+';
      return '< $1';
    }
    default:
      return null; // added_at, entry_id, number: too granular to divide on
  }
}

function dividerFieldsOf(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const chosen = arr.filter(r => r && r.divider === true);
  if (chosen.length > 0) return chosen.map(r => ({ field: r.by, color: r.dividerColor || '#6b7280' }));
  if (arr.some(r => r && r.divider === false)) return [];
  return [{ field: arr[0].by, color: '#6b7280' }];
}

export function getSortCategories(card, sortOrder, setsList = []) {
  if (!card || !sortOrder || sortOrder === 'custom') return [];

  let dividerFields = [];
  if (Array.isArray(sortOrder)) {
    dividerFields = dividerFieldsOf(sortOrder);
  } else if (typeof sortOrder === 'string' && sortOrder.startsWith('[')) {
    try { dividerFields = dividerFieldsOf(JSON.parse(sortOrder)); }
    catch { dividerFields = []; }
  } else if (typeof sortOrder === 'string') {
    if (sortOrder.startsWith('name')) dividerFields = [{ field: 'name', color: '#6b7280' }];
    else if (sortOrder.startsWith('set')) dividerFields = [{ field: 'set', color: '#6b7280' }];
    else if (sortOrder.startsWith('type')) dividerFields = [{ field: 'type', color: '#6b7280' }];
    else if (sortOrder.startsWith('price')) dividerFields = [{ field: 'price', color: '#6b7280' }];
    else if (sortOrder.startsWith('language')) dividerFields = [{ field: 'language', color: '#6b7280' }];
  }

  return dividerFields.map(df => ({
    field: df.field,
    color: df.color,
    label: categoryForField(card, df.field, setsList)
  })).filter(c => c.label !== null);
}

// Category the container FILES by — the primary (first) sort field, matching
// the backend's placement engine. Used by the Category-to-Page map, which must
// track filing, not the (independent) visual divider choice.
export function getPrimaryCategory(card, sortOrder, setsList = []) {
  if (!card || !sortOrder || sortOrder === 'custom') return null;
  let field = null;
  if (Array.isArray(sortOrder)) field = sortOrder[0]?.by || null;
  else if (typeof sortOrder === 'string' && sortOrder.startsWith('[')) {
    try { field = JSON.parse(sortOrder)[0]?.by || null; } catch { field = null; }
  } else if (typeof sortOrder === 'string') {
    if (sortOrder.startsWith('name')) field = 'name';
    else if (sortOrder.startsWith('set')) field = 'set';
    else if (sortOrder.startsWith('type')) field = 'type';
    else if (sortOrder.startsWith('price')) field = 'price';
    else if (sortOrder.startsWith('language')) field = 'language';
  }
  if (!field) return null;
  return categoryForField(card, field, setsList);
}

// The categories that begin at a card, given the ones in force before it: every
// level from the first one that differs down, all of them for the first card,
// and [] when the card carries on where the last one left off.
export function changedCategories(cats, prevCats) {
  if (!cats || cats.length === 0) return [];
  if (!prevCats || prevCats.length === 0) return cats;
  const diffIdx = cats.findIndex((cat, j) => !prevCats[j] || cat.label !== prevCats[j].label);
  return diffIdx === -1 ? [] : cats.slice(diffIdx);
}

// changedCategories for every item of a row or page, in order. Empty slots
// (null) and the filing ghost begin nothing and do not break a run, the same
// way the binder page treats them.
export function dividerStarts(items, sortOrder, setsList = []) {
  let lastCats = [];
  return items.map(item => {
    if (!item || item.__ghost) return [];
    const cats = getSortCategories(item, sortOrder, setsList);
    const changed = changedCategories(cats, lastCats);
    if (cats.length > 0) lastCats = cats;
    return changed;
  });
}

// Cards already in display order, split wherever a divider would go. Each group
// has the slot index it starts at and the full category path of its first card
// ([] when the container has no dividers, which makes the whole row one group).
export function groupByDividers(cards, sortOrder, setsList = []) {
  const groups = [];
  dividerStarts(cards, sortOrder, setsList).forEach((changed, index) => {
    if (groups.length === 0 || changed.length > 0) {
      groups.push({ start: index, path: getSortCategories(cards[index], sortOrder, setsList), cards: [] });
    }
    groups[groups.length - 1].cards.push(cards[index]);
  });
  return groups;
}
