import sys
import re

with open('backend/src/utils/compartmentSort.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """  const validComps = compartments.filter(c => {
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
  });"""

replacement = """  const isSetSort = location.sort_order.startsWith('set');

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

if target in content:
    content = content.replace(target, replacement)
    with open('backend/src/utils/compartmentSort.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print("compartmentSort.js assignedSets logic patched.")
else:
    print("Warning: strict target for assignedSets not found")
