import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """                const activeCompCards = cardsByCompartment.get(activeComp.id) || [];
                const activeCardIndex = Math.min(coverflowActiveIndex, Math.max(0, activeCompCards.length - 1));
                const activeCard = activeCompCards[activeCardIndex];"""

replacement1 = """                const activeCompCards = cardsByCompartment.get(activeComp.id) || [];
                const renderedCards = [...activeCompCards];
                let recSpotIndex = -1;
                if (currentRecSpot && currentRecSpot.compartment_id === activeComp.id) {
                  recSpotIndex = Math.floor(currentRecSpot.position / 1000) - 1;
                  while (renderedCards.length < recSpotIndex) renderedCards.push(null);
                  renderedCards.splice(recSpotIndex, 0, {
                    __ghost: true,
                    entry_id: 'rec-ghost',
                    image_url: recCard?.image_url,
                    name: recCard?.name,
                    set_name: recCard?.set_name,
                    printing: recCard?.printing || 'Normal'
                  });
                }
                const activeCardIndex = Math.min(coverflowActiveIndex, Math.max(0, renderedCards.length - 1));
                const activeCard = renderedCards[activeCardIndex];"""

if target1 in content:
    content = content.replace(target1, replacement1)
else:
    print("Warning: target1 not found")

target2 = """                          <div className="box-coverflow-track">
                            {(() => {
                              const renderedCards = [...activeCompCards];
                              let recSpotIndex = -1;
                              if (currentRecSpot && currentRecSpot.compartment_id === activeComp.id) {
                                recSpotIndex = Math.floor(currentRecSpot.position / 1000) - 1;
                                while (renderedCards.length < recSpotIndex) renderedCards.push(null);
                                renderedCards.splice(recSpotIndex, 0, {
                                  __ghost: true,
                                  entry_id: 'rec-ghost',
                                  image_url: recCard?.image_url,
                                  name: recCard?.name,
                                  set_name: recCard?.set_name,
                                  printing: recCard?.printing || 'Normal'
                                });
                              }

                              return renderedCards.map((card, i) => {"""

replacement2 = """                          <div className="box-coverflow-track">
                            {(() => {
                              return renderedCards.map((card, i) => {"""

if target2 in content:
    content = content.replace(target2, replacement2)
else:
    print("Warning: target2 not found")


target3 = """                            disabled={activeCardIndex >= activeCompCards.length - 1}
                            onClick={() => setCoverflowActiveIndex(prev => Math.min(activeCompCards.length - 1, prev + 1))}"""

replacement3 = """                            disabled={activeCardIndex >= renderedCards.length - 1}
                            onClick={() => setCoverflowActiveIndex(prev => Math.min(renderedCards.length - 1, prev + 1))}"""

if target3 in content:
    content = content.replace(target3, replacement3)
else:
    print("Warning: target3 not found (might not match exactly)")
    
target4 = """                          onTouchEnd={(e) => handleCoverflowTouchEnd(e, activeCompCards.length)}"""
replacement4 = """                          onTouchEnd={(e) => handleCoverflowTouchEnd(e, renderedCards.length)}"""

if target4 in content:
    content = content.replace(target4, replacement4)
else:
    print("Warning: target4 not found")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Coverflow activeCardIndex clamping fixed.")
