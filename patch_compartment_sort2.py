import sys
import re

with open('backend/src/utils/compartmentSort.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update getSortCategory to match frontend
target_cat = """function getSortCategory(card, sortOrder) {
  if (!card || !sortOrder || sortOrder === 'custom') return null;
  if (sortOrder.startsWith('name')) return card.name ? card.name.charAt(0).toUpperCase() : '?';
  if (sortOrder.startsWith('set')) return card.set_name || 'Unknown Set';"""

replacement_cat = """function getSortCategory(card, sortOrder) {
  if (!card || !sortOrder || sortOrder === 'custom') return null;
  if (sortOrder.startsWith('name')) return card.name ? card.name.charAt(0).toUpperCase() : '?';
  if (sortOrder.startsWith('set')) {
    if (!card.set_name) return 'Unknown Set';
    if (!setsCache || setsCache.length === 0) return card.set_name;
    const idx = setsCache.findIndex(s => s.name === card.set_name);
    return idx >= 0 ? `${idx + 1}. ${card.set_name}` : card.set_name;
  }"""

content = content.replace(target_cat, replacement_cat)

# 2. Update loadCompartments
content = content.replace(
    "SELECT compartment_id, set_name FROM compartment_set_assignments WHERE compartment_id IN (${placeholders})",
    "SELECT compartment_id, filter_value FROM compartment_assignments WHERE compartment_id IN (${placeholders})"
)
content = content.replace("setsByCompartment", "filtersByCompartment")
content = content.replace("r.set_name", "r.filter_value")
content = content.replace("assignedSets: filtersByCompartment.get(c.id) || []", "assignedFilters: filtersByCompartment.get(c.id) || []")

# 3. Update locationAcceptsCard
# It currently assumes assignedSets is only checked if isSetSort. But we want it to check assignedFilters for ANY sort.
target_accepts = """function locationAcceptsCard(location, cardMetadata) {
  return true;
}"""
# Wait, locationAcceptsCard is completely different?
# Oh, locationAcceptsCard is actually very small.
# Ah, I saw logic inside recommendSlot:
# "if (isSetSort && c.assignedSets && c.assignedSets.length > 0) {"

target_logic = """  const isSetSort = location.sort_order.startsWith('set');

  const validComps = compartments.filter(c => {
    // If it has explicit sets, and we are sorting by set, it MUST match
    if (isSetSort && c.assignedSets && c.assignedSets.length > 0) {
      return cardCat && c.assignedSets.includes(cardCat);
    }
    
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    // If it has NO explicit sets (or we are ignoring them), but has cards, it only accepts matching dynamic category
    if (dCats.length > 0) {
      return cardCat && dCats.includes(cardCat);
    }
    
    // If it has no explicit sets and no dynamic cards, it accepts anything
    return true;
  });

  // Separate into preferred (assigned/matching) vs unassigned
  const assignedComps = validComps.filter(c => {
    if (isSetSort && c.assignedSets && c.assignedSets.length > 0) return true;
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    return dCats.length > 0;
  });
  
  const unassignedComps = validComps.filter(c => {
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    return !(isSetSort && c.assignedSets && c.assignedSets.length > 0) && dCats.length === 0;
  });"""

replacement_logic = """  const validComps = compartments.filter(c => {
    // If it has explicit filters, it MUST match
    if (c.assignedFilters && c.assignedFilters.length > 0) {
      return cardCat && c.assignedFilters.includes(cardCat);
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
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    return dCats.length > 0;
  });
  
  const unassignedComps = validComps.filter(c => {
    const dCats = dynamicCatsByCompId.get(c.id) || [];
    return !(c.assignedFilters && c.assignedFilters.length > 0) && dCats.length === 0;
  });"""

content = content.replace(target_logic, replacement_logic)

with open('backend/src/utils/compartmentSort.js', 'w', encoding='utf-8') as f:
    f.write(content)
print("Updated compartmentSort.js")
