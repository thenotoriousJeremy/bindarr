import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target = """                                const prevCat = getSortCategory(prev, selectedLoc.sort_order);
                                const categoryStart = cat && (!prev || prevCat !== cat);
                                const absOffset = Math.abs(offset);

                                const isRecSpot = card.__ghost;"""

replacement = """                                const prevCat = getSortCategory(prev, selectedLoc.sort_order);
                                const categoryStart = cat && (!prev || prevCat !== cat);

                                const isRecSpot = card.__ghost;"""

if target in content:
    content = content.replace(target, replacement)
    with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Syntax error fixed.")
else:
    print("Target not found.")
