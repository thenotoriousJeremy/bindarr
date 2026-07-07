import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target = """                        {/* Focused Card Actions */}
                        {activeCard && !activeCard.__ghost && (
                          <div className="focused-card-info-panel">"""

replacement = """                        {/* Focused Card Actions */}
                        {activeCard && !activeCard.__ghost && !activeCard.__divider && !activeCard.__empty && (
                          <div className="focused-card-info-panel">"""

if target in content:
    content = content.replace(target, replacement)
    print("Replaced focused card panel condition")
else:
    print("Target not found")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
