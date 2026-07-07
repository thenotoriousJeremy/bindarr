import sys

with open('backend/src/utils/compartmentSort.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = "module.exports = { sortCards, compartmentLabel, loadCompartments, recommendSlot, rebalanceCompartmentByScheme };"
replacement = "module.exports = { sortCards, compartmentLabel, loadCompartments, recommendSlot, rebalanceCompartmentByScheme, locationAcceptsCard };"

if target in content:
    content = content.replace(target, replacement)
    with open('backend/src/utils/compartmentSort.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Export patched.")
else:
    print("Warning: export target not found again.")
