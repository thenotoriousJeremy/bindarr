import sys

with open('backend/src/utils/compartmentSort.js', 'r', encoding='utf-8') as f:
    content = f.read()

target_top = """const { resolveCardPrice, rebalanceCompartmentPositions } = require('./priceHelpers');"""
replacement_top = """const { resolveCardPrice, rebalanceCompartmentPositions } = require('./priceHelpers');

let setsCache = [];
async function loadSetsCache(db) {
  try {
    setsCache = await db.all('SELECT * FROM sets ORDER BY release_date ASC, id ASC');
    console.log(`Loaded ${setsCache.length} sets into compartmentSort cache`);
  } catch (e) {
    console.error('Failed to load sets cache', e);
  }
}
"""

target_sort1 = """  } else if (sortOrder === 'set-number') {
    sorted.sort((a, b) => {
      const cmpSet = (a.set_name || '').localeCompare(b.set_name || '');
      if (cmpSet !== 0) return cmpSet;"""
replacement_sort1 = """  } else if (sortOrder === 'set-number') {
    sorted.sort((a, b) => {
      const setAIndex = setsCache.findIndex(s => s.name === a.set_name);
      const setBIndex = setsCache.findIndex(s => s.name === b.set_name);
      const cmpSetChrono = (setAIndex >= 0 ? setAIndex : 999999) - (setBIndex >= 0 ? setBIndex : 999999);
      if (cmpSetChrono !== 0) return cmpSetChrono;
      
      const cmpSet = (a.set_name || '').localeCompare(b.set_name || '');
      if (cmpSet !== 0) return cmpSet;"""

target_sort2 = """  } else if (sortOrder === 'set-number-printing') {
    sorted.sort((a, b) => {
      const cmpSet = (a.set_name || '').localeCompare(b.set_name || '');
      if (cmpSet !== 0) return cmpSet;"""
replacement_sort2 = """  } else if (sortOrder === 'set-number-printing') {
    sorted.sort((a, b) => {
      const setAIndex = setsCache.findIndex(s => s.name === a.set_name);
      const setBIndex = setsCache.findIndex(s => s.name === b.set_name);
      const cmpSetChrono = (setAIndex >= 0 ? setAIndex : 999999) - (setBIndex >= 0 ? setBIndex : 999999);
      if (cmpSetChrono !== 0) return cmpSetChrono;

      const cmpSet = (a.set_name || '').localeCompare(b.set_name || '');
      if (cmpSet !== 0) return cmpSet;"""

target_export = """module.exports = { sortCards, compartmentLabel, loadCompartments, recommendSlot, rebalanceCompartmentByScheme, locationAcceptsCard };"""
replacement_export = """module.exports = { sortCards, compartmentLabel, loadCompartments, recommendSlot, rebalanceCompartmentByScheme, locationAcceptsCard, loadSetsCache };"""

if target_top in content and target_sort1 in content and target_sort2 in content and target_export in content:
    content = content.replace(target_top, replacement_top)
    content = content.replace(target_sort1, replacement_sort1)
    content = content.replace(target_sort2, replacement_sort2)
    content = content.replace(target_export, replacement_export)
    print("Modified compartmentSort.js")
else:
    print("Target not found in compartmentSort.js")

with open('backend/src/utils/compartmentSort.js', 'w', encoding='utf-8') as f:
    f.write(content)
