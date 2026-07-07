import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. BinderPageContent padding
target_binder = """  const rendered = [...cards];
  if (recIdx >= 0) {
    rendered.splice(Math.min(recIdx, rendered.length), 0, {"""

replacement_binder = """  const rendered = [...cards];
  if (recIdx >= 0) {
    while (rendered.length < recIdx) rendered.push(null);
    rendered.splice(recIdx, 0, {"""

if target_binder in content:
    content = content.replace(target_binder, replacement_binder)
else:
    print("Warning: target_binder not found")

# 2. Coverflow padding
target_coverflow_splice = """                              if (currentRecSpot && currentRecSpot.compartment_id === activeComp.id) {
                                recSpotIndex = Math.floor(currentRecSpot.position / 1000) - 1;
                                renderedCards.splice(Math.min(recSpotIndex, renderedCards.length), 0, {"""

replacement_coverflow_splice = """                              if (currentRecSpot && currentRecSpot.compartment_id === activeComp.id) {
                                recSpotIndex = Math.floor(currentRecSpot.position / 1000) - 1;
                                while (renderedCards.length < recSpotIndex) renderedCards.push(null);
                                renderedCards.splice(recSpotIndex, 0, {"""

if target_coverflow_splice in content:
    content = content.replace(target_coverflow_splice, replacement_coverflow_splice)
else:
    print("Warning: target_coverflow_splice not found")

# 3. Coverflow rendering of null cards
target_coverflow_render = """                              return renderedCards.map((card, i) => {
                                const prev = i > 0 ? renderedCards[i - 1] : null;
                                const cat = getSortCategory(card, selectedLoc.sort_order);
                                const prevCat = getSortCategory(prev, selectedLoc.sort_order);
                                const categoryStart = cat && (!prev || prevCat !== cat);

                                const offset = i - activeCardIndex;
                                const absOffset = Math.abs(offset);
                                const zIndex = 50 - absOffset;
                                let transform = `translateX(0) scale(1) rotateY(0deg)`;
                                let opacity = 1;
                                let filter = 'none';
                                if (offset !== 0) {
                                  const dir = offset > 0 ? 1 : -1;
                                  const translateX = dir * (85 + absOffset * 35);
                                  const rotateY = dir * -48;
                                  transform = `translateX(${translateX}px) scale(0.8) rotateY(${rotateY}deg)`;
                                  opacity = Math.max(0.12, 1 - absOffset * 0.22);
                                  filter = `brightness(${Math.max(0.35, 1 - absOffset * 0.18)})`;
                                }

                                return (
                                  <div
                                    id={isRecSpot ? "recommended-spot" : undefined}
                                    key={card.entry_id}
                                    className={`box-coverflow-card ${offset === 0 ? 'active' : ''} ${card.entry_id === focusEntryId ? 'focus-flash' : ''} ${isRecSpot ? 'recommended-ghost' : ''}`}
                                    style={{
                                      transform,
                                      zIndex,
                                      opacity: isRecSpot ? opacity : opacity,
                                      filter
                                    }}
                                    onClick={() => setCoverflowActiveIndex(i)}
                                  >
                                  {categoryStart && (
                                    <div style={{ position: 'absolute', top: '-24px', left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-card)', border: '1px solid var(--border-glass)', borderBottom: 'none', padding: '2px 10px', borderRadius: '6px 6px 0 0', fontSize: '0.65rem', fontWeight: 'bold', whiteSpace: 'nowrap', zIndex: -1 }}>
                                      {cat}
                                    </div>
                                  )}
                                  <img src={card.image_url} alt={card.name} />
                                  <PrintingBadge printing={card.printing} />
                                  {isRecSpot && (
                                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: '#ffc107', color: '#000', fontSize: '0.75rem', fontWeight: 'bold', padding: '3px 8px', borderRadius: '4px', zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>Slot {i + 1}</div>
                                  )}
                                </div>
                              );
                            })"""

replacement_coverflow_render = """                              return renderedCards.map((card, i) => {
                                const offset = i - activeCardIndex;
                                const absOffset = Math.abs(offset);
                                const zIndex = 50 - absOffset;
                                let transform = `translateX(0) scale(1) rotateY(0deg)`;
                                let opacity = 1;
                                let filter = 'none';
                                if (offset !== 0) {
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
                                const categoryStart = cat && (!prev || prevCat !== cat);
                                const isRecSpot = card.__ghost;

                                return (
                                  <div
                                    id={isRecSpot ? "recommended-spot" : undefined}
                                    key={card.entry_id || `rec-${i}`}
                                    className={`box-coverflow-card ${offset === 0 ? 'active' : ''} ${card.entry_id === focusEntryId ? 'focus-flash' : ''} ${isRecSpot ? 'recommended-ghost' : ''}`}
                                    style={{
                                      transform,
                                      zIndex,
                                      opacity: isRecSpot ? opacity : opacity,
                                      filter
                                    }}
                                    onClick={() => setCoverflowActiveIndex(i)}
                                  >
                                  {categoryStart && (
                                    <div style={{ position: 'absolute', top: '-24px', left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-card)', border: '1px solid var(--border-glass)', borderBottom: 'none', padding: '2px 10px', borderRadius: '6px 6px 0 0', fontSize: '0.65rem', fontWeight: 'bold', whiteSpace: 'nowrap', zIndex: -1 }}>
                                      {cat}
                                    </div>
                                  )}
                                  <img src={card.image_url} alt={card.name} />
                                  {card.printing && <PrintingBadge printing={card.printing} />}
                                  {isRecSpot && (
                                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: '#ffc107', color: '#000', fontSize: '0.75rem', fontWeight: 'bold', padding: '3px 8px', borderRadius: '4px', zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>Slot {i + 1}</div>
                                  )}
                                </div>
                              );
                            })"""

if target_coverflow_render in content:
    content = content.replace(target_coverflow_render, replacement_coverflow_render)
else:
    print("Warning: target_coverflow_render not found")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("LocationManager padding patched.")
