import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target = """                              return renderedCards.map((card, i) => {
                                const prev = i > 0 ? renderedCards[i - 1] : null;
                                const cat = getSortCategory(card, selectedLoc.sort_order);
                                const prevCat = getSortCategory(prev, selectedLoc.sort_order);
                                const categoryStart = cat && (!prev || prevCat !== cat);

                                const offset = i - activeCardIndex;"""

replacement = """                              return renderedCards.map((card, i) => {
                                const offset = i - activeCardIndex;
                                const absOffset = Math.abs(offset);
                                let transform = '';
                                let zIndex = 10 - absOffset;
                                let opacity = 1;
                                let filter = 'none';

                                if (offset === 0) {
                                  transform = `translateX(0px) scale(1.22) translateZ(0px)`;
                                  opacity = 1;
                                } else {
                                  const dir = offset > 0 ? 1 : -1;
                                  const translateX = dir * (85 + absOffset * 35);
                                  const rotateY = dir * -48;
                                  transform = `translateX(${translateX}px) scale(0.8) rotateY(${rotateY}deg)`;
                                  opacity = Math.max(0.12, 1 - absOffset * 0.22);
                                  filter = `brightness(${Math.max(0.35, 1 - absOffset * 0.18)})`;
                                }

                                if (!card) {
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
                                }

                                const prev = i > 0 ? renderedCards[i - 1] : null;
                                const cat = getSortCategory(card, selectedLoc.sort_order);
                                const prevCat = getSortCategory(prev, selectedLoc.sort_order);
                                const categoryStart = cat && (!prev || prevCat !== cat);"""

if target in content:
    content = content.replace(target, replacement)
else:
    print("Warning: Coverflow padding top not found")


target_bottom = """                                const isRecSpot = card.__ghost;

                                let transform = '';
                                let zIndex = 10 - absOffset;
                                let opacity = 1;
                                let filter = 'none';

                                if (offset === 0) {
                                  transform = `translateX(0px) scale(1.22) translateZ(0px)`;
                                  opacity = 1;
                                } else {
                                  const dir = offset > 0 ? 1 : -1;
                                  const translateX = dir * (85 + absOffset * 35);
                                  const rotateY = dir * -48;
                                  transform = `translateX(${translateX}px) scale(0.8) rotateY(${rotateY}deg)`;
                                  opacity = Math.max(0.12, 1 - absOffset * 0.22);
                                  filter = `brightness(${Math.max(0.35, 1 - absOffset * 0.18)})`;
                                }"""

replacement_bottom = """                                const isRecSpot = card.__ghost;"""

if target_bottom in content:
    content = content.replace(target_bottom, replacement_bottom)
else:
    print("Warning: target_bottom not found")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Coverflow padded")
