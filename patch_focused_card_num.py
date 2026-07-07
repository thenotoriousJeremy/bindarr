import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target = """                                <strong style={{ fontSize: '0.85rem' }}>#{activeCardIndex + 1} | {activeCard.name}</strong>"""

replacement = """                                <strong style={{ fontSize: '0.85rem' }}>#{activeCard.__slotNumber} | {activeCard.name}</strong>"""

if target in content:
    content = content.replace(target, replacement)
    print("Replaced active card index with slot number")
else:
    print("Target not found")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
