import sys

with open('backend/src/utils/compartmentSort.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """module.exports = { sortCards, compartmentLabel, loadCompartments, recommendSlot, rebalanceCompartmentByScheme, locationAcceptsCard, loadSetsCache };"""
replacement = """module.exports = { sortCards, compartmentLabel, loadCompartments, recommendSlot, rebalanceCompartmentByScheme, locationAcceptsCard, loadSetsCache, getSortCategory };"""

if target in content:
    content = content.replace(target, replacement)
    print("Exported getSortCategory")
else:
    print("Target not found")

with open('backend/src/utils/compartmentSort.js', 'w', encoding='utf-8') as f:
    f.write(content)
