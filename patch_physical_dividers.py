import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """                const activeCompCards = cardsByCompartment.get(activeComp.id) || [];
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
                }"""

replacement1 = """                const activeCompCards = cardsByCompartment.get(activeComp.id) || [];
                const baseCards = [...activeCompCards];
                if (currentRecSpot && currentRecSpot.compartment_id === activeComp.id) {
                  const recIdx = Math.floor(currentRecSpot.position / 1000) - 1;
                  while (baseCards.length < recIdx) baseCards.push(null);
                  baseCards.splice(recIdx, 0, {
                    __ghost: true,
                    entry_id: 'rec-ghost',
                    image_url: recCard?.image_url,
                    name: recCard?.name,
                    set_name: recCard?.set_name,
                    printing: recCard?.printing || 'Normal'
                  });
                }

                const renderedCards = [];
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

if target1 in content:
    content = content.replace(target1, replacement1)
    print("Replaced target1")
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

replacement2 = """                                if (!card) {
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

                                if (card.__divider) {
                                  return (
                                    <div
                                      key={card.entry_id}
                                      className={`box-coverflow-card ${offset === 0 ? 'active' : ''}`}
                                      style={{ transform, zIndex, opacity, filter: 'none', background: 'linear-gradient(135deg, rgba(255, 71, 71, 0.8), rgba(150, 0, 0, 0.8))', border: '1px solid rgba(255, 71, 71, 0.5)', display: 'flex', flexDirection: 'column', overflow: 'visible' }}
                                      onClick={() => setCoverflowActiveIndex(i)}
                                    >
                                      <div style={{ position: 'absolute', top: '-18px', left: '10px', background: 'var(--accent-red)', color: '#fff', padding: '2px 12px', borderRadius: '6px 6px 0 0', fontSize: '0.7rem', fontWeight: 'bold', boxShadow: '0 -2px 5px rgba(0,0,0,0.3)', whiteSpace: 'nowrap' }}>
                                        {card.label}
                                      </div>
                                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '0.5rem', color: '#fff' }}>
                                        <div style={{ fontSize: '1.2rem', fontWeight: 'bold', textAlign: 'center', padding: '0 1rem' }}>{card.label}</div>
                                      </div>
                                    </div>
                                  );
                                }"""

if target2 in content:
    content = content.replace(target2, replacement2)
    print("Replaced target2")
else:
    print("Failed to find target2")

target3 = """                                const prev = i > 0 ? renderedCards[i - 1] : null;
                                const cat = getSortCategory(card, selectedLoc.sort_order);
                                const prevCat = getSortCategory(prev, selectedLoc.sort_order);
                                const categoryStart = cat && (!prev || prevCat !== cat);

                                const isRecSpot = card.__ghost;

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
                                    <div className="set-divider-label" title={cat}>
                                      {cat}
                                    </div>
                                  )}
                                  <img src={card.image_url} alt={card.name} />"""

replacement3 = """                                const isRecSpot = card.__ghost;

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
                                  <img src={card.image_url} alt={card.name} />"""

if target3 in content:
    content = content.replace(target3, replacement3)
    print("Replaced target3")
else:
    print("Failed to find target3")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
