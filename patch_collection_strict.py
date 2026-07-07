import sys
import re

with open('backend/src/routes/collection.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. require locationAcceptsCard
target_req = "const { recommendSlot, compartmentLabel, loadCompartments, rebalanceCompartmentByScheme, sortCards } = require('../utils/compartmentSort');"
replacement_req = "const { recommendSlot, compartmentLabel, loadCompartments, rebalanceCompartmentByScheme, sortCards, locationAcceptsCard } = require('../utils/compartmentSort');"
if target_req in content:
    content = content.replace(target_req, replacement_req)

# 2. remove local locationAcceptsCard
target_fn = """function locationAcceptsCard(location, cardMetadata) {
  if (!location.rule_type || location.rule_type === 'any') return true;
  
  try {
    const config = location.rule_config ? JSON.parse(location.rule_config) : {};
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
}"""
if target_fn in content:
    content = content.replace(target_fn, "")

# 3. Modify resolveCompartmentAndPosition to include rule_type and rule_config
target_sql = "const location = await db.get(`SELECT id, name, type, sort_order, foil_sorting, user_id FROM locations WHERE id = ? AND user_id = ?`, [locationId, userId]);"
replacement_sql = "const location = await db.get(`SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, user_id FROM locations WHERE id = ? AND user_id = ?`, [locationId, userId]);"
if target_sql in content:
    content = content.replace(target_sql, replacement_sql)

with open('backend/src/routes/collection.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("collection.js strict filtering patched.")
