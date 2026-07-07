import sys
import re

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """                const renderedCards = [];
                let currentCat = null;
                for (const card of baseCards) {
                  if (card) {
                    const cat = getSortCategory(card, selectedLoc.sort_order);
                    if (cat && cat !== currentCat) {
                      renderedCards.push({
                        __divider: true,
                        entry_id: `div-${cat}`,
                        label: cat
                      });
                      currentCat = cat;
                    }
                  }
                  renderedCards.push(card);
                }"""

replacement1 = """                const renderedCards = [];
                let currentCat = null;
                let slotCounter = 1;
                for (const card of baseCards) {
                  if (card) {
                    const cat = getSortCategory(card, selectedLoc.sort_order);
                    if (cat && cat !== currentCat) {
                      renderedCards.push({
                        __divider: true,
                        entry_id: `div-${cat}`,
                        label: cat
                      });
                      currentCat = cat;
                    }
                    renderedCards.push({ ...card, __slotNumber: slotCounter });
                  } else {
                    renderedCards.push({
                      __empty: true,
                      __slotNumber: slotCounter,
                      entry_id: `spacer-${slotCounter}`
                    });
                  }
                  slotCounter++;
                }"""

if target1 in content:
    content = content.replace(target1, replacement1)
    print("Replaced target1 (renderedCards gen)")
else:
    print("Failed to find target1")

target2 = """                                if (!card) {
                                  return (
                                    <div
                                      key={`spacer-${i}`}
                                      className={`box-coverflow-card ${offset === 0 ? 'active' : ''}`}
                                      style={{ transform, zIndex, opacity: opacity * 0.6, filter }}
                                      onClick={() => setCoverflowActiveIndex(i)}
                                    >
                                      <div style={{ width: '100%', height: '100%', background: 'rgba(0,0,0,0.3)', border: '2px dashed rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '5px' }}>
                                        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.8rem', fontWeight: 'bold' }}>Slot {i + 1}</span>
                                      </div>
                                    </div>
                                  );
                                }"""

replacement2 = """                                if (card.__empty) {
                                  return (
                                    <div
                                      key={card.entry_id}
                                      className={`box-coverflow-card ${offset === 0 ? 'active' : ''}`}
                                      style={{ transform, zIndex, opacity: opacity * 0.6, filter }}
                                      onClick={() => setCoverflowActiveIndex(i)}
                                    >
                                      <div style={{ width: '100%', height: '100%', background: 'rgba(0,0,0,0.3)', border: '2px dashed rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '5px' }}>
                                        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.8rem', fontWeight: 'bold' }}>Slot {card.__slotNumber}</span>
                                      </div>
                                    </div>
                                  );
                                }"""

if target2 in content:
    content = content.replace(target2, replacement2)
    print("Replaced target2 (empty slot)")
else:
    print("Failed to find target2")

target3 = """                                  {isRecSpot && (
                                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: '#ffc107', color: '#000', fontSize: '0.75rem', fontWeight: 'bold', padding: '3px 8px', borderRadius: '4px', zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>Slot {i + 1}</div>
                                  )}"""

replacement3 = """                                  {isRecSpot && (
                                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: '#ffc107', color: '#000', fontSize: '0.75rem', fontWeight: 'bold', padding: '3px 8px', borderRadius: '4px', zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>Slot {card.__slotNumber}</div>
                                  )}"""

if target3 in content:
    content = content.replace(target3, replacement3)
    print("Replaced target3 (ghost slot)")
else:
    print("Failed to find target3")


with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
