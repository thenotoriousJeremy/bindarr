import sys
import re

with open('backend/src/utils/compartmentSort.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add locationAcceptsCard at the top
if 'function locationAcceptsCard' not in content:
    location_accepts_card_code = """
function locationAcceptsCard(location, cardMetadata) {
  if (!location.rule_type || location.rule_type === 'any') return true;
  
  try {
    const config = location.rule_config ? (typeof location.rule_config === 'string' ? JSON.parse(location.rule_config) : location.rule_config) : {};
    if (location.rule_type === 'alphabetical_range') {
      const start = (config.start || 'a').toLowerCase();
      const end = (config.end || 'z').toLowerCase();
      const firstLetter = (cardMetadata.name || '').charAt(0).toLowerCase();
      if (!firstLetter) return false;
      return firstLetter >= start && firstLetter <= end;
    }
    if (location.rule_type === 'specific_sets') {
      const sets = config.sets || [];
      return sets.includes(cardMetadata.set_name);
    }
  } catch (e) {
    console.error('Failed to parse location rule_config', e);
  }
  return true;
}

"""
    # Insert after requires
    content = re.sub(r'(const [^\n]+\n+)', r'\1' + location_accepts_card_code, content, count=1)


# 2. Modify recommendSlot to use locationAcceptsCard and be strict
target_strict = """  const cardCat = getSortCategory(cardMetadata, location.sort_order);

  // Determine dynamic categories for each compartment based on sort_order
  const dynamicCatsByCompId = new Map();
  compartments.forEach(c => {
    const compCards = cardsByCompId.get(c.id) || [];
    const cardCats = compCards.map(card => getSortCategory(card, location.sort_order)).filter(Boolean);
    // Explicit assignedSets act as category overrides
    const combinedCats = new Set([...(c.assignedSets || []), ...cardCats]);
    dynamicCatsByCompId.set(c.id, Array.from(combinedCats));
  });

  // Find compartments assigned to the card's category (explicitly or dynamically)
  const assignedComps = compartments.filter(c => {
    const cats = dynamicCatsByCompId.get(c.id) || [];
    return cardCat && cats.includes(cardCat);
  });

  // Find unassigned/empty compartments (no explicit assignments and no categorized cards)
  const unassignedComps = compartments.filter(c => {
    const cats = dynamicCatsByCompId.get(c.id) || [];
    return cats.length === 0;
  });

  // Build the eligible pool (assigned first, then unassigned as overflow)
  let pool = [...assignedComps, ...unassignedComps];
  pool.sort((a, b) => a.idx - b.idx);

  // If the pool has no free space, fall back to all compartments in the location
  const poolHasFreeSpace = pool.some(c => {
    const count = overrideCompartments
      ? (overrideCompartments.find(oc => oc.id === c.id)?.count || 0)
      : (cardsByCompId.get(c.id) || []).length;
    return count < c.capacity;
  });

  if (pool.length === 0 || !poolHasFreeSpace) {
    pool = [...compartments];
  }"""

replacement_strict = """  // 1. Container-level strict filter
  if (!locationAcceptsCard(location, cardMetadata)) {
    return null;
  }

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
    // If it has explicit sets, it MUST match
    if (c.assignedSets && c.assignedSets.length > 0) {
      // we check cardCat but specifically we can just check if card.set_name is in assignedSets if the sort_order is set-number, 
      // but actually assignedSets are tied to whatever the category is!
      return cardCat && c.assignedSets.includes(cardCat);
    }
    
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    // If it has NO explicit sets, but has cards, it only accepts matching dynamic category
    if (dCats.length > 0) {
      return cardCat && dCats.includes(cardCat);
    }
    
    // If it has no explicit sets and no dynamic cards, it accepts anything
    return true;
  });

  // Separate into preferred (assigned/matching) vs unassigned
  const assignedComps = validComps.filter(c => {
    if (c.assignedSets && c.assignedSets.length > 0) return true;
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    return dCats.length > 0;
  });
  
  const unassignedComps = validComps.filter(c => {
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    return !(c.assignedSets && c.assignedSets.length > 0) && dCats.length === 0;
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
  
  pool.sort((a, b) => a.idx - b.idx);
  
  // Check if final pool has free space
  const finalHasFreeSpace = pool.some(c => {
    const count = overrideCompartments
      ? (overrideCompartments.find(oc => oc.id === c.id)?.count || 0)
      : (cardsByCompId.get(c.id) || []).length;
    return count < c.capacity;
  });

  // We NO LONGER fallback to `[...compartments]`. If it's full, or doesn't match rules, it returns null!
  if (pool.length === 0 || !finalHasFreeSpace) {
    return null;
  }"""

if target_strict in content:
    content = content.replace(target_strict, replacement_strict)
else:
    print("Warning: strict target not found")

# 3. Export locationAcceptsCard
target_export = "module.exports = { recommendSlot, compartmentLabel, loadCompartments, rebalanceCompartmentByScheme, sortCards };"
replacement_export = "module.exports = { recommendSlot, compartmentLabel, loadCompartments, rebalanceCompartmentByScheme, sortCards, locationAcceptsCard };"
if target_export in content:
    content = content.replace(target_export, replacement_export)
else:
    print("Warning: export target not found")

with open('backend/src/utils/compartmentSort.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("compartmentSort.js strict filtering patched.")
