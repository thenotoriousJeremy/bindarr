import sys

with open('backend/src/tcgApi.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """module.exports = {
  searchCards,
  getCardById,
  getCardsBySet,
  updateCollectionPrices
};"""

replacement = """module.exports = {
  searchCards,
  getCardById,
  getCardsBySet,
  updateCollectionPrices,
  fetchAndCacheSets
};"""

if target in content:
    content = content.replace(target, replacement)
    print("Replaced exports")
else:
    print("Target not found")

with open('backend/src/tcgApi.js', 'w', encoding='utf-8') as f:
    f.write(content)
